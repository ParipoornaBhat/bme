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
import random
import sys
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


def sample_origin(shape: tuple[int, int, int], labels: np.ndarray, rng: np.random.Generator):
    if (labels == 2).any() and rng.random() < 0.7:
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

    def __init__(self):
        super().__init__()

        def block(i, o):
            return nn.Sequential(
                nn.Conv3d(i, o, 3, padding=1, bias=False),
                nn.InstanceNorm3d(o),
                nn.ReLU(inplace=True),
            )

        self.e1 = block(1, 16)
        self.e2 = block(16, 32)
        self.e3 = block(32, 64)
        self.pool = nn.MaxPool3d(2)
        self.up2 = nn.ConvTranspose3d(64, 32, 2, stride=2)
        self.d2 = block(64, 32)
        self.up1 = nn.ConvTranspose3d(32, 16, 2, stride=2)
        self.d1 = block(32, 16)
        self.out = nn.Conv3d(16, 2, 1)

    def forward(self, x):
        a = self.e1(x)
        b = self.e2(self.pool(a))
        c = self.e3(self.pool(b))
        y = self.d2(torch.cat([self.up2(c), b], 1))
        y = self.d1(torch.cat([self.up1(y), a], 1))
        return self.out(y)


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
    """Leave VRAM for the Windows desktop. A full GPU allocation can freeze the screen."""
    torch.set_num_threads(1)
    if device != "cuda":
        return
    try:
        torch.cuda.set_per_process_memory_fraction(0.65)
    except RuntimeError:
        pass
    torch.backends.cudnn.benchmark = False


def release():
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


@torch.no_grad()
def predict_volume(model: nn.Module, image: np.ndarray, device: str) -> np.ndarray:
    """One patch on the GPU at a time. Votes stay uint16 so the full scan is not copied as float."""
    model.eval()
    shape = image.shape
    padded = pad_volume(image)
    votes_bone = np.zeros(padded.shape, dtype=np.uint16)
    votes_bme = np.zeros(padded.shape, dtype=np.uint16)
    hits = np.zeros(padded.shape, dtype=np.uint16)
    for origin in window_origins(padded.shape):
        patch = np.ascontiguousarray(crop(padded, origin))
        x = torch.from_numpy(patch).float().unsqueeze(0).unsqueeze(0).to(device)
        prob = torch.sigmoid(model(x)[0])
        bone = (prob[0] >= 0.5).cpu().numpy()
        bme = ((prob[1] >= 0.5).cpu().numpy() & bone)
        del x, prob
        sl = tuple(slice(o, o + p) for o, p in zip(origin, PATCH))
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
    ap.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    args = ap.parse_args()

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

    classes = worklist_class(base)
    print("Loading volumes", flush=True)
    print("One scan at a time. Only the training patches are kept, then the volume is released.", flush=True)
    rng_load = np.random.default_rng(SEED)
    cases = []
    for p in files:
        item = load_case(base, p.parent.name)
        if not item:
            continue
        image = pad_volume(item["image"])
        labels = pad_volume(item["labels"])
        patches, patch_labels = [], []
        for _ in range(PATCHES_PER_CASE):
            origin = sample_origin(image.shape, labels, rng_load)
            patches.append(np.ascontiguousarray(crop(image, origin)))
            patch_labels.append(np.ascontiguousarray(crop(labels, origin)))
        cases.append({
            "id": item["id"],
            "cls": classes.get(item["id"], ""),
            "bme_voxels": item["bme_voxels"],
            "patches": patches,
            "patch_labels": patch_labels,
        })
        del item, image, labels, patches, patch_labels
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
        f"Patch {PATCH[0]}×{PATCH[1]}×{PATCH[2]} on the original voxel grid, "
        f"{PATCHES_PER_CASE} patches per case per epoch. "
        "Edema outside predicted bone is removed.",
        flush=True,
    )

    device = resolve_device(args.device)
    guard_device(device)
    print(f"device {device}", flush=True)
    if device == "cuda":
        print("GPU memory capped at 65% so the desktop is not starved.", flush=True)
    order = cases[:]
    random.Random(SEED).shuffle(order)
    groups: list[list[dict]] = [[] for _ in range(folds_n)]
    for i, case in enumerate(order):
        groups[i % folds_n].append(case)

    out_dir = base / "data" / "results3d"
    out_dir.mkdir(parents=True, exist_ok=True)
    fold_rows = []

    for fold, val in enumerate(groups):
        train = [c for g in groups if g is not val for c in g]
        print(f"fold {fold}: train {[c['id'] for c in train]}  val {[c['id'] for c in val]}", flush=True)
        model = UNet3D().to(device)
        opt = torch.optim.Adam(model.parameters(), lr=1e-3)
        for epoch in range(1, args.epochs + 1):
            model.train()
            total = 0.0
            steps = 0
            order_cases = train[:]
            random.shuffle(order_cases)
            for case in order_cases:
                for image, labels in zip(case["patches"], case["patch_labels"]):
                    x = torch.from_numpy(image).float().unsqueeze(0).unsqueeze(0).to(device)
                    lab = torch.from_numpy(labels).to(device)
                    tgt, valid = targets(lab)
                    opt.zero_grad(set_to_none=True)
                    loss = dice_focal(model(x)[0], tgt, valid)
                    loss.backward()
                    opt.step()
                    total += float(loss)
                    steps += 1
                    del x, lab, tgt, valid, loss
            print(f"epoch {epoch}/{args.epochs}  loss={total / max(steps, 1):.4f}", flush=True)

        bone_d, bme_d, sens, fps, present_hit, present_n = [], [], [], [], 0, 0
        for case in val:
            loaded = load_case(base, case["id"])
            if not loaded:
                continue
            pred = predict_volume(model, loaded["image"], device)
            bone_d.append(dice(loaded["labels"], pred, 1))
            bme_d.append(dice(loaded["labels"], pred, 2))
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
        torch.save(
            {"state": model.state_dict(), "patch": PATCH, "seed": SEED},
            out_dir / f"fold_{fold}.pt",
        )
        fold_rows.append({
            "fold": fold,
            "val": [c["id"] for c in val],
            "bone_dice": float(np.mean(bone_d)),
            "bme_dice": float(np.mean(bme_d)),
            "lesion_sensitivity": float(np.mean(sens)),
            "fp_per_case": float(np.mean(fps)),
            "presence_correct": present_hit,
            "presence_n": present_n,
        })

    metrics = {
        "model": "3d-unet",
        "device": device,
        "folds": folds_n,
        "epochs": args.epochs,
        "seed": SEED,
        "patch": list(PATCH),
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
        "per_fold": fold_rows,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "note": (
            f"{len(cases)} volumes ({n_bme} with edema, {n_neg} without), "
            f"{folds_n} patient-level folds, patch {PATCH[0]}×{PATCH[1]}×{PATCH[2]}. "
            "Bone and edema are trained together. Edema outside the predicted bone is removed. "
            "Dice, lesion sensitivity, and false positives per case are mean ± std across folds."
        ),
    }
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    print(metrics["note"], flush=True)
    for key, s in metrics["summary"].items():
        if s:
            print(f"  {key}  {s['mean']:.3f} ± {s['std']:.3f}", flush=True)


if __name__ == "__main__":
    main()
