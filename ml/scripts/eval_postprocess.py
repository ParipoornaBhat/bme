"""Fair and reproducible evaluation of post-processing on existing 3D U-Net weights.

Workflow:
1. Loads existing 3D weights (data/results3d/fold_*.pt) and metrics.json.
2. In-sample leakage prevention: for each fold, predicts ONLY that fold's held-out cases.
3. Caches continuous probability volumes in a temporary directory outside the repo.
4. Evaluates:
   a. Baseline (binarize-then-vote consensus) to verify match against metrics.json.
   b. Soft probability averaging only (threshold=0.5, min_size=0).
   c. Grid search over threshold (0.5-0.8) and minimum component size (0-3000 mm^3).
   d. Fair nested cross-validation (tuned on 4 folds, evaluated on 5th held-out fold).
   e. Optimistic "tuned on everything" upper-bound.
5. Computes paired bootstrap 95% confidence intervals for Dice differences vs baseline.
6. Reports aggregate metrics and counts only (no case/patient identifiers).
"""

from __future__ import annotations

import argparse
import gc
import json
import random
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

# Ensure local imports
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
sys.path.insert(0, str(SCRIPT_DIR))

from postprocess import postprocess_volume  # noqa: E402
from train_3d import PATCH, UNet3D, crop, dice, lesion_stats, load_case, pad_volume, window_origins  # noqa: E402


