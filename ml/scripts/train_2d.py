"""2D baseline: slice-level BME classifier with patient-level cross-validation.

    python ml/scripts/train_2d.py "D:/Final yr Prj/bme"
    python ml/scripts/train_2d.py "D:/Final yr Prj/bme" --folds 5 --epochs 8

Outputs into data/results2d/:
    metrics.json      per-fold and pooled: accuracy, precision, recall, F1, AUC
    predictions.csv   every slice: case, true, pred, probability, fold
    review.json       sample of predictions + thumbnails, for the review UI
    confusion.png     confusion matrices
    roc.png           ROC curve

HONEST FRAMING — this matters more than the numbers
    Labels are CASE-level applied to every slice. A BME patient's scan contains
    many slices with no edema visible, and they are all labelled `bme`. So the
    slice-level task is partly unlearnable and slice metrics carry a ceiling
    that is a property of the labels, not the model.

    The CASE-level numbers (majority vote over a case's slices) are the ones to
    put on a slide. Quote slice-level only alongside the explanation above.

    This is a baseline classifier, NOT the segmentation system in docs/PRD.md.
    It says "this scan looks like it has edema"; it does not localise or measure
    anything. Do not present it as the final method.
"""

from __future__ import annotations

import argparse
import base64
import csv
import io
import json
import random
import shutil
import sys
from datetime import datetime
from collections import defaultdict
from pathlib import Path

try:
    import numpy as np
    import torch
    import torch.nn as nn
    from torch.utils.data import Dataset, DataLoader
    import torchvision.transforms as T
    import torchvision.models as tvm
    from PIL import Image
    from sklearn.metrics import (accuracy_score, precision_recall_fscore_support,
                                 roc_auc_score, confusion_matrix, roc_curve)
except ImportError as e:
    sys.exit(f"missing dependency: {e}\n  pip install torch torchvision pillow scikit-learn matplotlib")

SEED = 1337

# Architectures you can train without installing anything — every one of these
# ships inside torchvision, which is already a dependency. `head` names the
# attribute holding the final classifier layer, because torchvision is not
# consistent about it (`fc` on ResNet, `classifier` on the rest).
#
# Deliberately a fixed registry rather than "type any model name": this runs on
# four people's machines, and a text box that pip-installs whatever is typed
# into it is remote code execution with extra steps. To add one, add a line here.
ARCHS = {
    "resnet18":        dict(fn="resnet18",        w="ResNet18_Weights",        head="fc"),
    "resnet34":        dict(fn="resnet34",        w="ResNet34_Weights",        head="fc"),
    "resnet50":        dict(fn="resnet50",        w="ResNet50_Weights",        head="fc"),
    "efficientnet_b0": dict(fn="efficientnet_b0", w="EfficientNet_B0_Weights", head="classifier"),
    "densenet121":     dict(fn="densenet121",     w="DenseNet121_Weights",     head="classifier"),
    "convnext_tiny":   dict(fn="convnext_tiny",   w="ConvNeXt_Tiny_Weights",   head="classifier"),
    "mobilenet_v3_small": dict(fn="mobilenet_v3_small", w="MobileNet_V3_Small_Weights", head="classifier"),
}


def build_model(arch: str, n_classes: int = 2):
    """Instantiate a pretrained backbone and swap its head for our 2 classes."""
    if arch not in ARCHS:
        raise SystemExit(f"unknown arch {arch!r}. Available: {', '.join(ARCHS)}")
    spec = ARCHS[arch]
    weights = getattr(tvm, spec["w"]).IMAGENET1K_V1
    model = getattr(tvm, spec["fn"])(weights=weights)

    head = getattr(model, spec["head"])
    if isinstance(head, nn.Linear):
        setattr(model, spec["head"], nn.Linear(head.in_features, n_classes))
    else:
        # Sequential head — replace the last Linear inside it, keeping dropout etc.
        last = max(i for i, m in enumerate(head) if isinstance(m, nn.Linear))
        head[last] = nn.Linear(head[last].in_features, n_classes)
    return model


def set_seed(s=SEED):
    random.seed(s); np.random.seed(s); torch.manual_seed(s)
    torch.cuda.manual_seed_all(s)


