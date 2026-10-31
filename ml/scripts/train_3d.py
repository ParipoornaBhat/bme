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
import csv
import gc
import hashlib
import json
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


def normalize(raw: np.ndarray, denoise: bool = True) -> np.ndarray:
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


def pad_volume(vol: np.ndarray) -> np.ndarray:
    pads = [(0, max(0, PATCH[i] - vol.shape[i])) for i in range(3)]
    if any(b for _, b in pads):
        return np.pad(vol, pads)
    return vol


def window_origins(shape: tuple[int, int, int]) -> list[tuple[int, int, int]]:
    ranges = []
    for ax in range(3):
        last = max(0, shape[ax] - PATCH[ax])
        if last == 0:
            ranges.append([0])
            continue
        starts = list(range(0, last + 1, STRIDE[ax]))
        if starts[-1] != last:
            starts.append(last)
        ranges.append(starts)
    return [(x, y, z) for x in ranges[0] for y in ranges[1] for z in ranges[2]]


def crop(vol: np.ndarray, origin: tuple[int, int, int]) -> np.ndarray:
    sl = tuple(slice(o, o + p) for o, p in zip(origin, PATCH))
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
) -> tuple[int, int, int]:
    if sampling_mix is None:
        sampling_mix = {"lesion": 0.7, "bone": 0.0, "random": 0.3}

    p_lesion = sampling_mix.get("lesion", 0.7)
    p_bone = sampling_mix.get("bone", 0.0)

    # Fast path for standard default: guaranteed bit-identical to legacy behavior
    if p_bone == 0.0:
        if (labels == 2).any() and rng.random() < p_lesion:
            pts = np.argwhere(labels == 2)
            point = pts[int(rng.integers(len(pts)))]
            return tuple(
                int(np.clip(point[ax] - PATCH[ax] // 2, 0, max(0, shape[ax] - PATCH[ax])))
                for ax in range(3)
            )
        return tuple(
            0 if shape[ax] <= PATCH[ax] else int(rng.integers(0, shape[ax] - PATCH[ax] + 1))
            for ax in range(3)
        )

    # General path when bone sampling is active (p_bone > 0.0)
    u = rng.random()
    has_lesion = (labels == 2).any()
    has_bone = ((labels == 1) | (labels == 2)).any()

    if u < p_lesion and has_lesion:
        pts = np.argwhere(labels == 2)
        point = pts[int(rng.integers(len(pts)))]
        return tuple(
            int(np.clip(point[ax] - PATCH[ax] // 2, 0, max(0, shape[ax] - PATCH[ax])))
            for ax in range(3)
        )
    elif u < (p_lesion + p_bone) and has_bone:
        pts = np.argwhere((labels == 1) | (labels == 2))
        point = pts[int(rng.integers(len(pts)))]
        return tuple(
            int(np.clip(point[ax] - PATCH[ax] // 2, 0, max(0, shape[ax] - PATCH[ax])))
            for ax in range(3)
        )
    else:
        return tuple(
            0 if shape[ax] <= PATCH[ax] else int(rng.integers(0, shape[ax] - PATCH[ax] + 1))
            for ax in range(3)
        )


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
      - Intensity: scale in [0.9, 1.1] and shift in [-0.05, 0.05], clipped to [0, 1].
      - Noise: additive Gaussian with sigma=0.01, clipped to [0, 1].
      - Labels: NEVER modified by intensity scaling or noise.
    """
    img = img_patch.copy()
    lbl = lbl_patch.copy()

    # 1. Left-right horizontal flip (axis 1)
    if do_flip and rng.random() < 0.5:
        img = np.ascontiguousarray(np.flip(img, axis=1))
        lbl = np.ascontiguousarray(np.flip(lbl, axis=1))

    # 2. Intensity scale and shift (image only)
    if do_intensity:
        scale = float(rng.uniform(0.9, 1.1))
        shift = float(rng.uniform(-0.05, 0.05))
        img = np.clip(img * scale + shift, 0.0, 1.0)

    # 3. Additive Gaussian noise (image only)
    if do_noise:
        noise = rng.normal(0.0, 0.01, size=img.shape).astype(np.float32)
        img = np.clip(img + noise, 0.0, 1.0)

    return img, lbl


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


def load_case(base: Path, case_id: str) -> dict | None:
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
        norm = normalize(np.asanyarray(img.dataobj))
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
    norm = normalize(np.asanyarray(img.dataobj))
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

    def __init__(self, base_channels: int = 16, double_conv: bool = False):
        super().__init__()
        self.model_arch = "unet3d"
        self.base_channels = base_channels
        self.double_conv = double_conv

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

        c1 = base_channels
        c2 = base_channels * 2
        c3 = base_channels * 4

        self.e1 = block(1, c1)
        self.e2 = block(c1, c2)
        self.e3 = block(c2, c3)
        self.pool = nn.MaxPool3d(2)
        self.up2 = nn.ConvTranspose3d(c3, c2, 2, stride=2)
        self.d2 = block(c3, c2)
        self.up1 = nn.ConvTranspose3d(c2, c1, 2, stride=2)
        self.d1 = block(c2, c1)
        self.out = nn.Conv3d(c1, 2, 1)

    def forward(self, x, return_cnet: bool = False):
        a = self.e1(x)
        b = self.e2(self.pool(a))
        c = self.e3(self.pool(b))
        y = self.d2(torch.cat([self.up2(c), b], 1))
        y = self.d1(torch.cat([self.up1(y), a], 1))
        out = self.out(y)
        if return_cnet:
            return out, None
        return out


class AttentionGate3D(nn.Module):
    """3D Attention Gate (Oktay et al., 2018).
    Weights encoder skip features by attention coefficients derived from coarser gating features.
    """

    def __init__(self, f_g: int, f_l: int, f_int: int):
        super().__init__()
        self.w_g = nn.Sequential(
            nn.Conv3d(f_g, f_int, kernel_size=1, stride=1, padding=0, bias=False),
            nn.InstanceNorm3d(f_int),
        )
        self.w_x = nn.Sequential(
            nn.Conv3d(f_l, f_int, kernel_size=1, stride=1, padding=0, bias=False),
            nn.InstanceNorm3d(f_int),
        )
        self.psi = nn.Sequential(
            nn.Conv3d(f_int, 1, kernel_size=1, stride=1, padding=0, bias=True),
            nn.InstanceNorm3d(1),
            nn.Sigmoid(),
        )
        self.relu = nn.ReLU(inplace=True)

    def forward(self, g: torch.Tensor, x: torch.Tensor) -> torch.Tensor:
        w_g = self.w_g(g)
        w_x = self.w_x(x)
        if w_g.shape[2:] != w_x.shape[2:]:
            w_g = nn.functional.interpolate(w_g, size=w_x.shape[2:], mode="trilinear", align_corners=True)
        psi = self.relu(w_g + w_x)
        alpha = self.psi(psi)
        return x * alpha


class CNetHead3D(nn.Module):
    """Candidate/Classification Network (C-Net) Gatekeeper.
    Predicts patient/patch-level edema presence logit from global bottleneck features.
    """

    def __init__(self, in_channels: int):
        super().__init__()
        self.pool = nn.AdaptiveAvgPool3d(1)
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

    def __init__(self, base_channels: int = 16, double_conv: bool = True):
        super().__init__()
        self.model_arch = "cnet_dual_unet"
        self.base_channels = base_channels
        self.double_conv = double_conv

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

        c1 = base_channels
        c2 = base_channels * 2
        c3 = base_channels * 4

        # Encoder
        self.e1 = block(1, c1)
        self.e2 = block(c1, c2)
        self.e3 = block(c2, c3)
        self.pool = nn.MaxPool3d(2)

        # C-Net presence classifier head at bottleneck
        self.cnet = CNetHead3D(c3)

        # Decoder with transposed convolutions and direct high-fidelity skip connections
        self.up2 = nn.ConvTranspose3d(c3, c2, 2, stride=2)
        self.d2 = block(c3, c2)
        self.up1 = nn.ConvTranspose3d(c2, c1, 2, stride=2)
        self.d1 = block(c2, c1)

        # Output dual-channel segmentation head (channel 0: bone, channel 1: edema)
        self.out = nn.Conv3d(c1, 2, 1)

    def forward(self, x: torch.Tensor, return_cnet: bool = False):
        a = self.e1(x)
        b = self.e2(self.pool(a))
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


def build_model(
    arch: str = "mednext",
    base_channels: int = 16,
    double_conv: bool = False,
) -> nn.Module:
    if arch == "mednext":
        return MedNeXt3D(base_channels=base_channels)
    if arch in ("cnet_dual_unet", "cnet_attention_unet"):
        return CNetDualUNet3D(base_channels=base_channels, double_conv=double_conv)
    return UNet3D(base_channels=base_channels, double_conv=double_conv)



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
) -> torch.Tensor:
    """Dice + focal. Uncertain voxels are weighted out. Edema is weighted by bme_weight (default: 2.5) to counteract class imbalance."""
    prob = torch.sigmoid(logits)
    loss = logits.new_zeros(())
    denom_v = valid.sum().clamp(min=1)
    for c in range(2):
        p = prob[c]
        t = target[c]
        pv, tv = p * valid, t * valid
        inter = (pv * tv).sum()
        dice = 1 - (2 * inter + 1) / (pv.sum() + tv.sum() + 1)
        bce = nn.functional.binary_cross_entropy(p.clamp(1e-4, 1 - 1e-4), t, reduction="none")
        pt = torch.where(t > 0.5, p, 1 - p)
        focal = ((1 - pt).pow(gamma) * bce * valid).sum() / denom_v
        w = 1.0 if c == 0 else bme_weight
        loss = loss + w * (dice + focal)
    return loss


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
    """Leave VRAM for the Windows desktop. A full GPU allocation can freeze the screen."""
    torch.set_num_threads(1)
    if device != "cuda":
        return
    try:
        torch.cuda.set_per_process_memory_fraction(0.65)
    except RuntimeError:
        pass
    torch.backends.cudnn.benchmark = cudnn_benchmark


def release():
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def postprocess_prediction(
    pred: np.ndarray,
    min_bme_voxels: int = 50,
) -> np.ndarray:
    """Filter out isolated noise speckles of predicted BME smaller than min_bme_voxels."""
    if min_bme_voxels <= 0 or not (pred == 2).any():
        return pred
    out = pred.copy()
    lab, num = cc_label(out == 2)
    if num > 0:
        counts = np.bincount(lab.ravel())
        small_ids = np.where((counts < min_bme_voxels) & (counts > 0))[0]
        if len(small_ids) > 0:
            small_mask = np.isin(lab, small_ids)
            # Demote small false positive speckles to bone (1)
            out[small_mask] = 1
    return out


@torch.no_grad()
def predict_volume(
    model: nn.Module,
    image: np.ndarray,
    device: str,
    val_batch_size: int = 1,
    use_amp: bool = False,
    channels_last: bool = False,
    min_bme_voxels: int = 50,
    cnet_threshold: float = 0.40,
    bme_threshold: float = 0.35,
) -> np.ndarray:
    """Sliding-window inference. Supports val_batch_size >= 1 for faster evaluation and C-Net presence gating."""
    model.eval()
    shape = image.shape
    padded = pad_volume(image)
    votes_bone = np.zeros(padded.shape, dtype=np.uint16)
    votes_bme = np.zeros(padded.shape, dtype=np.uint16)
    hits = np.zeros(padded.shape, dtype=np.uint16)
    origins = window_origins(padded.shape)
    has_cnet = hasattr(model, "cnet")
    cnet_probs: list[float] = []

    if val_batch_size <= 1:
        for origin in origins:
            patch = np.ascontiguousarray(crop(padded, origin))
            x = torch.from_numpy(patch).float().unsqueeze(0).unsqueeze(0).to(device)
            if channels_last:
                x = x.to(memory_format=torch.channels_last_3d)
            if has_cnet:
                if use_amp and device == "cuda":
                    with torch.amp.autocast(device_type="cuda"):
                        raw_seg, cnet_logit = model(x, return_cnet=True)
                        prob = torch.sigmoid(raw_seg[0])
                        cnet_p = float(torch.sigmoid(cnet_logit).cpu().item())
                else:
                    raw_seg, cnet_logit = model(x, return_cnet=True)
                    prob = torch.sigmoid(raw_seg[0])
                    cnet_p = float(torch.sigmoid(cnet_logit).cpu().item())
                cnet_probs.append(cnet_p)
            else:
                if use_amp and device == "cuda":
                    with torch.amp.autocast(device_type="cuda"):
                        prob = torch.sigmoid(model(x)[0])
                else:
                    prob = torch.sigmoid(model(x)[0])
            bone = (prob[0] >= 0.5).cpu().numpy()
            bme = ((prob[1] >= bme_threshold).cpu().numpy() & bone)
            del x, prob
            sl = tuple(slice(o, o + p) for o, p in zip(origin, PATCH))
            votes_bone[sl] += bone
            votes_bme[sl] += bme
            hits[sl] += 1
    else:
        for i in range(0, len(origins), val_batch_size):
            batch_orig = origins[i : i + val_batch_size]
            batch_arr = np.stack([crop(padded, o) for o in batch_orig])
            x = torch.from_numpy(batch_arr).float().unsqueeze(1).to(device)
            if channels_last:
                x = x.to(memory_format=torch.channels_last_3d)
            if has_cnet:
                if use_amp and device == "cuda":
                    with torch.amp.autocast(device_type="cuda"):
                        raw_seg, cnet_logit = model(x, return_cnet=True)
                        probs = torch.sigmoid(raw_seg).cpu().numpy()
                        cnet_ps = torch.sigmoid(cnet_logit).cpu().numpy()
                else:
                    raw_seg, cnet_logit = model(x, return_cnet=True)
                    probs = torch.sigmoid(raw_seg).cpu().numpy()
                    cnet_ps = torch.sigmoid(cnet_logit).cpu().numpy()
                cnet_probs.extend(cnet_ps.tolist() if hasattr(cnet_ps, "tolist") else [float(cnet_ps)])
            else:
                if use_amp and device == "cuda":
                    with torch.amp.autocast(device_type="cuda"):
                        probs = torch.sigmoid(model(x)).cpu().numpy()
                else:
                    probs = torch.sigmoid(model(x)).cpu().numpy()
            for j, o in enumerate(batch_orig):
                bone = probs[j, 0] >= 0.5
                bme = (probs[j, 1] >= bme_threshold) & bone
                sl = tuple(slice(o[k], o[k] + PATCH[k]) for k in range(3))
                votes_bone[sl] += bone
                votes_bme[sl] += bme
                hits[sl] += 1
            del x, probs

    # C-Net gatekeeper: if maximum presence probability across scan is below threshold, block BME entirely
    if has_cnet and cnet_probs and (max(cnet_probs) < cnet_threshold):
        votes_bme.fill(0)

    votes_bone = votes_bone[: shape[0], : shape[1], : shape[2]]
    votes_bme = votes_bme[: shape[0], : shape[1], : shape[2]]
    hits = np.maximum(hits[: shape[0], : shape[1], : shape[2]], 1)
    out = np.zeros(shape, dtype=np.uint8)
    out[votes_bone * 2 >= hits] = 1
    out[(votes_bme * 2 >= hits) & (out == 1)] = 2
    if min_bme_voxels > 0:
        out = postprocess_prediction(out, min_bme_voxels=min_bme_voxels)
    return out



def mean_std(vals: list[float]) -> dict | None:
    if not vals:
        return None
    a = np.asarray(vals, dtype=float)
    std = float(a.std(ddof=1)) if len(a) > 1 else 0.0
    return {"mean": float(a.mean()), "std": std}


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
        "patch": list(PATCH),
        "data_config": data_config,
        "fingerprint": fingerprint,
        "n_cases": n_cases,
        "n_bme": n_bme,
        "n_negative": n_neg,
        "summary": {
            "bone_dice": mean_std([r["bone_dice"] for r in fold_rows]),
            "bme_dice": mean_std([r["bme_dice"] for r in fold_rows]),
            "lesion_sensitivity": mean_std([r["lesion_sensitivity"] for r in fold_rows]),
            "fp_per_case": mean_std([r["fp_per_case"] for r in fold_rows]),
        },
        "presence_correct": sum(r.get("presence_correct", 0) for r in fold_rows),
        "presence_n": sum(r.get("presence_n", 0) for r in fold_rows),
        "min_bme_voxels": first.get("min_bme_voxels", 50),
        "base_channels": first.get("base_channels", 16),
        "double_conv": first.get("double_conv", False),
        "amp_skipped_steps_total": total_skipped,
        "amp_skipped_pct_mean": round(mean_skipped_pct, 4),
        "per_fold": fold_rows,

        "merged_at": datetime.now(timezone.utc).isoformat(),
        "note": (
            f"{n_cases} volumes ({n_bme} with edema, {n_neg} without), "
            f"{len(fold_rows)} {fold_mode} folds, patch {PATCH[0]}x{PATCH[1]}x{PATCH[2]}. "
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
    ap.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    ap.add_argument("--out-dir", type=str, default=None)
    ap.add_argument("--amp", action="store_true", help="Automatic Mixed Precision (FP16)")
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
    # Data Experiment options (OPT-IN, OFF by default, baseline behavior unchanged when off):
    ap.add_argument("--resample-patches-each-epoch", action="store_true",
                    help="Resample training patches each epoch in memory (requires --out-dir outside data/)")
    ap.add_argument("--augment", action="store_true",
                    help="Enable all 3D data augmentations (flip, intensity, noise) on training patches")
    ap.add_argument("--aug-flip", action="store_true",
                    help="Enable horizontal left-right flip augmentation (axis 1)")
    ap.add_argument("--aug-intensity", action="store_true",
                    help="Enable intensity scale [0.9, 1.1] and shift [-0.05, 0.05]")
    ap.add_argument("--aug-noise", action="store_true",
                    help="Enable additive Gaussian noise (sigma=0.01)")
    ap.add_argument("--legacy-case-folds", action="store_true",
                    help="Reproduce legacy case-level fold assignment instead of patient grouping")
    ap.add_argument("--allow-case-level-folds", action="store_true",
                    help="Allow case-level folds if patient_id is missing or blank in worklist.csv")
    ap.add_argument("--sampling-mix", type=str, default="lesion=0.7,bone=0.0,random=0.3",
                    help="Patch sampling proportions: lesion=A,bone=B,random=C (fractions summing to 1.0)")
    # Experimental options (OFF by default, changes experiment):
    ap.add_argument("--batch-size", type=int, default=1, help="[EXPERIMENT CHANGE] Training patch batch size (default: 1)")
    ap.add_argument("--min-bme-voxels", type=int, default=50,
                    help="Minimum connected component volume in voxels for BME lesions (default: 50)")
    ap.add_argument("--base-channels", type=int, default=16,
                    help="Base channel width for UNet3D (default: 16; use 32 for higher capacity)")
    ap.add_argument("--double-conv", action="store_true",
                    help="Use dual conv layers per resolution block in UNet3D")
    ap.add_argument("--eval-only", action="store_true",
                    help="Run validation evaluation on existing fold checkpoints without training")
    ap.add_argument("--model-arch", type=str, default="mednext", choices=["unet3d", "cnet_dual_unet", "cnet_attention_unet", "mednext"],
                    help="Model architecture: 'mednext' (State-of-the-Art 3D ConvNeXt), 'cnet_dual_unet' (C-Net + Dual-Channel U-Net), or 'unet3d' (standard)")
    ap.add_argument("--cnet-weight", type=float, default=0.5,
                    help="Loss weight for C-Net binary presence classification (default: 0.5)")
    ap.add_argument("--cnet-threshold", type=float, default=0.40,
                    help="Presence threshold for C-Net gatekeeper (default: 0.40)")
    ap.add_argument("--bme-loss-weight", type=float, default=2.5,
                    help="Loss weight for BME edema class to address class imbalance (default: 2.5)")
    ap.add_argument("--bme-threshold", type=float, default=0.35,
                    help="Probability threshold for BME edema segmentation (default: 0.35)")
    args = ap.parse_args()


    random.seed(SEED)
    np.random.seed(SEED)
    torch.manual_seed(SEED)

    base = Path(args.base)

    try:
        sampling_mix_dict = parse_sampling_mix(args.sampling_mix)
    except ValueError as e:
        raise SystemExit(f"[ERROR] {e}")

    is_data_experiment = bool(
        args.resample_patches_each_epoch or args.augment or
        args.aug_flip or args.aug_intensity or args.aug_noise or
        (args.sampling_mix != "lesion=0.7,bone=0.0,random=0.3")
    )
    if is_data_experiment:
        if not args.out_dir:
            raise SystemExit(
                "[ERROR] Output isolation violation: data experiment runs must explicitly specify "
                "--out-dir OUTSIDE data/ (e.g. --out-dir ../results3d_exp or /kaggle/working/results3d_exp)."
            )
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
        "resample_patches_each_epoch": bool(args.resample_patches_each_epoch),
        "augment": bool(args.augment),
        "aug_flip": bool(args.augment or args.aug_flip),
        "aug_intensity": bool(args.augment or args.aug_intensity),
        "aug_noise": bool(args.augment or args.aug_noise),
        "sampling_mix": sampling_mix_dict,
    }

    out_dir = Path(args.out_dir) if args.out_dir else base / "data" / "results3d"

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
    for cid in case_ids:
        item = load_case(base, cid)
        if not item:
            continue
        image = pad_volume(item["image"])
        labels = pad_volume(item["labels"])
        t_s0 = time.time()
        patches, patch_labels = [], []
        for _ in range(PATCHES_PER_CASE):
            origin = sample_origin(image.shape, labels, rng_load, sampling_mix_dict)
            patches.append(np.ascontiguousarray(crop(image, origin)))
            patch_labels.append(np.ascontiguousarray(crop(labels, origin)))
        t_sampling_total += (time.time() - t_s0)
        pid = patients.get(item["id"], "").strip()
        case_item = {
            "id": item["id"],
            "patient_id": pid,
            "cls": classes.get(item["id"], ""),
            "bme_voxels": item["bme_voxels"],
            "patches": patches,
            "patch_labels": patch_labels,
        }
        if args.resample_patches_each_epoch:
            case_item["volume_image"] = np.ascontiguousarray(image, dtype=np.float32)
            case_item["volume_labels"] = np.ascontiguousarray(labels, dtype=np.uint8)
        cases.append(case_item)
        del item, image, labels, patches, patch_labels
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
            fold_mode = "case_level"
            for c in cases:
                if not c.get("patient_id"):
                    c["patient_id"] = c["id"]
        else:
            fold_mode = "patient_grouped"

        # 1. Group cases by patient
        patient_to_cases: dict[str, list[dict]] = {}
        for case in cases:
            pid = case["patient_id"]
            if pid not in patient_to_cases:
                patient_to_cases[pid] = []
            patient_to_cases[pid].append(case)

        # Sort cases within each patient group by case ID for determinism
        for pid in patient_to_cases:
            patient_to_cases[pid].sort(key=lambda c: c["id"])

        # 2. Shuffle sorted unique patient IDs with SEED
        unique_patient_ids = sorted(patient_to_cases.keys())
        rng_patients = random.Random(SEED)
        rng_patients.shuffle(unique_patient_ids)

        # 3. Assign each patient group to the currently smallest fold (ties to lowest fold index)
        groups = [[] for _ in range(folds_n)]
        for pid in unique_patient_ids:
            p_cases = patient_to_cases[pid]
            smallest_fold_idx = min(range(folds_n), key=lambda f: len(groups[f]))
            groups[smallest_fold_idx].extend(p_cases)

        patient_count = len(unique_patient_ids)

    print(
        f"{len(cases)} volumes across {patient_count} patients ({n_bme} with edema, {n_neg} without). "
        f"Using {folds_n} {fold_mode} folds. Seed {SEED}.",
        flush=True,
    )
    print(
        f"Patch {PATCH[0]}×{PATCH[1]}×{PATCH[2]} on the original voxel grid, "
        f"{PATCHES_PER_CASE} patches per case per epoch. "
        "Edema outside predicted bone is removed.",
        flush=True,
    )

    device = resolve_device(args.device)
    guard_device(device, cudnn_benchmark=args.cudnn_benchmark)
    print(f"device {device}", flush=True)
    if device == "cuda":
        print(f"GPU memory capped at 65% so the desktop is not starved. cuDNN benchmark: {args.cudnn_benchmark}.", flush=True)

    loss_config = {"type": "dice_focal", "bone_weight": 1.0, "edema_weight": 1.0}
    current_fingerprint, fingerprint_payload = compute_dataset_fingerprint(
        case_ids=[c["id"] for c in cases],
        groups=groups,
        batch_size=1,
        patches_per_case=PATCHES_PER_CASE,
        lesion_sampling_ratio=0.7,
        learning_rate=1e-3,
        loss_config=loss_config,
        independent_fold_seeds=bool(args.independent_fold_seeds),
        data_flags=data_config,
        fold_mode=fold_mode,
        patient_count=patient_count,
        sampling_mix=sampling_mix_dict,
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
                if ckpt_patch is not None and list(ckpt_patch) != list(PATCH):
                    mismatches.append(f"patch shape (saved {ckpt_patch} != current {list(PATCH)})")
                if ckpt_data_cfg is not None and ckpt_data_cfg != data_config:
                    mismatches.append(f"data_config (saved {ckpt_data_cfg} != current {data_config})")
                if m_epochs is not None and m_epochs != args.epochs:
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
            model = build_model(arch=ckpt_arch, base_channels=ckpt_bc, double_conv=ckpt_dc).to(device)
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

            model = build_model(arch=args.model_arch, base_channels=args.base_channels, double_conv=args.double_conv).to(device)
            if args.channels_last_3d:
                model = model.to(memory_format=torch.channels_last_3d)

            opt = torch.optim.Adam(model.parameters(), lr=1e-3)
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
                model.load_state_dict(ckpt["state"])
                if "opt" in ckpt:
                    opt.load_state_dict(ckpt["opt"])
                if scaler and "scaler" in ckpt and ckpt["scaler"] is not None:
                    scaler.load_state_dict(ckpt["scaler"])
                start_epoch = int(ckpt.get("epoch", 0)) + 1
                print(f"fold {fold}: resumed from epoch {start_epoch - 1} ({latest_ckpt.name})", flush=True)
            except ValueError:
                raise
            except Exception as e:
                print(f"fold {fold}: failed to resume latest checkpoint ({e}), starting fresh", flush=True)
                start_epoch = 1

        amp_skipped_total = 0
        total_steps_fold = 0

        for epoch in range(start_epoch, args.epochs + 1):
            t_ep_start = time.time()
            t_data_total = 0.0
            t_train_total = 0.0
            model.train()
            total = 0.0
            steps = 0
            amp_skipped_epoch = 0
            seed_base = (SEED + fold) if args.independent_fold_seeds else SEED
            rng_epoch_data = np.random.default_rng(np.random.SeedSequence([seed_base, fold, epoch]))

            do_flip = bool(args.augment or args.aug_flip)
            do_intensity = bool(args.augment or args.aug_intensity)
            do_noise = bool(args.augment or args.aug_noise)
            has_aug = do_flip or do_intensity or do_noise

            order_cases = train[:]
            random.shuffle(order_cases)

            for case in order_cases:
                t_d0 = time.time()
                if args.resample_patches_each_epoch:
                    cur_patches = []
                    cur_labels = []
                    vol_img = case["volume_image"]
                    vol_lbl = case["volume_labels"]
                    for _ in range(PATCHES_PER_CASE):
                        origin = sample_origin(vol_img.shape, vol_lbl, rng_epoch_data, sampling_mix_dict)
                        p_img = np.ascontiguousarray(crop(vol_img, origin))
                        p_lbl = np.ascontiguousarray(crop(vol_lbl, origin))
                        if has_aug:
                            p_img, p_lbl = apply_augmentation(
                                p_img, p_lbl, rng_epoch_data,
                                do_flip=do_flip, do_intensity=do_intensity, do_noise=do_noise
                            )
                        cur_patches.append(p_img)
                        cur_labels.append(p_lbl)
                elif has_aug:
                    cur_patches = []
                    cur_labels = []
                    for p_img, p_lbl in zip(case["patches"], case["patch_labels"]):
                        a_img, a_lbl = apply_augmentation(
                            p_img, p_lbl, rng_epoch_data,
                            do_flip=do_flip, do_intensity=do_intensity, do_noise=do_noise
                        )
                        cur_patches.append(a_img)
                        cur_labels.append(a_lbl)
                else:
                    cur_patches = case["patches"]
                    cur_labels = case["patch_labels"]
                t_data_total += (time.time() - t_d0)

                for image, labels in zip(cur_patches, cur_labels):
                    t_d0 = time.time()
                    x = torch.from_numpy(image).float().unsqueeze(0).unsqueeze(0).to(device)
                    if args.channels_last_3d:
                        x = x.to(memory_format=torch.channels_last_3d)
                    lab = torch.from_numpy(labels).to(device)
                    tgt, valid = targets(lab)
                    t_data_total += (time.time() - t_d0)

                    t_tr0 = time.time()
                    opt.zero_grad(set_to_none=True)
                    total_steps_fold += 1
                    has_cnet = hasattr(model, "cnet")
                    if has_cnet:
                        has_bme = ((tgt[1] * valid).sum() > 0).float().unsqueeze(0)
                        if use_amp:
                            with torch.amp.autocast(device_type="cuda"):
                                logits, cnet_logit = model(x, return_cnet=True)
                            loss_seg = dice_focal(logits[0].float(), tgt, valid, bme_weight=args.bme_loss_weight)
                            loss_cnet = nn.functional.binary_cross_entropy_with_logits(cnet_logit.view(-1).float(), has_bme.view(-1).float())
                            loss = loss_seg + args.cnet_weight * loss_cnet
                            if not torch.isfinite(loss):
                                amp_skipped_epoch += 1
                                amp_skipped_total += 1
                                continue
                            scale_before = scaler.get_scale()
                            scaler.scale(loss).backward()
                            scaler.step(opt)
                            scaler.update()
                            scale_after = scaler.get_scale()
                            if scale_after < scale_before:
                                amp_skipped_epoch += 1
                                amp_skipped_total += 1
                        else:
                            logits, cnet_logit = model(x, return_cnet=True)
                            loss_seg = dice_focal(logits[0], tgt, valid, bme_weight=args.bme_loss_weight)
                            loss_cnet = nn.functional.binary_cross_entropy_with_logits(cnet_logit.view(-1), has_bme.view(-1))
                            loss = loss_seg + args.cnet_weight * loss_cnet
                            loss.backward()
                            opt.step()
                    else:
                        if use_amp:
                            with torch.amp.autocast(device_type="cuda"):
                                logits = model(x)[0]
                            # Compute loss in full FP32 precision
                            loss = dice_focal(logits.float(), tgt, valid, bme_weight=args.bme_loss_weight)
                            if not torch.isfinite(loss):
                                amp_skipped_epoch += 1
                                amp_skipped_total += 1
                                continue
                            scale_before = scaler.get_scale()
                            scaler.scale(loss).backward()
                            scaler.step(opt)
                            scaler.update()
                            scale_after = scaler.get_scale()
                            if scale_after < scale_before:
                                amp_skipped_epoch += 1
                                amp_skipped_total += 1
                        else:
                            loss = dice_focal(model(x)[0], tgt, valid, bme_weight=args.bme_loss_weight)
                            loss.backward()
                            opt.step()
                    total += float(loss.detach())
                    steps += 1
                    t_tr_delta = time.time() - t_tr0
                    t_train_total += t_tr_delta
                    t_train_accum += t_tr_delta
                    del x, lab, tgt, valid, loss

            t_save_start = time.time()
            if args.checkpoint_every_epoch or args.max_runtime_minutes is not None:
                torch.save(
                    {
                        "epoch": epoch,
                        "state": model.state_dict(),
                        "opt": opt.state_dict(),
                        "scaler": scaler.state_dict() if scaler else None,
                        "patch": PATCH,
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
                    },
                    latest_ckpt,
                )
            t_save_total = time.time() - t_save_start
            t_save_accum += t_save_total

            ep_time = time.time() - t_ep_start
            epoch_times.append(ep_time)
            mean_ep_time = float(np.mean(epoch_times[-10:]))
            rem_ep = (args.epochs - epoch) + ((folds_n - 1 - fold) * args.epochs)
            eta_sec = int(rem_ep * mean_ep_time)
            eta_str = f"{eta_sec // 60}m {eta_sec % 60:02d}s" if eta_sec >= 60 else f"{eta_sec}s"
            amp_info = f", amp_skipped={amp_skipped_epoch}" if (use_amp and amp_skipped_epoch > 0) else ""
            if args.profile:
                print(
                    f"epoch {epoch}/{args.epochs}  loss={total / max(steps, 1):.4f}  "
                    f"[{ep_time:.1f}s: data={t_data_total:.2f}s, train={t_train_total:.2f}s, save={t_save_total:.2f}s{amp_info} | ETA: {eta_str}]",
                    flush=True,
                )
            else:
                print(f"epoch {epoch}/{args.epochs}  loss={total / max(steps, 1):.4f}  [{ep_time:.1f}s/epoch | ETA: {eta_str}{amp_info}]", flush=True)

            if args.max_runtime_minutes is not None:
                elapsed_min = (time.time() - t_pipeline_start) / 60.0
                if elapsed_min >= args.max_runtime_minutes:
                    print("\n" + "=" * 70, flush=True)
                    print(f"[TIME GUARD] Runtime limit reached: {elapsed_min:.2f}m >= {args.max_runtime_minutes:.2f}m.", flush=True)
                    print(f"Completed epoch {epoch}/{args.epochs} of fold {fold}.", flush=True)
                    print(f"Resumable checkpoint safely saved to: {latest_ckpt.name}", flush=True)
                    print(f"To resume in next version: run with --resume. Training will resume from epoch {epoch + 1}.", flush=True)
                    print("Exiting cleanly.", flush=True)
                    print("=" * 70 + "\n", flush=True)
                    time_guard_triggered = True
                    status_payload = {
                        "fold": fold,
                        "status": "incomplete",
                        "epoch_reached": epoch,
                        "target_epochs": args.epochs,
                        "fingerprint": current_fingerprint,
                        "val_cases": sorted([c["id"] for c in val]),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }
                    (out_dir / f"status_fold_{fold}.json").write_text(json.dumps(status_payload, indent=2), encoding="utf-8")
                    break

        if time_guard_triggered:
            break

        t_val_start = time.time()
        bone_d, bme_d, sens, fps, present_hit, present_n = [], [], [], [], 0, 0
        for val_idx, case in enumerate(val, 1):
            loaded = load_case(base, case["id"])
            if not loaded:
                continue
            pred = predict_volume(
                model,
                loaded["image"],
                device,
                val_batch_size=args.val_batch_size,
                use_amp=use_amp,
                channels_last=args.channels_last_3d,
                min_bme_voxels=args.min_bme_voxels,
                cnet_threshold=args.cnet_threshold,
                bme_threshold=args.bme_threshold,
            )
            bone_d.append(dice(loaded["labels"], pred, 1))
            bme_d.append(dice(loaded["labels"], pred, 2))
            s, fp = lesion_stats(loaded["labels"], pred)
            sens.append(s)
            fps.append(fp)
            gt_pos = loaded["bme_voxels"] > 0
            pr_pos = bool((pred == 2).any())
            present_n += 1
            present_hit += int(gt_pos == pr_pos)
            prefix = f"  {case['id']}" if args.show_ids else f"  val case {val_idx}/{len(val)}"
            print(
                f"{prefix}  bone_dice={bone_d[-1]:.3f}  bme_dice={bme_d[-1]:.3f}  "
                f"edema={'yes' if pr_pos else 'no'}",
                flush=True,
            )
            del loaded, pred
            release()
        t_val_total = time.time() - t_val_start
        t_val_accum += t_val_total
        if args.profile:
            print(f"fold {fold} validation time: {t_val_total:.1f}s ({len(val)} cases, val_batch_size={args.val_batch_size})", flush=True)

        if not args.eval_only:
            t_save_f0 = time.time()
            torch.save(
                {
                    "state": model.state_dict(),
                    "patch": PATCH,
                    "seed": SEED,
                    "data_config": data_config,
                    "fold_mode": fold_mode,
                    "patient_count": patient_count,
                    "sampling_mix": sampling_mix_dict,
                    "fingerprint": current_fingerprint,
                    "val_cases": sorted([c["id"] for c in val]),
                    "base_channels": getattr(model, "base_channels", 16),
                    "double_conv": getattr(model, "double_conv", False),
                    "min_bme_voxels": args.min_bme_voxels,
                    "model_arch": getattr(model, "model_arch", args.model_arch),
                    "cnet_threshold": args.cnet_threshold,
                    "cnet_weight": args.cnet_weight,
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
                "epoch_reached": args.epochs,
                "target_epochs": args.epochs,
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

        fold_row = {
            "fold": fold,
            "val": [c["id"] for c in val],
            "val_cases": sorted([c["id"] for c in val]),
            "fold_mode": fold_mode,
            "patient_count": patient_count,
            "sampling_mix": sampling_mix_dict,
            "fingerprint": current_fingerprint,
            "final_loss": float(total / max(steps, 1)) if steps > 0 else 0.0,
            "bone_dice": float(np.mean(bone_d)),
            "bme_dice": float(np.mean(bme_d)),
            "lesion_sensitivity": float(np.mean(sens)),
            "fp_per_case": float(np.mean(fps)),
            "presence_correct": present_hit,
            "presence_n": present_n,
            "min_bme_voxels": args.min_bme_voxels,
            "model_arch": getattr(model, "model_arch", args.model_arch),
            "cnet_threshold": args.cnet_threshold if hasattr(model, "cnet") else None,

            "amp_skipped_steps": amp_skipped_total,
            "amp_skipped_pct": round(amp_pct, 4),
            "data_config": data_config,
            "epochs": args.epochs,
            "seed": SEED,
            "device": device,
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
            "model": "3d-unet",
            "device": device,
            "folds": folds_n,
            "fold_mode": fold_mode,
            "patient_count": patient_count,
            "val_cases_per_fold": {str(r["fold"]): r["val_cases"] for r in fold_rows},
            "sampling_mix": sampling_mix_dict,
            "epochs": args.epochs,
            "seed": SEED,
            "patch": list(PATCH),
            "data_config": data_config,
            "fingerprint": current_fingerprint,
            "n_cases": len(cases),
            "n_bme": n_bme,
            "n_negative": n_neg,
            "summary": {
                "bone_dice": mean_std([r["bone_dice"] for r in fold_rows]),
                "bme_dice": mean_std([r["bme_dice"] for r in fold_rows]),
                "lesion_sensitivity": mean_std([r["lesion_sensitivity"] for r in fold_rows]),
                "fp_per_case": mean_std([r["fp_per_case"] for r in fold_rows]),
            },
            "presence_correct": sum(r["presence_correct"] for r in fold_rows),
            "presence_n": sum(r["presence_n"] for r in fold_rows),
            "min_bme_voxels": args.min_bme_voxels,
            "model_arch": getattr(model, "model_arch", args.model_arch),
            "cnet_threshold": args.cnet_threshold if hasattr(model, "cnet") else None,
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
                f"{folds_n} {fold_mode} folds, patch {PATCH[0]}×{PATCH[1]}×{PATCH[2]}. "
                "Bone and edema are trained together. Edema outside the predicted bone is removed. "
                "Dice, lesion sensitivity, and false positives per case are mean ± std across folds."
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
    elif args.fold is not None or args.run_folds is not None:
        # Check if all folds are now complete across independent processes
        merge_metrics_files(out_dir, folds_n)


if __name__ == "__main__":
    main()