def release():
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def predict_case_probabilities(
    model: nn.Module,
    image: np.ndarray,
    device: str,
    traced_model: torch.jit.ScriptModule | None = None,
    batch_size: int = 8,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Run sliding window inference and return both continuous probabilities and votes."""
    model.eval()
    shape = image.shape
    padded = pad_volume(image)
    origins = window_origins(padded.shape)

    prob_sum_bone = np.zeros(padded.shape, dtype=np.float32)
    prob_sum_bme = np.zeros(padded.shape, dtype=np.float32)
    votes_bone = np.zeros(padded.shape, dtype=np.uint16)
    votes_bme = np.zeros(padded.shape, dtype=np.uint16)
    hits = np.zeros(padded.shape, dtype=np.uint16)

    with torch.no_grad():
        for i in range(0, len(origins), batch_size):
            batch_origins = origins[i : i + batch_size]
            batch_patches = np.stack([crop(padded, o) for o in batch_origins])
            xt = torch.from_numpy(batch_patches).unsqueeze(1).float().to(device)

            if len(batch_origins) == batch_size and traced_model is not None:
                probs = torch.sigmoid(traced_model(xt)).cpu().numpy()
            else:
                probs = torch.sigmoid(model(xt)).cpu().numpy()

            for j, o in enumerate(batch_origins):
                sl = tuple(slice(o[k], o[k] + PATCH[k]) for k in range(3))
                p_b = probs[j, 0]
                p_e = probs[j, 1]

                # Continuous accumulation
                prob_sum_bone[sl] += p_b
                prob_sum_bme[sl] += p_e

                # Baseline discrete voting (binarize-then-vote)
                bone_vote = p_b >= 0.5
                bme_vote = (p_e >= 0.5) & bone_vote
                votes_bone[sl] += bone_vote
                votes_bme[sl] += bme_vote
                hits[sl] += 1

            del xt, probs

    # Crop padding
    prob_sum_bone = prob_sum_bone[: shape[0], : shape[1], : shape[2]]
    prob_sum_bme = prob_sum_bme[: shape[0], : shape[1], : shape[2]]
    votes_bone = votes_bone[: shape[0], : shape[1], : shape[2]]
    votes_bme = votes_bme[: shape[0], : shape[1], : shape[2]]
    hits = np.maximum(hits[: shape[0], : shape[1], : shape[2]], 1)

    # Normalized average continuous probabilities
    prob_bone = prob_sum_bone / hits
    prob_bme = prob_sum_bme / hits

    return prob_bone, prob_bme, votes_bone, votes_bme, hits


def evaluate_single_case(
    *,
    gt_labels: np.ndarray,
    spacing: tuple[float, float, float],
    prob_bone: np.ndarray | None = None,
    prob_bme: np.ndarray | None = None,
    votes_bone: np.ndarray | None = None,
    votes_bme: np.ndarray | None = None,
    hits: np.ndarray | None = None,
    threshold: float = 0.5,
    min_size_mm3: float = 0.0,
    prob_average: bool = True,
) -> dict:
    pred, n_removed = postprocess_volume(
        prob_bone=prob_bone,
        prob_bme=prob_bme,
        votes_bone=votes_bone,
        votes_bme=votes_bme,
        hits=hits,
        threshold=threshold,
        min_size_mm3=min_size_mm3,
        spacing=spacing,
        prob_average=prob_average,
    )

    bone_d = dice(gt_labels, pred, 1)
    bme_d = dice(gt_labels, pred, 2)
    sens, fp_lesions = lesion_stats(gt_labels, pred)
    fp_voxels = int(((pred == 2) & (gt_labels != 2)).sum())

    return {
        "bone_dice": bone_d,
        "bme_dice": bme_d,
        "lesion_sens": sens,
        "fp_lesions": fp_lesions,
        "fp_voxels": fp_voxels,
        "lesions_removed": n_removed,
    }


def aggregate_case_metrics(metrics_list: list[dict]) -> dict:
    keys = ["bone_dice", "bme_dice", "lesion_sens", "fp_lesions", "fp_voxels", "lesions_removed"]
    out = {}
    for k in keys:
        vals = [m[k] for m in metrics_list]
        arr = np.asarray(vals, dtype=float)
        out[k] = {
            "mean": float(np.mean(arr)),
            "std": float(np.std(arr, ddof=1)) if len(arr) > 1 else 0.0,
        }
    return out


def compute_paired_bootstrap(
    baseline_dices: list[float],
    comparison_dices: list[float],
    n_boot: int = 2000,
    seed: int = 1337,
) -> tuple[float, float, float]:
    """Computes paired bootstrap difference and 95% CI."""
    b_arr = np.asarray(baseline_dices, dtype=float)
    c_arr = np.asarray(comparison_dices, dtype=float)
    diffs = c_arr - b_arr
    observed_mean_diff = float(np.mean(diffs))

    rng = np.random.default_rng(seed)
    n = len(diffs)
    boot_means = np.empty(n_boot, dtype=float)
    for i in range(n_boot):
        indices = rng.integers(0, n, size=n)
        boot_means[i] = float(np.mean(diffs[indices]))

    ci_lower = float(np.percentile(boot_means, 2.5))
    ci_upper = float(np.percentile(boot_means, 97.5))
    return observed_mean_diff, ci_lower, ci_upper


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--bootstrap-samples", type=int, default=2000)
    args = parser.parse_args()

    # Determine device
    device = "cuda" if (args.device == "cuda" or (args.device == "auto" and torch.cuda.is_available())) else "cpu"
    print(f"[PREFLIGHT] Inference device: {device}", flush=True)

    # Locate results and metrics
    results_dir = REPO_ROOT / "data" / "results3d"
    metrics_path = results_dir / "metrics.json"
    if not metrics_path.exists():
        raise SystemExit(f"Missing metrics.json at {metrics_path}")

    metrics_json = json.loads(metrics_path.read_text(encoding="utf-8"))
    folds_data = metrics_json.get("per_fold", [])
    if not folds_data:
        raise SystemExit("No per_fold data found in metrics.json")

    # Locate dataset
    staging_dir = Path.home() / ".kaggle_bme_staging"
    if not staging_dir.exists():
        staging_dir = REPO_ROOT

    total_cases = sum(len(f["val"]) for f in folds_data)
    print(f"[PREFLIGHT] Found {len(folds_data)} folds with {total_cases} held-out cases total.", flush=True)

    # Use a secure temporary directory outside the repository for probability caching
    temp_obj = tempfile.TemporaryDirectory(prefix="bme_postprocess_")
    temp_dir = Path(temp_obj.name)
    print(f"[CACHE] Caching continuous probability volumes in external temp directory: {temp_dir}", flush=True)

    case_records = []
    case_counter = 0

    try:
        t_start = time.time()
        for f_idx, fold_info in enumerate(folds_data):
            fold_num = fold_info["fold"]
            val_cases = fold_info["val"]
            model_path = results_dir / f"fold_{fold_num}.pt"
            if not model_path.exists():
                raise SystemExit(f"Model file missing: {model_path}")

            print(f"\n[INFERENCE] Processing Fold {fold_num} ({len(val_cases)} held-out cases)...", flush=True)
            model = UNet3D().to(device)
            blob = torch.load(model_path, map_location=device, weights_only=False)
            model.load_state_dict(blob["state"])
            model.eval()

            # Create traced model for batch_size speedup
            traced_model = None
            try:
                dummy_input = torch.randn(args.batch_size, 1, *PATCH, device=device)
                traced_model = torch.jit.trace(model, dummy_input)
            except Exception as e:
                print(f"  (Tracing skipped: {e})", flush=True)

            for case_idx, cid in enumerate(val_cases, 1):
                case_counter += 1
                loaded = load_case(staging_dir, cid)
                if not loaded:
                    raise SystemExit(f"Failed to load case data for fold {fold_num} (index {case_idx})")

                prob_bone, prob_bme, votes_bone, votes_bme, hits = predict_case_probabilities(
                    model=model,
                    image=loaded["image"],
                    device=device,
                    traced_model=traced_model,
                    batch_size=args.batch_size,
                )

                cache_file = temp_dir / f"case_{case_counter:03d}.npz"
                np.savez_compressed(
                    cache_file,
                    prob_bone=prob_bone.astype(np.float16),
                    prob_bme=prob_bme.astype(np.float16),
                    votes_bone=votes_bone.astype(np.uint16),
                    votes_bme=votes_bme.astype(np.uint16),
                    hits=hits.astype(np.uint16),
                    gt=loaded["labels"].astype(np.uint8),
                    spacing=np.asarray(loaded["spacing"], dtype=np.float32),
                    fold=fold_num,
                )

                case_records.append({
                    "case_num": case_counter,
                    "fold": fold_num,
                    "cache_file": cache_file,
                })

                print(f"  Fold {fold_num}: evaluated case {case_idx}/{len(val_cases)} [Total: {case_counter}/{total_cases}]", flush=True)
                del loaded, prob_bone, prob_bme, votes_bone, votes_bme, hits
                release()

            del model, traced_model
            release()

        inference_time = time.time() - t_start
        print(f"\n[CACHE COMPLETE] Inferred and cached all {len(case_records)} cases in {inference_time:.1f}s.", flush=True)

        # --- PREPARE DATA STRUCTURES FOR GRID & BASELINE ---
        thresholds = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80]
        min_sizes_mm3 = [0.0, 100.0, 250.0, 500.0, 1000.0, 2000.0, 3000.0]

        print("\n[EVALUATION] Streaming cached cases from disk to evaluate baseline, soft averaging, and grid search...", flush=True)
        baseline_case_metrics = []
        soft_case_metrics = []
        grid_eval: dict[tuple[float, float], list[dict]] = {(t, s): [] for t in thresholds for s in min_sizes_mm3}

        for r_idx, r in enumerate(case_records, 1):
            with np.load(r["cache_file"]) as d:
                fold_num = int(d["fold"])
                gt = d["gt"]
                spacing = tuple(float(s) for s in d["spacing"])
                vox_vol = float(abs(spacing[0] * spacing[1] * spacing[2]))

                # 1. Baseline
                base_m = evaluate_single_case(
                    gt_labels=gt,
                    spacing=spacing,
                    votes_bone=d["votes_bone"],
                    votes_bme=d["votes_bme"],
                    hits=d["hits"],
                    prob_average=False,
                )
                base_m["fold"] = fold_num
                baseline_case_metrics.append(base_m)

                # 2. Soft probability averaging only (t=0.5, s=0)
                soft_m = evaluate_single_case(
                    gt_labels=gt,
                    spacing=spacing,
                    prob_bone=d["prob_bone"],
                    prob_bme=d["prob_bme"],
                    threshold=0.5,
                    min_size_mm3=0.0,
                    prob_average=True,
                )
                soft_m["fold"] = fold_num
                soft_case_metrics.append(soft_m)

                # 3. Fast grid evaluation for this case
                prob_bone = d["prob_bone"]
                prob_bme = d["prob_bme"]
                bone_mask = prob_bone >= 0.5
                bone_d = dice(gt, bone_mask.astype(np.uint8), 1)

                for t in thresholds:
                    bme_raw = (prob_bme >= t) & bone_mask
                    if not bme_raw.any():
                        empty_m = {
                            "bone_dice": bone_d,
                            "bme_dice": 0.0 if (gt == 2).any() else 1.0,
                            "lesion_sens": 0.0 if (gt == 2).any() else 1.0,
                            "fp_lesions": 0.0,
                            "fp_voxels": 0,
                            "lesions_removed": 0,
                            "fold": fold_num,
                        }
                        for s in min_sizes_mm3:
                            grid_eval[(t, s)].append(empty_m)
                        continue

                    labeled_bme, num_comp = cc_label(bme_raw)
                    counts = np.bincount(labeled_bme.ravel())
                    comp_vols = counts[1:] * vox_vol

                    for s in min_sizes_mm3:
                        if s == 0.0:
                            bme_curr = bme_raw
                            n_rem = 0
                        else:
                            keep = np.zeros(num_comp + 1, dtype=bool)
                            keep[1:] = comp_vols >= s
                            bme_curr = keep[labeled_bme]
                            n_rem = int((comp_vols < s).sum())

                        pred_curr = np.zeros_like(gt, dtype=np.uint8)
                        pred_curr[bone_mask] = 1
                        pred_curr[bme_curr] = 2

                        bme_d_val = dice(gt, pred_curr, 2)
                        sens_val, fp_les_val = lesion_stats(gt, pred_curr)
                        fp_vox_val = int(((pred_curr == 2) & (gt != 2)).sum())

                        grid_eval[(t, s)].append({
                            "bone_dice": bone_d,
                            "bme_dice": bme_d_val,
                            "lesion_sens": sens_val,
                            "fp_lesions": fp_les_val,
                            "fp_voxels": fp_vox_val,
                            "lesions_removed": n_rem,
                            "fold": fold_num,
                        })

            if r_idx % 10 == 0 or r_idx == len(case_records):
                print(f"  Grid evaluated on {r_idx}/{len(case_records)} cases...", flush=True)
                release()

        # Verify against metrics.json fold by fold
        baseline_fold_metrics = []
        for f_idx in range(len(folds_data)):
            f_cases = [m for m in baseline_case_metrics if m["fold"] == f_idx]
            bone_mean = float(np.mean([m["bone_dice"] for m in f_cases]))
            bme_mean = float(np.mean([m["bme_dice"] for m in f_cases]))
            sens_mean = float(np.mean([m["lesion_sens"] for m in f_cases]))
            fp_mean = float(np.mean([m["fp_lesions"] for m in f_cases]))
            baseline_fold_metrics.append({
                "fold": f_idx,
                "bone_dice": bone_mean,
                "bme_dice": bme_mean,
                "lesion_sens": sens_mean,
                "fp_lesions": fp_mean,
                "fp_voxels": float(np.mean([m["fp_voxels"] for m in f_cases])),
                "n_cases": len(f_cases),
            })

            expected = folds_data[f_idx]
            print(f"Fold {f_idx} (N={len(f_cases)} cases):")
            print(f"  Bone Dice:    Recomputed={bone_mean:.4f} | Target={expected['bone_dice']:.4f} | Diff={abs(bone_mean - expected['bone_dice']):.6f}")
            print(f"  BME Dice:     Recomputed={bme_mean:.4f} | Target={expected['bme_dice']:.4f} | Diff={abs(bme_mean - expected['bme_dice']):.6f}")
            print(f"  Sensitivity:  Recomputed={sens_mean:.4f} | Target={expected['lesion_sensitivity']:.4f} | Diff={abs(sens_mean - expected['lesion_sensitivity']):.6f}")
            print(f"  FP Lesions:   Recomputed={fp_mean:.1f} | Target={expected['fp_per_case']:.1f} | Diff={abs(fp_mean - expected['fp_per_case']):.3f}")

            if abs(bme_mean - expected["bme_dice"]) > 0.005:
                raise SystemExit(f"CRITICAL MISMATCH on Fold {f_idx}: difference exceeds tolerance!")

        base_bme_mean = float(np.mean([f["bme_dice"] for f in baseline_fold_metrics]))
        base_bme_std = float(np.std([f["bme_dice"] for f in baseline_fold_metrics], ddof=1))
        base_bone_mean = float(np.mean([f["bone_dice"] for f in baseline_fold_metrics]))
        base_bone_std = float(np.std([f["bone_dice"] for f in baseline_fold_metrics], ddof=1))
        base_sens_mean = float(np.mean([f["lesion_sens"] for f in baseline_fold_metrics]))
        base_sens_std = float(np.std([f["lesion_sens"] for f in baseline_fold_metrics], ddof=1))
        base_fp_les_mean = float(np.mean([f["fp_lesions"] for f in baseline_fold_metrics]))
        base_fp_les_std = float(np.std([f["fp_lesions"] for f in baseline_fold_metrics], ddof=1))
        base_fp_vox_mean = float(np.mean([f["fp_voxels"] for f in baseline_fold_metrics]))
        base_fp_vox_std = float(np.std([f["fp_voxels"] for f in baseline_fold_metrics], ddof=1))

        print("\nBaseline Summary across 5 folds:")
        print(f"  Bone Dice:          {base_bone_mean:.4f} +/- {base_bone_std:.4f}")
        print(f"  BME Dice:           {base_bme_mean:.4f} +/- {base_bme_std:.4f}")
        print(f"  Lesion Sensitivity: {base_sens_mean:.4f} +/- {base_sens_std:.4f}")
        print(f"  FP Lesions / case:  {base_fp_les_mean:.1f} +/- {base_fp_les_std:.1f}")
        print(f"  FP Voxels / case:   {base_fp_vox_mean:.1f} +/- {base_fp_vox_std:.1f}")

        # --- B. SOFT PROBABILITY AVERAGING ONLY (T=0.5, S=0) ---
        print("\n" + "=" * 70)
        print("STEP 3B: SOFT PROBABILITY AVERAGING ONLY (Threshold=0.5, Min Size=0)")
        print("=" * 70)
        soft_case_metrics = []
        for c in cached_data:
            m = evaluate_single_case(
                gt_labels=c["gt"],
                spacing=c["spacing"],
                prob_bone=c["prob_bone"],
                prob_bme=c["prob_bme"],
                threshold=0.5,
                min_size_mm3=0.0,
                prob_average=True,
            )
            m["fold"] = c["fold"]
            soft_case_metrics.append(m)

        soft_fold_metrics = []
        for f_idx in range(len(folds_data)):
            f_cases = [m for m in soft_case_metrics if m["fold"] == f_idx]
            soft_fold_metrics.append({
                "fold": f_idx,
                "bone_dice": float(np.mean([m["bone_dice"] for m in f_cases])),
                "bme_dice": float(np.mean([m["bme_dice"] for m in f_cases])),
                "lesion_sens": float(np.mean([m["lesion_sens"] for m in f_cases])),
                "fp_lesions": float(np.mean([m["fp_lesions"] for m in f_cases])),
                "fp_voxels": float(np.mean([m["fp_voxels"] for m in f_cases])),
            })

        soft_bme_mean = float(np.mean([f["bme_dice"] for f in soft_fold_metrics]))
        soft_bme_std = float(np.std([f["bme_dice"] for f in soft_fold_metrics], ddof=1))
        soft_bone_mean = float(np.mean([f["bone_dice"] for f in soft_fold_metrics]))
        soft_bone_std = float(np.std([f["bone_dice"] for f in soft_fold_metrics], ddof=1))
        soft_sens_mean = float(np.mean([f["lesion_sens"] for f in soft_fold_metrics]))
        soft_sens_std = float(np.std([f["lesion_sens"] for f in soft_fold_metrics], ddof=1))
        soft_fp_vox_mean = float(np.mean([f["fp_voxels"] for f in soft_fold_metrics]))
        soft_fp_vox_std = float(np.std([f["fp_voxels"] for f in soft_fold_metrics], ddof=1))

        # Bootstrap for soft probability averaging vs baseline
        b_dices = [m["bme_dice"] for m in baseline_case_metrics]
        s_dices = [m["bme_dice"] for m in soft_case_metrics]
        soft_diff, soft_ci_lo, soft_ci_hi = compute_paired_bootstrap(
            b_dices, s_dices, n_boot=args.bootstrap_samples
        )

        print(f"  Bone Dice:          {soft_bone_mean:.4f} +/- {soft_bone_std:.4f}")
        print(f"  BME Dice:           {soft_bme_mean:.4f} +/- {soft_bme_std:.4f}")
        print(f"  Lesion Sensitivity: {soft_sens_mean:.4f} +/- {soft_sens_std:.4f}")
        print(f"  FP Voxels / case:   {soft_fp_vox_mean:.1f} +/- {soft_fp_vox_std:.1f}")
        print(f"  Paired BME Dice Difference vs Baseline: {soft_diff:+.4f} (95% CI: [{soft_ci_lo:+.4f}, {soft_ci_hi:+.4f}])")

        # --- C. GRID SEARCH OVER THRESHOLD & MINIMUM SIZE ---
        print("\n" + "=" * 70)
        print("STEP 3C: GRID SEARCH (Threshold 0.5-0.8, Min Size 0-3000 mm^3)")
        print("=" * 70)
        thresholds = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80]
        min_sizes_mm3 = [0.0, 100.0, 250.0, 500.0, 1000.0, 2000.0, 3000.0]

        # Evaluate all combinations across all cases and cache case-level metrics
        # grid_results[(t, s)][case_idx] = metrics_dict
        grid_eval: dict[tuple[float, float], list[dict]] = {}
        for t in thresholds:
            for s in min_sizes_mm3:
                case_res = []
                for c in cached_data:
                    m = evaluate_single_case(
                        gt_labels=c["gt"],
                        spacing=c["spacing"],
                        prob_bone=c["prob_bone"],
                        prob_bme=c["prob_bme"],
                        threshold=t,
                        min_size_mm3=s,
                        prob_average=True,
                    )
                    m["fold"] = c["fold"]
                    case_res.append(m)
                grid_eval[(t, s)] = case_res

        # --- D. FAIR NESTED CROSS-VALIDATION SELECTION ---
        print("\n" + "=" * 70)
        print("STEP 4: FAIR NESTED CROSS-VALIDATION (Tuned on 4 folds, evaluated on held-out fold)")
        print("=" * 70)
        nested_held_out_metrics = []
        nested_selections = []

        for val_f in range(len(folds_data)):
            # Select best (t, s) on the other 4 folds
            best_pair = (0.50, 0.0)
            best_train_bme = -1.0
            for t in thresholds:
                for s in min_sizes_mm3:
                    # Filter cases from folds != val_f
                    train_cases = [m for m in grid_eval[(t, s)] if m["fold"] != val_f]
                    # Compute mean fold BME Dice across the 4 training folds
                    fold_scores = []
                    for train_f in range(len(folds_data)):
                        if train_f == val_f:
                            continue
                        f_pts = [m["bme_dice"] for m in train_cases if m["fold"] == train_f]
                        fold_scores.append(np.mean(f_pts))
                    train_score = float(np.mean(fold_scores))
                    if train_score > best_train_bme:
                        best_train_bme = train_score
                        best_pair = (t, s)

            # Apply best_pair to held-out fold val_f
            t_sel, s_sel = best_pair
            val_cases = [m for m in grid_eval[(t_sel, s_sel)] if m["fold"] == val_f]
            nested_held_out_metrics.extend(val_cases)
            nested_selections.append({
                "fold": val_f,
                "selected_threshold": t_sel,
                "selected_min_size_mm3": s_sel,
                "train_bme_dice": best_train_bme,
                "test_bme_dice": float(np.mean([m["bme_dice"] for m in val_cases])),
                "test_bone_dice": float(np.mean([m["bone_dice"] for m in val_cases])),
                "test_sens": float(np.mean([m["lesion_sens"] for m in val_cases])),
                "test_fp_voxels": float(np.mean([m["fp_voxels"] for m in val_cases])),
                "test_removed": float(np.mean([m["lesions_removed"] for m in val_cases])),
            })

            print(f"Fold {val_f}: selected threshold={t_sel:.2f}, min_size={s_sel:.0f} mm^3 (4-fold train BME Dice={best_train_bme:.4f}) -> Held-out BME Dice={nested_selections[-1]['test_bme_dice']:.4f}")

        # Summary of Nested Cross-Validation
        ncv_bme_mean = float(np.mean([s["test_bme_dice"] for s in nested_selections]))
        ncv_bme_std = float(np.std([s["test_bme_dice"] for s in nested_selections], ddof=1))
        ncv_bone_mean = float(np.mean([s["test_bone_dice"] for s in nested_selections]))
        ncv_bone_std = float(np.std([s["test_bone_dice"] for s in nested_selections], ddof=1))
        ncv_sens_mean = float(np.mean([s["test_sens"] for s in nested_selections]))
        ncv_sens_std = float(np.std([s["test_sens"] for s in nested_selections], ddof=1))
        ncv_fp_vox_mean = float(np.mean([s["test_fp_voxels"] for s in nested_selections]))
        ncv_fp_vox_std = float(np.std([s["test_fp_voxels"] for s in nested_selections], ddof=1))
        ncv_rem_mean = float(np.mean([s["test_removed"] for s in nested_selections]))
        ncv_rem_std = float(np.std([s["test_removed"] for s in nested_selections], ddof=1))

        # Bootstrap for Nested CV vs baseline
        ncv_dices = [m["bme_dice"] for m in nested_held_out_metrics]
        ncv_diff, ncv_ci_lo, ncv_ci_hi = compute_paired_bootstrap(
            b_dices, ncv_dices, n_boot=args.bootstrap_samples
        )

        print("\nNested Cross-Validation Overall Results:")
        print(f"  Bone Dice:          {ncv_bone_mean:.4f} +/- {ncv_bone_std:.4f}")
        print(f"  BME Dice:           {ncv_bme_mean:.4f} +/- {ncv_bme_std:.4f}")
        print(f"  Lesion Sensitivity: {ncv_sens_mean:.4f} +/- {ncv_sens_std:.4f}")
        print(f"  FP Voxels / case:   {ncv_fp_vox_mean:.1f} +/- {ncv_fp_vox_std:.1f}")
        print(f"  Lesions Removed / c:{ncv_rem_mean:.1f} +/- {ncv_rem_std:.1f}")
        print(f"  Paired BME Dice Difference vs Baseline: {ncv_diff:+.4f} (95% CI: [{ncv_ci_lo:+.4f}, {ncv_ci_hi:+.4f}])")

        # --- E. OPTIMISTIC ("TUNED ON EVERYTHING") EVALUATION ---
        print("\n" + "=" * 70)
        print("STEP 4B: OPTIMISTIC TUNING (Tuned on all 61 cases directly)")
        print("=" * 70)
        best_opt_pair = (0.50, 0.0)
        best_opt_bme = -1.0
        for t in thresholds:
            for s in min_sizes_mm3:
                all_cases = grid_eval[(t, s)]
                fold_means = [np.mean([m["bme_dice"] for m in all_cases if m["fold"] == f_idx]) for f_idx in range(len(folds_data))]
                mean_bme = float(np.mean(fold_means))
                if mean_bme > best_opt_bme:
                    best_opt_bme = mean_bme
                    best_opt_pair = (t, s)

        opt_t, opt_s = best_opt_pair
        opt_cases = grid_eval[(opt_t, opt_s)]
        opt_fold_metrics = []
        for f_idx in range(len(folds_data)):
            f_cases = [m for m in opt_cases if m["fold"] == f_idx]
            opt_fold_metrics.append({
                "fold": f_idx,
                "bone_dice": float(np.mean([m["bone_dice"] for m in f_cases])),
                "bme_dice": float(np.mean([m["bme_dice"] for m in f_cases])),
                "lesion_sens": float(np.mean([m["lesion_sens"] for m in f_cases])),
                "fp_voxels": float(np.mean([m["fp_voxels"] for m in f_cases])),
                "lesions_removed": float(np.mean([m["lesions_removed"] for m in f_cases])),
            })

        opt_bme_mean = float(np.mean([f["bme_dice"] for f in opt_fold_metrics]))
        opt_bme_std = float(np.std([f["bme_dice"] for f in opt_fold_metrics], ddof=1))
        opt_bone_mean = float(np.mean([f["bone_dice"] for f in opt_fold_metrics]))
        opt_bone_std = float(np.std([f["bone_dice"] for f in opt_fold_metrics], ddof=1))
        opt_sens_mean = float(np.mean([f["lesion_sens"] for f in opt_fold_metrics]))
        opt_sens_std = float(np.std([f["lesion_sens"] for f in opt_fold_metrics], ddof=1))
        opt_fp_vox_mean = float(np.mean([f["fp_voxels"] for f in opt_fold_metrics]))
        opt_fp_vox_std = float(np.std([f["fp_voxels"] for f in opt_fold_metrics], ddof=1))
        opt_rem_mean = float(np.mean([f["lesions_removed"] for f in opt_fold_metrics]))
        opt_rem_std = float(np.std([f["lesions_removed"] for f in opt_fold_metrics], ddof=1))

        # Bootstrap for Optimistic vs baseline
        opt_dices = [m["bme_dice"] for m in opt_cases]
        opt_diff, opt_ci_lo, opt_ci_hi = compute_paired_bootstrap(
            b_dices, opt_dices, n_boot=args.bootstrap_samples
        )

        print(f"Best Optimistic Configuration: threshold={opt_t:.2f}, min_size={opt_s:.0f} mm^3")
        print(f"  Bone Dice:          {opt_bone_mean:.4f} +/- {opt_bone_std:.4f}")
        print(f"  BME Dice:           {opt_bme_mean:.4f} +/- {opt_bme_std:.4f}")
        print(f"  Lesion Sensitivity: {opt_sens_mean:.4f} +/- {opt_sens_std:.4f}")
        print(f"  FP Voxels / case:   {opt_fp_vox_mean:.1f} +/- {opt_fp_vox_std:.1f}")
        print(f"  Lesions Removed / c:{opt_rem_mean:.1f} +/- {opt_rem_std:.1f}")
        print(f"  Paired BME Dice Difference vs Baseline: {opt_diff:+.4f} (95% CI: [{opt_ci_lo:+.4f}, {opt_ci_hi:+.4f}])")

        # Top 5 grid configurations across all 61 cases
        print("\n" + "=" * 70)
        print("TOP 5 GRID CONFIGURATIONS (Full Dataset Average):")
        print("=" * 70)
        grid_ranks = []
        for (t, s), cases in grid_eval.items():
            f_means = [np.mean([m["bme_dice"] for m in cases if m["fold"] == f_idx]) for f_idx in range(len(folds_data))]
            grid_ranks.append(((t, s), float(np.mean(f_means)), float(np.std(f_means, ddof=1))))
        grid_ranks.sort(key=lambda x: x[1], reverse=True)
        for rank, ((t, s), mean_b, std_b) in enumerate(grid_ranks[:5], 1):
            print(f"  {rank}. Threshold={t:.2f}, MinSize={s:4.0f} mm^3 -> BME Dice: {mean_b:.4f} +/- {std_b:.4f}")

    finally:
        # Guarantee cleanup of external temporary directory
        temp_obj.cleanup()
        print(f"\n[CLEANUP] Temporary directory {temp_dir} successfully deleted.", flush=True)


if __name__ == "__main__":
    main()
