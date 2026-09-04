"""2D segmentation: a U-Net that MARKS the edema, rather than answering yes/no.

    python ml/scripts/train_2d_seg.py "D:/Final yr Prj/bme"
    python ml/scripts/train_2d_seg.py "D:/Final yr Prj/bme" --folds 5 --epochs 40

Outputs into data/results2dseg/:
    metrics.json     Dice, IoU, lesion sensitivity, false positives per slice
    preview/         overlays: prediction vs reference, for eyeballing
    runs/<stamp>/    archived history

HOW THIS DIFFERS FROM train_2d.py
    train_2d.py is a CLASSIFIER: one label per slice, no drawing needed, and it
    can only say "this looks like edema". This is a SEGMENTER: it outputs a mask
    and therefore a location and an area. It needs real annotations.

WHY IT PREDICTS TWO CHANNELS
    Bone and lesion are learned together rather than lesion alone. Bone is large
    and easy, and the shared encoder carries that signal into the harder lesion
    task; the literature reports the joint model beating the lesion-only one.
    At inference the lesion is then clipped to the predicted bone, which removes
    the muscle and joint-fluid false positives that dominate otherwise.

WHY DICE + FOCAL
    Edema is well under 1% of pixels. Plain cross-entropy converges happily to
    predicting all-background and reports 99% accuracy while finding nothing.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import shutil
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

try:
    import numpy as np
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from torch.utils.data import Dataset, DataLoader
    from PIL import Image
except ImportError as e:
    sys.exit(f"missing dependency: {e}\n  pip install torch torchvision pillow")

SEED = 1337
BONE, BME = 1, 2

# Preprocessing contract, shared with infer_2d.py. Painted masks are saved at
# the source slice's own resolution and the curated 2D set has 77 distinct
# sizes, so a fixed canvas is required before anything can be batched. Masks
# resample NEAREST — a bilinear mask invents label values that do not exist.
IMG_SIZE = 256
CHANNELS = ["bone", "bme"]  # channel 0 = bone incl. lesion, channel 1 = lesion


# ---------------------------------------------------------------- model
class Block(nn.Module):
    def __init__(self, i, o):
        super().__init__()
        self.f = nn.Sequential(
            nn.Conv2d(i, o, 3, padding=1, bias=False), nn.BatchNorm2d(o), nn.ReLU(inplace=True),
            nn.Conv2d(o, o, 3, padding=1, bias=False), nn.BatchNorm2d(o), nn.ReLU(inplace=True),
        )

    def forward(self, x):
        return self.f(x)


class UNet(nn.Module):
    """Compact U-Net. Two output channels: bone and lesion."""

    def __init__(self, ch=(32, 64, 128, 256), out_ch=2):
        super().__init__()
        self.downs = nn.ModuleList()
        prev = 1
        for c in ch:
            self.downs.append(Block(prev, c))
            prev = c
        self.pool = nn.MaxPool2d(2)
        self.bottom = Block(ch[-1], ch[-1] * 2)
        self.ups = nn.ModuleList()
        self.dec = nn.ModuleList()
        prev = ch[-1] * 2
        for c in reversed(ch):
            self.ups.append(nn.ConvTranspose2d(prev, c, 2, stride=2))
            self.dec.append(Block(c * 2, c))
            prev = c
        self.head = nn.Conv2d(ch[0], out_ch, 1)

    def forward(self, x):
        skips = []
        for d in self.downs:
            x = d(x)
            skips.append(x)
            x = self.pool(x)
        x = self.bottom(x)
        for up, dec, skip in zip(self.ups, self.dec, reversed(skips)):
            x = up(x)
            if x.shape[-2:] != skip.shape[-2:]:
                x = F.interpolate(x, size=skip.shape[-2:], mode="nearest")
            x = dec(torch.cat([skip, x], dim=1))
        return self.head(x)


# ---------------------------------------------------------------- data
class SegDS(Dataset):
    def __init__(self, rows, root, train):
        self.rows, self.root, self.train = rows, root, train

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        r = self.rows[i]
        raw_im = Image.open(self.root / r["image"])
        if raw_im.mode != "L":
            raw_im = raw_im.convert("L")
        raw_mk = Image.open(self.root / r["mask"])
        if raw_mk.size != raw_im.size:
            raw_mk = raw_mk.resize(raw_im.size, Image.NEAREST)
        raw_im = raw_im.resize((IMG_SIZE, IMG_SIZE), Image.BILINEAR)
        raw_mk = raw_mk.resize((IMG_SIZE, IMG_SIZE), Image.NEAREST)
        img = np.asarray(raw_im, dtype=np.float32) / 255.0
        msk = np.asarray(raw_mk, dtype=np.uint8)

        if self.train:
            # Geometric only. Brightness jitter is risky here: edema IS
            # brightness on these sequences, so shifting it can turn a lesion
            # into background and teach the model the wrong boundary.
            if random.random() < 0.5:
                img, msk = img[:, ::-1].copy(), msk[:, ::-1].copy()
            if random.random() < 0.5:
                k = random.choice([1, 2, 3])
                img, msk = np.rot90(img, k).copy(), np.rot90(msk, k).copy()

        x = torch.from_numpy(img)[None]
        y = torch.stack([
            torch.from_numpy((msk == BONE) | (msk == BME)).float(),  # bone incl. lesion
            torch.from_numpy(msk == BME).float(),
        ])
        return x, y


def dice_focal(logits, target, eps=1.0):
    p = torch.sigmoid(logits)
    num = 2 * (p * target).sum((0, 2, 3)) + eps
    den = p.sum((0, 2, 3)) + target.sum((0, 2, 3)) + eps
    dice = 1 - (num / den).mean()

    bce = F.binary_cross_entropy_with_logits(logits, target, reduction="none")
    pt = torch.exp(-bce)
    focal = ((1 - pt) ** 2 * bce).mean()
    return dice + focal


def dice_score(pred, target, eps=1e-6):
    inter = (pred * target).sum()
    return float((2 * inter + eps) / (pred.sum() + target.sum() + eps))


def patient_folds(rows, k, seed=SEED):
    by_case = defaultdict(list)
    for r in rows:
        by_case[r["case_id"]].append(r)
    cases = sorted(by_case)
    rng = random.Random(seed)
    rng.shuffle(cases)
    folds = [[] for _ in range(k)]
    for i, c in enumerate(cases):
        folds[i % k].append(c)
    return by_case, folds


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--lr", type=float, default=1e-3)
    args = ap.parse_args()

    random.seed(SEED); np.random.seed(SEED); torch.manual_seed(SEED)

    base = Path(args.base)
    root = base / "data" / "seg2d"
    idx = root / "index.csv"
    if not idx.exists():
        sys.exit("no data/seg2d/index.csv — run ml/scripts/make_2d_seg.py first")

    rows = list(csv.DictReader(open(idx, encoding="utf-8")))
    by_case, folds = patient_folds(rows, args.folds)
    device = "cuda" if torch.cuda.is_available() else "cpu"

    n_cases = len(by_case)
    print(f"slices {len(rows)}   cases {n_cases}   device {device}")
    if n_cases < args.folds:
        sys.exit(f"only {n_cases} annotated case(s); need at least {args.folds} for "
                 f"{args.folds}-fold. Annotate more, or pass --folds {max(2, n_cases)}.")
    print(f"{args.folds}-fold, patient-level (no case in both train and val)\n")

    # One set of weights per fold; inference averages the probability maps over
    # all of them. Wiped first so a shorter run cannot leave stale folds behind.
    ckpt_dir = base / "data" / "results2dseg" / "checkpoints"
    if ckpt_dir.exists():
        shutil.rmtree(ckpt_dir)
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    saved_folds: list[dict] = []

    per_fold = []
    for k in range(args.folds):
        va_cases = set(folds[k])
        tr = [r for r in rows if r["case_id"] not in va_cases]
        va = [r for r in rows if r["case_id"] in va_cases]
        if not va or not tr:
            continue
        print(f"  fold {k}: train={len(tr)} / val={len(va)} slices ({len(va_cases)} cases)")

        model = UNet().to(device)
        opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
        sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
        tl = DataLoader(SegDS(tr, root, True), batch_size=args.batch, shuffle=True)
        vl = DataLoader(SegDS(va, root, False), batch_size=args.batch)

        for ep in range(args.epochs):
            model.train()
            tot = 0.0
            for x, y in tl:
                x, y = x.to(device), y.to(device)
                opt.zero_grad()
                loss = dice_focal(model(x), y)
                loss.backward()
                opt.step()
                tot += loss.item() * x.size(0)
            sched.step()
            if (ep + 1) % 5 == 0 or ep == args.epochs - 1:
                print(f"      epoch {ep+1}/{args.epochs}  loss={tot/len(tr):.4f}")

        model.eval()
        bone_d, les_d, hits, misses, fp = [], [], 0, 0, 0
        with torch.no_grad():
            for x, y in vl:
                x, y = x.to(device), y.to(device)
                p = (torch.sigmoid(model(x)) > 0.5).float()
                # Clip the lesion to predicted bone: edema outside bone is not
                # edema, and this removes the dominant false-positive class.
                p[:, 1] = p[:, 1] * p[:, 0]
                for b in range(x.size(0)):
                    bone_d.append(dice_score(p[b, 0], y[b, 0]))
                    has_ref = y[b, 1].sum() > 0
                    has_pred = p[b, 1].sum() > 0
                    if has_ref:
                        les_d.append(dice_score(p[b, 1], y[b, 1]))
                        hits += int(has_pred)
                        misses += int(not has_pred)
                    elif has_pred:
                        fp += 1

        m = {
            "bone_dice": float(np.mean(bone_d)) if bone_d else float("nan"),
            "lesion_dice": float(np.mean(les_d)) if les_d else float("nan"),
            "lesion_sensitivity": hits / max(1, hits + misses),
            "false_positive_slices": fp,
            "n_val_slices": len(va),
        }
        per_fold.append(m)
        torch.save({
            "channels": CHANNELS,
            "fold": k,
            "img_size": IMG_SIZE,
            "lesion_dice": None if np.isnan(m["lesion_dice"]) else m["lesion_dice"],
            "bone_dice": None if np.isnan(m["bone_dice"]) else m["bone_dice"],
            "state_dict": {n: v.detach().cpu() for n, v in model.state_dict().items()},
        }, ckpt_dir / f"fold{k}.pt")
        saved_folds.append({
            "fold": k, "file": f"fold{k}.pt",
            "lesion_dice": None if np.isnan(m["lesion_dice"]) else m["lesion_dice"],
            "bone_dice": None if np.isnan(m["bone_dice"]) else m["bone_dice"],
        })
        print(f"      -> bone Dice={m['bone_dice']:.3f}  lesion Dice={m['lesion_dice']:.3f}  "
              f"sens={m['lesion_sensitivity']:.3f}  FP slices={fp}"
              f"  (weights -> checkpoints/fold{k}.pt)\n")

    if not per_fold:
        sys.exit("no fold produced a result")

    def agg(key):
        v = [f[key] for f in per_fold if not np.isnan(f[key])]
        return {"mean": float(np.mean(v)), "std": float(np.std(v))} if v else None

    out = base / "data" / "results2dseg"
    out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    metrics = {
        "run_id": f"{stamp}_unet2d", "finished_at": datetime.now().isoformat(timespec="seconds"),
        "model": "2D U-Net, bone + lesion channels", "device": device,
        "folds": args.folds, "epochs": args.epochs, "seed": SEED,
        "n_slices": len(rows), "n_cases": n_cases,
        "per_fold": per_fold,
        "summary": {k: agg(k) for k in ("bone_dice", "lesion_dice", "lesion_sensitivity")},
        "note": ("Lesion Dice is averaged over slices that actually contain a lesion; "
                 "including empty slices would inflate it towards 1. False positives are "
                 "counted on slices with no reference lesion."),
    }
    metrics["checkpoints"] = {"dir": "data/results2dseg/checkpoints",
                              "n_folds": len(saved_folds), "img_size": IMG_SIZE}
    (ckpt_dir / "manifest.json").write_text(json.dumps({
        "created_at": metrics["finished_at"],
        "model": "unet2d",
        "channels": CHANNELS,
        "lesion_channel": 1,
        "img_size": IMG_SIZE,
        "seed": SEED,
        "folds": saved_folds,
        "n_slices": len(rows),
        "n_cases": n_cases,
        "summary": metrics["summary"],
        "note": ("Sigmoid per channel, threshold 0.5. The lesion channel is "
                 "multiplied by the bone channel at inference: edema outside bone "
                 "is not edema. Inference averages the probability maps over all "
                 "folds."),
    }, indent=2), encoding="utf-8")
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    run_dir = out / "runs" / metrics["run_id"]
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    print("=" * 60)
    for k in ("bone_dice", "lesion_dice", "lesion_sensitivity"):
        s = metrics["summary"][k]
        if s:
            print(f"  {k:20s} {s['mean']:.3f} +- {s['std']:.3f}")
    print(f"\n-> {out}")
    print("=" * 60)


if __name__ == "__main__":
    main()
