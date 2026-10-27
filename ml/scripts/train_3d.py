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
import json
import os
import math
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import nibabel as nib
import numpy as np
import torch
import torch.nn as nn
from scipy.ndimage import label as cc_label

sys.path.insert(0, str(Path(__file__).resolve().parent))
from seg2nifti import build_labelmap, read_segmentation, to_volume_grid  # noqa: E402

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


def normalize(raw: np.ndarray) -> np.ndarray:
    """Scale to 0–1 in float32. A Python float here would widen the volume to float64."""
    x = np.asarray(raw, dtype=np.float32)
    lo, hi = np.percentile(x, [1, 99]).astype(np.float32)
    scale = (hi - lo) + np.float32(1e-6)
    out = (x - lo) / scale
    np.clip(out, 0, 1, out=out)
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


def sample_origin(shape: tuple[int, int, int], labels: np.ndarray, rng: np.random.Generator,
                  patch=PATCH, lesion_pts: np.ndarray | None = None):
    pts = lesion_pts if lesion_pts is not None else (np.argwhere(labels == 2) if (labels == 2).any() else None)
    if pts is not None and len(pts) and rng.random() < 0.7:
        point = pts[int(rng.integers(len(pts)))]
        return tuple(
            int(np.clip(point[ax] - patch[ax] // 2, 0, max(0, shape[ax] - patch[ax])))
            for ax in range(3)
        )
    return tuple(
        0 if shape[ax] <= patch[ax] else int(rng.integers(0, shape[ax] - patch[ax] + 1))
        for ax in range(3)
    )


def augment(image: np.ndarray, labels: np.ndarray, rng: np.random.Generator):
    """In-plane flips and a mild intensity change. No resampling, so labels stay exact."""
    for ax in (0, 1):
        if rng.random() < 0.5:
            image = np.flip(image, ax)
            labels = np.flip(labels, ax)
    if rng.random() < 0.8:
        gamma = np.float32(np.exp(rng.uniform(-0.3, 0.3)))
        image = np.power(np.clip(image, 0, 1), gamma)
        image = image * np.float32(rng.uniform(0.9, 1.1)) + np.float32(rng.uniform(-0.05, 0.05))
    return np.ascontiguousarray(image, dtype=np.float32), np.ascontiguousarray(labels)


def volume_path(base: Path, case_id: str) -> Path:
    folder = base / "data" / "nifti" / case_id
    meta = folder / "series.json"
    if meta.exists():
        try:
            annotated = json.loads(meta.read_text(encoding="utf-8")).get("annotated") or ""
        except json.JSONDecodeError:
            annotated = ""
        if annotated and annotated != "primary":
            named = folder / f"{case_id}_{annotated}.nii.gz"
            if named.exists():
                return named
    return folder / f"{case_id}_primary.nii.gz"


def worklist_class(base: Path) -> dict[str, str]:
    path = base / "data" / "worklist.csv"
    if not path.exists():
        return {}
    with path.open(newline="", encoding="utf-8") as f:
        return {row["case_id"]: row.get("class") or "" for row in csv.DictReader(f)}


def load_case(base: Path, case_id: str) -> dict | None:
    seg = base / "data" / "annotations" / case_id / f"{case_id}.seg.nrrd"
    vol = volume_path(base, case_id)
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
    norm = normalize(np.asanyarray(img.dataobj))
    spacing = tuple(float(abs(z)) or 1.0 for z in img.header.get_zooms()[:3])
    for note in notes:
        print(f"  {case_id}  {note}", flush=True)
    return {
        "id": case_id,
        "image": norm.astype(np.float32),
        "labels": placed.astype(np.uint8),
        "bme_voxels": int((placed == 2).sum()),
        "spacing": spacing,
    }


class UNet3D(nn.Module):
    """Joint bone and lesion. Two channels, lesion clipped to bone at inference."""

    def __init__(self, width: int = 16):
        super().__init__()
        w = width

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
        self.up2 = nn.ConvTranspose3d(4 * w, 2 * w, 2, stride=2)
        self.d2 = block(4 * w, 2 * w)
        self.up1 = nn.ConvTranspose3d(2 * w, w, 2, stride=2)
        self.d1 = block(2 * w, w)
        self.out = nn.Conv3d(w, 2, 1)

    def forward(self, x):
        a = self.e1(x)
        b = self.e2(self.pool(a))
        c = self.e3(self.pool(b))
        y = self.d2(torch.cat([self.up2(c), b], 1))
        y = self.d1(torch.cat([self.up1(y), a], 1))
        return self.out(y)


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

    def __init__(self, width: int = 16):
        super().__init__()
        w = width

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
        self.up2 = nn.ConvTranspose3d(4 * w, 2 * w, 2, stride=2)
        self.gate2 = AttentionGate3d(2 * w, 2 * w, w)
        self.d2 = block(4 * w, 2 * w)
        self.up1 = nn.ConvTranspose3d(2 * w, w, 2, stride=2)
        self.gate1 = AttentionGate3d(w, w, max(1, w // 2))
        self.d1 = block(2 * w, w)
        self.out = nn.Conv3d(w, 2, 1)

    def forward(self, x):
        a = self.e1(x)
        b = self.e2(self.pool(a))
        c = self.e3(self.pool(b))
        y = self.up2(c)
        b = self.gate2(b, y)
        y = self.d2(torch.cat([y, b], 1))
        y = self.up1(y)
        a = self.gate1(a, y)
        y = self.d1(torch.cat([y, a], 1))
        return self.out(y)


def build_model(name: str, width: int = 16) -> nn.Module:
    if name == "unet":
        return UNet3D(width)
    if name == "attention-unet":
        return AttentionUNet3D(width)
    raise SystemExit(f"unknown model {name!r}. choices: unet, attention-unet")


def targets(labels: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Bone includes the lesion. Uncertain voxels are left out of the loss."""
    bone = ((labels == 1) | (labels == 2)).float()
    bme = (labels == 2).float()
    valid = (labels != 3).float()
    return torch.stack([bone, bme], 0), valid


def dice_focal(logits: torch.Tensor, target: torch.Tensor, valid: torch.Tensor, gamma: float = 2.0) -> torch.Tensor:
    """Dice + focal. Uncertain voxels are weighted out. Edema is a small fraction of the patch."""
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
        loss = loss + dice + focal
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


def guard_device(device: str):
    """Limit this process. BME_GPU_FRACTION overrides the laptop default of 90%."""
    torch.set_num_threads(1)
    if device != "cuda":
        return
    frac = min(0.95, max(0.05, float(os.environ.get("BME_GPU_FRACTION", "0.90"))))
    try:
        torch.cuda.set_per_process_memory_fraction(frac)
    except RuntimeError:
        pass
    torch.backends.cudnn.benchmark = False
    print(f"GPU memory capped at {frac:.0%} for this process.", flush=True)


def release():
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


@torch.no_grad()
def predict_volume(model: nn.Module, image: np.ndarray, device: str, patch_size=PATCH) -> np.ndarray:
    """One patch on the GPU at a time. Votes stay uint16 so the full scan is not copied as float."""
    model.eval()
    patch_size = tuple(int(p) for p in patch_size)
    shape = image.shape
    padded = pad_volume(image, patch_size)
    votes_bone = np.zeros(padded.shape, dtype=np.uint16)
    votes_bme = np.zeros(padded.shape, dtype=np.uint16)
    hits = np.zeros(padded.shape, dtype=np.uint16)
    for origin in window_origins(padded.shape, patch_size):
        patch = np.ascontiguousarray(crop(padded, origin, patch_size))
        x = torch.from_numpy(patch).float().unsqueeze(0).unsqueeze(0).to(device)
        prob = torch.sigmoid(model(x)[0].float())
        bone = (prob[0] >= 0.5).cpu().numpy()
        bme = ((prob[1] >= 0.5).cpu().numpy() & bone)
        del x, prob
        sl = tuple(slice(o, o + p) for o, p in zip(origin, patch_size))
        votes_bone[sl] += bone
        votes_bme[sl] += bme
        hits[sl] += 1
    votes_bone = votes_bone[: shape[0], : shape[1], : shape[2]]
    votes_bme = votes_bme[: shape[0], : shape[1], : shape[2]]
    hits = np.maximum(hits[: shape[0], : shape[1], : shape[2]], 1)
    out = np.zeros(shape, dtype=np.uint8)
    out[votes_bone * 2 >= hits] = 1
    out[(votes_bme * 2 >= hits) & (out == 1)] = 2
    return out


def mean_std(vals: list[float]) -> dict | None:
    if not vals:
        return None
    a = np.asarray(vals, dtype=float)
    std = float(a.std(ddof=1)) if len(a) > 1 else 0.0
    return {"mean": float(a.mean()), "std": std}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--model", choices=("unet", "attention-unet"), default="unet")
    ap.add_argument("--out", default="", help="folder under data/. Default depends on the model.")
    ap.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    # Defaults reproduce the laptop run. The H200 job (ml/slurm/train_3d.sbatch) raises them.
    ap.add_argument("--width", type=int, default=16, help="channels in the first layer")
    ap.add_argument("--patch", default="96,96,12", help="x,y,z, each divisible by 4")
    ap.add_argument("--patches-per-case", type=int, default=PATCHES_PER_CASE)
    ap.add_argument("--batch", type=int, default=1)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--resample", action="store_true",
                    help="keep scans in memory and cut fresh patches every epoch (needs RAM)")
    ap.add_argument("--augment", action="store_true", help="in-plane flips and intensity jitter")
    ap.add_argument("--amp", action="store_true", help="bfloat16 autocast on CUDA")
    ap.add_argument("--cosine", action="store_true", help="cosine learning-rate decay per fold")
    ap.add_argument("--hours", type=float, default=0.0,
                    help="training time budget across all folds; epochs are fitted to it (0 = off)")
    ap.add_argument("--max-cases", type=int, default=0, help="smoke tests only")
    args = ap.parse_args()
    patch = tuple(int(v) for v in args.patch.split(","))
    if len(patch) != 3 or any(p % 4 for p in patch):
        raise SystemExit(f"--patch must be three numbers divisible by 4, got {args.patch}")
    started = time.monotonic()

    random.seed(SEED)
    np.random.seed(SEED)
    torch.manual_seed(SEED)

    base = Path(args.base)
    ann = base / "data" / "annotations"
    files = sorted(
        p for p in ann.glob("*/*.seg.nrrd") if p.name == f"{p.parent.name}.seg.nrrd"
    ) if ann.is_dir() else []
    if not files:
        raise SystemExit("No 3D annotations. Paint and save a case on the Annotate page first.")
    if args.max_cases:
        files = files[: args.max_cases]

    classes = worklist_class(base)
    print("Loading volumes", flush=True)
    print("One scan at a time. Only the training patches are kept, then the volume is released.", flush=True)
    rng_load = np.random.default_rng(SEED)
    cases = []
    for n, p in enumerate(files, start=1):
        print(f"Reading {p.parent.name} ({n}/{len(files)}). Cutting patches, then releasing the scan.", flush=True)
        item = load_case(base, p.parent.name)
        if not item:
            continue
        image = pad_volume(item["image"], patch)
        labels = pad_volume(item["labels"], patch)
        case = {
            "id": item["id"],
            "cls": classes.get(item["id"], ""),
            "bme_voxels": item["bme_voxels"],
        }
        if args.resample:
            # float16 halves the RAM; patches are cast back to float32 when cut.
            case["image"] = image.astype(np.float16)
            case["labels"] = labels
            case["lesion_pts"] = np.argwhere(labels == 2).astype(np.int32)
        else:
            patches, patch_labels = [], []
            for _ in range(args.patches_per_case):
                origin = sample_origin(image.shape, labels, rng_load, patch)
                patches.append(np.ascontiguousarray(crop(image, origin, patch)))
                patch_labels.append(np.ascontiguousarray(crop(labels, origin, patch)))
            case["patches"] = patches
            case["patch_labels"] = patch_labels
        cases.append(case)
        del item, image, labels
        release()
    if len(cases) < 2:
        raise SystemExit(f"Need at least 2 annotated volumes to hold one out. Found {len(cases)}.")

    n_bme = sum(1 for c in cases if c["bme_voxels"] > 0)
    n_neg = len(cases) - n_bme
    folds_n = max(2, min(args.folds, len(cases)))
    print(
        f"{len(cases)} volumes ({n_bme} with edema, {n_neg} without). "
        f"Using {folds_n} patient-level folds. Seed {SEED}.",
        flush=True,
    )
    print(
        f"Patch {patch[0]}×{patch[1]}×{patch[2]} on the original voxel grid, "
        f"{args.patches_per_case} patches per case per epoch"
        f"{' (fresh every epoch)' if args.resample else ''}, width {args.width}, batch {args.batch}"
        f"{', augmented' if args.augment else ''}. "
        "Edema outside predicted bone is removed.",
        flush=True,
    )

    device = resolve_device(args.device)
    guard_device(device)
    print(f"device {device}", flush=True)
    order = cases[:]
    random.Random(SEED).shuffle(order)
    groups: list[list[dict]] = [[] for _ in range(folds_n)]
    for i, case in enumerate(order):
        groups[i % folds_n].append(case)

    out_name = args.out or ("results3d" if args.model == "unet" else "results3d-attn")
    out_dir = base / "data" / out_name
    out_dir.mkdir(parents=True, exist_ok=True)
    fold_rows = []

    for fold, val in enumerate(groups):
        train = [c for g in groups if g is not val for c in g]
        print(
            f"Fold {fold + 1} of {folds_n}: training on {len(train)} scans, "
            f"then scoring {len(val)} held-out scan(s).",
            flush=True,
        )
        model = build_model(args.model, args.width).to(device)
        opt = torch.optim.Adam(model.parameters(), lr=args.lr)
        rng_train = np.random.default_rng(SEED + fold)
        use_amp = args.amp and device == "cuda"
        fold_epochs = args.epochs
        if args.hours > 0:
            # Whatever is left of the budget, shared by the folds not yet trained.
            left = args.hours * 3600 - (time.monotonic() - started)
            fold_budget = max(60.0, left / (folds_n - fold))
        fold_start = time.monotonic()
        total_steps = folds_n * args.epochs

        def batches():
            items = []
            order_cases = train[:]
            random.shuffle(order_cases)
            for case in order_cases:
                if args.resample:
                    for _ in range(args.patches_per_case):
                        origin = sample_origin(case["image"].shape, case["labels"], rng_train,
                                               patch, case["lesion_pts"])
                        items.append((crop(case["image"], origin, patch).astype(np.float32),
                                      crop(case["labels"], origin, patch)))
                else:
                    items.extend(zip(case["patches"], case["patch_labels"]))
            random.shuffle(items)
            for i in range(0, len(items), args.batch):
                chunk = items[i: i + args.batch]
                if args.augment:
                    chunk = [augment(im, lb, rng_train) for im, lb in chunk]
                yield chunk

        epoch = 0
        while epoch < fold_epochs:
            epoch += 1
            if args.cosine and fold_epochs > 1:
                lr = 1e-5 + (args.lr - 1e-5) * 0.5 * (1 + math.cos(math.pi * (epoch - 1) / (fold_epochs - 1)))
                for g in opt.param_groups:
                    g["lr"] = lr
            model.train()
            total = 0.0
            steps = 0
            for chunk in batches():
                x = torch.from_numpy(np.stack([im for im, _ in chunk])).float().unsqueeze(1).to(device)
                lab = torch.from_numpy(np.stack([lb for _, lb in chunk])).to(device)
                opt.zero_grad(set_to_none=True)
                with torch.autocast("cuda", dtype=torch.bfloat16, enabled=use_amp):
                    logits = model(x)
                logits = logits.float()
                loss = logits.new_zeros(())
                for b in range(len(chunk)):
                    tgt, valid = targets(lab[b])
                    loss = loss + dice_focal(logits[b], tgt, valid)
                loss = loss / len(chunk)
                loss.backward()
                opt.step()
                total += float(loss.detach())
                steps += 1
                del x, lab, logits, loss
            if args.hours > 0 and epoch == 1:
                per_epoch = time.monotonic() - fold_start
                fold_epochs = int(max(2, min(args.epochs, fold_budget // max(per_epoch, 1e-3))))
                print(
                    f"Fold {fold + 1}: one epoch takes {per_epoch:.0f}s; "
                    f"fitting {fold_epochs} epochs into {fold_budget / 60:.0f} min.",
                    flush=True,
                )
                total_steps = folds_n * fold_epochs
            done = fold * fold_epochs + epoch
            width = 24
            fill = int(width * min(done, total_steps) / total_steps)
            print(
                f"[{'#' * fill}{'.' * (width - fill)}] {done}/{total_steps}  "
                f"fold {fold + 1}/{folds_n}  epoch {epoch}/{fold_epochs}  "
                f"learning bone and edema  loss={total / max(steps, 1):.4f}",
                flush=True,
            )

        bone_d, bme_d, sens, fps, present_hit, present_n = [], [], [], [], 0, 0
        bone_box = [0, 0, 0]
        edema_box = [0, 0, 0]
        for vi, case in enumerate(val, start=1):
            print(
                f"Scoring held-out scan {case['id']} ({vi}/{len(val)}). Walking the whole volume.",
                flush=True,
            )
            loaded = load_case(base, case["id"])
            if not loaded:
                continue
            pred = predict_volume(model, loaded["image"], device, patch)
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
            print(
                f"  {case['id']}  bone_dice={bone_d[-1]:.3f}  bme_dice={bme_d[-1]:.3f}  "
                f"edema={'yes' if pr_pos else 'no'}",
                flush=True,
            )
            del loaded, pred
            release()
        b_prec, b_rec, b_f1, b_iou = rates(*bone_box)
        e_prec, e_rec, e_f1, e_iou = rates(*edema_box)
        torch.save(
            {"state": model.state_dict(), "patch": list(patch), "width": args.width, "seed": SEED, "model": args.model},
            out_dir / f"fold_{fold}.pt",
        )
        fold_rows.append({
            "fold": fold,
            "val": [c["id"] for c in val],
            "epochs_run": epoch,
            "bone_dice": float(np.mean(bone_d)),
            "bme_dice": float(np.mean(bme_d)),
            "lesion_sensitivity": float(np.mean(sens)),
            "fp_per_case": float(np.mean(fps)),
            "presence_correct": present_hit,
            "presence_n": present_n,
            "bone_precision": b_prec,
            "bone_recall": b_rec,
            "bone_f1": b_f1,
            "bone_iou": b_iou,
            "edema_precision": e_prec,
            "edema_recall": e_rec,
            "edema_f1": e_f1,
            "edema_iou": e_iou,
        })

    metrics = {
        "model": args.model,
        "device": device,
        "folds": folds_n,
        "epochs": max(r["epochs_run"] for r in fold_rows),
        "seed": SEED,
        "patch": list(patch),
        "width": args.width,
        "batch": args.batch,
        "patches_per_case": args.patches_per_case,
        "resample": args.resample,
        "augment": args.augment,
        "hours_budget": args.hours,
        "hours_taken": round((time.monotonic() - started) / 3600, 2),
        "n_cases": len(cases),
        "n_bme": n_bme,
        "n_negative": n_neg,
        "summary": {
            "bone_dice": mean_std([r["bone_dice"] for r in fold_rows]),
            "bme_dice": mean_std([r["bme_dice"] for r in fold_rows]),
            "lesion_sensitivity": mean_std([r["lesion_sensitivity"] for r in fold_rows]),
            "fp_per_case": mean_std([r["fp_per_case"] for r in fold_rows]),
            "bone_precision": mean_std([r["bone_precision"] for r in fold_rows]),
            "bone_recall": mean_std([r["bone_recall"] for r in fold_rows]),
            "bone_f1": mean_std([r["bone_f1"] for r in fold_rows]),
            "bone_iou": mean_std([r["bone_iou"] for r in fold_rows]),
            "edema_precision": mean_std([r["edema_precision"] for r in fold_rows]),
            "edema_recall": mean_std([r["edema_recall"] for r in fold_rows]),
            "edema_f1": mean_std([r["edema_f1"] for r in fold_rows]),
            "edema_iou": mean_std([r["edema_iou"] for r in fold_rows]),
        },
        "presence_correct": sum(r["presence_correct"] for r in fold_rows),
        "presence_n": sum(r["presence_n"] for r in fold_rows),
        "per_fold": fold_rows,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "note": (
            f"{len(cases)} volumes ({n_bme} with edema, {n_neg} without), "
            f"{folds_n} patient-level folds, patch {patch[0]}×{patch[1]}×{patch[2]}, width {args.width}. "
            "Bone and edema are trained together. Edema outside the predicted bone is removed. "
            "Dice, lesion sensitivity, and false positives per case are mean ± std across folds."
        ),
    }
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    from metrics_log import from_summary
    log_path = from_summary(
        base, task="3d", model=args.model, device=device,
        out_dir=f"data/{out_name}", folds=folds_n, epochs=metrics["epochs"],
        n_cases=len(cases), summary=metrics["summary"],
        n_bme=n_bme, n_negative=n_neg, fp_key="fp_per_case", fp_unit="per_case",
        presence_correct=metrics["presence_correct"], presence_n=metrics["presence_n"],
        patch="x".join(str(p) for p in PATCH),
    )
    print(metrics["note"], flush=True)
    for key, s in metrics["summary"].items():
        if s:
            print(f"  {key}  {s['mean']:.3f} ± {s['std']:.3f}", flush=True)
    print(f"-> {out_dir / 'metrics.json'}", flush=True)
    print(f"-> {log_path}", flush=True)


if __name__ == "__main__":
    main()
