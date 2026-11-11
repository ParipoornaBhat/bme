"""3D bone and edema segmentation.

    python ml/scripts/train_3d.py <base> --epochs 40 --folds 5

A 3D U-Net trained on patches of the annotated scan, not a resized thumbnail.
Bone and edema are learned together. At prediction, edema outside the predicted
bone is removed. Folds are patient-level. Loss is Dice + focal. The held-out
score is mean ± std across folds.

Prints "fold k:" and "epoch n/m" for the training page.
Writes data/results3d/metrics.json and fold_<k>.pt.
"""

from __future__ import annotations

import argparse
import contextlib
import csv
import gc
import hashlib
import json
import os
import math
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

import nibabel as nib
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from scipy.ndimage import affine_transform, zoom
from scipy.ndimage import label as cc_label
import scipy.ndimage as ndi

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from seg2nifti import build_labelmap, read_segmentation, to_volume_grid  # noqa: E402
except Exception:
    build_labelmap = read_segmentation = to_volume_grid = None

SEED = 1337
PATCH = (96, 96, 12)  # x, y, z. Sized so a 6 GB laptop GPU keeps the desktop alive.
STRIDE = (48, 48, 6)
PATCHES_PER_CASE = 8


def resolve_device(choice: str) -> str:
    if choice == "cpu":
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    if choice == "cuda":
        why = (
            "this PyTorch is a CPU-only build"
            if torch.version.cuda is None
            else "no CUDA device is visible to PyTorch"
        )
        raise SystemExit(f"--device cuda requested but unavailable: {why}")
    return "cpu"


def sanitize_labels(labels: np.ndarray) -> np.ndarray:
    """Sanitize label maps by clipping to valid range [0, 3]."""
    return np.clip(labels, 0, 3).astype(np.uint8)


