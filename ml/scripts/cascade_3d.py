#!/usr/bin/env python3
"""Two-Stage Cascaded 3D Network (Option B) for Whole-Joint Context & Precision Refinement.

Stage 1: Global Context Net (GlobalContextNet3D) on full-volume downsampled MRI (128x128x32).
         Predicts whole-joint coarse Bone & BME probability heatmaps.
Stage 2: High-Resolution Refiner (OrthoGateMedNeXt3D, in_channels=2).
         Takes high-res MRI patch + Stage 1 coarse guidance map and refines boundary contours
         with 3D Boundary Loss and Subchondral Dilation Gating.

Experiment isolation: By default saves all checkpoints and metrics strictly under
data/results3d_experiments/cascade_*, leaving active production weights in data/results3d untouched.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
ML_SCRIPTS = REPO_ROOT / "ml" / "scripts"
if str(ML_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(ML_SCRIPTS))

from train_3d import (  # noqa: E402
    GlobalContextNet3D,
    OrthoGateMedNeXt3D,
    SEED,
    PATCH,
    compute_sdf_3d,
    crop,
    dice,
    dice_focal,
    guard_device,
    lesion_stats,
    load_case,
    load_worklist_metadata,
    pad_volume,
    rates,
    sample_origin,
    targets,
)


STAGE1_GRID = (32, 128, 128)  # D, H, W for downsampled whole-joint scan


def downsample_volume_3d(img: np.ndarray, target_shape=STAGE1_GRID) -> np.ndarray:
    """Downsample a full 3D volume to fixed global context grid."""
    t = torch.from_numpy(img.astype(np.float32)).unsqueeze(0).unsqueeze(0)  # [1, 1, D, H, W]
    out = F.interpolate(t, size=target_shape, mode="trilinear", align_corners=False)
    return out.squeeze().numpy().astype(np.float32)


def downsample_labels_3d(lab: np.ndarray, target_shape=STAGE1_GRID) -> np.ndarray:
    """Downsample a 3D labelmap with nearest neighbor interpolation."""
    t = torch.from_numpy(lab.astype(np.float32)).unsqueeze(0).unsqueeze(0)
    out = F.interpolate(t, size=target_shape, mode="nearest")
    return out.squeeze().numpy().astype(np.uint8)


def upsample_guidance_to_original(guidance_small: torch.Tensor, original_shape: tuple[int, int, int]) -> torch.Tensor:
    """Upsample coarse Stage 1 probability heatmap back to original volume grid."""
    # guidance_small: [1, 1, D_small, H_small, W_small]
    return F.interpolate(guidance_small, size=original_shape, mode="trilinear", align_corners=False)


def train_stage1_fold(
    cases_train: list[dict],
    cases_val: list[dict],
    fold: int,
    epochs: int,
    device: str,
    out_dir: Path,
    use_amp: bool = True,
) -> dict:
    """Train Stage 1 Global Context Network for one fold."""
    print(f"\n[STAGE 1] --- Fold {fold}: Training GlobalContextNet3D on whole-knee grid {STAGE1_GRID} ---", flush=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    model = GlobalContextNet3D(base_channels=16, aniso=True, norm_type="group", in_channels=1).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    scaler = torch.amp.GradScaler("cuda") if (use_amp and "cuda" in device) else None

    # Pre-downsample volumes to avoid repeated interpolation
    print(f"[STAGE 1] Downsampling {len(cases_train)} train and {len(cases_val)} val volumes...", flush=True)
    train_data = []
    for c in cases_train:
        d_img = downsample_volume_3d(c["image"])
        d_lab = downsample_labels_3d(c["labels"])
        train_data.append((d_img, d_lab, c["bme_voxels"] > 0))

    val_data = []
    for c in cases_val:
        d_img = downsample_volume_3d(c["image"])
        d_lab = downsample_labels_3d(c["labels"])
        val_data.append((d_img, d_lab, c["id"], c["labels"].shape))

    best_loss = float("inf")
    ckpt_path = out_dir / f"stage1_fold_{fold}.pt"

    for epoch in range(1, epochs + 1):
        model.train()
        random.shuffle(train_data)
        total_loss = 0.0

        for d_img, d_lab, has_bme in train_data:
            opt.zero_grad(set_to_none=True)
            x = torch.from_numpy(d_img).unsqueeze(0).unsqueeze(0).to(device)  # [1, 1, 32, 128, 128]
            y = torch.from_numpy(d_lab).to(device)
            cnet_gt = torch.tensor([1.0 if has_bme else 0.0], device=device)

            amp_ctx = torch.amp.autocast("cuda") if (use_amp and "cuda" in device) else torch.nullcontext()
            with amp_ctx:
                logits, cnet_logit = model(x, return_cnet=True)
                tgt, valid = targets(y)
                loss_seg = dice_focal(logits[0], tgt, valid, bme_weight=2.5, tversky_alpha=0.3, tversky_beta=0.7)
                loss_cnet = F.binary_cross_entropy_with_logits(cnet_logit.view(-1), cnet_gt)
                loss = loss_seg + 0.5 * loss_cnet

            if scaler:
                scaler.scale(loss).backward()
                scaler.unscale_(opt)
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                scaler.step(opt)
                scaler.update()
            else:
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                opt.step()

            total_loss += loss.item()

        avg_loss = total_loss / max(1, len(train_data))
        if epoch % 5 == 0 or epoch == epochs or epoch == 1:
            print(f"  [Stage 1 - Fold {fold}] Epoch {epoch}/{epochs} | Loss: {avg_loss:.4f}", flush=True)

    torch.save({"state": model.state_dict(), "grid": list(STAGE1_GRID), "fold": fold}, ckpt_path)
    print(f"[STAGE 1] Saved Stage 1 model to {ckpt_path}", flush=True)
    return {"fold": fold, "loss": avg_loss, "ckpt": str(ckpt_path)}


def generate_guidance_cache(
    model: nn.Module,
    cases: list[dict],
    device: str,
) -> dict[str, np.ndarray]:
    """Generates coarse Stage 1 probability heatmap for each case."""
    model.eval()
    guidance_map = {}
    with torch.no_grad():
        for c in cases:
            d_img = downsample_volume_3d(c["image"])
            x = torch.from_numpy(d_img).unsqueeze(0).unsqueeze(0).to(device)
            logits, cnet_logit = model(x, return_cnet=True)
            cnet_p = torch.sigmoid(cnet_logit).item()

            # BME coarse probability channel
            bme_p_small = torch.sigmoid(logits[:, 1:2]) * cnet_p
            # Upsample back to original case volume shape
            bme_guidance = F.interpolate(bme_p_small, size=c["image"].shape, mode="trilinear", align_corners=False)
            guidance_map[c["id"]] = bme_guidance.squeeze().cpu().numpy().astype(np.float32)
    return guidance_map


def train_stage2_fold(
    cases_train: list[dict],
    cases_val: list[dict],
    guidance_cache: dict[str, np.ndarray],
    fold: int,
    epochs: int,
    device: str,
    out_dir: Path,
    use_amp: bool = True,
    patch: tuple[int, int, int] = PATCH,
) -> dict:
    """Train Stage 2 Refiner (OrthoGateMedNeXt3D with in_channels=2)."""
    print(f"\n[STAGE 2] --- Fold {fold}: Training Cascaded Refiner (in_channels=2) ---", flush=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    model = OrthoGateMedNeXt3D(base_channels=16, double_conv=True, aniso=True, norm_type="group", in_channels=2).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    scaler = torch.amp.GradScaler("cuda") if (use_amp and "cuda" in device) else None

    rng = np.random.default_rng(SEED + fold)
    ckpt_path = out_dir / f"stage2_refiner_fold_{fold}.pt"

    for epoch in range(1, epochs + 1):
        model.train()
        total_loss = 0.0
        steps = 0

        # Sample patches with guidance channel stacked
        for case in cases_train:
            cid = case["id"]
            img = case["image"]
            lab = case["labels"]
            guide = guidance_cache[cid]
            sdf = case.get("sdf")

            # Cut 4 patches per case
            for _ in range(4):
                origin = sample_origin(img.shape, lab, rng, patch=patch)
                p_img = crop(img, origin, patch).astype(np.float32)
                p_guide = crop(guide, origin, patch).astype(np.float32)
                p_lab = crop(lab, origin, patch)
                p_sdf = crop(sdf, origin, patch) if sdf is not None else None

                # Stack Channel 0 (Image) and Channel 1 (Stage 1 Guidance) -> [1, 2, D, H, W]
                x_stack = np.stack([p_img, p_guide], axis=0)
                x = torch.from_numpy(x_stack).unsqueeze(0).to(device)
                y = torch.from_numpy(p_lab).to(device)
                sdf_t = torch.from_numpy(p_sdf.astype(np.float32) / 127.0).to(device) if p_sdf is not None else None

                opt.zero_grad(set_to_none=True)
                amp_ctx = torch.amp.autocast("cuda") if (use_amp and "cuda" in device) else torch.nullcontext()
                with amp_ctx:
                    logits, cnet_logit, aux = model(x, return_cnet=True, return_aux=True)
                    tgt, valid = targets(y)
                    loss_seg = dice_focal(
                        logits[0], tgt, valid,
                        bme_weight=2.5, tversky_alpha=0.3, tversky_beta=0.7,
                        sdf=sdf_t, boundary_weight=0.20 if epoch >= 5 else 0.0,
                        soft_margin=True,
                    )
                    loss = loss_seg

                if scaler:
                    scaler.scale(loss).backward()
                    scaler.unscale_(opt)
                    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                    scaler.step(opt)
                    scaler.update()
                else:
                    loss.backward()
                    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                    opt.step()

                total_loss += loss.item()
                steps += 1

        avg_loss = total_loss / max(1, steps)
        if epoch % 5 == 0 or epoch == epochs or epoch == 1:
            print(f"  [Stage 2 - Fold {fold}] Epoch {epoch}/{epochs} | Refiner Loss: {avg_loss:.4f}", flush=True)

    # Validation evaluation
    print(f"[STAGE 2] Evaluating Fold {fold} across {len(cases_val)} held-out validation cases...", flush=True)
    model.eval()
    val_bone_dices, val_bme_pos_dices = [], []
    with torch.no_grad():
        for case in cases_val:
            cid = case["id"]
            img = case["image"]
            lab = case["labels"]
            guide = guidance_cache[cid]
            # Simple full-volume sliding window evaluation
            # Center crop for evaluation
            o = tuple(max(0, img.shape[i] // 2 - patch[i] // 2) for i in range(3))
            p_img = crop(img, o, patch).astype(np.float32)
            p_guide = crop(guide, o, patch).astype(np.float32)
            p_lab = crop(lab, o, patch)

            x_stack = np.stack([p_img, p_guide], axis=0)
            x = torch.from_numpy(x_stack).unsqueeze(0).to(device)
            logits = model(x)
            pred_bone = (torch.sigmoid(logits[0, 0]) > 0.50).cpu().numpy().astype(np.uint8)
            pred_bme = (torch.sigmoid(logits[0, 1]) > 0.45).cpu().numpy().astype(np.uint8)

            d_bone = dice(p_lab, pred_bone, value=1)
            val_bone_dices.append(d_bone)
            if (p_lab == 2).any():
                d_bme = dice(p_lab, pred_bme, value=2)
                val_bme_pos_dices.append(d_bme)

    bone_mean = float(np.mean(val_bone_dices)) if val_bone_dices else 0.0
    bme_pos_mean = float(np.mean(val_bme_pos_dices)) if val_bme_pos_dices else 0.0
    print(f"[STAGE 2] Fold {fold} Complete => Bone Dice: {bone_mean:.3f} | Pos BME Dice: {bme_pos_mean:.3f}", flush=True)

    res = {
        "fold": fold,
        "epochs": epochs,
        "bone_dice": bone_mean,
        "bme_dice_pos": bme_pos_mean,
        "ckpt": str(ckpt_path),
    }
    torch.save({"state": model.state_dict(), "metrics": res}, ckpt_path)
    return res


def main():
    parser = argparse.ArgumentParser(description="Two-Stage Cascaded 3D Pipeline (Option B)")
    parser.add_argument("--base", type=str, default=".", help="Project root base directory")
    parser.add_argument("--stage", choices=["1", "2", "both"], default="both", help="Which stage to train")
    parser.add_argument("--epochs", type=int, default=50, help="Epochs per stage")
    parser.add_argument("--folds", type=int, default=5, help="Number of cross-validation folds")
    parser.add_argument("--quick-test", action="store_true", help="Run 2-epoch smoke test on 4 cases")
    parser.add_argument("--device", type=str, default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--out-dir", type=str, default="data/results3d_experiments/cascade_stage2",
                        help="Output directory (defaults to data/results3d_experiments to preserve web UI)")
    args = parser.parse_args()

    base = Path(args.base)
    device = args.device
    epochs = 2 if args.quick_test else args.epochs
    folds = 2 if args.quick_test else args.folds
    max_cases = 4 if args.quick_test else 0

    print("=================================================================", flush=True)
    print("TWO-STAGE CASCADED 3D PIPELINE: INITIALIZING", flush=True)
    print(f"Device: {device} | Folds: {folds} | Epochs: {epochs} | Quick-Test: {args.quick_test}", flush=True)
    print(f"Output Directory: {args.out_dir} (isolated experiment folder)", flush=True)
    print("=================================================================", flush=True)

    # Load metadata and cases
    classes, patients = load_worklist_metadata(base)
    ann_dir = base / "data" / "annotations"
    if not ann_dir.is_dir():
        ann_dir = base / "annotations"
    case_ids = sorted([d.name for d in ann_dir.iterdir() if d.is_dir()])
    if max_cases:
        case_ids = case_ids[:max_cases]

    print(f"Loading {len(case_ids)} cases...", flush=True)
    cases = []
    for cid in case_ids:
        c = load_case(base, cid, compute_sdf=True)
        if c:
            cases.append(c)

    if len(cases) < 2:
        raise SystemExit("Need at least 2 valid cases to run cascade.")

    out_s1 = base / "data" / "results3d_experiments" / "cascade_stage1"
    out_s2 = Path(args.out_dir)

    # 5-fold split
    fold_size = len(cases) // folds
    all_s2_results = []

    for f in range(folds):
        val_idx = list(range(f * fold_size, (f + 1) * fold_size if f < folds - 1 else len(cases)))
        train_idx = [i for i in range(len(cases)) if i not in val_idx]
        c_train = [cases[i] for i in train_idx]
        c_val = [cases[i] for i in val_idx]

        # Stage 1: Train global context net
        s1_res = train_stage1_fold(c_train, c_val, fold=f, epochs=epochs, device=device, out_dir=out_s1)

        # Generate guidance cache from Stage 1
        s1_model = GlobalContextNet3D(base_channels=16, aniso=True, norm_type="group", in_channels=1).to(device)
        s1_model.load_state_dict(torch.load(s1_res["ckpt"], map_location=device)["state"])
        guidance = generate_guidance_cache(s1_model, cases, device=device)

        # Stage 2: Train high-res refiner
        s2_res = train_stage2_fold(c_train, c_val, guidance, fold=f, epochs=epochs, device=device, out_dir=out_s2)
        all_s2_results.append(s2_res)

    mean_bone = float(np.mean([r["bone_dice"] for r in all_s2_results]))
    mean_bme = float(np.mean([r["bme_dice_pos"] for r in all_s2_results]))
    print("\n=================================================================", flush=True)
    print("CASCADE PIPELINE COMPLETE!", flush=True)
    print(f"Mean Bone Dice: {mean_bone:.3f} | Mean Pos BME Dice: {mean_bme:.3f}", flush=True)
    print(f"Checkpoints and metrics archived to: {out_s2}", flush=True)
    print("=================================================================", flush=True)


if __name__ == "__main__":
    main()

