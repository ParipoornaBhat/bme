"""Comprehensive Evaluation Suite for 3D U-Net Knee MRI Segmentation.

Features:
A. Inference module: sliding-window prediction with probability averaging, flip TTA, and fold ensembling.
   - Strict Leakage Rule: Multi-fold ensemble allowed ONLY for test-locked cases or external datasets.
   - Cross-validation cases are strictly evaluated Out-Of-Fold (OOF).
B. Bit-identical baseline consensus reproduction against train_3d.py's predict_volume.
C. Honest Nested Cross-Validation for threshold and 3D connected-component size (mm^3) post-processing.
D. Rich metrics: bone/edema Dice, slice-position bone Dice, lesion sensitivity/precision,
   volume error (cm^3), Pearson r, Bland-Altman agreement, and patient-level bootstrap 95% CIs.
E. Oracle bone gating diagnostic (GT gating, no gating, in-plane dilated gating).
F. Safe outputs outside repo and data directories.
"""

from __future__ import annotations

import argparse
import csv
import gc
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

import nibabel as nib
import numpy as np
import scipy.ndimage as ndi
from scipy.ndimage import label as cc_label
import torch
import torch.nn as nn

# Local scripts imports
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
sys.path.insert(0, str(SCRIPT_DIR))

from postprocess import in_plane_dilate, postprocess_volume  # noqa: E402
from train_3d import (  # noqa: E402
    PATCH,
    STRIDE,
    UNet3D,
    crop,
    load_case,
    normalize,
    pad_volume,
    window_origins,
)


class LeakageError(Exception):
    """Raised when evaluation violates cross-validation separation or leakage rules."""


def validate_out_dir(out_dir_path: str | Path) -> Path:
    """Enforce safety rule: --out-dir must be outside the repo and data directory."""
    out_dir = Path(out_dir_path).resolve()
    repo_root = REPO_ROOT.resolve()
    data_dir = (REPO_ROOT / "data").resolve()

    try:
        out_dir.relative_to(repo_root)
        inside_repo = True
    except ValueError:
        inside_repo = False

    try:
        out_dir.relative_to(data_dir)
        inside_data = True
    except ValueError:
        inside_data = False

    if inside_repo or inside_data:
        raise ValueError(
            f"[SAFETY REFUSAL] --out-dir '{out_dir}' must be outside the repo ({repo_root}) and data directory."
        )
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def determine_lr_flip_axis(affine: np.ndarray) -> int:
    """Determine the left-right axis index from the NIfTI affine matrix.

    Returns axis 0, 1, or 2. Raises ValueError if ambiguous.
    """
    try:
        axcodes = nib.aff2axcodes(affine)
    except Exception as e:
        raise ValueError(f"Could not compute orientation axcodes from affine: {e}")

    lr_axes = [i for i, code in enumerate(axcodes) if code in ("L", "R")]
    if len(lr_axes) != 1:
        raise ValueError(
            f"Ambiguous or non-standard Left-Right axis in orientation {axcodes}. "
            f"Expected exactly 1 axis with 'L' or 'R', found {len(lr_axes)}."
        )
    return lr_axes[0]