def _apply_fast_n4(x: np.ndarray, body_mask: np.ndarray) -> np.ndarray:
    """Apply downsampled SimpleITK N4 bias-field correction inside the foreground mask."""
    try:
        import SimpleITK as sitk
    except ImportError:
        return x
    try:
        pos_x = np.maximum(x, 0.0).astype(np.float32)
        img = sitk.GetImageFromArray(pos_x)
        msk = sitk.GetImageFromArray(body_mask.astype(np.uint8))
        # sitk.GetImageFromArray reverses numpy (H, W, D) -> ITK (D, W, H)
        sz_z = max(1, min(2, x.shape[2] // 8))
        shrink = [sz_z, 6, 6]
        n4_filter = sitk.N4BiasFieldCorrectionImageFilter()
        n4_filter.SetMaximumNumberOfIterations([20, 20])
        n4_filter.Execute(sitk.Shrink(img, shrink), sitk.Shrink(msk, shrink))
        log_bias = sitk.GetArrayFromImage(n4_filter.GetLogBiasFieldAsImage(img))
        bias = np.exp(np.clip(log_bias, -4.0, 4.0)).astype(np.float32)
        corrected = pos_x / np.maximum(bias, 1e-3)
        return np.where(body_mask, corrected, 0.0).astype(np.float32)
    except Exception:
        return x


def normalize(raw: np.ndarray, denoise: bool = True, n4: bool = False) -> np.ndarray:
    """Robust MRI preprocessing and noise cleaning:
    1. Filter background air and Rician thermal noise down to exact 0.0 via
       adaptive noise peak & valley detection.
    2. Extract contiguous body mask and eliminate floating ghosting/coil specks.
    3. Fill body slice holes so bone marrow and internal cavities are 100% preserved.
    4. Suppress high-frequency in-plane acquisition grain with mild gaussian smoothing.
    5. Eliminate hyper-intense spike artifacts (coil flares, metal) via foreground percentiles.
    6. Normalize tissue contrast cleanly to [0, 1] in float32.
    """
    x = np.asarray(raw, dtype=np.float32)
    pos = x[x > 0]
    if len(pos) == 0:
        return np.zeros_like(x, dtype=np.float32)

    mean_val = float(pos.mean())
    body_mask = None

    if len(pos) > 1000 and float(pos.max()) > float(pos.min()) + 1e-3:
        # Detect Rician air noise mode and valley separating background air from knee anatomy
        upper_bound = min(float(mean_val * 2.5), float(pos.max()))
        if upper_bound > float(pos.min()):
            counts, bin_edges = np.histogram(pos, bins=100, range=(float(pos.min()), upper_bound))
            peak_idx = int(np.argmax(counts))
            valley_idx = peak_idx
            min_count = counts[peak_idx]
            for k in range(peak_idx, len(counts)):
                if counts[k] < min_count:
                    min_count = counts[k]
                    valley_idx = k
                elif counts[k] > min_count * 1.4:
                    break
            valley_val = float((bin_edges[valley_idx] + bin_edges[valley_idx + 1]) / 2.0)
            valley_val = max(mean_val * 0.15, min(valley_val, mean_val * 0.65))
            raw_fg = x > valley_val

            labeled, n_comps = ndi.label(raw_fg)
            if n_comps > 0:
                sizes = ndi.sum(raw_fg, labeled, range(1, n_comps + 1))
                max_size = max(sizes)
                # Keep components >= 1% of main knee anatomy to remove air speckles & coil ghosts
                keep_labels = [i + 1 for i, s in enumerate(sizes) if s >= max_size * 0.01]
                body_mask = np.isin(labeled, keep_labels)
                if body_mask.ndim == 3:
                    for z in range(body_mask.shape[2]):
                        body_mask[:, :, z] = ndi.binary_fill_holes(body_mask[:, :, z])
                else:
                    body_mask = ndi.binary_fill_holes(body_mask)

    if body_mask is None or body_mask.sum() < 100:
        air_threshold = max(float(x.min()), mean_val * 0.10)
        body_mask = x > air_threshold

    # N4 bias-field correction removes RF coil shading before smoothing/percentile clipping
    if n4 and x.ndim == 3 and min(x.shape[:2]) >= 48 and x.shape[2] >= 8 and body_mask.sum() > 1000:
        x = _apply_fast_n4(x, body_mask)

    # In-plane mild gaussian smoothing to eliminate thermal Rician noise grain
    if denoise and body_mask.sum() > 100 and x.ndim == 3:
        smoothed = ndi.gaussian_filter(x, sigma=(0.5, 0.5, 0.0))
        x = np.where(body_mask, smoothed, x)

    tissue_vals = x[body_mask]
    if len(tissue_vals) > 100:
        lo, hi = np.percentile(tissue_vals, [0.5, 99.5]).astype(np.float32)
    else:
        lo, hi = np.percentile(x, [1.0, 99.0]).astype(np.float32)

    scale = max(float(hi - lo), 1e-5)
    out = (x - lo) / scale
    np.clip(out, 0.0, 1.0, out=out)
    out[~body_mask] = 0.0
    return out


def pad_volume(vol: np.ndarray, patch=PATCH) -> np.ndarray:
    pads = [(0, max(0, patch[i] - vol.shape[i])) for i in range(3)]
    if any(b for _, b in pads):
        return np.pad(vol, pads)
    return vol


def window_origins(shape: tuple[int, int, int], patch=PATCH) -> list[tuple[int, int, int]]:
    stride = tuple(max(1, p // 2) for p in patch)
    ranges = []
    for ax in range(3):
        last = max(0, shape[ax] - patch[ax])
        if last == 0:
            ranges.append([0])
            continue
        starts = list(range(0, last + 1, stride[ax]))
        if starts[-1] != last:
            starts.append(last)
        ranges.append(starts)
    return [(x, y, z) for x in ranges[0] for y in ranges[1] for z in ranges[2]]


def crop(vol: np.ndarray, origin: tuple[int, int, int], patch=PATCH) -> np.ndarray:
    sl = tuple(slice(o, o + p) for o, p in zip(origin, patch))
    return vol[sl]


def parse_sampling_mix(arg_val: str) -> dict[str, float]:
    parts = [p.strip() for p in arg_val.split(",") if p.strip()]
    mix = {}
    for part in parts:
        if "=" not in part:
            raise ValueError(f"Invalid item '{part}' in --sampling-mix '{arg_val}', expected key=value.")
        k, v = part.split("=", 1)
        k = k.strip().lower()
        try:
            mix[k] = float(v.strip())
        except ValueError:
            raise ValueError(f"Invalid float value '{v}' for key '{k}' in --sampling-mix '{arg_val}'.")
    for req in ["lesion", "bone", "random"]:
        if req not in mix:
            raise ValueError(f"Missing required key '{req}' in --sampling-mix '{arg_val}'.")
    total = sum(mix.values())
    if not (0.999 <= total <= 1.001):
        raise ValueError(f"--sampling-mix fractions must sum to 1.0 (got {total:.4f} from '{arg_val}').")
    return mix


def sample_origin(
    shape: tuple[int, int, int],
    labels: np.ndarray,
    rng: np.random.Generator,
    sampling_mix: dict[str, float] | None = None,
    patch=PATCH,
    lesion_pts: np.ndarray | None = None,
) -> tuple[int, int, int]:
    if sampling_mix is None:
        sampling_mix = {"lesion": 0.7, "bone": 0.0, "random": 0.3}

    p_lesion = sampling_mix.get("lesion", 0.7)
    p_bone = sampling_mix.get("bone", 0.0)

    def centred(pts):
        point = pts[int(rng.integers(len(pts)))]
        return tuple(
            int(np.clip(point[ax] - patch[ax] // 2, 0, max(0, shape[ax] - patch[ax])))
            for ax in range(3)
        )

    def anywhere():
        return tuple(
            0 if shape[ax] <= patch[ax] else int(rng.integers(0, shape[ax] - patch[ax] + 1))
            for ax in range(3)
        )

    pts = lesion_pts if lesion_pts is not None else (np.argwhere(labels == 2) if (labels == 2).any() else None)
    has_lesion = pts is not None and len(pts) > 0

    # Default mix (no bone sampling): same draws, in the same order, as before the mix existed.
    if p_bone == 0.0:
        if has_lesion and rng.random() < p_lesion:
            return centred(pts)
        return anywhere()

    u = rng.random()
    if u < p_lesion and has_lesion:
        return centred(pts)
    if u < (p_lesion + p_bone) and ((labels == 1) | (labels == 2)).any():
        return centred(np.argwhere((labels == 1) | (labels == 2)))
    return anywhere()


def _mri_intensity_augment(
    img: np.ndarray,
    rng: np.random.Generator,
    apply_shading: bool = True,
    apply_contrast: bool = True,
    apply_gamma: bool = True,
    apply_scale_shift: bool = True,
    apply_noise: bool = False,
) -> np.ndarray:
    """Scanner-invariant MRI intensity transforms: gamma, contrast, synthetic 3D coil shading, scale/shift."""
    out = np.asarray(img, dtype=np.float32).copy()

    # 1. Non-linear gamma (simulates STIR / T2-FS receiver LUT differences)
    if apply_gamma and rng.random() < 0.5:
        gamma = float(rng.uniform(0.75, 1.35))
        out = np.power(np.clip(out, 0.0, 1.0), gamma, dtype=np.float32)

    # 2. Local dynamic contrast stretch around volume mean
    if apply_contrast and rng.random() < 0.5:
        c_alpha = float(rng.uniform(0.82, 1.22))
        mu = float(out.mean())
        out = mu + c_alpha * (out - mu)

    # 3. Smooth 3D synthetic coil-shading bias field (models B1 receiver drop-off)
    if apply_shading and rng.random() < 0.5:
        sx, sy, sz = out.shape
        gx = np.linspace(-1.0, 1.0, sx, dtype=np.float32)[:, None, None]
        gy = np.linspace(-1.0, 1.0, sy, dtype=np.float32)[None, :, None]
        gz = np.linspace(-1.0, 1.0, sz, dtype=np.float32)[None, None, :]
        cx, cy, cz = rng.uniform(-0.22, 0.22, size=3)
        qx, qy = rng.uniform(-0.10, 0.10, size=2)
        bias = np.clip(1.0 + cx * gx + cy * gy + cz * gz + qx * (gx ** 2 - 0.33) + qy * (gy ** 2 - 0.33), 0.70, 1.30)
        out = out * bias.astype(np.float32)

    # 4. Affine scale and shift
    if apply_scale_shift:
        scale = float(rng.uniform(0.9, 1.1))
        shift = float(rng.uniform(-0.05, 0.05))
        out = out * scale + shift

    # 5. Optional Gaussian noise
    if apply_noise:
        noise = rng.normal(0.0, 0.01, size=out.shape).astype(np.float32)
        out = out + noise

    return np.clip(out, 0.0, 1.0).astype(np.float32)


def apply_augmentation(
    img_patch: np.ndarray,
    lbl_patch: np.ndarray,
    rng: np.random.Generator,
    do_flip: bool = True,
    do_intensity: bool = True,
    do_noise: bool = True,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Apply 3D medical image augmentations in memory.
    Preserves spatial alignment between img_patch and lbl_patch.
    Constraints:
      - Flip: left-right horizontal flip along axis 1 (width) with p=0.5. No z-flips.
      - Intensity: gamma, contrast, synthetic coil shading, scale/shift, clipped to [0, 1].
      - Noise: additive Gaussian with sigma=0.01, clipped to [0, 1].
      - Labels: NEVER modified by intensity scaling or noise.
    """
    img = img_patch.copy()
    lbl = lbl_patch.copy()

    # 1. Left-right horizontal flip (axis 1)
    if do_flip and rng.random() < 0.5:
        img = np.ascontiguousarray(np.flip(img, axis=1))
        lbl = np.ascontiguousarray(np.flip(lbl, axis=1))

    # 2 & 3. MRI intensity transforms & Gaussian noise (image only)
    if do_intensity or do_noise:
        img = _mri_intensity_augment(
            img,
            rng,
            apply_shading=do_intensity,
            apply_contrast=do_intensity,
            apply_gamma=do_intensity,
            apply_scale_shift=do_intensity,
            apply_noise=do_noise,
        )

    return img, lbl


def augment(image: np.ndarray, labels: np.ndarray, rng: np.random.Generator):
    """In-plane flips + scanner-invariant MRI intensity augmentation (gamma, contrast, coil shading)."""
    for ax in (0, 1):
        if rng.random() < 0.5:
            image = np.flip(image, ax)
            labels = np.flip(labels, ax)
    if rng.random() < 0.85:
        image = _mri_intensity_augment(
            image,
            rng,
            apply_shading=True,
            apply_contrast=True,
            apply_gamma=True,
            apply_scale_shift=True,
            apply_noise=(rng.random() < 0.35),
        )
    else:
        image = np.clip(image, 0.0, 1.0).astype(np.float32)
    return np.ascontiguousarray(image, dtype=np.float32), np.ascontiguousarray(labels)


def parse_target_spacing(target) -> tuple[float, float, float] | None:
    """Parse target spacing into a 3-tuple (sx, sy, sz) in mm.

    Supports:
      - None, 0, 0.0, "0", "none", "native" -> None (keep native resolution)
      - (0.5, 0.5, 3.0) or [0.5, 0.5, 3.0] -> (0.5, 0.5, 3.0)
      - "0.5,0.5,3.0" or "0.5x0.5x3.0" or "0.5*0.5*3.0" -> (0.5, 0.5, 3.0)
      - 0.5 or "0.5" -> (0.5, 0.5, 3.0) [default 3.0 mm slice thickness]
    """
    if target is None:
        return None
    if isinstance(target, (list, tuple)):
        if len(target) == 3:
            return (float(target[0]), float(target[1]), float(target[2]))
        if len(target) == 1:
            val = float(target[0])
            return (val, val, 3.0) if val > 0 else None
    if isinstance(target, (int, float)):
        val = float(target)
        if val <= 0:
            return None
        return (val, val, 3.0)
    if isinstance(target, str):
        cleaned = target.strip().lower()
        if cleaned in ("", "0", "0.0", "none", "native", "false"):
            return None
        parts = [p.strip() for p in cleaned.replace("x", ",").replace("*", ",").split(",") if p.strip()]
        if len(parts) == 3:
            return (float(parts[0]), float(parts[1]), float(parts[2]))
        if len(parts) == 1:
            val = float(parts[0])
            return (val, val, 3.0) if val > 0 else None
    return None


def to_spacing(image: np.ndarray, labels: np.ndarray | None, spacing, target):
    """Resample volume (and labels) to physical target spacing (standardizing to 0.5 x 0.5 x 3.0 mm).

    Normalizes voxel size across diverse scanner acquisitions so patches cover the
    identical physical anatomical volume across every patient.
    """
    tgt = parse_target_spacing(target)
    if tgt is None:
        return image, labels
    sx, sy, sz = float(spacing[0]), float(spacing[1]), float(spacing[2])
    tx, ty, tz = tgt
    fx = sx / tx
    fy = sy / ty
    fz = sz / tz
    factors = (fx, fy, fz)

    # If within 2% of target on all axes, skip resampling
    if all(abs(f - 1.0) < 0.02 for f in factors):
        return image, labels

    out_shape = tuple(max(1, int(round(s * f))) for s, f in zip(image.shape, factors))
    if out_shape == image.shape:
        return image, labels

    # Fast multi-threaded 3D interpolation with PyTorch
    t_img = torch.from_numpy(np.ascontiguousarray(image, dtype=np.float32)).unsqueeze(0).unsqueeze(0)
    res_img = F.interpolate(t_img, size=out_shape, mode="trilinear", align_corners=False).squeeze(0).squeeze(0).numpy()
    np.clip(res_img, 0.0, 1.0, out=res_img)

    res_lab = None
    if labels is not None:
        t_lab = torch.from_numpy(np.ascontiguousarray(labels, dtype=np.float32)).unsqueeze(0).unsqueeze(0)
        # Nearest-neighbor for discrete segmentation classes {0, 1, 2, 3}
        res_lab = F.interpolate(t_lab, size=out_shape, mode="nearest").squeeze(0).squeeze(0).to(torch.uint8).numpy()

    return res_img, res_lab


def back_to_shape(mask: np.ndarray, shape) -> np.ndarray:
    """Nearest-neighbour resize of a label mask to an exact shape."""
    shape = tuple(int(s) for s in shape)
    if tuple(mask.shape) == shape:
        return mask
    t = torch.from_numpy(np.ascontiguousarray(mask, dtype=np.float32)).unsqueeze(0).unsqueeze(0)
    res = F.interpolate(t, size=shape, mode="nearest").squeeze(0).squeeze(0).to(torch.uint8).numpy()
    return res


def spatial_crop(image: np.ndarray, labels: np.ndarray, origin, patch, rng: np.random.Generator,
                 p_rot: float = 0.5, p_scale: float = 0.5, max_deg: float = 30.0,
                 scale_range: tuple[float, float] = (0.7, 1.4)):
    """Cut one patch, rotated and/or zoomed in-plane about its centre.

    nnU-Net's defaults (rotation within +-30 deg, scaling 0.7-1.4, each with
    p=0.2), applied slice-wise: the same 2D transform on every slice, z left
    alone. nnU-Net does this whenever a patch's longest edge is more than twice
    its shortest, which 160x160x16 is. Image is linear-interpolated, labels
    nearest, outside the scan is 0 (background). No noise is added.
    """
    rot = rng.random() < p_rot
    scl = rng.random() < p_scale
    if not (rot or scl):
        return crop(image, origin, patch).astype(np.float32), crop(labels, origin, patch)
    theta = np.deg2rad(rng.uniform(-max_deg, max_deg)) if rot else 0.0
    s = rng.uniform(*scale_range) if scl else 1.0
    m2 = np.array([[np.cos(theta), -np.sin(theta)], [np.sin(theta), np.cos(theta)]]) / s
    mat = np.eye(3)
    mat[:2, :2] = m2
    c_out = (np.array(patch, dtype=float) - 1) / 2
    c_in = np.array(origin, dtype=float) + c_out
    # Only the input region the output can reach is converted to float32.
    reach = np.abs(m2) @ c_out[:2] + 2
    lo = np.maximum(np.floor(c_in[:2] - reach).astype(int), 0)
    hi = np.minimum(np.ceil(c_in[:2] + reach).astype(int) + 1, np.array(image.shape[:2]))
    z0, z1 = int(origin[2]), int(origin[2]) + int(patch[2])
    sub_img = np.asarray(image[lo[0]:hi[0], lo[1]:hi[1], z0:z1], dtype=np.float32)
    sub_lab = np.asarray(labels[lo[0]:hi[0], lo[1]:hi[1], z0:z1])
    centre = c_in - np.array([lo[0], lo[1], z0], dtype=float)
    offset = centre - mat @ c_out
    img = affine_transform(sub_img, mat, offset=offset, output_shape=tuple(patch), order=1, mode="constant", cval=0.0)
    lab = affine_transform(sub_lab, mat, offset=offset, output_shape=tuple(patch), order=0, mode="constant", cval=0)
    return np.clip(img, 0, 1).astype(np.float32), lab.astype(np.uint8)


def volume_path(base: Path, case_id: str) -> Path:
    nii_dir = None
    for candidate in [
        base / "data" / "nifti",
        base / "nifti",
        base / "bme_dataset_bundle" / "data" / "nifti",
        base / "bme_dataset_bundle" / "nifti",
    ]:
        if candidate.is_dir():
            nii_dir = candidate
            break
    if nii_dir is None:
        cands = [p for p in base.rglob("nifti") if p.is_dir()]
        nii_dir = cands[0] if cands else base
    folder = nii_dir / case_id
    if folder.is_dir():
        meta = folder / "series.json"
        if meta.exists():
            try:
                annotated = json.loads(meta.read_text(encoding="utf-8")).get("annotated") or ""
            except json.JSONDecodeError:
                annotated = ""
            if annotated and annotated != "primary":
                for f in folder.glob(f"{case_id}_{annotated}.nii*"):
                    return f
        for f in folder.glob(f"{case_id}*.nii*"):
            if "labels" not in f.name:
                return f
        all_nii = [f for f in folder.glob("*.nii*") if "labels" not in f.name and not f.name.endswith(".txt")]
        if all_nii:
            return all_nii[0]

    # Robust fallback: search base for scan volume of this case
    candidates = [
        f for f in base.rglob(f"{case_id}*.nii*")
        if "labels" not in f.name and not f.name.endswith(".txt") and f.is_file()
    ]
    if candidates:
        for c in candidates:
            if "primary" in c.name:
                return c
        return candidates[0]

    return folder / f"{case_id}_primary.nii.gz"


def load_worklist_metadata(base: Path) -> tuple[dict[str, str], dict[str, str]]:
    """
    Returns (case_to_class, case_to_patient) from worklist.csv.
    """
    path = None
    for candidate in [
        base / "data" / "worklist.csv",
        base / "worklist.csv",
        base / "bme_dataset_bundle" / "data" / "worklist.csv",
        base / "bme_dataset_bundle" / "worklist.csv",
    ]:
        if candidate.is_file():
            path = candidate
            break
    if path is None:
        cands = [p for p in base.rglob("worklist.csv") if p.is_file()]
        if cands:
            path = cands[0]
        else:
            return {}, {}
    c_to_cls = {}
    c_to_pid = {}
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            cid = row.get("case_id") or ""
            if cid:
                c_to_cls[cid] = row.get("class") or ""
                c_to_pid[cid] = (row.get("patient_id") or "").strip()
    return c_to_cls, c_to_pid


def worklist_class(base: Path) -> dict[str, str]:
    c_cls, _ = load_worklist_metadata(base)
    return c_cls


def load_case(base: Path, case_id: str, n4: bool = False) -> dict | None:
    vol = volume_path(base, case_id)
    ann_dir = None
    for candidate in [
        base / "data" / "annotations",
        base / "annotations",
        base / "bme_dataset_bundle" / "data" / "annotations",
        base / "bme_dataset_bundle" / "annotations",
    ]:
        if candidate.is_dir():
            ann_dir = candidate
            break
    if ann_dir is None:
        cands = [p for p in base.rglob("annotations") if p.is_dir()]
        ann_dir = cands[0] if cands else base

    case_ann = ann_dir / case_id
    labs = [f for f in case_ann.glob("*_labels.nii*") if f.is_file()] if case_ann.is_dir() else []
    if not labs:
        labs = [p for p in base.rglob(f"{case_id}*_labels.nii*") if p.is_file()]

    seg = case_ann / f"{case_id}.seg.nrrd"
    if labs and seg.exists() and seg.stat().st_mtime > labs[0].stat().st_mtime:
        labs = []

    if labs and vol.exists():
        img = nib.load(str(vol))
        lab_img = nib.load(str(labs[0]))
        placed = sanitize_labels(np.asanyarray(lab_img.dataobj))
        norm = normalize(np.asanyarray(img.dataobj), n4=n4)
        spacing = tuple(float(abs(z)) or 1.0 for z in img.header.get_zooms()[:3])
        return {
            "id": case_id,
            "image": norm.astype(np.float32),
            "labels": placed,
            "bme_voxels": int((placed == 2).sum()),
            "spacing": spacing,
        }

    seg = case_ann / f"{case_id}.seg.nrrd"
    if not seg.exists() or not vol.exists():
        print(f"  {case_id}  skipped (missing scan or annotation)", flush=True)
        return None
    try:
        data, header, segments = read_segmentation(seg)
        lab, _, problems = build_labelmap(data, segments)
    except Exception as e:
        print(f"  {case_id}  skipped ({type(e).__name__}: {e})", flush=True)
        return None
    fatal = [p for p in problems if not str(p).startswith("required segment")]
    if fatal:
        print(f"  {case_id}  skipped ({'; '.join(fatal)})", flush=True)
        return None
    img = nib.load(str(vol))
    try:
        placed, notes = to_volume_grid(lab, header, img)
    except ValueError as e:
        print(f"  {case_id}  skipped ({e})", flush=True)
        return None
    placed = sanitize_labels(placed)
    norm = normalize(np.asanyarray(img.dataobj), n4=n4)
    spacing = tuple(float(abs(z)) or 1.0 for z in img.header.get_zooms()[:3])
    for note in notes:
        print(f"  {case_id}  {note}", flush=True)
    return {
        "id": case_id,
        "image": norm.astype(np.float32),
        "labels": placed,
        "bme_voxels": int((placed == 2).sum()),
        "spacing": spacing,
    }


class UNet3D(nn.Module):
    """Joint bone and lesion. Two channels, lesion clipped to bone at inference."""

    def __init__(self, base_channels: int = 16, double_conv: bool = False, width: int = None, aniso: bool = False):
        super().__init__()
        if width is not None:
            base_channels = width
        self.model_arch = "unet3d"
        self.base_channels = base_channels
        self.width = base_channels
        self.double_conv = double_conv
        self.aniso = aniso
        w = base_channels
        k1 = (2, 2, 1) if aniso else (2, 2, 2)

        def block(i, o):
            if double_conv:
                return nn.Sequential(
                    nn.Conv3d(i, o, 3, padding=1, bias=False),
                    nn.InstanceNorm3d(o),
                    nn.ReLU(inplace=True),
                    nn.Conv3d(o, o, 3, padding=1, bias=False),
                    nn.InstanceNorm3d(o),
                    nn.ReLU(inplace=True),
                )
            return nn.Sequential(
                nn.Conv3d(i, o, 3, padding=1, bias=False),
                nn.InstanceNorm3d(o),
                nn.ReLU(inplace=True),
            )

        self.e1 = block(1, w)
        self.e2 = block(w, 2 * w)
        self.e3 = block(2 * w, 4 * w)
        self.pool = nn.MaxPool3d(2)
        self.pool1 = nn.MaxPool3d(k1)
        self.up2 = nn.ConvTranspose3d(4 * w, 2 * w, 2, stride=2)
        self.d2 = block(4 * w, 2 * w)
        self.up1 = nn.ConvTranspose3d(2 * w, w, k1, stride=k1)
        self.d1 = block(2 * w, w)
        self.out = nn.Conv3d(w, 2, 1)

    def forward(self, x: torch.Tensor, return_cnet: bool = False):
        e1 = self.e1(x)
        e2 = self.e2(self.pool1(e1))
        e3 = self.e3(self.pool(e2))
        d2 = self.d2(torch.cat([self.up2(e3), e2], 1))
        d1 = self.d1(torch.cat([self.up1(d2), e1], 1))
        out = self.out(d1)
        if return_cnet:
            return out, None
        return out


def _make_norm3d(channels: int, norm_type: str = "group") -> nn.Module:
    """Batch-size-safe 3D normalization helper ('group' uses gcd so any channel count works)."""
    if norm_type == "batch":
        return nn.BatchNorm3d(channels)
    if norm_type == "instance":
        return nn.InstanceNorm3d(channels, affine=True)
    groups = math.gcd(channels, 8) or 1
    return nn.GroupNorm(groups, channels, affine=True)


class CNetHead3D(nn.Module):
    """Candidate/Classification Network (C-Net) Gatekeeper.
    Predicts patient/patch-level edema presence logit from global bottleneck features.
    """

    def __init__(self, in_channels: int):
        super().__init__()
        # Max pooling preserves peak focal lesion activation across the bottleneck instead of averaging small BME out.
        self.pool = nn.AdaptiveMaxPool3d(1)
        self.fc = nn.Sequential(
            nn.Linear(in_channels, 64),
            nn.ReLU(inplace=True),
            nn.Dropout(0.2),
            nn.Linear(64, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        b = x.size(0)
        pooled = self.pool(x).view(b, -1)
        return self.fc(pooled).squeeze(-1)


class CNetDualUNet3D(nn.Module):
    """C-Net Gatekeeper + Dual-Channel 3D U-Net.

    1. C-Net head at bottleneck gates edema presence (blocks false positives on negative controls).
    2. Direct high-fidelity skip connections preserve 100% of bone cortex boundaries without attention dampening.
    3. Dual-channel output: Channel 0 for Bone, Channel 1 for Edema (BME).
    """

    def __init__(self, base_channels: int = 16, double_conv: bool = True, aniso: bool = False, norm_type: str = "instance"):
        super().__init__()
        self.model_arch = "cnet_dual_unet"
        self.base_channels = base_channels
        self.double_conv = double_conv
        self.aniso = aniso
        self.norm_type = norm_type
        k1 = (2, 2, 1) if aniso else 2

        def _norm(o: int) -> nn.Module:
            return _make_norm3d(o, norm_type)

        def block(i, o):
            if double_conv:
                return nn.Sequential(
                    nn.Conv3d(i, o, 3, padding=1, bias=False),
                    _norm(o),
                    nn.ReLU(inplace=True),
                    nn.Conv3d(o, o, 3, padding=1, bias=False),
                    _norm(o),
                    nn.ReLU(inplace=True),
                )
            return nn.Sequential(
                nn.Conv3d(i, o, 3, padding=1, bias=False),
                _norm(o),
                nn.ReLU(inplace=True),
            )

        c1 = base_channels
        c2 = base_channels * 2
        c3 = base_channels * 4

        # Encoder
        self.e1 = block(1, c1)
        self.e2 = block(c1, c2)
        self.e3 = block(c2, c3)
        self.pool1 = nn.MaxPool3d(k1)
        self.pool = nn.MaxPool3d(2)

        # C-Net presence classifier head at bottleneck
        self.cnet = CNetHead3D(c3)

        # Decoder with transposed convolutions and direct high-fidelity skip connections
        self.up2 = nn.ConvTranspose3d(c3, c2, 2, stride=2)
        self.d2 = block(c3, c2)
        self.up1 = nn.ConvTranspose3d(c2, c1, k1, stride=k1)
        self.d1 = block(c2, c1)

        # Output dual-channel segmentation head (channel 0: bone, channel 1: edema)
        self.out = nn.Conv3d(c1, 2, 1)

    def forward(self, x: torch.Tensor, return_cnet: bool = False):
        a = self.e1(x)
        b = self.e2(self.pool1(a))
        c = self.e3(self.pool(b))

        cnet_logit = self.cnet(c)

        # Direct skip connections without attention dampening
        up2_out = self.up2(c)
        y = self.d2(torch.cat([up2_out, b], 1))

        up1_out = self.up1(y)
        y = self.d1(torch.cat([up1_out, a], 1))

        seg = self.out(y)
        if return_cnet:
            return seg, cnet_logit
        return seg


# Alias for backward compatibility with existing checkpoints
CNetAttentionUNet3D = CNetDualUNet3D


class MedNeXtBlock3D(nn.Module):
    """MedNeXt Block (MICCAI 2023).
    Modern 3D ConvNeXt-style residual block with depthwise 3D convolution,
    inverted bottleneck expansion, GELU activation, and residual connection.
    """

    def __init__(self, in_channels: int, out_channels: int, exp_ratio: int = 2, kernel_size: int = 5):
        super().__init__()
        self.in_channels = in_channels
        self.out_channels = out_channels
        pad = kernel_size // 2

        # 1. 3D Depthwise Convolution
        self.dw_conv = nn.Conv3d(
            in_channels,
            in_channels,
            kernel_size=kernel_size,
            padding=pad,
            groups=in_channels,
            bias=True,
        )

        # 2. Normalization
        self.norm = nn.InstanceNorm3d(in_channels, affine=True)

        # 3. Inverted Bottleneck (1x1x1 Conv pointwise expansion)
        hidden_dim = in_channels * exp_ratio
        self.pw_conv1 = nn.Conv3d(in_channels, hidden_dim, kernel_size=1)
        self.act = nn.GELU()

        # 4. Pointwise projection back to out_channels
        self.pw_conv2 = nn.Conv3d(hidden_dim, out_channels, kernel_size=1)

        # 5. Residual identity / projection shortcut
        if in_channels != out_channels:
            self.res_proj = nn.Conv3d(in_channels, out_channels, kernel_size=1)
        else:
            self.res_proj = nn.Identity()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        res = self.res_proj(x)
        y = self.dw_conv(x)
        y = self.norm(y)
        y = self.pw_conv1(y)
        y = self.act(y)
        y = self.pw_conv2(y)
        return y + res


class MedNeXt3D(nn.Module):
    """MedNeXt 3D Architecture for Medical Image Segmentation (MICCAI 2023).
    Encoder-Decoder with large-kernel 3D Depthwise ConvNeXt blocks,
    inverted bottlenecks, and residual skip connections.
    """

    def __init__(self, base_channels: int = 16, exp_ratio: int = 2, kernel_size: int = 5, **kwargs):
        super().__init__()
        self.model_arch = "mednext"
        self.base_channels = base_channels

        c1 = base_channels
        c2 = base_channels * 2
        c3 = base_channels * 4

        # Stem: map 1 input channel to base_channels
        self.stem = nn.Sequential(
            nn.Conv3d(1, c1, kernel_size=3, padding=1),
            nn.InstanceNorm3d(c1, affine=True),
            nn.GELU(),
        )

        # Encoder stages
        self.enc1 = MedNeXtBlock3D(c1, c1, exp_ratio=exp_ratio, kernel_size=kernel_size)
        self.down1 = nn.Conv3d(c1, c2, kernel_size=2, stride=2)

        self.enc2 = MedNeXtBlock3D(c2, c2, exp_ratio=exp_ratio, kernel_size=kernel_size)
        self.down2 = nn.Conv3d(c2, c3, kernel_size=2, stride=2)

        self.enc3 = MedNeXtBlock3D(c3, c3, exp_ratio=exp_ratio, kernel_size=kernel_size)

        # Decoder stages with residual skip fusion
        self.up2 = nn.ConvTranspose3d(c3, c2, kernel_size=2, stride=2)
        self.fuse2 = nn.Conv3d(c2 + c2, c2, kernel_size=1)
        self.dec2 = MedNeXtBlock3D(c2, c2, exp_ratio=exp_ratio, kernel_size=kernel_size)

        self.up1 = nn.ConvTranspose3d(c2, c1, kernel_size=2, stride=2)
        self.fuse1 = nn.Conv3d(c1 + c1, c1, kernel_size=1)
        self.dec1 = MedNeXtBlock3D(c1, c1, exp_ratio=exp_ratio, kernel_size=kernel_size)

        # Output head (channel 0: bone, channel 1: edema)
        self.out = nn.Conv3d(c1, 2, kernel_size=1)

    def forward(self, x: torch.Tensor, return_cnet: bool = False):
        x0 = self.stem(x)

        e1 = self.enc1(x0)
        e2 = self.enc2(self.down1(e1))
        e3 = self.enc3(self.down2(e2))

        d2 = self.up2(e3)
        d2 = self.dec2(self.fuse2(torch.cat([d2, e2], dim=1)))

        d1 = self.up1(d2)
        d1 = self.dec1(self.fuse1(torch.cat([d1, e1], dim=1)))

        seg = self.out(d1)
        if return_cnet:
            return seg, None
        return seg


class AttentionGate3d(nn.Module):
    def __init__(self, skip_ch, gate_ch, inter):
        super().__init__()
        self.theta = nn.Conv3d(skip_ch, inter, 1, bias=False)
        self.phi = nn.Conv3d(gate_ch, inter, 1, bias=False)
        self.psi = nn.Sequential(nn.ReLU(inplace=True), nn.Conv3d(inter, 1, 1), nn.Sigmoid())

    def forward(self, skip, gate):
        if gate.shape[-3:] != skip.shape[-3:]:
            gate = nn.functional.interpolate(gate, size=skip.shape[-3:], mode="nearest")
        return skip * self.psi(self.theta(skip) + self.phi(gate))


class AttentionUNet3D(nn.Module):
    """3D U-Net with attention on the skip links. Same two outputs, same patch size."""

    def __init__(self, width: int = 16, aniso: bool = False):
        super().__init__()
        w = width
        # aniso: the first level pools in-plane only, so 16 thick slices are not
        # halved twice before the network has seen any of them.
        k1 = (2, 2, 1) if aniso else (2, 2, 2)

        def block(i, o):
            return nn.Sequential(
                nn.Conv3d(i, o, 3, padding=1, bias=False),
                nn.InstanceNorm3d(o),
                nn.ReLU(inplace=True),
            )

        self.e1 = block(1, w)
        self.e2 = block(w, 2 * w)
        self.e3 = block(2 * w, 4 * w)
        self.pool = nn.MaxPool3d(2)
        self.pool1 = nn.MaxPool3d(k1)
        self.up2 = nn.ConvTranspose3d(4 * w, 2 * w, 2, stride=2)
        self.gate2 = AttentionGate3d(2 * w, 2 * w, w)
        self.d2 = block(4 * w, 2 * w)
        self.up1 = nn.ConvTranspose3d(2 * w, w, k1, stride=k1)
        self.gate1 = AttentionGate3d(w, w, max(1, w // 2))
        self.d1 = block(2 * w, w)
        self.out = nn.Conv3d(w, 2, 1)

    def forward(self, x, return_cnet: bool = False):
        a = self.e1(x)
        b = self.e2(self.pool1(a))
        c = self.e3(self.pool(b))
        y = self.up2(c)
        b = self.gate2(b, y)
        y = self.d2(torch.cat([y, b], 1))
        y = self.up1(y)
        a = self.gate1(a, y)
        y = self.d1(torch.cat([y, a], 1))
        out = self.out(y)
        if return_cnet:
            return out, None
        return out


class _OrthoMedNeXtBlock3D(nn.Module):
    """5x5x3 Anisotropic Depthwise-Separable MedNeXt residual block with batch-invariant norm."""

    def __init__(self, channels: int, exp_ratio: int = 2, kernel_size: tuple[int, int, int] = (5, 5, 3), norm_type: str = "group"):
        super().__init__()
        pad = tuple(k // 2 for k in kernel_size)
        self.dw = nn.Conv3d(channels, channels, kernel_size=kernel_size, padding=pad, groups=channels, bias=False)
        self.norm = _make_norm3d(channels, norm_type)
        hidden = channels * exp_ratio
        self.pw1 = nn.Conv3d(channels, hidden, kernel_size=1)
        self.act = nn.GELU()
        self.pw2 = nn.Conv3d(hidden, channels, kernel_size=1)
        self.gamma = nn.Parameter(torch.full((1, channels, 1, 1, 1), 0.5))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = self.pw2(self.act(self.pw1(self.norm(self.dw(x)))))
        return x + self.gamma * y


class _ASPP3D(nn.Module):
    """Lightweight depthwise-separable 3D ASPP for multi-scale focal & diffuse BME context."""

    def __init__(self, channels: int, norm_type: str = "group"):
        super().__init__()
        mid = max(8, channels // 4)
        self.b0 = nn.Sequential(nn.Conv3d(channels, mid, 1, bias=False), _make_norm3d(mid, norm_type), nn.GELU())
        self.b1 = nn.Sequential(
            nn.Conv3d(channels, channels, 3, padding=1, groups=channels, bias=False),
            nn.Conv3d(channels, mid, 1, bias=False),
            _make_norm3d(mid, norm_type),
            nn.GELU(),
        )
        self.b2 = nn.Sequential(
            nn.Conv3d(channels, channels, 3, padding=(2, 2, 1), dilation=(2, 2, 1), groups=channels, bias=False),
            nn.Conv3d(channels, mid, 1, bias=False),
            _make_norm3d(mid, norm_type),
            nn.GELU(),
        )
        self.b3 = nn.Sequential(
            nn.AdaptiveAvgPool3d(1),
            nn.Conv3d(channels, mid, 1, bias=True),
            nn.GELU(),
        )
        self.proj = nn.Sequential(
            nn.Conv3d(mid * 4, channels, 1, bias=False),
            _make_norm3d(channels, norm_type),
        )
        self.gamma = nn.Parameter(torch.full((1, channels, 1, 1, 1), 0.5))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        g = self.b3(x).expand(-1, -1, x.shape[2], x.shape[3], x.shape[4])
        cat = torch.cat([self.b0(x), self.b1(x), self.b2(x), g], dim=1)
        return x + self.gamma * self.proj(cat)


class _BoneGuidedAttention3D(nn.Module):
    """Locks edema features inside predicted bone marrow while damping extra-osseous signal."""

    def __init__(self, channels: int, norm_type: str = "group"):
        super().__init__()
        mid = max(4, channels // 2)
        self.gate = nn.Sequential(
            nn.Conv3d(channels + 1, mid, 1, bias=False),
            _make_norm3d(mid, norm_type),
            nn.GELU(),
            nn.Conv3d(mid, 1, 1),
            nn.Sigmoid(),
        )
        self.refine = nn.Sequential(
            nn.Conv3d(channels, channels, 3, padding=1, groups=channels, bias=False),
            nn.Conv3d(channels, channels, 1, bias=False),
            _make_norm3d(channels, norm_type),
            nn.GELU(),
        )

    def forward(self, feat: torch.Tensor, bone_logit: torch.Tensor) -> torch.Tensor:
        bone_prob = torch.sigmoid(bone_logit)
        learned_gate = self.gate(torch.cat([feat, bone_prob], dim=1))
        # Blend structural bone prior with learned gating while preserving non-zero gradient floor
        soft_mask = 0.10 + 0.90 * (0.5 * bone_prob + 0.5 * learned_gate)
        gated = feat * soft_mask
        return gated + self.refine(gated)


class OrthoGateMedNeXt3D(nn.Module):
    """OrthoGate-MedNeXt3D:
    5x5x3 anisotropic MedNeXt blocks + GroupNorm + ASPP3D bottleneck +
    Bone-Guided Spatial Attention + Deep Supervision + Bottleneck C-Net Gatekeeper (< 2.5 MB/fold).
    """

    def __init__(
        self,
        base_channels: int = 16,
        double_conv: bool = True,
        aniso: bool = True,
        norm_type: str = "group",
        exp_ratio: int = 2,
        **kwargs,
    ):
        super().__init__()
        resolved_norm = norm_type if norm_type in ("group", "instance", "batch") else "group"
        self.model_arch = "orthogate_mednext"
        self.base_channels = base_channels
        self.double_conv = double_conv
        self.aniso = aniso
        self.norm_type = resolved_norm

        c1 = base_channels
        c2 = base_channels * 2
        c3 = base_channels * 4
        n_blocks = 2 if double_conv else 1
        k1 = (2, 2, 1) if aniso else (2, 2, 2)

        def stage(ch: int) -> nn.Sequential:
            return nn.Sequential(
                *[_OrthoMedNeXtBlock3D(ch, exp_ratio=exp_ratio, kernel_size=(5, 5, 3), norm_type=resolved_norm) for _ in range(n_blocks)]
            )

        self.stem = nn.Sequential(
            nn.Conv3d(1, c1, kernel_size=3, padding=1, bias=False),
            _make_norm3d(c1, resolved_norm),
            nn.GELU(),
        )
        self.enc1 = stage(c1)
        self.down1 = nn.Sequential(
            nn.Conv3d(c1, c2, kernel_size=k1, stride=k1, bias=False),
            _make_norm3d(c2, resolved_norm),
        )
        self.enc2 = stage(c2)
        self.down2 = nn.Sequential(
            nn.Conv3d(c2, c3, kernel_size=2, stride=2, bias=False),
            _make_norm3d(c3, resolved_norm),
        )
        self.enc3 = stage(c3)
        self.aspp = _ASPP3D(c3, norm_type=resolved_norm)
        self.cnet = CNetHead3D(c3)

        self.up2 = nn.ConvTranspose3d(c3, c2, kernel_size=2, stride=2)
        self.fuse2 = nn.Sequential(nn.Conv3d(c2 * 2, c2, 1, bias=False), _make_norm3d(c2, resolved_norm), nn.GELU())
        self.dec2 = stage(c2)
        self.ds2 = nn.Conv3d(c2, 2, kernel_size=1)

        self.up1 = nn.ConvTranspose3d(c2, c1, kernel_size=k1, stride=k1)
        self.fuse1 = nn.Sequential(nn.Conv3d(c1 * 2, c1, 1, bias=False), _make_norm3d(c1, resolved_norm), nn.GELU())
        self.dec1 = stage(c1)

        self.out_bone = nn.Conv3d(c1, 1, kernel_size=1)
        self.bone_attn = _BoneGuidedAttention3D(c1, norm_type=resolved_norm)
        self.out_bme = nn.Conv3d(c1, 1, kernel_size=1)

    def forward(self, x: torch.Tensor, return_cnet: bool = False, return_aux: bool = False):
        e1 = self.enc1(self.stem(x))
        e2 = self.enc2(self.down1(e1))
        e3 = self.aspp(self.enc3(self.down2(e2)))

        cnet_logit = self.cnet(e3)

        d2 = self.dec2(self.fuse2(torch.cat([self.up2(e3), e2], dim=1)))
        d1 = self.dec1(self.fuse1(torch.cat([self.up1(d2), e1], dim=1)))

        bone_logit = self.out_bone(d1)
        bme_feat = self.bone_attn(d1, bone_logit)
        bme_logit = self.out_bme(bme_feat)
        seg = torch.cat([bone_logit, bme_logit], dim=1)

        if return_aux:
            ds2_up = F.interpolate(self.ds2(d2), size=x.shape[2:], mode="trilinear", align_corners=False)
            return seg, cnet_logit, [ds2_up]
        if return_cnet:
            return seg, cnet_logit
        return seg


def build_model(
    arch: str = "mednext",
    base_channels: int = 16,
    double_conv: bool = False,
    aniso: bool = False,
    norm_type: str = "instance",
    **kwargs,
) -> nn.Module:
    name = kwargs.get("name", arch)
    width = kwargs.get("width", base_channels)
    aniso = kwargs.get("aniso", aniso)
    norm_type = kwargs.get("norm_type", norm_type)
    if name == "orthogate_mednext":
        return OrthoGateMedNeXt3D(base_channels=width, double_conv=double_conv, aniso=aniso, norm_type=norm_type)
    if name == "mednext":
        return MedNeXt3D(base_channels=width)
    if name in ("cnet_dual_unet", "cnet_attention_unet"):
        return CNetDualUNet3D(base_channels=width, double_conv=double_conv, aniso=aniso, norm_type=norm_type)
    if name in ("attention-unet", "attn"):
        return AttentionUNet3D(width=width, aniso=aniso)
    return UNet3D(base_channels=width, double_conv=double_conv, aniso=aniso)


def targets(labels: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Bone includes the lesion. Uncertain voxels are left out of the loss."""
    bone = ((labels == 1) | (labels == 2)).float()
    bme = (labels == 2).float()
    valid = (labels != 3).float()
    return torch.stack([bone, bme], 0), valid


def dice_focal(
    logits: torch.Tensor,
    target: torch.Tensor,
    valid: torch.Tensor,
    gamma: float = 2.0,
    bme_weight: float = 2.5,
    tversky_alpha: float = 0.5,
    tversky_beta: float = 0.5,
    label_smoothing: float = 0.0,
) -> torch.Tensor:
    """Tversky/Dice + AMP-safe Focal loss. Channel 1 (edema) supports asymmetric Tversky (alpha<beta) to stop FN collapse."""
    prob = torch.sigmoid(logits.float()).clamp(1e-4, 1.0 - 1e-4)
    loss = logits.new_zeros((), dtype=torch.float32)
    denom_v = valid.sum().clamp(min=1.0)
    ls = float(max(0.0, min(0.1, label_smoothing)))
    for c in range(2):
        p = prob[c]
        t = target[c].float()
        pv, tv = p * valid, t * valid
        tp = (pv * tv).sum()
        if c == 1 and (abs(tversky_alpha - 0.5) > 1e-6 or abs(tversky_beta - 0.5) > 1e-6):
            fp = (pv * (1.0 - tv) * valid).sum()
            fn = ((1.0 - pv) * tv).sum()
            region_loss = 1.0 - (tp + 1.0) / (tp + tversky_alpha * fp + tversky_beta * fn + 1.0)
        else:
            region_loss = 1.0 - (2.0 * tp + 1.0) / (pv.sum() + tv.sum() + 1.0)
        t_bce = t * (1.0 - ls) + 0.5 * ls if ls > 0.0 else t
        bce = nn.functional.binary_cross_entropy(p, t_bce, reduction="none")
        pt = torch.where(t > 0.5, p, 1.0 - p)
        focal = ((1.0 - pt).pow(gamma) * bce * valid).sum() / denom_v
        w = 1.0 if c == 0 else bme_weight
        loss = loss + w * (region_loss + focal)
    return loss


def rates(tp, fp, fn):
    prec = float(tp / (tp + fp)) if tp + fp else 1.0
    rec = float(tp / (tp + fn)) if tp + fn else 1.0
    f1 = float(2 * prec * rec / (prec + rec)) if prec + rec else 0.0
    iou = float(tp / (tp + fp + fn)) if tp + fp + fn else 1.0
    return prec, rec, f1, iou


def lesion_stats(gt: np.ndarray, pred: np.ndarray) -> tuple[float, float]:
    gt_lab, n_gt = cc_label(gt == 2)
    pr_lab, n_pr = cc_label(pred == 2)
    if n_gt == 0:
        sens = 1.0 if n_pr == 0 else 0.0
    else:
        hit = 0
        for i in range(1, n_gt + 1):
            if (pred[gt_lab == i] == 2).any():
                hit += 1
        sens = hit / n_gt
    fp = 0
    for i in range(1, n_pr + 1):
        if not (gt[pr_lab == i] == 2).any():
            fp += 1
    return sens, float(fp)


def dice(gt: np.ndarray, pred: np.ndarray, value: int) -> float:
    g = gt == value
    p = pred == value
    if value == 1:
        g = (gt == 1) | (gt == 2)
        p = (pred == 1) | (pred == 2)
    inter = np.logical_and(g, p).sum()
    denom = g.sum() + p.sum()
    if denom == 0:
        return 1.0
    return float((2 * inter) / denom)


def guard_device(device: str, cudnn_benchmark: bool = False):
    """Limit this process. BME_GPU_FRACTION overrides the laptop default of 90%."""
    torch.set_num_threads(1)
    if device != "cuda":
        return
    frac = min(0.95, max(0.05, float(os.environ.get("BME_GPU_FRACTION", "0.90"))))
    try:
        torch.cuda.set_per_process_memory_fraction(frac)
    except RuntimeError:
        pass
    torch.backends.cudnn.benchmark = cudnn_benchmark
    print(f"GPU memory capped at {frac:.0%} for this process.", flush=True)


def release():
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def postprocess_prediction(
    pred: np.ndarray,
    min_bme_voxels: int = 50,
    prob_bme: np.ndarray | None = None,
    min_conf_voxels: int = 25,
    high_conf: float = 0.65,
    closing_iters: int = 1,
) -> np.ndarray:
    """Apply intra-osseous 3D morphological closing + confidence hysteresis speckle filtering.

    1. Reconnects fragmented lesion islands via 3D closing strictly inside predicted bone.
    2. Drops tiny components < min_bme_voxels UNLESS prob_bme confirms a high-confidence peak (>= high_conf)
       with at least min_conf_voxels voxels.
    """
    if min_bme_voxels <= 0 or not (pred == 2).any():
        return pred
    out = pred.copy()
    if closing_iters > 0:
        bone_mask = (out == 1) | (out == 2)
        # In-plane 3x3x1 closing reconnects split edema islands without smearing across 3mm thick Z slices.
        struct = np.ones((3, 3, 1), dtype=bool)
        closed_bme = ndi.binary_closing(out == 2, structure=struct, iterations=closing_iters) & bone_mask
        out[closed_bme] = 2

    lab, num = cc_label(out == 2)
    if num > 0:
        counts = np.bincount(lab.ravel())
        demote_ids: list[int] = []
        for cid in range(1, num + 1):
            cnt = int(counts[cid])
            if cnt >= min_bme_voxels:
                continue
            keep_hyst = (
                prob_bme is not None
                and min_conf_voxels > 0
                and cnt >= min_conf_voxels
                and float(prob_bme[lab == cid].max()) >= high_conf
            )
            if not keep_hyst:
                demote_ids.append(cid)
        if demote_ids:
            out[np.isin(lab, demote_ids)] = 1
    return out


_GAUSS_CACHE: dict[tuple[int, int, int], np.ndarray] = {}


def _gaussian_window_3d(patch_size: tuple[int, int, int], sigma_scale: float = 0.25) -> np.ndarray:
    """Cached normalized 3D Gaussian importance window (patch centers weighted higher than edges)."""
    key = tuple(int(p) for p in patch_size)
    if key in _GAUSS_CACHE:
        return _GAUSS_CACHE[key]
    axes = []
    for s in key:
        coords = np.arange(s, dtype=np.float32) - (s - 1) / 2.0
        sig = max(1.0, float(s) * sigma_scale)
        g = np.exp(-0.5 * (coords / sig) ** 2, dtype=np.float32)
        axes.append(g)
    win = axes[0][:, None, None] * axes[1][None, :, None] * axes[2][None, None, :]
    win = np.maximum(win / max(float(win.max()), 1e-6), 0.05).astype(np.float32)
    _GAUSS_CACHE[key] = win
    return win


def _apply_cnet_gate(
    avg_bme: np.ndarray,
    cnet_probs: list[float],
    cnet_threshold: float,
    cnet_soft: bool = True,
) -> np.ndarray:
    """Apply hard or soft-ramp C-Net gatekeeper using top-3 patch confidence."""
    if not cnet_probs or cnet_threshold <= 0:
        return avg_bme
    top_k = min(3, len(cnet_probs))
    top_mean = float(np.mean(sorted(cnet_probs)[-top_k:]))
    if not cnet_soft:
        if top_mean < cnet_threshold:
            avg_bme.fill(0.0)
        return avg_bme
    t_high = float(cnet_threshold)
    t_low = max(0.05, t_high - 0.20)
    if top_mean >= t_high:
        return avg_bme
    if top_mean <= t_low:
        avg_bme.fill(0.0)
        return avg_bme
    ramp = (top_mean - t_low) / max(t_high - t_low, 1e-6)
    return (avg_bme * float(ramp)).astype(np.float32)


@torch.no_grad()
def _score_volume_passes(
    model: nn.Module,
    vol: np.ndarray,
    device: str,
    patch_size: tuple[int, int, int],
    val_batch_size: int,
    use_amp: bool,
    channels_last: bool,
    gaussian_window: bool = True,
    cnet_temperature: float = 1.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[float]]:
    """Run one sliding-window pass and return unpadded (prob_bone, prob_bme, weights, cnet_probs)."""
    shape = vol.shape
    padded = pad_volume(vol, patch_size)
    prob_sum_bone = np.zeros(padded.shape, dtype=np.float32)
    prob_sum_bme = np.zeros(padded.shape, dtype=np.float32)
    hits = np.zeros(padded.shape, dtype=np.float32)
    win = _gaussian_window_3d(patch_size) if gaussian_window else np.ones(patch_size, dtype=np.float32)
    origins = window_origins(padded.shape, patch_size)
    has_cnet = hasattr(model, "cnet")
    temp = max(0.25, float(cnet_temperature))
    cnet_probs: list[float] = []

    for i in range(0, len(origins), val_batch_size):
        batch_orig = origins[i : i + val_batch_size]
        batch_arr = np.stack([crop(padded, o, patch_size) for o in batch_orig])
        x = torch.from_numpy(batch_arr).float().unsqueeze(1).to(device)
        if channels_last:
            x = x.to(memory_format=torch.channels_last_3d)
        if has_cnet:
            if use_amp and device == "cuda":
                with torch.amp.autocast(device_type="cuda"):
                    raw_seg, cnet_logit = model(x, return_cnet=True)
                    probs = torch.sigmoid(raw_seg.float()).cpu().numpy()
                    cnet_ps = torch.sigmoid(cnet_logit.float() / temp).cpu().numpy()
            else:
                raw_seg, cnet_logit = model(x, return_cnet=True)
                probs = torch.sigmoid(raw_seg).cpu().numpy()
                cnet_ps = torch.sigmoid(cnet_logit / temp).cpu().numpy()
            cnet_probs.extend(cnet_ps.tolist() if hasattr(cnet_ps, "tolist") else [float(cnet_ps)])
        else:
            if use_amp and device == "cuda":
                with torch.amp.autocast(device_type="cuda"):
                    probs = torch.sigmoid(model(x).float()).cpu().numpy()
            else:
                probs = torch.sigmoid(model(x)).cpu().numpy()
        for j, o in enumerate(batch_orig):
            sl = tuple(slice(o[k], o[k] + patch_size[k]) for k in range(3))
            prob_sum_bone[sl] += probs[j, 0] * win
            prob_sum_bme[sl] += probs[j, 1] * win
            hits[sl] += win
        del x, probs

    sl_crop = (slice(0, shape[0]), slice(0, shape[1]), slice(0, shape[2]))
    return prob_sum_bone[sl_crop], prob_sum_bme[sl_crop], hits[sl_crop], cnet_probs


@torch.no_grad()
def predict_volume_probs(
    model: nn.Module,
    image: np.ndarray,
    device: str,
    patch_size=PATCH,
    val_batch_size: int = 1,
    use_amp: bool = False,
    channels_last: bool = False,
    cnet_threshold: float = 0.30,
    tta: bool = False,
    gaussian_window: bool = True,
    cnet_soft: bool = True,
    cnet_temperature: float = 1.0,
) -> tuple[np.ndarray, np.ndarray]:
    """Compute continuous (avg_bone, avg_bme) probability maps with Gaussian stitching, TTA, and C-Net gate."""
    model.eval()
    patch_size = tuple(int(p) for p in patch_size)
    prob_bone, prob_bme, hits, cnet_probs = _score_volume_passes(
        model,
        image,
        device,
        patch_size,
        val_batch_size,
        use_amp,
        channels_last,
        gaussian_window=gaussian_window,
        cnet_temperature=cnet_temperature,
    )
    if tta:
        flipped_img = np.ascontiguousarray(np.flip(image, axis=1))
        fb, fm, fh, fc = _score_volume_passes(
            model,
            flipped_img,
            device,
            patch_size,
            val_batch_size,
            use_amp,
            channels_last,
            gaussian_window=gaussian_window,
            cnet_temperature=cnet_temperature,
        )
        prob_bone = prob_bone + np.flip(fb, axis=1)
        prob_bme = prob_bme + np.flip(fm, axis=1)
        hits = hits + np.flip(fh, axis=1)
        cnet_probs.extend(fc)

    hits_crop = np.maximum(hits, 1e-6).astype(np.float32)
    avg_bone = (prob_bone / hits_crop).astype(np.float32)
    avg_bme = (prob_bme / hits_crop).astype(np.float32)
    if hasattr(model, "cnet") and cnet_probs and cnet_threshold > 0:
        avg_bme = _apply_cnet_gate(avg_bme, cnet_probs, cnet_threshold, cnet_soft=cnet_soft)
    return avg_bone, avg_bme


@torch.no_grad()
def predict_volume(
    model: nn.Module,
    image: np.ndarray,
    device: str,
    patch_size=PATCH,
    val_batch_size: int = 1,
    use_amp: bool = False,
    channels_last: bool = False,
    min_bme_voxels: int = 50,
    cnet_threshold: float = 0.30,
    bme_threshold: float = 0.50,
    tta: bool = False,
    gaussian_window: bool = True,
    cnet_soft: bool = True,
    cnet_temperature: float = 1.0,
    min_conf_voxels: int = 25,
    high_conf: float = 0.65,
) -> np.ndarray:
    """Sliding-window Gaussian probability averaging + Soft C-Net gating + 3D closing & hysteresis."""
    shape = image.shape
    avg_bone, avg_bme = predict_volume_probs(
        model,
        image,
        device,
        patch_size=patch_size,
        val_batch_size=val_batch_size,
        use_amp=use_amp,
        channels_last=channels_last,
        cnet_threshold=cnet_threshold,
        tta=tta,
        gaussian_window=gaussian_window,
        cnet_soft=cnet_soft,
        cnet_temperature=cnet_temperature,
    )
    out = np.zeros(shape, dtype=np.uint8)
    out[avg_bone >= 0.5] = 1
    out[(avg_bme >= bme_threshold) & (out == 1)] = 2
    if min_bme_voxels > 0:
        out = postprocess_prediction(
            out,
            min_bme_voxels=min_bme_voxels,
            prob_bme=avg_bme,
            min_conf_voxels=min_conf_voxels,
            high_conf=high_conf,
        )
    return out


@torch.no_grad()
def calibrate_cnet_threshold_from_train(
    model: nn.Module,
    train_cases: list[dict],
    device: str,
    patch_size: tuple[int, int, int],
    val_batch_size: int = 8,
    use_amp: bool = False,
    channels_last: bool = False,
    default_thresh: float = 0.50,
    max_per_class: int = 24,
    cnet_temperature: float = 1.0,
) -> float:
    """Calibrate fold C-Net top-3 threshold strictly on training-fold cases (zero val leakage)."""
    if not hasattr(model, "cnet"):
        return default_thresh
    pos = sorted([c for c in train_cases if c.get("bme_voxels", 0) > 0 and "image" in c], key=lambda c: c["id"])
    neg = sorted([c for c in train_cases if c.get("bme_voxels", 0) == 0 and "image" in c], key=lambda c: c["id"])
    if len(pos) < 4 or len(neg) < 4:
        return default_thresh

    def _evenly(lst: list[dict], k: int) -> list[dict]:
        if len(lst) <= k:
            return lst
        idxs = np.linspace(0, len(lst) - 1, k, dtype=int)
        return [lst[int(i)] for i in idxs]

    sample = _evenly(pos, max_per_class) + _evenly(neg, max_per_class)
    model.eval()
    temp = max(0.25, float(cnet_temperature))
    pos_scores: list[float] = []
    neg_scores: list[float] = []
    for c in sample:
        vol = np.asarray(c["image"], dtype=np.float32)
        padded = pad_volume(vol, patch_size)
        origins = window_origins(padded.shape, patch_size)
        cnet_ps_all: list[float] = []
        for i in range(0, len(origins), val_batch_size):
            batch_orig = origins[i : i + val_batch_size]
            x = torch.from_numpy(np.stack([crop(padded, o, patch_size) for o in batch_orig])).float().unsqueeze(1).to(device)
            if channels_last:
                x = x.to(memory_format=torch.channels_last_3d)
            if use_amp and device == "cuda":
                with torch.amp.autocast(device_type="cuda"):
                    _, cl = model(x, return_cnet=True)
            else:
                _, cl = model(x, return_cnet=True)
            ps = torch.sigmoid(cl.float() / temp).cpu().numpy().reshape(-1).tolist()
            cnet_ps_all.extend(ps)
            del x
        top_k = min(3, len(cnet_ps_all))
        score = float(np.mean(sorted(cnet_ps_all)[-top_k:])) if cnet_ps_all else 0.0
        if c["bme_voxels"] > 0:
            pos_scores.append(score)
        else:
            neg_scores.append(score)

    best_score = -1.0
    best_threshs: list[float] = [default_thresh]
    # Keep upper threshold conservative (<= 0.58) and require >= 92% positive sensitivity.
    for t in np.linspace(0.25, 0.58, 15):
        tpr = float(np.mean([s >= t for s in pos_scores]))
        tnr = float(np.mean([s < t for s in neg_scores]))
        obj = (tpr + tnr - 1.0) if tpr >= 0.92 else (tpr + tnr - 2.0)
        if obj > best_score + 1e-9:
            best_score = obj
            best_threshs = [float(t)]
        elif abs(obj - best_score) <= 1e-9:
            best_threshs.append(float(t))
    return round(float(np.median(best_threshs)), 3)


@torch.no_grad()
def calibrate_bme_threshold_from_train(
    model: nn.Module,
    train_cases: list[dict],
    device: str,
    patch_size: tuple[int, int, int],
    val_batch_size: int = 8,
    use_amp: bool = False,
    channels_last: bool = False,
    min_bme_voxels: int = 50,
    cnet_threshold: float = 0.30,
    default_thresh: float = 0.50,
    tta: bool = False,
    max_pos: int = 16,
    gaussian_window: bool = True,
    cnet_soft: bool = True,
    cnet_temperature: float = 1.0,
) -> float:
    """Calibrate fold BME voxel threshold strictly on positive training-fold cases (zero val leakage)."""
    pos = sorted(
        [c for c in train_cases if c.get("bme_voxels", 0) > 0 and "image" in c and "labels" in c],
        key=lambda c: c["id"],
    )
    if len(pos) < 4:
        return default_thresh
    if len(pos) > max_pos:
        idxs = np.linspace(0, len(pos) - 1, max_pos, dtype=int)
        pos = [pos[int(i)] for i in idxs]

    model.eval()
    candidates = [0.35, 0.40, 0.45, 0.50]
    dice_by_thr: dict[float, list[float]] = {t: [] for t in candidates}

    for c in pos:
        vol = np.asarray(c["image"], dtype=np.float32)
        lbl = np.asarray(c["labels"], dtype=np.uint8)
        avg_bone, avg_bme = predict_volume_probs(
            model,
            vol,
            device,
            patch_size=patch_size,
            val_batch_size=val_batch_size,
            use_amp=use_amp,
            channels_last=channels_last,
            cnet_threshold=cnet_threshold,
            tta=tta,
            gaussian_window=gaussian_window,
            cnet_soft=cnet_soft,
            cnet_temperature=cnet_temperature,
        )
        bone_mask = avg_bone >= 0.5

        for t in candidates:
            out = np.zeros(vol.shape, dtype=np.uint8)
            out[bone_mask] = 1
            out[(avg_bme >= t) & bone_mask] = 2
            if min_bme_voxels > 0:
                out = postprocess_prediction(out, min_bme_voxels=min_bme_voxels, prob_bme=avg_bme)
            dice_by_thr[t].append(dice(lbl, out, 2))

    best_thr = default_thresh
    best_dice = -1.0
    for t in candidates:
        mean_d = float(np.mean(dice_by_thr[t]))
        if mean_d > best_dice + 1e-6:
            best_dice = mean_d
            best_thr = t
    return round(float(best_thr), 3)



def mean_std(vals: list[float]) -> dict | None:
    if not vals:
        return None
    a = np.asarray(vals, dtype=float)
    std = float(a.std(ddof=1)) if len(a) > 1 else 0.0
    return {"mean": float(a.mean()), "std": std}


DEFAULT_ARCH = {"model": "unet", "width": 16, "patch": list(PATCH)}

SUMMARY_KEYS = (
    "bone_dice", "bme_dice", "lesion_sensitivity", "fp_per_case",
    "bme_dice_pos", "lesion_sensitivity_pos", "clean_scan_specificity", "fp_per_neg_case",
    "bone_precision", "bone_recall", "bone_f1", "bone_iou",
    "edema_precision", "edema_recall", "edema_f1", "edema_iou",
)


def summarise(rows: list[dict]) -> dict:
    """mean ± std across folds. A key is left out unless every fold row carries it."""
    out = {}
    for k in SUMMARY_KEYS:
        if rows and all(k in r for r in rows):
            out[k] = mean_std([r[k] for r in rows])
    return out


def compute_dataset_fingerprint(
    case_ids: list[str],
    groups: list[list[dict]],
    batch_size: int,
    patches_per_case: int,
    lesion_sampling_ratio: float,
    learning_rate: float,
    loss_config: dict,
    independent_fold_seeds: bool,
    data_flags: dict,
    fold_mode: str = "patient_grouped",
    patient_count: int = 0,
    sampling_mix: dict | None = None,
    arch: dict | None = None,
) -> tuple[str, dict]:
    val_cases_per_fold = {
        str(f): sorted([c["id"] for c in groups[f]])
        for f in range(len(groups))
    }
    payload = {
        "case_ids": sorted(case_ids),
        "val_cases_per_fold": val_cases_per_fold,
        "fold_mode": fold_mode,
        "patient_count": patient_count,
        "batch_size": batch_size,
        "patches_per_case": patches_per_case,
        "lesion_sampling_ratio": lesion_sampling_ratio,
        "sampling_mix": sampling_mix or {"lesion": 0.7, "bone": 0.0, "random": 0.3},
        "learning_rate": learning_rate,
        "loss_config": loss_config,
        "independent_fold_seeds": independent_fold_seeds,
        "data_flags": data_flags,
    }
    if arch and arch != DEFAULT_ARCH:
        payload["arch"] = arch
    raw = json.dumps(payload, sort_keys=True)
    fingerprint = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return fingerprint, payload


def merge_metrics_files(out_dir: Path, folds_n: int = 5) -> dict | None:
    """Merge per-fold metric files into final metrics.json (for parallel fold training)."""
    fold_files = sorted(out_dir.glob("metrics_fold_*.json"))
    fold_rows = []
    if fold_files:
        for f in fold_files:
            try:
                row = json.loads(f.read_text(encoding="utf-8"))
                fold_rows.append(row)
            except Exception:
                pass
        fold_rows.sort(key=lambda r: r.get("fold", 0))

    # Check for incomplete or missing folds
    incomplete_folds = []
    for f_idx in range(folds_n):
        status_file = out_dir / f"status_fold_{f_idx}.json"
        if status_file.exists():
            try:
                st = json.loads(status_file.read_text(encoding="utf-8"))
                if st.get("status") == "incomplete":
                    incomplete_folds.append((f_idx, st.get("epoch_reached", "?"), st.get("target_epochs", "?")))
            except Exception:
                pass
        elif not any(r.get("fold") == f_idx for r in fold_rows):
            incomplete_folds.append((f_idx, 0, "?"))

    if incomplete_folds or len(fold_rows) < folds_n:
        print("=" * 70, flush=True)
        print("[WARNING] TRAINING RUN INCOMPLETE - REFUSING TO WRITE COMPLETE metrics.json", flush=True)
        print("=" * 70, flush=True)
        for f_idx, ep, target_ep in incomplete_folds:
            print(f"  Fold {f_idx}: INCOMPLETE (reached epoch {ep}/{target_ep})", flush=True)
        print(f"  Completed folds found: {len(fold_rows)}/{folds_n}", flush=True)
        if fold_rows:
            (out_dir / "metrics_partial.json").write_text(json.dumps(fold_rows, indent=2), encoding="utf-8")
            print(f"  Wrote partial metrics ({len(fold_rows)} folds) to {out_dir / 'metrics_partial.json'}", flush=True)
        print("=" * 70, flush=True)
        return None

    first = fold_rows[0]
    first_fp = first.get("fingerprint")
    first_mode = first.get("fold_mode", "patient_grouped")
    for r in fold_rows:
        if r.get("fingerprint") and first_fp and r.get("fingerprint") != first_fp:
            print(f"[ERROR] Fingerprint mismatch across folds in merge: {r.get('fingerprint')} != {first_fp}", flush=True)
            return None
        if r.get("fold_mode") and first_mode and r.get("fold_mode") != first_mode:
            print(f"[ERROR] Fold mode mismatch across folds in merge: {r.get('fold_mode')} != {first_mode}", flush=True)
            return None
    epochs = first.get("epochs", 40)
    seed = first.get("seed", SEED)
    device = first.get("device", "cuda")
    n_cases = first.get("n_cases", 61)
    n_bme = first.get("n_bme", 61)
    n_neg = first.get("n_negative", 0)
    total_skipped = sum(r.get("amp_skipped_steps", 0) for r in fold_rows)
    mean_skipped_pct = float(np.mean([r.get("amp_skipped_pct", 0.0) for r in fold_rows]))
    data_config = first.get("data_config", None)
    fingerprint = first_fp
    fold_mode = first_mode
    patient_count = first.get("patient_count", 0)
    sampling_mix = first.get("sampling_mix")
    patch_used = first.get("patch", list(PATCH))
    val_cases_per_fold = {
        str(r.get("fold", idx)): r.get("val_cases", [])
        for idx, r in enumerate(fold_rows)
    }

    metrics = {
        "model": "3d-unet",
        "device": device,
        "folds": len(fold_rows),
        "fold_mode": fold_mode,
        "patient_count": patient_count,
        "val_cases_per_fold": val_cases_per_fold,
        "sampling_mix": sampling_mix,
        "epochs": epochs,
        "seed": seed,
        "patch": patch_used,
        "data_config": data_config,
        "fingerprint": fingerprint,
        "n_cases": n_cases,
        "n_bme": n_bme,
        "n_negative": n_neg,
        "summary": summarise(fold_rows),
        "presence_correct": sum(r.get("presence_correct", 0) for r in fold_rows),
        "presence_n": sum(r.get("presence_n", 0) for r in fold_rows),
        "min_bme_voxels": first.get("min_bme_voxels", 50),
        "model_arch": first.get("model_arch"),
        "cnet_threshold": first.get("cnet_threshold"),
        "cnet_soft": first.get("cnet_soft", True),
        "cnet_temperature": first.get("cnet_temperature", 1.0),
        "bme_threshold": first.get("bme_threshold"),
        "norm_type": first.get("norm_type", "instance"),
        "gaussian_window": first.get("gaussian_window", True),
        "tversky_beta": first.get("tversky_beta", 0.5),
        "aniso": first.get("aniso", False),
        "val_tta": first.get("val_tta", False),
        "n4": first.get("n4", False),
        "base_channels": first.get("base_channels", 16),
        "double_conv": first.get("double_conv", False),
        "amp_skipped_steps_total": total_skipped,
        "amp_skipped_pct_mean": round(mean_skipped_pct, 4),
        "per_fold": fold_rows,

        "merged_at": datetime.now(timezone.utc).isoformat(),
        "note": (
            f"{n_cases} volumes ({n_bme} with edema, {n_neg} without), "
            f"{len(fold_rows)} {fold_mode} folds, patch {patch_used[0]}x{patch_used[1]}x{patch_used[2]}. "
            "Bone and edema are trained together. Edema outside the predicted bone is removed. "
            "Dice, lesion sensitivity, and false positives per case are mean ± std across folds."
        ),
    }
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    print(f"[OK] Successfully merged {len(fold_rows)} folds into {out_dir / 'metrics.json'}:", flush=True)
    for key, s in metrics["summary"].items():
        if s:
            print(f"  {key:<20}: {s['mean']:.4f} \u00b1 {s['std']:.4f}", flush=True)
    if total_skipped > 0:
        print(f"  amp_skipped_steps   : {total_skipped} ({mean_skipped_pct:.2f}%)", flush=True)
        if mean_skipped_pct > 1.0:
            print("[WARNING] AMP skipped steps exceeded 1% of total steps!", flush=True)
    return metrics


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base", nargs="?", default=".")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--model", choices=("unet", "attention-unet"), default="unet")
    ap.add_argument("--out", default="", help="folder under data/. Default depends on the model.")
    ap.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    # Defaults reproduce the laptop run. The H200 job (ml/slurm/train_3d.sbatch) raises them.
    ap.add_argument("--width", type=int, default=16, help="channels in the first layer")
    ap.add_argument("--patch", default="96,96,12", help="x,y,z, each divisible by 4")
    ap.add_argument("--patches-per-case", type=int, default=PATCHES_PER_CASE)
    ap.add_argument("--batch", "--batch-size", dest="batch", type=int, default=1,
                    help="patches per optimiser step")
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--resample", "--resample-patches-each-epoch", dest="resample", action="store_true",
                    help="keep scans in memory and cut fresh patches every epoch (needs RAM; "
                         "needs --out or --out-dir that is not the baseline)")
    ap.add_argument("--augment", action="store_true", help="in-plane flips and intensity jitter")
    ap.add_argument("--amp", action="store_true", help="bfloat16 autocast on CUDA")
    ap.add_argument("--cosine", action="store_true", help="cosine learning-rate decay per fold")
    ap.add_argument("--hours", type=float, default=0.0,
                    help="training time budget across all folds; epochs are fitted to it (0 = off)")
    ap.add_argument("--max-cases", type=int, default=0, help="smoke tests only")
    ap.add_argument("--out-dir", type=str, default=None,
                    help="full output folder. Data experiments must point outside data/")
    ap.add_argument("--resume", action="store_true", help="Resume from latest checkpoints")
    ap.add_argument("--checkpoint-every-epoch", action="store_true", help="Save latest checkpoint per epoch")
    ap.add_argument("--quick-test", action="store_true", help="Run fast 2-epoch 2-fold test")
    ap.add_argument("--fold", type=int, default=None, help="Train only a specific fold index")
    ap.add_argument("--show-ids", action="store_true", help="Print patient/case IDs in logs (default: anonymized counts)")
    ap.add_argument("--profile", action="store_true", help="Profile per-epoch time breakdown (data, train, save, val)")
    ap.add_argument("--cudnn-benchmark", action="store_true", help="Enable cuDNN auto-tuner (fast on static patch sizes)")
    ap.add_argument("--channels-last-3d", action="store_true", help="Use channels_last_3d memory format")
    ap.add_argument("--val-batch-size", type=int, default=1, help="Validation sliding window batch size (default: 1)")
    ap.add_argument("--merge-metrics", action="store_true", help="Merge per-fold metrics files and exit")
    ap.add_argument("--independent-fold-seeds", action="store_true", help="Seed each fold with SEED + fold (default: False)")
    ap.add_argument("--run-folds", nargs="+", type=int, default=None, help="Explicit list of fold indices to run (e.g. --run-folds 0 1)")
    ap.add_argument("--skip-completed", dest="skip_completed", action="store_true", default=True, help="Skip folds whose completed checkpoint and metrics match config (default: True)")
    ap.add_argument("--no-skip-completed", dest="skip_completed", action="store_false", help="Do not skip completed folds")
    ap.add_argument("--max-runtime-minutes", type=float, default=None, help="Maximum training runtime in minutes before clean checkpoint and exit")
    ap.add_argument("--aug-flip", action="store_true",
                    help="Left-right flip on axis 1 (3D augmentation set, separate from --augment)")
    ap.add_argument("--aug-intensity", action="store_true",
                    help="Intensity scale [0.9, 1.1] and shift [-0.05, 0.05]")
    ap.add_argument("--aug-noise", action="store_true",
                    help="Additive Gaussian noise (sigma=0.01)")
    ap.add_argument("--legacy-case-folds", action="store_true",
                    help="Reproduce legacy case-level fold assignment instead of patient grouping")
    ap.add_argument("--allow-case-level-folds", action="store_true",
                    help="Allow case-level folds if patient_id is missing or blank in worklist.csv")
    ap.add_argument("--sampling-mix", type=str, default="lesion=0.7,bone=0.0,random=0.3",
                    help="Patch sampling proportions: lesion=A,bone=B,random=C (fractions summing to 1.0)")
    # Architecture & experimental options:
    ap.add_argument("--min-bme-voxels", type=int, default=50,
                    help="Minimum connected component volume in voxels for BME lesions (default: 50)")
    ap.add_argument("--base-channels", type=int, default=16,
                    help="Base channel width for UNet3D (default: 16; use 32 for higher capacity)")
    ap.add_argument("--double-conv", action="store_true",
                    help="Use dual conv layers per resolution block in UNet3D")
    ap.add_argument("--eval-only", action="store_true",
                    help="Run validation evaluation on existing fold checkpoints without training")
    ap.add_argument("--model-arch", type=str, default="mednext", choices=["unet3d", "cnet_dual_unet", "cnet_attention_unet", "mednext", "orthogate_mednext", "attention-unet"],
                    help="Model architecture: 'orthogate_mednext', 'mednext', 'cnet_dual_unet', 'cnet_attention_unet', 'attention-unet', or 'unet3d'")
    ap.add_argument("--cnet-weight", type=float, default=0.5,
                    help="Loss weight for C-Net binary presence classification (default: 0.5)")
    ap.add_argument("--cnet-threshold", type=float, default=0.30,
                    help="Presence threshold for C-Net gatekeeper (default: 0.30)")
    ap.add_argument("--cnet-soft", dest="cnet_soft", action="store_true", default=True,
                    help="Use smooth ramp C-Net gatekeeper instead of hard zero cutoff (default: True)")
    ap.add_argument("--no-cnet-soft", dest="cnet_soft", action="store_false",
                    help="Use legacy binary C-Net hard cutoff")
    ap.add_argument("--cnet-temperature", type=float, default=1.0,
                    help="Logit temperature scaling for calibrated C-Net probability (default: 1.0)")
    ap.add_argument("--bme-loss-weight", type=float, default=2.5,
                    help="Loss weight for BME edema class to address class imbalance (default: 2.5)")
    ap.add_argument("--tversky-alpha", type=float, default=None,
                    help="Tversky FP weight on edema (default: 0.3 for orthogate_mednext, 0.5 otherwise)")
    ap.add_argument("--tversky-beta", type=float, default=None,
                    help="Tversky FN weight on edema (default: 0.7 for orthogate_mednext, 0.5 otherwise)")
    ap.add_argument("--gaussian-window", dest="gaussian_window", action="store_true", default=True,
                    help="Weight sliding-window predictions with a 3D Gaussian center kernel (default: True)")
    ap.add_argument("--no-gaussian-window", dest="gaussian_window", action="store_false",
                    help="Disable Gaussian window weighting in sliding-window stitching")
    ap.add_argument("--deep-supervision", dest="deep_supervision", action="store_true", default=True,
                    help="Enable auxiliary decoder deep-supervision loss when supported (default: True)")
    ap.add_argument("--no-deep-supervision", dest="deep_supervision", action="store_false",
                    help="Disable deep-supervision auxiliary loss")
    ap.add_argument("--bme-threshold", type=float, default=0.50,
                    help="Probability threshold for BME edema segmentation (default: 0.50)")
    ap.add_argument("--spacing", type=str, default="0.5,0.5,3.0",
                    help="Physical voxel spacing in mm for isotropic standardization (default: 0.5,0.5,3.0; '0' or 'none' for native grid)")
    ap.add_argument("--aniso", action="store_true",
                    help="first pooling level in-plane only, for thick-slice stacks")
    ap.add_argument("--aug-spatial", action="store_true",
                    help="in-plane rotation +-30 deg and zoom 0.7-1.4, slice-wise (needs --resample)")
    ap.add_argument("--aug-p-rot", type=float, default=0.5,
                    help="probability of in-plane rotation per patch (default: 0.5)")
    ap.add_argument("--aug-p-scale", type=float, default=0.5,
                    help="probability of in-plane scaling per patch (default: 0.5)")
    ap.add_argument("--norm-type", type=str, default="instance", choices=["instance", "batch", "group"],
                    help="Normalization layer for CNetDualUNet3D: 'instance' (default), 'batch', or 'group'")
    ap.add_argument("--n4", action="store_true",
                    help="Apply fast downsampled SimpleITK N4 bias-field correction during normalization")
    ap.add_argument("--val-tta", action="store_true",
                    help="Average original and left-right flipped volume probabilities at validation/inference")
    ap.add_argument("--calibrate-cnet", action="store_true",
                    help="Calibrate per-fold C-Net threshold strictly on training-fold cases (zero val leakage)")
    ap.add_argument("--calibrate-bme", action="store_true",
                    help="Calibrate per-fold BME voxel threshold strictly on training-fold positives (zero val leakage)")
    args = ap.parse_args()
    if args.aug_spatial and not args.resample:
        raise SystemExit("--aug-spatial cuts fresh rotated patches each epoch; add --resample")
    patch = tuple(int(v) for v in args.patch.split(","))
    if len(patch) != 3 or any(p % 4 for p in patch):
        raise SystemExit(f"--patch must be three numbers divisible by 4, got {args.patch}")
    started = time.monotonic()


    random.seed(SEED)
    np.random.seed(SEED)
    torch.manual_seed(SEED)

    base = Path(args.base)
    out_name = args.out or ("results3d" if args.model == "unet" else "results3d-attn")

    try:
        sampling_mix_dict = parse_sampling_mix(args.sampling_mix)
    except ValueError as e:
        raise SystemExit(f"[ERROR] {e}")

    is_data_experiment = bool(
        args.resample or args.augment or
        args.aug_flip or args.aug_intensity or args.aug_noise or
        args.spacing or args.aniso or args.aug_spatial or
        args.n4 or (args.norm_type != "instance") or
        (args.sampling_mix != "lesion=0.7,bone=0.0,random=0.3")
    )
    baseline_names = ("results3d", "results3d-attn")
    if is_data_experiment and not args.out_dir:
        if out_name in baseline_names:
            raise SystemExit(
                "[ERROR] Output isolation violation: data experiment runs must not overwrite the baseline. "
                "Pass --out NAME (not results3d or results3d-attn), or --out-dir OUTSIDE data/ "
                "(e.g. --out-dir ../results3d_exp or /kaggle/working/results3d_exp)."
            )
    if is_data_experiment and args.out_dir:
        resolved_out = Path(args.out_dir).resolve()
        resolved_data = (base / "data").resolve()
        if (
            resolved_out == resolved_data or
            resolved_data in resolved_out.parents or
            "data/results3d" in str(args.out_dir).replace("\\", "/") or
            resolved_out == (resolved_data / "results3d")
        ):
            raise SystemExit(
                f"[ERROR] Output isolation violation: --out-dir ({resolved_out}) is inside data/. "
                "Experiment runs must write to a directory outside data/ to protect baseline results."
            )

    data_config = {
        "resample_patches_each_epoch": bool(args.resample),
        "augment": bool(args.augment),
        "aug_flip": bool(args.aug_flip),
        "aug_intensity": bool(args.aug_intensity),
        "aug_noise": bool(args.aug_noise),
        "sampling_mix": sampling_mix_dict,
    }
    # Only recorded when used, so fingerprints of earlier runs stay valid.
    tgt_spacing = parse_target_spacing(args.spacing)
    if tgt_spacing:
        data_config["spacing_mm"] = list(tgt_spacing)
    if args.aniso:
        data_config["aniso"] = True
    if args.aug_spatial:
        data_config["aug_spatial"] = True
    if args.n4:
        data_config["n4"] = True
    eff_norm_type = "group" if (args.model_arch == "orthogate_mednext" and args.norm_type == "instance") else args.norm_type
    eff_tversky_alpha = float(args.tversky_alpha) if args.tversky_alpha is not None else (0.3 if args.model_arch == "orthogate_mednext" else 0.5)
    eff_tversky_beta = float(args.tversky_beta) if args.tversky_beta is not None else (0.7 if args.model_arch == "orthogate_mednext" else 0.5)
    if eff_norm_type != "instance":
        data_config["norm_type"] = eff_norm_type

    out_dir = Path(args.out_dir) if args.out_dir else base / "data" / out_name

    if args.merge_metrics:
        merge_metrics_files(out_dir, args.folds)
        return

    ann = None
    for candidate in [
        base / "data" / "annotations",
        base / "annotations",
        base / "bme_dataset_bundle" / "data" / "annotations",
        base / "bme_dataset_bundle" / "annotations",
    ]:
        if candidate.is_dir():
            ann = candidate
            break
    if ann is None:
        cands = [p for p in base.rglob("annotations") if p.is_dir()]
        ann = cands[0] if cands else None

    case_ids = []
    if ann and ann.is_dir():
        for d in ann.iterdir():
            if d.is_dir():
                if list(d.glob("*_labels.nii*")) or list(d.glob("*.seg.nrrd")):
                    case_ids.append(d.name)
        case_ids.sort()

    if not case_ids:
        all_labels = list(base.rglob("*_labels.nii*")) + list(base.rglob("*.seg.nrrd"))
        case_ids = sorted(list({p.parent.name for p in all_labels if p.is_file()}))

    if not case_ids:
        raise SystemExit(f"No 3D annotations found under {base}. Paint and save a case on the Annotate page first.")

    if args.max_cases:
        case_ids = case_ids[: args.max_cases]

    if args.quick_test:
        case_ids = case_ids[:min(len(case_ids), 4)]
        args.epochs = min(args.epochs, 2)
        args.folds = min(args.folds, 2)
        print(f"[QUICK TEST] Smoke test mode: {len(case_ids)} cases, {args.epochs} epochs, {args.folds} folds.", flush=True)

    t_pipeline_start = time.time()
    classes, patients = load_worklist_metadata(base)
    print("Loading volumes", flush=True)
    print("One scan at a time. Only the training patches are kept, then the volume is released.", flush=True)
    rng_load = np.random.default_rng(SEED)
    cases = []
    t_load_start = time.time()
    t_sampling_total = 0.0
    for n, cid in enumerate(case_ids, start=1):
        print(f"Reading scan {n}/{len(case_ids)}. Cutting patches, then releasing the scan.", flush=True)
        item = load_case(base, cid, n4=args.n4)
        if not item:
            continue
        if tgt_spacing:
            item["image"], item["labels"] = to_spacing(item["image"], item["labels"], item["spacing"], tgt_spacing)
            item["bme_voxels"] = int((item["labels"] == 2).sum())
        image = pad_volume(item["image"], patch)
        labels = pad_volume(item["labels"], patch)
        case = {
            "id": item["id"],
            "patient_id": patients.get(item["id"], "").strip(),
            "cls": classes.get(item["id"], ""),
            "bme_voxels": item["bme_voxels"],
        }
        if args.resample:
            # float16 halves the RAM; patches are cast back to float32 when cut.
            case["image"] = image.astype(np.float16)
            case["labels"] = labels
            case["lesion_pts"] = np.argwhere(labels == 2).astype(np.int32)
        else:
            t_s0 = time.time()
            patches, patch_labels = [], []
            for _ in range(args.patches_per_case):
                origin = sample_origin(image.shape, labels, rng_load, sampling_mix_dict, patch)
                patches.append(np.ascontiguousarray(crop(image, origin, patch)))
                patch_labels.append(np.ascontiguousarray(crop(labels, origin, patch)))
            t_sampling_total += (time.time() - t_s0)
            case["patches"] = patches
            case["patch_labels"] = patch_labels
        cases.append(case)
        del item, image, labels
        release()
    t_load_total = max(0.0, (time.time() - t_load_start) - t_sampling_total)
    if len(cases) < 2:
        raise SystemExit(f"Need at least 2 annotated volumes to hold one out. Found {len(cases)}.")

    n_bme = sum(1 for c in cases if c["bme_voxels"] > 0)
    n_neg = len(cases) - n_bme
    folds_n = max(2, min(args.folds, len(cases)))

    # Fold assignment logic
    if args.legacy_case_folds:
        fold_mode = "legacy_case_level"
        for c in cases:
            if not c.get("patient_id"):
                c["patient_id"] = c["id"]
        order = cases[:]
        random.Random(SEED).shuffle(order)
        groups: list[list[dict]] = [[] for _ in range(folds_n)]
        for i, case in enumerate(order):
            groups[i % folds_n].append(case)
        patient_count = len(set(c["patient_id"] for c in cases))
    else:
        missing_patients = [c["id"] for c in cases if not c.get("patient_id")]
        if missing_patients:
            if not args.allow_case_level_folds:
                raise SystemExit(
                    f"[ERROR] Found {len(missing_patients)} cases with missing or blank patient_id in worklist.csv. "
                    "Patient-grouped folds cannot be formed safely without patient IDs. "
                    "To allow case-level splits, pass --allow-case-level-folds, or use --legacy-case-folds."
                )
            fold_mode = "case_level_stratified"
            for c in cases:
                if not c.get("patient_id"):
                    c["patient_id"] = c["id"]
        else:
            fold_mode = "patient_grouped_stratified"

        # 1. Group cases by patient so same-patient scans never leak across train and val
        patient_to_cases: dict[str, list[dict]] = {}
        for case in cases:
            pid = case["patient_id"]
            if pid not in patient_to_cases:
                patient_to_cases[pid] = []
            patient_to_cases[pid].append(case)

        # Sort cases within each patient group by case ID for determinism
        for pid in patient_to_cases:
            patient_to_cases[pid].sort(key=lambda c: c["id"])

        # 2. Stratify unique patients into negative controls + 3 lesion-size tertile bins
        unique_patient_ids = sorted(patient_to_cases.keys())
        rng_patients = random.Random(SEED)
        neg_pids = [
            pid for pid in unique_patient_ids
            if sum(c["bme_voxels"] for c in patient_to_cases[pid]) == 0
        ]
        pos_pids = sorted(
            [
                pid for pid in unique_patient_ids
                if sum(c["bme_voxels"] for c in patient_to_cases[pid]) > 0
            ],
            key=lambda pid: (sum(c["bme_voxels"] for c in patient_to_cases[pid]), pid),
        )
        n_pos = len(pos_pids)
        b1, b2 = n_pos // 3, (2 * n_pos) // 3
        strata = [neg_pids, pos_pids[:b1], pos_pids[b1:b2], pos_pids[b2:]]

        # 3. Shuffle within each stratum with SEED and distribute evenly across folds
        groups = [[] for _ in range(folds_n)]
        fold_cursor = 0
        for stratum in strata:
            s_pids = list(stratum)
            rng_patients.shuffle(s_pids)
            for pid in s_pids:
                groups[fold_cursor % folds_n].extend(patient_to_cases[pid])
                fold_cursor += 1

        patient_count = len(unique_patient_ids)

    print(
        f"{len(cases)} volumes across {patient_count} patients ({n_bme} with edema, {n_neg} without). "
        f"Using {folds_n} {fold_mode} folds. Seed {SEED}.",
        flush=True,
    )
    print(
        f"Patch {patch[0]}×{patch[1]}×{patch[2]} on "
        f"{f'a {args.spacing} mm in-plane grid' if args.spacing else 'the original voxel grid'}"
        f"{', in-plane-first pooling' if args.aniso else ''}"
        f"{', rotation/zoom' if args.aug_spatial else ''}, "
        f"{args.patches_per_case} patches per case per epoch"
        f"{' (fresh every epoch)' if args.resample else ''}, width {args.width}, batch {args.batch}"
        f"{', augmented' if args.augment else ''}. "
        "Edema outside predicted bone is removed.",
        flush=True,
    )

    device = resolve_device(args.device)
    guard_device(device, cudnn_benchmark=args.cudnn_benchmark)
    print(f"device {device}", flush=True)
    loss_config = {"type": "dice_focal", "bone_weight": 1.0, "edema_weight": 1.0}
    current_fingerprint, fingerprint_payload = compute_dataset_fingerprint(
        case_ids=[c["id"] for c in cases],
        groups=groups,
        batch_size=args.batch,
        patches_per_case=args.patches_per_case,
        lesion_sampling_ratio=0.7,
        learning_rate=args.lr,
        loss_config=loss_config,
        independent_fold_seeds=bool(args.independent_fold_seeds),
        data_flags=data_config,
        fold_mode=fold_mode,
        patient_count=patient_count,
        sampling_mix=sampling_mix_dict,
        arch={"model": args.model, "width": args.width, "patch": list(patch)},
    )
    print(f"Dataset fingerprint: {current_fingerprint[:16]}... ({len(cases)} cases, {folds_n} folds, mode: {fold_mode})", flush=True)

    out_dir.mkdir(parents=True, exist_ok=True)

    partial_path = out_dir / "metrics_partial.json"
    fold_rows = []
    if args.resume and partial_path.exists():
        try:
            fold_rows = json.loads(partial_path.read_text(encoding="utf-8"))
        except Exception:
            fold_rows = []

    epoch_times = []
    use_amp = args.amp and (device == "cuda")

    if args.run_folds is not None:
        folds_to_run = [f for f in args.run_folds if 0 <= f < folds_n]
    elif args.fold is not None:
        folds_to_run = [args.fold]
    else:
        folds_to_run = list(range(folds_n))

    t_train_accum = 0.0
    t_val_accum = 0.0
    t_save_accum = 0.0
    time_guard_triggered = False

    for fold in folds_to_run:
        val = groups[fold]
        if args.independent_fold_seeds:
            random.seed(SEED + fold)
            np.random.seed(SEED + fold)
            torch.manual_seed(SEED + fold)

        final_ckpt = out_dir / f"fold_{fold}.pt"
        final_metric = out_dir / f"metrics_fold_{fold}.json"
        should_check_skip = (not args.eval_only) and args.skip_completed and (final_ckpt.exists() or final_metric.exists())
        if should_check_skip and final_ckpt.exists():

            try:
                ckpt = torch.load(final_ckpt, map_location="cpu", weights_only=False)
                ckpt_seed = ckpt.get("seed")
                ckpt_patch = ckpt.get("patch")
                ckpt_data_cfg = ckpt.get("data_config")
                ckpt_fp = ckpt.get("fingerprint")
                ckpt_val_cases = ckpt.get("val_cases")

                m_epochs = None
                if final_metric.exists():
                    try:
                        m_row = json.loads(final_metric.read_text(encoding="utf-8"))
                        m_epochs = m_row.get("epochs")
                        m_seed = m_row.get("seed")
                        if m_seed is not None and ckpt_seed is None:
                            ckpt_seed = m_seed
                        if ckpt_fp is None:
                            ckpt_fp = m_row.get("fingerprint")
                        if ckpt_val_cases is None:
                            ckpt_val_cases = m_row.get("val_cases") or m_row.get("val")
                    except Exception:
                        pass

                mismatches = []
                if ckpt_seed is not None and ckpt_seed != SEED:
                    mismatches.append(f"seed (saved {ckpt_seed} != current {SEED})")
                if ckpt_patch is not None and list(ckpt_patch) != list(patch):
                    mismatches.append(f"patch shape (saved {ckpt_patch} != current {list(patch)})")
                if ckpt.get("width") is not None and ckpt["width"] != args.width:
                    mismatches.append(f"width (saved {ckpt['width']} != current {args.width})")
                if ckpt.get("model") is not None and ckpt["model"] != args.model:
                    mismatches.append(f"model (saved {ckpt['model']} != current {args.model})")
                if ckpt_data_cfg is not None and ckpt_data_cfg != data_config:
                    mismatches.append(f"data_config (saved {ckpt_data_cfg} != current {data_config})")
                if m_epochs is not None and args.hours <= 0 and m_epochs != args.epochs:
                    mismatches.append(f"epochs (saved {m_epochs} != current {args.epochs})")
                ckpt_fold_mode = ckpt.get("fold_mode")
                if ckpt_fold_mode is not None and ckpt_fold_mode != fold_mode:
                    mismatches.append(f"fold_mode (saved {ckpt_fold_mode} != current {fold_mode})")
                if ckpt_fp is not None and ckpt_fp != current_fingerprint:
                    mismatches.append(f"dataset fingerprint (saved {ckpt_fp} != current {current_fingerprint})")
                current_val = sorted([c["id"] for c in val])
                if ckpt_val_cases is not None and sorted(ckpt_val_cases) != current_val:
                    mismatches.append(f"val_cases (saved {ckpt_val_cases} != current {current_val})")
                ckpt_arch = ckpt.get("model_arch")
                if ckpt_arch is not None and ckpt_arch != args.model_arch:
                    mismatches.append(f"model_arch (saved {ckpt_arch} != current {args.model_arch})")

                if mismatches:
                    raise ValueError(
                        f"[ERROR] Refusing to skip completed fold {fold}: recorded configuration mismatch in existing checkpoint {final_ckpt.name}!\n"
                        f"  Mismatches: {'; '.join(mismatches)}.\n"
                        "  To test a different configuration, specify a separate --out-dir or remove obsolete checkpoints."
                    )

                print(f"fold {fold}: already completed ({final_ckpt.name} verified: seed={SEED}, epochs={args.epochs}), skipping training.", flush=True)
                if not any(r.get("fold") == fold for r in fold_rows):
                    if final_metric.exists():
                        try:
                            m_data = json.loads(final_metric.read_text(encoding="utf-8"))
                            fold_rows.append(m_data)
                        except Exception:
                            pass
                    else:
                        m_file = out_dir / "metrics.json"
                        if m_file.exists():
                            try:
                                m_data = json.loads(m_file.read_text(encoding="utf-8"))
                                for r in m_data.get("per_fold", []):
                                    if r.get("fold") == fold:
                                        fold_rows.append(r)
                                        break
                            except Exception:
                                pass
                continue
            except ValueError:
                raise
            except Exception as e:
                print(f"fold {fold}: could not verify existing checkpoint ({e}), training fresh.", flush=True)

        if args.eval_only:
            if not final_ckpt.exists():
                print(f"fold {fold}: checkpoint {final_ckpt.name} not found, skipping eval.", flush=True)
                continue
            ckpt = torch.load(final_ckpt, map_location=device, weights_only=False)
            ckpt_arch = ckpt.get("model_arch", args.model_arch)
            ckpt_bc = ckpt.get("base_channels", args.base_channels)
            ckpt_dc = ckpt.get("double_conv", args.double_conv)
            ckpt_aniso = bool(ckpt.get("aniso", args.aniso))
            ckpt_norm = ckpt.get("norm_type", args.norm_type)
            model = build_model(arch=ckpt_arch, base_channels=ckpt_bc, double_conv=ckpt_dc, aniso=ckpt_aniso, norm_type=ckpt_norm).to(device)
            if args.channels_last_3d:
                model = model.to(memory_format=torch.channels_last_3d)
            model.load_state_dict(ckpt["state"])
            total = 0.0
            steps = 0
            amp_skipped_total = 0
            total_steps_fold = 0
            train = []
            start_epoch = args.epochs + 1
            opt = None
            scaler = None
            print(f"fold {fold}: loaded {final_ckpt.name} for eval-only validation (arch={ckpt_arch}, min_bme_voxels={args.min_bme_voxels})", flush=True)
        else:
            train = [c for g in groups if g is not val for c in g]
            if args.show_ids:
                print(f"fold {fold}: train {[c['id'] for c in train]}  val {[c['id'] for c in val]}", flush=True)
            else:
                print(f"fold {fold}: train {len(train)} cases  val {len(val)} cases (arch={args.model_arch})", flush=True)

            arch = args.model_arch if hasattr(args, "model_arch") else ("attention-unet" if getattr(args, "model", "") == "attention-unet" else "unet3d")
            base_channels = args.base_channels if args.base_channels != 16 else getattr(args, "width", 16)
            double_conv = getattr(args, "double_conv", False)
            aniso = getattr(args, "aniso", False)
            model = build_model(arch=arch, base_channels=base_channels, double_conv=double_conv, aniso=aniso, norm_type=eff_norm_type).to(device)
            if args.channels_last_3d:
                model = model.to(memory_format=torch.channels_last_3d)

            opt = torch.optim.Adam(model.parameters(), lr=args.lr)
            scaler = torch.cuda.amp.GradScaler() if use_amp else None
            start_epoch = 1

        latest_ckpt = out_dir / f"fold_{fold}_latest.pt"

        if (not args.eval_only) and args.resume and latest_ckpt.exists():
            try:
                ckpt = torch.load(latest_ckpt, map_location=device, weights_only=False)
                ckpt_data_cfg = ckpt.get("data_config")
                ckpt_fp = ckpt.get("fingerprint")
                ckpt_val_cases = ckpt.get("val_cases")
                ckpt_fold_mode = ckpt.get("fold_mode")
                ckpt_arch = ckpt.get("model_arch")
                if ckpt_arch is not None and ckpt_arch != args.model_arch:
                    raise ValueError(
                        f"Cannot resume fold {fold}: checkpoint {latest_ckpt.name} model_arch {ckpt_arch} != current {args.model_arch}."
                    )
                if ckpt_fold_mode is not None and ckpt_fold_mode != fold_mode:
                    raise ValueError(
                        f"Cannot resume fold {fold}: checkpoint {latest_ckpt.name} fold_mode {ckpt_fold_mode} != current {fold_mode}."
                    )
                if ckpt_data_cfg is not None and ckpt_data_cfg != data_config:
                    raise ValueError(
                        f"Cannot resume fold {fold}: checkpoint {latest_ckpt.name} was trained with data_config={ckpt_data_cfg}, "
                        f"but current run specifies {data_config}. To test a new experiment, train in a separate --out-dir."
                    )
                if ckpt_fp is not None and ckpt_fp != current_fingerprint:
                    raise ValueError(
                        f"Cannot resume fold {fold}: checkpoint {latest_ckpt.name} has dataset fingerprint {ckpt_fp}, "
                        f"but current run specifies {current_fingerprint}. Refusing to resume with mismatched data/config."
                    )
                current_val = sorted([c["id"] for c in val])
                if ckpt_val_cases is not None and sorted(ckpt_val_cases) != current_val:
                    raise ValueError(
                        f"Cannot resume fold {fold}: checkpoint {latest_ckpt.name} validation cases {ckpt_val_cases} != current {current_val}."
                    )
                if ckpt.get("width") is not None and ckpt["width"] != args.width:
                    raise ValueError(
                        f"Cannot resume fold {fold}: checkpoint {latest_ckpt.name} width {ckpt['width']} != current {args.width}."
                    )
                model.load_state_dict(ckpt["state"])
                if "opt" in ckpt:
                    opt.load_state_dict(ckpt["opt"])
                start_epoch = int(ckpt.get("epoch", 0)) + 1
                print(f"fold {fold}: resumed from epoch {start_epoch - 1} ({latest_ckpt.name})", flush=True)
            except ValueError:
                raise
            except Exception as e:
                print(f"fold {fold}: failed to resume latest checkpoint ({e}), starting fresh", flush=True)
                start_epoch = 1

        amp_skipped_total = 0
        total_steps_fold = 0
        total = 0.0
        steps = 0

        fold_epochs = args.epochs
        fold_pos = folds_to_run.index(fold)
        if args.hours > 0:
            # Whatever is left of the budget, shared by the folds not yet trained.
            left = args.hours * 3600 - (time.monotonic() - started)
            fold_budget = max(60.0, left / (len(folds_to_run) - fold_pos))
        fold_start = time.monotonic()

        do_flip = bool(args.aug_flip)
        do_intensity = bool(args.aug_intensity)
        do_noise = bool(args.aug_noise)
        has_aug3d = do_flip or do_intensity or do_noise

        epoch = start_epoch - 1
        while epoch < fold_epochs:
            epoch += 1
            t_ep_start = time.time()
            t_data_total = 0.0
            t_train_total = 0.0
            if args.cosine and fold_epochs > 1:
                lr = 1e-5 + (args.lr - 1e-5) * 0.5 * (1 + math.cos(math.pi * (epoch - 1) / (fold_epochs - 1)))
                for g in opt.param_groups:
                    g["lr"] = lr
            model.train()
            total = 0.0
            steps = 0
            amp_skipped_epoch = 0
            seed_base = (SEED + fold) if args.independent_fold_seeds else SEED
            rng_epoch_data = np.random.default_rng(np.random.SeedSequence([seed_base, fold, epoch]))

            t_d0 = time.time()
            order_cases = train[:]
            random.shuffle(order_cases)
            items = []
            for case in order_cases:
                if args.resample:
                    for _ in range(args.patches_per_case):
                        origin = sample_origin(case["image"].shape, case["labels"], rng_epoch_data,
                                               sampling_mix_dict, patch, case["lesion_pts"])
                        if args.aug_spatial:
                            items.append(spatial_crop(case["image"], case["labels"], origin, patch, rng_epoch_data, p_rot=args.aug_p_rot, p_scale=args.aug_p_scale))
                        else:
                            items.append((crop(case["image"], origin, patch).astype(np.float32),
                                          crop(case["labels"], origin, patch)))
                else:
                    items.extend(zip(case["patches"], case["patch_labels"]))
            random.shuffle(items)
            if has_aug3d:
                items = [
                    apply_augmentation(im, lb, rng_epoch_data,
                                       do_flip=do_flip, do_intensity=do_intensity, do_noise=do_noise)
                    for im, lb in items
                ]
            if args.augment:
                items = [augment(im, lb, rng_epoch_data) for im, lb in items]
            t_data_total += (time.time() - t_d0)

            for i in range(0, len(items), args.batch):
                chunk = items[i: i + args.batch]
                t_d0 = time.time()
                x = torch.from_numpy(np.stack([im for im, _ in chunk])).float().unsqueeze(1).to(device)
                if args.channels_last_3d:
                    x = x.to(memory_format=torch.channels_last_3d)
                lab = torch.from_numpy(np.stack([lb for _, lb in chunk])).to(device)
                t_data_total += (time.time() - t_d0)

                t_tr0 = time.time()
                opt.zero_grad(set_to_none=True)
                total_steps_fold += 1
                has_cnet = hasattr(model, "cnet")
                has_aux = bool(args.deep_supervision and hasattr(model, "ds2"))
                amp_ctx = torch.amp.autocast(device_type="cuda") if use_amp else contextlib.nullcontext()
                cnet_logit = None
                aux_logits: list[torch.Tensor] = []

                with amp_ctx:
                    if has_aux:
                        logits, cnet_logit, aux_logits = model(x, return_cnet=True, return_aux=True)
                    elif has_cnet:
                        logits, cnet_logit = model(x, return_cnet=True)
                    else:
                        logits = model(x)

                logits_fp32 = logits.float()
                loss_seg = logits_fp32.new_zeros(())
                batch_tgts = [targets(lab[b]) for b in range(len(chunk))]
                for b, (tgt, valid) in enumerate(batch_tgts):
                    loss_seg = loss_seg + dice_focal(
                        logits_fp32[b],
                        tgt,
                        valid,
                        bme_weight=args.bme_loss_weight,
                        tversky_alpha=eff_tversky_alpha,
                        tversky_beta=eff_tversky_beta,
                    )
                loss_seg = loss_seg / len(chunk)

                if aux_logits:
                    aux_loss = logits_fp32.new_zeros(())
                    for aux in aux_logits:
                        aux_fp32 = aux.float()
                        for b, (tgt, valid) in enumerate(batch_tgts):
                            aux_loss = aux_loss + dice_focal(
                                aux_fp32[b],
                                tgt,
                                valid,
                                bme_weight=args.bme_loss_weight,
                                tversky_alpha=eff_tversky_alpha,
                                tversky_beta=eff_tversky_beta,
                            )
                    loss_seg = loss_seg + 0.3 * (aux_loss / (len(chunk) * len(aux_logits)))

                if has_cnet and cnet_logit is not None:
                    has_bme = torch.stack([((lb == 2).sum() > 0).float() for lb in lab]).to(device).view(-1)
                    loss_cnet = nn.functional.binary_cross_entropy_with_logits(
                        cnet_logit.view(-1).float(),
                        has_bme.float(),
                    )
                    loss = loss_seg + args.cnet_weight * loss_cnet
                else:
                    loss = loss_seg

                if use_amp and not torch.isfinite(loss):
                    amp_skipped_epoch += 1
                    amp_skipped_total += 1
                    continue

                if scaler:
                    scale_before = scaler.get_scale()
                    scaler.scale(loss).backward()
                    scaler.unscale_(opt)
                    torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
                    scaler.step(opt)
                    scaler.update()
                    scale_after = scaler.get_scale()
                    if scale_after < scale_before:
                        amp_skipped_epoch += 1
                        amp_skipped_total += 1
                else:
                    loss.backward()
                    torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
                    opt.step()

                total += float(loss.detach())
                steps += 1
                t_tr_delta = time.time() - t_tr0
                t_train_total += t_tr_delta
                t_train_accum += t_tr_delta
                del x, lab, logits, loss
            del items

            if args.hours > 0 and epoch == start_epoch:
                per_epoch = time.monotonic() - fold_start
                fold_epochs = int(max(2, min(args.epochs, fold_budget // max(per_epoch, 1e-3))))
                print(
                    f"fold {fold}: one epoch takes {per_epoch:.0f}s; "
                    f"fitting {fold_epochs} epochs into {fold_budget / 60:.0f} min.",
                    flush=True,
                )
            if args.hours > 0:
                run_steps = len(folds_to_run) * fold_epochs
                done = fold_pos * fold_epochs + epoch
                bar_w = 24
                fill = int(bar_w * min(done, run_steps) / run_steps)
                print(
                    f"[{'#' * fill}{'.' * (bar_w - fill)}] {done}/{run_steps}  "
                    f"fold {fold + 1}/{folds_n}  epoch {epoch}/{fold_epochs}  "
                    f"learning bone and edema  loss={total / max(steps, 1):.4f}",
                    flush=True,
                )

            t_save_start = time.time()
            if args.checkpoint_every_epoch or args.max_runtime_minutes is not None:
                torch.save(
                    {
                        "epoch": epoch,
                        "state": model.state_dict(),
                        "opt": opt.state_dict(),
                        "patch": list(patch),
                        "width": args.width,
                        "aniso": bool(args.aniso),
                        "spacing_mm": list(tgt_spacing) if tgt_spacing else None,
                        "model": args.model,
                        "seed": SEED,
                        "data_config": data_config,
                        "fold_mode": fold_mode,
                        "patient_count": patient_count,
                        "sampling_mix": sampling_mix_dict,
                        "fingerprint": current_fingerprint,
                        "val_cases": sorted([c["id"] for c in val]),
                        "model_arch": getattr(model, "model_arch", args.model_arch),
                        "base_channels": getattr(model, "base_channels", args.base_channels),
                        "double_conv": getattr(model, "double_conv", args.double_conv),
                        "cnet_threshold": args.cnet_threshold,
                        "cnet_weight": args.cnet_weight,
                        "bme_threshold": args.bme_threshold,
                    },
                    latest_ckpt,
                )
            t_save_total = time.time() - t_save_start
            t_save_accum += t_save_total

            ep_time = time.time() - t_ep_start
            epoch_times.append(ep_time)
            mean_ep_time = float(np.mean(epoch_times[-10:]))
            rem_ep = (fold_epochs - epoch) + ((len(folds_to_run) - 1 - fold_pos) * fold_epochs)
            eta_sec = int(rem_ep * mean_ep_time)
            eta_str = f"{eta_sec // 60}m {eta_sec % 60:02d}s" if eta_sec >= 60 else f"{eta_sec}s"
            amp_info = f", amp_skipped={amp_skipped_epoch}" if (use_amp and amp_skipped_epoch > 0) else ""
            if args.profile:
                print(
                    f"epoch {epoch}/{fold_epochs}  loss={total / max(steps, 1):.4f}  "
                    f"[{ep_time:.1f}s: data={t_data_total:.2f}s, train={t_train_total:.2f}s, save={t_save_total:.2f}s{amp_info} | ETA: {eta_str}]",
                    flush=True,
                )
            else:
                print(f"epoch {epoch}/{fold_epochs}  loss={total / max(steps, 1):.4f}  [{ep_time:.1f}s/epoch | ETA: {eta_str}{amp_info}]", flush=True)

            if args.max_runtime_minutes is not None:
                elapsed_min = (time.time() - t_pipeline_start) / 60.0
                if elapsed_min >= args.max_runtime_minutes:
                    print("\n" + "=" * 70, flush=True)
                    print(f"[TIME GUARD] Runtime limit reached: {elapsed_min:.2f}m >= {args.max_runtime_minutes:.2f}m.", flush=True)
                    print(f"Completed epoch {epoch}/{fold_epochs} of fold {fold}.", flush=True)
                    print(f"Resumable checkpoint safely saved to: {latest_ckpt.name}", flush=True)
                    print(f"To resume in next version: run with --resume. Training will resume from epoch {epoch + 1}.", flush=True)
                    print("Exiting cleanly.", flush=True)
                    print("=" * 70 + "\n", flush=True)
                    time_guard_triggered = True
                    status_payload = {
                        "fold": fold,
                        "status": "incomplete",
                        "epoch_reached": epoch,
                        "target_epochs": fold_epochs,
                        "fingerprint": current_fingerprint,
                        "val_cases": sorted([c["id"] for c in val]),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }
                    (out_dir / f"status_fold_{fold}.json").write_text(json.dumps(status_payload, indent=2), encoding="utf-8")
                    break

        if time_guard_triggered:
            break

        fold_cnet_threshold = float(args.cnet_threshold)
        if (not args.eval_only) and args.calibrate_cnet and hasattr(model, "cnet") and train:
            fold_cnet_threshold = calibrate_cnet_threshold_from_train(
                model,
                train,
                device,
                patch,
                val_batch_size=args.val_batch_size,
                use_amp=use_amp,
                channels_last=args.channels_last_3d,
                default_thresh=fold_cnet_threshold,
                cnet_temperature=args.cnet_temperature,
            )
            print(f"fold {fold}: calibrated cnet_threshold = {fold_cnet_threshold:.3f} (soft={args.cnet_soft}, train-only)", flush=True)

        fold_bme_threshold = float(args.bme_threshold)
        if (not args.eval_only) and args.calibrate_bme and train:
            fold_bme_threshold = calibrate_bme_threshold_from_train(
                model,
                train,
                device,
                patch,
                val_batch_size=args.val_batch_size,
                use_amp=use_amp,
                channels_last=args.channels_last_3d,
                min_bme_voxels=args.min_bme_voxels,
                cnet_threshold=fold_cnet_threshold,
                default_thresh=fold_bme_threshold,
                tta=args.val_tta,
                gaussian_window=args.gaussian_window,
                cnet_soft=args.cnet_soft,
                cnet_temperature=args.cnet_temperature,
            )
            print(f"fold {fold}: calibrated bme_threshold = {fold_bme_threshold:.3f} (train-only, zero val leakage)", flush=True)

        t_val_start = time.time()
        bone_d, bme_d, sens, fps, present_hit, present_n = [], [], [], [], 0, 0
        bme_d_pos = []
        sens_pos = []
        neg_clean_hits = 0
        neg_n = 0
        fps_neg = []
        bone_box = [0, 0, 0]
        edema_box = [0, 0, 0]
        for val_idx, case in enumerate(val, 1):
            loaded = load_case(base, case["id"], n4=args.n4)
            if not loaded:
                continue
            # Predicted on the training grid, scored on the scan's own grid.
            val_image, _ = to_spacing(loaded["image"], None, loaded["spacing"], tgt_spacing)
            pred = predict_volume(
                model,
                val_image,
                device,
                patch,
                val_batch_size=args.val_batch_size,
                use_amp=use_amp,
                channels_last=args.channels_last_3d,
                min_bme_voxels=args.min_bme_voxels,
                cnet_threshold=fold_cnet_threshold,
                bme_threshold=fold_bme_threshold,
                tta=args.val_tta,
                gaussian_window=args.gaussian_window,
                cnet_soft=args.cnet_soft,
                cnet_temperature=args.cnet_temperature,
            )
            pred = back_to_shape(pred, loaded["labels"].shape)
            del val_image
            bone_d.append(dice(loaded["labels"], pred, 1))
            bme_d.append(dice(loaded["labels"], pred, 2))
            gt_bone = (loaded["labels"] == 1) | (loaded["labels"] == 2)
            pr_bone = (pred == 1) | (pred == 2)
            bone_box[0] += int(np.logical_and(gt_bone, pr_bone).sum())
            bone_box[1] += int(np.logical_and(~gt_bone, pr_bone).sum())
            bone_box[2] += int(np.logical_and(gt_bone, ~pr_bone).sum())
            gt_ed = loaded["labels"] == 2
            pr_ed = pred == 2
            edema_box[0] += int(np.logical_and(gt_ed, pr_ed).sum())
            edema_box[1] += int(np.logical_and(~gt_ed, pr_ed).sum())
            edema_box[2] += int(np.logical_and(gt_ed, ~pr_ed).sum())
            s, fp = lesion_stats(loaded["labels"], pred)
            sens.append(s)
            fps.append(fp)
            gt_pos = loaded["bme_voxels"] > 0
            pr_pos = bool((pred == 2).any())
            present_n += 1
            present_hit += int(gt_pos == pr_pos)
            if gt_pos:
                bme_d_pos.append(bme_d[-1])
                sens_pos.append(s)
            else:
                neg_n += 1
                if not pr_pos:
                    neg_clean_hits += 1
                fps_neg.append(fp)
            prefix = f"  {case['id']}" if args.show_ids else f"  val case {val_idx}/{len(val)}"
            print(
                f"{prefix}  bone_dice={bone_d[-1]:.3f}  bme_dice={bme_d[-1]:.3f}  "
                f"edema={'yes' if pr_pos else 'no'}",
                flush=True,
            )
            del loaded, pred
            release()
        b_prec, b_rec, b_f1, b_iou = rates(*bone_box)
        e_prec, e_rec, e_f1, e_iou = rates(*edema_box)
        t_val_total = time.time() - t_val_start
        t_val_accum += t_val_total
        if args.profile:
            print(f"fold {fold} validation time: {t_val_total:.1f}s ({len(val)} cases, val_batch_size={args.val_batch_size})", flush=True)

        if not args.eval_only:
            t_save_f0 = time.time()
            torch.save(
                {
                    "state": model.state_dict(),
                    "patch": list(patch),
                    "width": getattr(args, "width", getattr(model, "base_channels", 16)),
                    "aniso": bool(getattr(args, "aniso", False)),
                    "spacing_mm": list(tgt_spacing) if tgt_spacing else None,
                    "model": getattr(args, "model", getattr(model, "model_arch", "mednext")),
                    "seed": SEED,
                    "data_config": data_config,
                    "fold_mode": fold_mode,
                    "patient_count": patient_count,
                    "sampling_mix": sampling_mix_dict,
                    "fingerprint": current_fingerprint,
                    "val_cases": sorted([c["id"] for c in val]),
                    "base_channels": getattr(model, "base_channels", 16),
                    "double_conv": getattr(model, "double_conv", False),
                    "min_bme_voxels": getattr(args, "min_bme_voxels", 50),
                    "model_arch": getattr(model, "model_arch", getattr(args, "model_arch", "mednext")),
                    "cnet_threshold": fold_cnet_threshold,
                    "cnet_soft": bool(args.cnet_soft),
                    "cnet_temperature": float(args.cnet_temperature),
                    "cnet_weight": getattr(args, "cnet_weight", 0.5),
                    "bme_threshold": fold_bme_threshold,
                    "norm_type": getattr(model, "norm_type", eff_norm_type),
                    "gaussian_window": bool(args.gaussian_window),
                    "tversky_alpha": eff_tversky_alpha,
                    "tversky_beta": eff_tversky_beta,
                    "val_tta": bool(args.val_tta),
                    "n4": bool(args.n4),
                },
                final_ckpt,
            )
            t_save_accum += (time.time() - t_save_f0)
            if latest_ckpt.exists():
                try:
                    latest_ckpt.unlink()
                except Exception:
                    pass

            status_payload = {
                "fold": fold,
                "status": "completed",
                "epoch_reached": epoch,
                "target_epochs": fold_epochs,
                "fold_mode": fold_mode,
                "patient_count": patient_count,
                "sampling_mix": sampling_mix_dict,
                "fingerprint": current_fingerprint,
                "val_cases": sorted([c["id"] for c in val]),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            (out_dir / f"status_fold_{fold}.json").write_text(json.dumps(status_payload, indent=2), encoding="utf-8")

        amp_pct = (amp_skipped_total / max(total_steps_fold, 1)) * 100 if use_amp else 0.0
        if use_amp:
            print(f"fold {fold}: AMP non-finite steps skipped: {amp_skipped_total}/{total_steps_fold} ({amp_pct:.2f}%)", flush=True)
            if amp_pct > 1.0:
                print(f"[WARNING] fold {fold}: AMP skipped steps ({amp_pct:.2f}%) exceeded 1% threshold!", flush=True)

        bme_pos_mean = float(np.mean(bme_d_pos)) if bme_d_pos else float(np.mean(bme_d))
        sens_pos_mean = float(np.mean(sens_pos)) if sens_pos else float(np.mean(sens))
        clean_spec = float(neg_clean_hits / neg_n) if neg_n > 0 else 1.0
        fps_neg_mean = float(np.mean(fps_neg)) if fps_neg else 0.0

        print(
            f"fold {fold}: BME Dice (Positives Only) = {bme_pos_mean:.3f} (n={len(bme_d_pos)})  |  "
            f"Negative Specificity (TNR) = {clean_spec * 100:.1f}% (n={neg_n}, FP/neg={fps_neg_mean:.1f})",
            flush=True,
        )

        fold_row = {
            "fold": fold,
            "val": [c["id"] for c in val],
            "epochs_run": epoch,
            "val_cases": sorted([c["id"] for c in val]),
            "fold_mode": fold_mode,
            "patient_count": patient_count,
            "sampling_mix": sampling_mix_dict,
            "fingerprint": current_fingerprint,
            "final_loss": float(total / max(steps, 1)) if steps > 0 else 0.0,
            "bone_dice": float(np.mean(bone_d)),
            "bme_dice": float(np.mean(bme_d)),
            "bme_dice_pos": bme_pos_mean,
            "lesion_sensitivity": float(np.mean(sens)),
            "lesion_sensitivity_pos": sens_pos_mean,
            "clean_scan_specificity": clean_spec,
            "fp_per_case": float(np.mean(fps)),
            "fp_per_neg_case": fps_neg_mean,
            "n_pos_val": len(bme_d_pos),
            "n_neg_val": neg_n,
            "presence_correct": present_hit,
            "presence_n": present_n,
            "min_bme_voxels": getattr(args, "min_bme_voxels", 50),
            "model_arch": getattr(model, "model_arch", getattr(args, "model_arch", "mednext")),
            "cnet_threshold": fold_cnet_threshold if hasattr(model, "cnet") else None,
            "cnet_soft": bool(args.cnet_soft),
            "cnet_temperature": float(args.cnet_temperature),
            "bme_threshold": fold_bme_threshold,
            "norm_type": getattr(model, "norm_type", eff_norm_type),
            "gaussian_window": bool(args.gaussian_window),
            "tversky_beta": eff_tversky_beta,
            "val_tta": bool(args.val_tta),
            "n4": bool(args.n4),
            "base_channels": getattr(model, "base_channels", args.base_channels),
            "double_conv": getattr(model, "double_conv", args.double_conv),
            "bone_precision": b_prec,
            "bone_recall": b_rec,
            "bone_f1": b_f1,
            "bone_iou": b_iou,
            "edema_precision": e_prec,
            "edema_recall": e_rec,
            "edema_f1": e_f1,
            "edema_iou": e_iou,
            "amp_skipped_steps": amp_skipped_total,
            "amp_skipped_pct": round(amp_pct, 4),
            "data_config": data_config,
            "epochs": fold_epochs,
            "seed": SEED,
            "device": device,
            "patch": list(patch),
            "width": args.width,
            "aniso": bool(args.aniso),
            "spacing_mm": list(tgt_spacing) if tgt_spacing else None,
            "model": args.model,
            "n_cases": len(cases),
            "n_bme": n_bme,
            "n_negative": n_neg,
        }
        fold_rows.append(fold_row)

        fold_metric_path = out_dir / f"metrics_fold_{fold}.json"
        try:
            fold_metric_path.write_text(json.dumps(fold_row, indent=2), encoding="utf-8")
            partial_path.write_text(json.dumps(fold_rows, indent=2), encoding="utf-8")
        except Exception:
            pass

    if time_guard_triggered:
        print("\n" + "=" * 70, flush=True)
        print("[WARNING] TRAINING RUN PAUSED BY TIME GUARD - CHECKPOINT PRESERVED", flush=True)
        print("=" * 70, flush=True)
        print("  Process exiting cleanly (exit code 0).", flush=True)
        if fold_rows:
            (out_dir / "metrics_partial.json").write_text(json.dumps(fold_rows, indent=2), encoding="utf-8")
            print(f"  Wrote partial metrics ({len(fold_rows)} completed folds) to {out_dir / 'metrics_partial.json'}", flush=True)
        print("=" * 70 + "\n", flush=True)
        return

    t_total_pipeline = time.time() - t_pipeline_start
    print("=" * 60, flush=True)
    print("3D U-NET WALL-CLOCK TIMING BREAKDOWN", flush=True)
    print("=" * 60, flush=True)
    print(f"  Volume loading         : {t_load_total:6.1f}s", flush=True)
    print(f"  Patch sampling         : {t_sampling_total:6.1f}s", flush=True)
    print(f"  Training forward/back  : {t_train_accum:6.1f}s", flush=True)
    print(f"  Validation inference   : {t_val_accum:6.1f}s", flush=True)
    print(f"  Checkpoint saves       : {t_save_accum:6.1f}s", flush=True)
    print(f"  Total pipeline time    : {t_total_pipeline:6.1f}s", flush=True)
    print("=" * 60, flush=True)

    if len(fold_rows) >= folds_n:
        total_skipped = sum(r.get("amp_skipped_steps", 0) for r in fold_rows)
        mean_skipped_pct = float(np.mean([r.get("amp_skipped_pct", 0.0) for r in fold_rows]))
        metrics = {
            "model": args.model,
            "device": device,
            "folds": folds_n,
            "fold_mode": fold_mode,
            "patient_count": patient_count,
            "val_cases_per_fold": {str(r["fold"]): r["val_cases"] for r in fold_rows},
            "sampling_mix": sampling_mix_dict,
            "epochs": max(r["epochs_run"] for r in fold_rows),
            "seed": SEED,
            "patch": list(patch),
            "width": args.width,
            "aniso": bool(args.aniso),
            "spacing_mm": list(tgt_spacing) if tgt_spacing else None,
            "batch": args.batch,
            "patches_per_case": args.patches_per_case,
            "resample": args.resample,
            "augment": args.augment,
            "hours_budget": args.hours,
            "hours_taken": round((time.monotonic() - started) / 3600, 2),
            "data_config": data_config,
            "fingerprint": current_fingerprint,
            "n_cases": len(cases),
            "n_bme": n_bme,
            "n_negative": n_neg,
            "summary": summarise(fold_rows),
            "presence_correct": sum(r["presence_correct"] for r in fold_rows),
            "presence_n": sum(r["presence_n"] for r in fold_rows),
            "min_bme_voxels": args.min_bme_voxels,
            "model_arch": getattr(model, "model_arch", args.model_arch),
            "cnet_threshold": fold_rows[0].get("cnet_threshold") if (fold_rows and hasattr(model, "cnet")) else (args.cnet_threshold if hasattr(model, "cnet") else None),
            "cnet_soft": bool(args.cnet_soft),
            "cnet_temperature": float(args.cnet_temperature),
            "bme_threshold": fold_rows[0].get("bme_threshold", args.bme_threshold) if fold_rows else args.bme_threshold,
            "norm_type": getattr(model, "norm_type", eff_norm_type),
            "gaussian_window": bool(args.gaussian_window),
            "tversky_beta": eff_tversky_beta,
            "val_tta": bool(args.val_tta),
            "n4": bool(args.n4),
            "base_channels": getattr(model, "base_channels", args.base_channels),
            "double_conv": getattr(model, "double_conv", args.double_conv),
            "amp_skipped_steps_total": total_skipped,
            "amp_skipped_pct_mean": round(mean_skipped_pct, 4),
            "per_fold": fold_rows,

            "timing": {
                "volume_load_s": round(t_load_total, 2),
                "patch_sampling_s": round(t_sampling_total, 2),
                "train_s": round(t_train_accum, 2),
                "val_s": round(t_val_accum, 2),
                "save_s": round(t_save_accum, 2),
                "total_s": round(t_total_pipeline, 2),
            },
            "trained_at": datetime.now(timezone.utc).isoformat(),
            "note": (
                f"{len(cases)} volumes ({n_bme} with edema, {n_neg} without), "
                f"{folds_n} {fold_mode} folds, patch {patch[0]}\u00d7{patch[1]}\u00d7{patch[2]}, width {args.width}. "
                "Bone and edema are trained together. Edema outside the predicted bone is removed. "
                "Dice, lesion sensitivity, and false positives per case are mean \u00b1 std across folds."
            ),
        }
        (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
        print(metrics["note"], flush=True)
        for key, s in metrics["summary"].items():
            if s:
                print(f"  {key}  {s['mean']:.3f} \u00b1 {s['std']:.3f}", flush=True)
        if total_skipped > 0:
            print(f"  amp_skipped_steps   : {total_skipped} ({mean_skipped_pct:.2f}%)", flush=True)
            if mean_skipped_pct > 1.0:
                print("[WARNING] AMP skipped steps exceeded 1% of total steps!", flush=True)
        print(f"-> {out_dir / 'metrics.json'}", flush=True)
        try:
            from metrics_log import from_summary
            try:
                log_out_dir = out_dir.resolve().relative_to(base.resolve()).as_posix()
            except ValueError:
                log_out_dir = out_dir.name
            log_path = from_summary(
                base, task="3d", model=args.model, device=device,
                out_dir=log_out_dir, folds=folds_n, epochs=metrics["epochs"],
                n_cases=len(cases), summary=metrics["summary"],
                n_bme=n_bme, n_negative=n_neg, fp_key="fp_per_case", fp_unit="per_case",
                presence_correct=metrics["presence_correct"], presence_n=metrics["presence_n"],
                patch="x".join(str(p) for p in patch),
            )
            print(f"-> {log_path}", flush=True)
        except Exception as e:
            print(f"metrics log not written ({type(e).__name__}: {e})", flush=True)
    elif args.fold is not None or args.run_folds is not None:
        # Check if all folds are now complete across independent processes
        merge_metrics_files(out_dir, folds_n)


if __name__ == "__main__":
    main()
