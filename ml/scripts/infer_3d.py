"""Run the 3D model on one NRRD scan.

    python ml/scripts/infer_3d.py <base> <scan.nrrd> <out.json>

Writes edema present or not, volume in mm3, lesion count, and axial, coronal,
and sagittal views with the predicted mask. Prediction is a sliding window on
the scan's own voxel grid. Edema outside the predicted bone is removed.
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import numpy as np
import SimpleITK as sitk
import torch
from scipy.ndimage import label as cc_label, zoom

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_3d import (  # noqa: E402
    PATCH,
    build_model,
    guard_device,
    normalize,
    postprocess_prediction,
    predict_volume_probs,
    to_spacing,
)


def read_nrrd(path: Path):
    """ITK stores NRRD in LPS. The annotation viewer uses a RAS affine, same as NIfTI."""
    img = sitk.ReadImage(str(path))
    arr = np.transpose(sitk.GetArrayFromImage(img), (2, 1, 0))
    spacing = np.array([float(abs(s)) or 1.0 for s in img.GetSpacing()[:3]])
    direction = np.array(img.GetDirection(), dtype=float).reshape(3, 3)
    origin = np.array(img.GetOrigin(), dtype=float)
    lps_to_ras = np.diag([-1.0, -1.0, 1.0])
    aff = np.eye(4)
    aff[:3, :3] = (lps_to_ras @ direction) * spacing
    aff[:3, 3] = lps_to_ras @ origin
    return arr, spacing, aff


def pack(vol: np.ndarray) -> str:
    """i fastest, matching the annotation viewer index i + nx*(j + ny*k)."""
    return base64.b64encode(np.asfortranarray(vol).ravel(order="F").tobytes()).decode("ascii")


def _resolve_arch(blob: dict, default_name: str) -> str:
    """Map legacy checkpoint architecture strings to canonical build_model names."""
    arch = blob.get("model_arch") or blob.get("model") or default_name
    if arch in ("attention-unet", "attention_unet"):
        return "cnet_dual_unet"
    if arch == "unet":
        return "unet3d"
    return arch


WEIGHTS = {
    "results3d": "unet",
    "results3d-attn": "attention-unet",
}


def _resize_prob_to_shape(prob: np.ndarray, shape: tuple[int, int, int]) -> np.ndarray:
    """Trilinearly resample continuous probability map back onto native scan shape."""
    if prob.shape == shape:
        return prob.astype(np.float32, copy=False)
    factors = tuple(t / s for t, s in zip(shape, prob.shape))
    out = zoom(prob.astype(np.float32, copy=False), factors, order=1)
    return np.clip(out, 0.0, 1.0).astype(np.float32)


def ensemble_fold_predictions(
    fold_bones: list[np.ndarray],
    fold_bmes: list[np.ndarray],
    bme_thresholds: list[float],
    min_bme_voxels: int = 50,
    min_conf_voxels: int = 25,
    high_conf: float = 0.65,
) -> np.ndarray:
    """Average continuous 5-fold probability maps, lock edema to bone, and run closing + hysteresis."""
    n = len(fold_bones)
    avg_bone = np.mean(fold_bones, axis=0, dtype=np.float32)
    avg_bme = np.mean(fold_bmes, axis=0, dtype=np.float32)
    bme_thr = float(np.mean(bme_thresholds)) if bme_thresholds else 0.50

    mask = np.zeros(avg_bone.shape, dtype=np.uint8)
    mask[avg_bone >= 0.5] = 1
    mask[(avg_bme >= bme_thr) & (mask == 1)] = 2
    if min_bme_voxels > 0 and n > 0:
        mask = postprocess_prediction(
            mask,
            min_bme_voxels=min_bme_voxels,
            prob_bme=avg_bme,
            min_conf_voxels=min_conf_voxels,
            high_conf=high_conf,
        )
    return mask


def main():
    if len(sys.argv) < 4:
        raise SystemExit(__doc__)
    base, src, dest = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    out_name = sys.argv[4] if len(sys.argv) > 4 else "results3d"
    if out_name not in WEIGHTS:
        raise SystemExit(f"unknown weights folder {out_name!r}. choices: {', '.join(WEIGHTS)}")
    ckpts = sorted((base / "data" / out_name).glob("fold_*.pt"))
    if not ckpts:
        raise SystemExit(f"No weights in data/{out_name}. Train that model on the Training page first.")

    raw, spacing, affine = read_nrrd(src)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    guard_device(device)
    first = torch.load(ckpts[0], map_location=device, weights_only=False)
    norm = normalize(raw, n4=bool(first.get("n4", False)))
    default_arch = WEIGHTS.get(out_name, "unet3d")
    model_name = _resolve_arch(first, default_arch)
    patch = tuple(first.get("patch") or PATCH)
    aniso_default = bool(first.get("aniso", False))
    norm_default = first.get("norm_type", "instance")
    tta_default = bool(first.get("val_tta", False))
    raw_sp = first.get("spacing_mm")
    grid_mm = raw_sp if isinstance(raw_sp, (list, tuple)) else float(raw_sp or 0.0)

    grid, _ = to_spacing(norm, None, spacing, grid_mm)
    fold_bones: list[np.ndarray] = []
    fold_bmes: list[np.ndarray] = []
    bme_thresholds: list[float] = []
    min_vox_vals: list[int] = []

    for idx, ck in enumerate(ckpts):
        blob = first if idx == 0 else torch.load(ck, map_location=device, weights_only=False)
        arch = _resolve_arch(blob, default_arch)
        bc = int(blob.get("base_channels") or blob.get("width") or 16)
        dc = bool(blob.get("double_conv", False))
        an = bool(blob.get("aniso", aniso_default))
        nt = blob.get("norm_type", norm_default)
        use_tta = bool(blob.get("val_tta", tta_default))
        min_vox = int(blob.get("min_bme_voxels", 50))
        cnet_thresh = float(blob.get("cnet_threshold", 0.30) or 0.30)
        bme_thresh = float(blob.get("bme_threshold", 0.50) or 0.50)
        cnet_soft = bool(blob.get("cnet_soft", True))
        cnet_temp = float(blob.get("cnet_temperature", 1.0) or 1.0)
        gauss_win = bool(blob.get("gaussian_window", True))
        model = build_model(arch=arch, base_channels=bc, double_conv=dc, aniso=an, norm_type=nt).to(device)
        model.load_state_dict(blob["state"])
        avg_bone, avg_bme = predict_volume_probs(
            model,
            grid,
            device,
            patch,
            cnet_threshold=cnet_thresh,
            tta=use_tta,
            gaussian_window=gauss_win,
            cnet_soft=cnet_soft,
            cnet_temperature=cnet_temp,
        )
        fold_bones.append(_resize_prob_to_shape(avg_bone, norm.shape))
        fold_bmes.append(_resize_prob_to_shape(avg_bme, norm.shape))
        bme_thresholds.append(bme_thresh)
        min_vox_vals.append(min_vox)

    mask = ensemble_fold_predictions(
        fold_bones,
        fold_bmes,
        bme_thresholds,
        min_bme_voxels=int(np.median(min_vox_vals)) if min_vox_vals else 50,
    )

    vox = float(spacing[0] * spacing[1] * spacing[2])
    bme_n = int((mask == 2).sum())
    bone_n = int(((mask == 1) | (mask == 2)).sum())
    _, n_lesions = cc_label(mask == 2)
    if bme_n:
        cursor = [int(v) for v in np.argwhere(mask == 2).mean(axis=0)]
    else:
        cursor = [s // 2 for s in mask.shape]

    image_u8 = np.clip(np.rint(norm * 255), 0, 255).astype(np.uint8)
    out = {
        "ok": True,
        "model": model_name,
        "weights": out_name,
        "device": device,
        "folds": len(ckpts),
        "edema_present": bme_n > 0,
        "volume_mm3": round(bme_n * vox, 1),
        "volume_cm3": round(bme_n * vox / 1000, 3),
        "bone_mm3": round(bone_n * vox, 1),
        "bone_voxels": bone_n,
        "bme_voxels": bme_n,
        "fraction_of_bone": round(bme_n / bone_n, 4) if bone_n else None,
        "lesion_count": int(n_lesions),
        "shape": [int(s) for s in raw.shape],
        "spacing_mm": [round(float(s), 4) for s in spacing],
        "affine": [[round(float(v), 6) for v in row] for row in affine],
        "cursor": cursor,
        "image": pack(image_u8),
        "mask": pack(mask),
        "note": (
            "The scan's NRRD direction is converted to the same RAS axes as the annotation viewer, "
            "so axial, coronal, and sagittal follow how the volume was acquired. "
            "Edema outside the predicted bone is removed. "
            "Volume is predicted edema voxels times the scan spacing."
        ),
    }
    dest.write_text(json.dumps(out), encoding="utf-8")
    print(
        f"edema={'yes' if out['edema_present'] else 'no'}  "
        f"volume={out['volume_mm3']} mm3  lesions={out['lesion_count']}",
        flush=True,
    )


if __name__ == "__main__":
    main()