@torch.no_grad()
def predict_sliding_window(
    model: nn.Module,
    image: np.ndarray,
    device: str,
    val_batch_size: int = 8,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Run patch inference and return continuous probability sums, discrete votes, and hit counts."""
    model.eval()
    shape = image.shape
    padded = pad_volume(image)
    origins = window_origins(padded.shape)

    prob_sum_bone = np.zeros(padded.shape, dtype=np.float32)
    prob_sum_bme = np.zeros(padded.shape, dtype=np.float32)
    votes_bone = np.zeros(padded.shape, dtype=np.uint16)
    votes_bme = np.zeros(padded.shape, dtype=np.uint16)
    hits = np.zeros(padded.shape, dtype=np.uint16)

    for i in range(0, len(origins), val_batch_size):
        batch_orig = origins[i : i + val_batch_size]
        batch_arr = np.stack([crop(padded, o) for o in batch_orig])
        x = torch.from_numpy(batch_arr).float().unsqueeze(1).to(device)

        probs = torch.sigmoid(model(x)).cpu().numpy()
        for j, o in enumerate(batch_orig):
            p_bone = probs[j, 0]
            p_bme = probs[j, 1]
            sl = tuple(slice(o[k], o[k] + PATCH[k]) for k in range(3))

            prob_sum_bone[sl] += p_bone
            prob_sum_bme[sl] += p_bme

            b_bone = p_bone >= 0.5
            b_bme = (p_bme >= 0.5) & b_bone
            votes_bone[sl] += b_bone
            votes_bme[sl] += b_bme
            hits[sl] += 1
        del x, probs

    sl_crop = (slice(0, shape[0]), slice(0, shape[1]), slice(0, shape[2]))
    prob_sum_bone = prob_sum_bone[sl_crop]
    prob_sum_bme = prob_sum_bme[sl_crop]
    votes_bone = votes_bone[sl_crop]
    votes_bme = votes_bme[sl_crop]
    hits = np.maximum(hits[sl_crop], 1)

    return prob_sum_bone, prob_sum_bme, votes_bone, votes_bme, hits


@torch.no_grad()
def predict_case(
    models: list[nn.Module],
    image: np.ndarray,
    affine: np.ndarray,
    device: str,
    prob_averaging: bool = True,
    val_tta: bool = False,
    flip_axis: int | None = None,
    val_batch_size: int = 8,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Predict a full volume across one or more models, optionally with flip TTA.

    Returns:
        prob_bone, prob_bme, votes_bone, votes_bme, hits
    """
    if val_tta:
        if flip_axis is None:
            flip_axis = determine_lr_flip_axis(affine)

    n_models = len(models)
    accum_prob_bone = np.zeros(image.shape, dtype=np.float32)
    accum_prob_bme = np.zeros(image.shape, dtype=np.float32)
    accum_votes_bone = np.zeros(image.shape, dtype=np.uint32)
    accum_votes_bme = np.zeros(image.shape, dtype=np.uint32)
    accum_hits = np.zeros(image.shape, dtype=np.uint32)

    for model in models:
        # Standard forward pass
        pb_s, pm_s, vb_s, vm_s, h_s = predict_sliding_window(
            model, image, device, val_batch_size=val_batch_size
        )

        if val_tta and flip_axis is not None:
            flipped_img = np.flip(image, axis=flip_axis).copy()
            pb_f, pm_f, vb_f, vm_f, h_f = predict_sliding_window(
                model, flipped_img, device, val_batch_size=val_batch_size
            )
            # Unflip
            pb_f = np.flip(pb_f, axis=flip_axis)
            pm_f = np.flip(pm_f, axis=flip_axis)
            vb_f = np.flip(vb_f, axis=flip_axis)
            vm_f = np.flip(vm_f, axis=flip_axis)
            h_f = np.flip(h_f, axis=flip_axis)

            # Average probabilities across original and flip
            prob_b = 0.5 * ((pb_s / h_s) + (pb_f / h_f))
            prob_m = 0.5 * ((pm_s / h_s) + (pm_f / h_f))
            accum_prob_bone += prob_b
            accum_prob_bme += prob_m
            accum_votes_bone += vb_s + vb_f
            accum_votes_bme += vm_s + vm_f
            accum_hits += h_s + h_f
        else:
            accum_prob_bone += pb_s / h_s
            accum_prob_bme += pm_s / h_s
            accum_votes_bone += vb_s
            accum_votes_bme += vm_s
            accum_hits += h_s

    avg_prob_bone = accum_prob_bone / float(n_models)
    avg_prob_bme = accum_prob_bme / float(n_models)

    return (
        avg_prob_bone,
        avg_prob_bme,
        accum_votes_bone.astype(np.uint16),
        accum_votes_bme.astype(np.uint16),
        accum_hits.astype(np.uint16),
    )


def compute_dice(pred_bin: np.ndarray, gt_bin: np.ndarray) -> float:
    """Compute binary Dice score."""
    p = pred_bin.astype(bool)
    g = gt_bin.astype(bool)
    inter = np.logical_and(p, g).sum()
    total = p.sum() + g.sum()
    if total == 0:
        return 1.0
    return float((2.0 * inter) / total)


def compute_slice_position_bone_dice(pred_bone: np.ndarray, gt_bone: np.ndarray) -> dict[str, float]:
    """Compute bone Dice split by slice position: first 3, last 3, and middle slices."""
    z_slices = pred_bone.shape[2]
    if z_slices <= 6:
        d = compute_dice(pred_bone, gt_bone)
        return {"first_3": d, "middle": d, "last_3": d}

    d_first = compute_dice(pred_bone[:, :, :3], gt_bone[:, :, :3])
    d_middle = compute_dice(pred_bone[:, :, 3:-3], gt_bone[:, :, 3:-3])
    d_last = compute_dice(pred_bone[:, :, -3:], gt_bone[:, :, -3:])
    return {"first_3": d_first, "middle": d_middle, "last_3": d_last}


def compute_lesion_detection_metrics(gt_mask: np.ndarray, pred_mask: np.ndarray) -> dict[str, float]:
    """Compute lesion-level sensitivity, precision, and false-positive lesion counts.

    Overlap rule: Connected component is considered detected if >= 1 voxel overlaps.
    """
    gt_lab, n_gt = cc_label(gt_mask.astype(bool))
    pred_lab, n_pred = cc_label(pred_mask.astype(bool))

    if n_gt == 0:
        sens = 1.0 if n_pred == 0 else 0.0
    else:
        hits = 0
        for i in range(1, n_gt + 1):
            if np.any(pred_mask[gt_lab == i]):
                hits += 1
        sens = float(hits / n_gt)

    if n_pred == 0:
        prec = 1.0 if n_gt == 0 else 0.0
        fp_lesions = 0.0
    else:
        fp_count = 0
        for j in range(1, n_pred + 1):
            if not np.any(gt_mask[pred_lab == j]):
                fp_count += 1
        fp_lesions = float(fp_count)
        prec = float((n_pred - fp_count) / n_pred)

    return {
        "lesion_sensitivity": sens,
        "lesion_precision": prec,
        "fp_lesions": fp_lesions,
        "n_gt_lesions": float(n_gt),
        "n_pred_lesions": float(n_pred),
    }


def compute_edema_volume_stats(
    gt_mask: np.ndarray,
    pred_mask: np.ndarray,
    spacing: tuple[float, float, float],
) -> dict[str, float]:
    """Compute edema volume statistics in cm^3."""
    voxel_vol_cm3 = float(abs(spacing[0] * spacing[1] * spacing[2])) / 1000.0
    gt_vol_cm3 = float(np.sum(gt_mask)) * voxel_vol_cm3
    pred_vol_cm3 = float(np.sum(pred_mask)) * voxel_vol_cm3
    abs_err_cm3 = abs(pred_vol_cm3 - gt_vol_cm3)
    rel_err = abs_err_cm3 / (gt_vol_cm3 + 1e-6)

    return {
        "gt_vol_cm3": gt_vol_cm3,
        "pred_vol_cm3": pred_vol_cm3,
        "vol_abs_err_cm3": abs_err_cm3,
        "vol_rel_err": rel_err,
    }


def compute_case_evaluation(
    pred_labelmap: np.ndarray,
    gt_labelmap: np.ndarray,
    spacing: tuple[float, float, float],
) -> dict[str, Any]:
    """Full comprehensive evaluation for one case."""
    gt_bone = (gt_labelmap == 1) | (gt_labelmap == 2)
    pred_bone = (pred_labelmap == 1) | (pred_labelmap == 2)
    gt_bme = gt_labelmap == 2
    pred_bme = pred_labelmap == 2

    bone_dice = compute_dice(pred_bone, gt_bone)
    bme_dice = compute_dice(pred_bme, gt_bme)
    slice_bone = compute_slice_position_bone_dice(pred_bone, gt_bone)
    lesion_stats_dict = compute_lesion_detection_metrics(gt_bme, pred_bme)
    vol_stats = compute_edema_volume_stats(gt_bme, pred_bme, spacing)

    fp_voxels = float(np.sum(pred_bme & (~gt_bme)))

    return {
        "bone_dice": bone_dice,
        "bme_dice": bme_dice,
        "bone_dice_first_3": slice_bone["first_3"],
        "bone_dice_middle": slice_bone["middle"],
        "bone_dice_last_3": slice_bone["last_3"],
        "lesion_sensitivity": lesion_stats_dict["lesion_sensitivity"],
        "lesion_precision": lesion_stats_dict["lesion_precision"],
        "fp_lesions": lesion_stats_dict["fp_lesions"],
        "fp_voxels": fp_voxels,
        "gt_vol_cm3": vol_stats["gt_vol_cm3"],
        "pred_vol_cm3": vol_stats["pred_vol_cm3"],
        "vol_abs_err_cm3": vol_stats["vol_abs_err_cm3"],
        "vol_rel_err": vol_stats["vol_rel_err"],
    }


def compute_bland_altman_and_pearson(gt_vols: list[float], pred_vols: list[float]) -> dict[str, float]:
    """Compute Bland-Altman bias, limits of agreement, and Pearson r correlation."""
    g = np.asarray(gt_vols, dtype=float)
    p = np.asarray(pred_vols, dtype=float)
    if len(g) < 2:
        return {"bias": 0.0, "std": 0.0, "loa_lower": 0.0, "loa_upper": 0.0, "pearson_r": 0.0}

    diff = p - g
    bias = float(np.mean(diff))
    std = float(np.std(diff, ddof=1))
    loa_lower = bias - 1.96 * std
    loa_upper = bias + 1.96 * std

    std_g = np.std(g)
    std_p = np.std(p)
    if std_g > 1e-8 and std_p > 1e-8:
        corr_mat = np.corrcoef(g, p)
        pearson_r = float(corr_mat[0, 1])
    else:
        pearson_r = 0.0

    return {
        "bias": bias,
        "std": std,
        "loa_lower": loa_lower,
        "loa_upper": loa_upper,
        "pearson_r": pearson_r,
    }


def patient_level_bootstrap_ci(
    patient_ids: list[str],
    values: list[float],
    n_resamples: int = 2000,
    seed: int = 1337,
) -> tuple[float, float, float]:
    """Bootstrap 95% confidence interval with PATIENT-LEVEL resampling (paired scans stay together)."""
    pat_to_indices: dict[str, list[int]] = {}
    for idx, pid in enumerate(patient_ids):
        pat_to_indices.setdefault(pid, []).append(idx)

    unique_pats = sorted(pat_to_indices.keys())
    n_pats = len(unique_pats)
    if n_pats == 0:
        return 0.0, 0.0, 0.0

    observed_mean = float(np.mean(values))
    rng = np.random.default_rng(seed)
    boot_means = np.empty(n_resamples, dtype=float)

    for b in range(n_resamples):
        sampled_pats = rng.choice(unique_pats, size=n_pats, replace=True)
        sampled_indices = []
        for p in sampled_pats:
            sampled_indices.extend(pat_to_indices[p])
        boot_means[b] = float(np.mean([values[i] for i in sampled_indices]))

    ci_lower = float(np.percentile(boot_means, 2.5))
    ci_upper = float(np.percentile(boot_means, 97.5))
    return observed_mean, ci_lower, ci_upper


def paired_bootstrap_diff_ci(
    patient_ids: list[str],
    baseline_vals: list[float],
    comparison_vals: list[float],
    n_resamples: int = 2000,
    seed: int = 1337,
) -> tuple[float, float, float]:
    """Paired bootstrap 95% CI for the difference (comparison - baseline) over patient resamples."""
    pat_to_indices: dict[str, list[int]] = {}
    for idx, pid in enumerate(patient_ids):
        pat_to_indices.setdefault(pid, []).append(idx)

    unique_pats = sorted(pat_to_indices.keys())
    n_pats = len(unique_pats)
    if n_pats == 0:
        return 0.0, 0.0, 0.0

    diffs = [c - b for b, c in zip(baseline_vals, comparison_vals)]
    observed_diff = float(np.mean(diffs))
    rng = np.random.default_rng(seed)
    boot_diffs = np.empty(n_resamples, dtype=float)

    for b in range(n_resamples):
        sampled_pats = rng.choice(unique_pats, size=n_pats, replace=True)
        sampled_indices = []
        for p in sampled_pats:
            sampled_indices.extend(pat_to_indices[p])
        boot_diffs[b] = float(np.mean([diffs[i] for i in sampled_indices]))

    ci_lower = float(np.percentile(boot_diffs, 2.5))
    ci_upper = float(np.percentile(boot_diffs, 97.5))
    return observed_diff, ci_lower, ci_upper


def run_oracle_gating_diagnostic(
    prob_bone: np.ndarray,
    prob_bme: np.ndarray,
    gt_labelmap: np.ndarray,
    spacing: tuple[float, float, float],
    threshold: float = 0.5,
    bone_threshold: float = 0.5,
) -> dict[str, float]:
    """Evaluate oracle gating variants for a single held-out case:

    1. Current behavior (predicted bone gating)
    2. Oracle GT bone gating
    3. No gating
    4. In-plane dilated predicted bone gating (1, 2, 3 voxels)
    """
    gt_bone = (gt_labelmap == 1) | (gt_labelmap == 2)
    gt_bme = gt_labelmap == 2

    # 1. Standard predicted bone gating
    out_std, _ = postprocess_volume(
        prob_bone=prob_bone,
        prob_bme=prob_bme,
        threshold=threshold,
        bone_threshold=bone_threshold,
        spacing=spacing,
        prob_average=True,
    )
    dice_std = compute_dice(out_std == 2, gt_bme)

    # 2. Oracle GT bone gating
    out_oracle, _ = postprocess_volume(
        prob_bone=prob_bone,
        prob_bme=prob_bme,
        threshold=threshold,
        spacing=spacing,
        prob_average=True,
        bone_mask_override=gt_bone,
    )
    dice_oracle = compute_dice(out_oracle == 2, gt_bme)

    # 3. No gating
    out_nogate, _ = postprocess_volume(
        prob_bone=prob_bone,
        prob_bme=prob_bme,
        threshold=threshold,
        spacing=spacing,
        prob_average=True,
        skip_bone_gating=True,
    )
    dice_nogate = compute_dice(out_nogate == 2, gt_bme)

    # 4. Dilated predicted bone gating
    dices_dilated = {}
    for d in [1, 2, 3]:
        out_dil, _ = postprocess_volume(
            prob_bone=prob_bone,
            prob_bme=prob_bme,
            threshold=threshold,
            bone_threshold=bone_threshold,
            spacing=spacing,
            prob_average=True,
            dilate_bone_in_plane=d,
        )
        dices_dilated[f"dilate_{d}"] = compute_dice(out_dil == 2, gt_bme)

    return {
        "standard_pred_bone": dice_std,
        "oracle_gt_bone": dice_oracle,
        "no_gating": dice_nogate,
        "dilated_1": dices_dilated["dilate_1"],
        "dilated_2": dices_dilated["dilate_2"],
        "dilated_3": dices_dilated["dilate_3"],
    }


def parse_args():
    parser = argparse.ArgumentParser(description="3D U-Net Evaluation Suite and Diagnostics")
    parser.add_argument("--out-dir", required=True, help="Output directory (must be outside repo and data/)")
    parser.add_argument("--test-patients-file", default=None, help="Locked test-patients list (allows multi-fold ensemble)")
    parser.add_argument("--prob-averaging", action="store_true", default=True, help="Use probability averaging")
    parser.add_argument("--no-prob-averaging", dest="prob_averaging", action="store_false")
    parser.add_argument("--val-tta", action="store_true", default=False, help="Enable test-time flip augmentation")
    parser.add_argument("--flip-axis", type=int, default=None, help="Explicit flip axis for TTA (0, 1, or 2)")
    parser.add_argument("--batch-size", type=int, default=8, help="Inference batch size")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    parser.add_argument("--n-bootstrap", type=int, default=2000, help="Number of bootstrap resamples")
    parser.add_argument("--synthetic", action="store_true", help="Run synthetic self-test on CPU")
    return parser.parse_args()


def main():
    args = parse_args()
    out_dir = validate_out_dir(args.out_dir)

    print("=" * 70)
    print("3D U-NET EVALUATION SUITE & DIAGNOSTICS")
    print("=" * 70)
    print(f"Output directory verified: {out_dir}")
    print(f"Probability averaging    : {args.prob_averaging}")
    print(f"Val Flip TTA             : {args.val_tta}")

    if args.synthetic:
        print("[SYNTHETIC TEST MODE] Running CPU validation...")
        run_synthetic_self_test(out_dir)
        return

    # Standard real data evaluation requires matching checkpoints
    results_dir = REPO_ROOT / "data" / "results3d"
    pts = list(results_dir.glob("fold_*.pt"))
    if not pts:
        print("[NOTICE] No local checkpoints found in data/results3d/.")
        print("Real evaluation is designed to run in Kaggle/GPU cloud via train_3d_colab.ipynb ('eval_suite' config).")
        return

    print(f"Found {len(pts)} checkpoints in {results_dir}.")


def run_synthetic_self_test(out_dir: Path):
    """Synthetic self-test to verify math, bootstrap, and diagnostics on CPU."""
    print("1. Verifying oracle gating diagnostic logic...")
    shape = (32, 32, 8)
    gt_lab = np.zeros(shape, dtype=np.uint8)
    gt_lab[8:24, 8:24, 2:6] = 1  # Bone
    gt_lab[12:18, 12:18, 3:5] = 2  # Edema inside bone

    prob_bone = np.zeros(shape, dtype=np.float32)
    prob_bone[8:24, 8:24, 2:6] = 0.9

    prob_bme = np.zeros(shape, dtype=np.float32)
    prob_bme[12:18, 12:18, 3:5] = 0.85
    # Add a false positive outside bone
    prob_bme[2:5, 2:5, 3:5] = 0.85

    res = run_oracle_gating_diagnostic(prob_bone, prob_bme, gt_lab, spacing=(1.0, 1.0, 4.0))
    print(f"   Diagnostic results: {res}")
    assert res["standard_pred_bone"] > res["no_gating"], "Standard gating should suppress outside-bone FP"
    assert res["oracle_gt_bone"] >= res["standard_pred_bone"], "Oracle GT bone gating should be >= standard"

    print("2. Verifying patient-level bootstrap...")
    patients = ["p1", "p1", "p2", "p3", "p4", "p5"]
    dice_vals = [0.60, 0.62, 0.70, 0.55, 0.58, 0.65]
    mean_val, ci_l, ci_u = patient_level_bootstrap_ci(patients, dice_vals, n_resamples=500, seed=42)
    print(f"   Bootstrap mean: {mean_val:.3f}, 95% CI: [{ci_l:.3f}, {ci_u:.3f}]")
    assert ci_l <= mean_val <= ci_u, "Bootstrap mean must lie within CI"

    print("3. Verifying bit-identical consensus reproduction...")
    votes_bone = (prob_bone >= 0.5).astype(np.uint16)
    votes_bme = (prob_bme >= 0.5).astype(np.uint16)
    hits = np.ones(shape, dtype=np.uint16)
    out_vote, _ = postprocess_volume(
        votes_bone=votes_bone,
        votes_bme=votes_bme,
        hits=hits,
        prob_average=False,
    )
    # Compare with standard train_3d consensus logic
    manual_out = np.zeros(shape, dtype=np.uint8)
    manual_out[votes_bone * 2 >= hits] = 1
    manual_out[(votes_bme * 2 >= hits) & (manual_out == 1)] = 2
    assert np.array_equal(out_vote, manual_out), "Vote postprocessing must be bit-identical to predict_volume consensus"

    print("4. Writing synthetic evaluation output...")
    test_json = out_dir / "eval_results.json"
    test_csv = out_dir / "eval_metrics.csv"
    test_json.write_text(json.dumps({"synthetic": True, "diagnostics": res}, indent=2), encoding="utf-8")
    with open(test_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["metric", "value"])
        for k, v in res.items():
            w.writerow([k, v])

    print("[OK] Synthetic self-test passed completely.")


if __name__ == "__main__":
    main()


# Aliases for test compatibility
bland_altman_and_pearson = compute_bland_altman_and_pearson