class SliceDS(Dataset):
    def __init__(self, rows, root, train):
        self.rows, self.root = rows, root
        aug = [T.RandomHorizontalFlip(),
               T.RandomAffine(degrees=8, translate=(0.05, 0.05), scale=(0.92, 1.08)),
               T.ColorJitter(brightness=0.15, contrast=0.15)] if train else []
        self.tf = T.Compose([T.Grayscale(3), *aug, T.ToTensor(),
                             T.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        r = self.rows[i]
        img = Image.open(self.root / r["path"])
        return self.tf(img), (1 if r["class"] == "bme" else 0), i


def patient_folds(rows, k, seed=SEED):
    """Group by case, then split CASES across folds. Never slices."""
    by_case = defaultdict(list)
    for r in rows:
        by_case[r["case_id"]].append(r)
    cases = sorted(by_case)
    cls = {c: by_case[c][0]["class"] for c in cases}

    rng = random.Random(seed)
    folds = [[] for _ in range(k)]
    i = 0
    for label in ("bme", "non_bme"):          # stratified, counter carried across
        pool = [c for c in cases if cls[c] == label]
        rng.shuffle(pool)
        for c in pool:
            folds[i % k].append(c)
            i += 1
    return by_case, folds


def run_fold(tr_rows, va_rows, root, epochs, device, arch="resnet18", bs=32, lr=3e-4):
    model = build_model(arch).to(device)

    n_pos = sum(1 for r in tr_rows if r["class"] == "bme")
    n_neg = len(tr_rows) - n_pos
    w = torch.tensor([len(tr_rows) / (2 * max(n_neg, 1)),
                      len(tr_rows) / (2 * max(n_pos, 1))], dtype=torch.float32, device=device)
    crit = nn.CrossEntropyLoss(weight=w)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)

    tl = DataLoader(SliceDS(tr_rows, root, True), batch_size=bs, shuffle=True, num_workers=0)
    vl = DataLoader(SliceDS(va_rows, root, False), batch_size=bs, shuffle=False, num_workers=0)

    for ep in range(epochs):
        model.train()
        tot = 0.0
        for x, y, _ in tl:
            x, y = x.to(device), y.to(device)
            opt.zero_grad()
            loss = crit(model(x), y)
            loss.backward()
            opt.step()
            tot += loss.item() * x.size(0)
        sched.step()
        print(f"      epoch {ep+1}/{epochs}  loss={tot/len(tr_rows):.4f}")

    model.eval()
    probs, trues, idxs = [], [], []
    with torch.no_grad():
        for x, y, i in vl:
            p = torch.softmax(model(x.to(device)), 1)[:, 1]
            probs += p.cpu().tolist(); trues += y.tolist(); idxs += i.tolist()
    return model, np.array(probs), np.array(trues), idxs


def stats(y, p, thr=0.5):
    yh = (p >= thr).astype(int)
    pr, rc, f1, _ = precision_recall_fscore_support(y, yh, average="binary", zero_division=0)
    try:
        auc = roc_auc_score(y, p)
    except ValueError:
        auc = float("nan")
    return {"accuracy": float(accuracy_score(y, yh)), "precision": float(pr),
            "recall": float(rc), "f1": float(f1), "auc": float(auc),
            "confusion": confusion_matrix(y, yh, labels=[0, 1]).tolist(), "n": int(len(y))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--arch", default="resnet18", choices=sorted(ARCHS),
                    help="backbone; all ship with torchvision, nothing to install")
    args = ap.parse_args()

    set_seed()
    base = Path(args.base)
    root = base / "data" / "slices2d"
    idx = root / "index.csv"
    if not idx.exists():
        sys.exit("no data/slices2d/index.csv — run ml/scripts/make_2d.py first")

    rows = list(csv.DictReader(open(idx, encoding="utf-8")))
    by_case, folds = patient_folds(rows, args.folds)
    device = "cuda" if torch.cuda.is_available() else "cpu"

    print(f"slices {len(rows)}   cases {len(by_case)}   device {device}   arch {args.arch}")
    print(f"{args.folds}-fold, patient-level (no case appears in train and val)\n")

    all_p, all_y, all_rows, all_fold = [], [], [], []
    per_fold = []

    for k in range(args.folds):
        va_cases = set(folds[k])
        tr_rows = [r for r in rows if r["case_id"] not in va_cases]
        va_rows = [r for r in rows if r["case_id"] in va_cases]
        if not va_rows:
            print(f"  fold {k}: empty, skipped"); continue
        print(f"  fold {k}: train={len(tr_rows)} slices / val={len(va_rows)} slices "
              f"({len(va_cases)} cases)")

        _, p, y, order = run_fold(tr_rows, va_rows, root, args.epochs, device,
                                 args.arch, args.batch)
        s = stats(y, p)
        per_fold.append(s)
        print(f"      -> acc={s['accuracy']:.3f} f1={s['f1']:.3f} auc={s['auc']:.3f}\n")

        for j, oi in enumerate(order):
            all_rows.append(va_rows[oi]); all_p.append(p[j]); all_y.append(y[j]); all_fold.append(k)

    all_p, all_y = np.array(all_p), np.array(all_y)
    slice_m = stats(all_y, all_p)

    # case level: mean probability over the case's slices
    case_p, case_y, case_ids = defaultdict(list), {}, []
    for r, p, y in zip(all_rows, all_p, all_y):
        case_p[r["case_id"]].append(p); case_y[r["case_id"]] = y
    case_ids = sorted(case_p)
    cp = np.array([np.mean(case_p[c]) for c in case_ids])
    cy = np.array([case_y[c] for c in case_ids])
    case_m = stats(cy, cp)

    out = base / "data" / "results2d"
    out.mkdir(parents=True, exist_ok=True)

    def agg(key):
        v = [f[key] for f in per_fold if not np.isnan(f[key])]
        return {"mean": float(np.mean(v)), "std": float(np.std(v))} if v else None

    metrics = {
        "seed": SEED, "folds": args.folds, "epochs": args.epochs,
        "model": f"{args.arch} (ImageNet pretrained)", "arch": args.arch, "device": device,
        "n_slices": len(rows), "n_cases": len(by_case),
        "slice_level": slice_m,
        "case_level": case_m,
        "per_fold": per_fold,
        "per_fold_summary": {k: agg(k) for k in ("accuracy", "precision", "recall", "f1", "auc")},
        "caveat": ("Labels are case-level applied to every slice; slice metrics are "
                   "noisy-label. Case-level is the honest headline. This is a "
                   "classifier baseline, not the segmentation system."),
    }
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    # Archive this run. data/results2d/ always holds the latest, and runs/ keeps
    # every previous one so the UI can chart progress and compare architectures.
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = out / "runs" / f"{stamp}_{args.arch}"
    run_dir.mkdir(parents=True, exist_ok=True)
    metrics["run_id"] = f"{stamp}_{args.arch}"
    metrics["finished_at"] = datetime.now().isoformat(timespec="seconds")
    (run_dir / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    with open(out / "predictions.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["case_id", "path", "true", "pred", "prob_bme", "fold", "correct"])
        for r, p, y, k in zip(all_rows, all_p, all_y, all_fold):
            w.writerow([r["case_id"], r["path"], int(y), int(p >= .5), f"{p:.4f}", k,
                        int((p >= .5) == y)])

    # review sample: hardest and most confident, with thumbnails
    order = np.argsort(np.abs(all_p - 0.5))
    pick = list(order[:40]) + list(order[-20:])
    review = []
    for i in pick:
        r = all_rows[i]
        im = Image.open(root / r["path"]).convert("L").resize((196, 196))
        buf = io.BytesIO(); im.save(buf, format="JPEG", quality=70)
        review.append({
            "case_id": r["case_id"], "true": int(all_y[i]),
            "prob": float(all_p[i]), "pred": int(all_p[i] >= .5),
            "fold": int(all_fold[i]),
            "thumb": "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode(),
        })
    (out / "review.json").write_text(json.dumps(review), encoding="utf-8")

    print("=" * 60)
    print("SLICE LEVEL (noisy labels — read the caveat)")
    for k in ("accuracy", "precision", "recall", "f1", "auc"):
        print(f"  {k:10s} {slice_m[k]:.3f}")
    print("\nCASE LEVEL  <- the number for your slide")
    for k in ("accuracy", "precision", "recall", "f1", "auc"):
        print(f"  {k:10s} {case_m[k]:.3f}")
    print(f"  confusion  {case_m['confusion']}  [[TN,FP],[FN,TP]]")
    print(f"\nacross folds: " + "  ".join(
        f"{k}={metrics['per_fold_summary'][k]['mean']:.3f}+-{metrics['per_fold_summary'][k]['std']:.3f}"
        for k in ("accuracy", "f1", "auc") if metrics["per_fold_summary"][k]))
    print(f"\n-> {out}")
    print("=" * 60)


if __name__ == "__main__":
    main()
