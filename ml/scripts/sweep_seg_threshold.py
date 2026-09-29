"""Find the lesion decision threshold, without retraining anything.

    python ml/scripts/sweep_seg_threshold.py "D:/Final yr Prj/bme"
    python ml/scripts/sweep_seg_threshold.py <base> --apply

WHY THIS EXISTS
    train_2d_seg.py calls a pixel a lesion when sigmoid(logit) > 0.5. That 0.5
    is a default, not a decision. With 24 lesion slices against 70 empty ones,
    and lesion pixels a small fraction of even those, the network minimises its
    loss by painting generously — so at 0.5 the first real run flagged edema on
    59 of 70 healthy slices, an 84% false-alarm rate, while scoring a perfect
    1.000 lesion sensitivity that meant nothing.

    The threshold is the cheapest lever available: the weights already contain
    the ranking, and re-reading them at a stricter cut costs one forward pass
    per slice instead of a full retrain.

HOW IT STAYS HONEST
    Each fold is evaluated only on the slices that fold held out, using that
    fold's own checkpoint, reproducing the split with the same seed. That is
    the same data separation the training run used; sweeping on slices a
    checkpoint trained on would pick a threshold that flatters it and does not
    transfer.

    Every threshold is reported, not just the winner, so a choice made from
    this table is visibly a choice.

    --apply writes the selected threshold to data/results2dseg/threshold.json
    for inference to read. Without it, nothing is written.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import numpy as np
    import torch
    from torch.utils.data import DataLoader
except ImportError as e:
    sys.exit(f"missing dependency: {e}")

sys.path.insert(0, str(Path(__file__).parent))
from train_2d_seg import (  # noqa: E402
    SegDS, UNet, dice_score, patient_folds, resolve_device,
)

THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("base", nargs="?", default=r"D:/Final yr Prj/bme")
    ap.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    ap.add_argument("--apply", type=float, default=None, metavar="T",
                    help="write this threshold to threshold.json for inference")
    args = ap.parse_args()

    base = Path(args.base)
    out = base / "data" / "results2dseg"
    root = base / "data" / "seg2d"
    idx = root / "index.csv"
    ckpt_dir = out / "checkpoints"

    if not idx.exists():
        sys.exit("no data/seg2d/index.csv — run the segmentation pipeline first")
    metrics_path = out / "metrics.json"
    if not metrics_path.exists():
        sys.exit("no data/results2dseg/metrics.json — nothing has been trained yet")

    meta = json.loads(metrics_path.read_text(encoding="utf-8"))
    folds = int(meta.get("folds", 5))

    if args.apply is not None:
        f = out / "threshold.json"
        f.write_text(json.dumps({"lesion_threshold": args.apply}, indent=2), encoding="utf-8")
        print(f"wrote {f}  lesion_threshold={args.apply}")
        return

    import csv
    rows = list(csv.DictReader(idx.open(encoding="utf-8")))
    by_case, fold_cases = patient_folds(rows, folds)
    device = resolve_device(args.device)
    print(f"{len(rows)} slices, {len(by_case)} cases, {folds} folds, device {device}\n")

    # acc[t] = [bone dice…], [lesion dice…], hits, misses, fp, empty
    acc = {t: {"bone": [], "les": [], "hit": 0, "miss": 0, "fp": 0, "empty": 0}
           for t in THRESHOLDS}

    for k in range(folds):
        ck = ckpt_dir / f"fold{k}.pt"
        if not ck.exists():
            print(f"fold {k}: no checkpoint, skipped")
            continue
        va_cases = set(fold_cases[k])
        va = [r for r in rows if r["case_id"] in va_cases]
        if not va:
            continue

        model = UNet().to(device)
        model.load_state_dict(torch.load(ck, map_location=device)["state_dict"])
        model.eval()

        vl = DataLoader(SegDS(va, root, False), batch_size=8, shuffle=False, num_workers=0)
        with torch.no_grad():
            for x, y in vl:
                x, y = x.to(device), y.to(device)
                prob = torch.sigmoid(model(x))
                for t in THRESHOLDS:
                    p = (prob > t).float()
                    # Same constraint the trainer applies: edema outside bone
                    # is not edema. Sweeping without it would measure a
                    # different model from the one that gets deployed.
                    p[:, 1] = p[:, 1] * p[:, 0]
                    for b in range(x.size(0)):
                        a = acc[t]
                        a["bone"].append(dice_score(p[b, 0], y[b, 0]))
                        has_ref = y[b, 1].sum() > 0
                        has_pred = p[b, 1].sum() > 0
                        if has_ref:
                            a["les"].append(dice_score(p[b, 1], y[b, 1]))
                            a["hit"] += int(has_pred)
                            a["miss"] += int(not has_pred)
                        else:
                            a["empty"] += 1
                            a["fp"] += int(has_pred)
        print(f"fold {k}: {len(va)} held-out slices evaluated")

    print()
    print(f"{'thr':>5}  {'bone Dice':>9}  {'lesion Dice':>11}  {'sens':>6}  "
          f"{'false alarms':>13}  {'missed':>7}")
    print("-" * 66)
    table = []
    for t in THRESHOLDS:
        a = acc[t]
        if not a["bone"]:
            continue
        sens = a["hit"] / max(1, a["hit"] + a["miss"])
        fa = a["fp"] / max(1, a["empty"])
        row = {
            "threshold": t,
            "bone_dice": float(np.mean(a["bone"])),
            "lesion_dice": float(np.mean(a["les"])) if a["les"] else float("nan"),
            "lesion_sensitivity": sens,
            "false_alarm_rate": fa,
            "false_positive_slices": a["fp"],
            "empty_slices": a["empty"],
            "missed_slices": a["miss"],
        }
        table.append(row)
        print(f"{t:>5.2f}  {row['bone_dice']:>9.3f}  {row['lesion_dice']:>11.3f}  "
              f"{sens:>6.3f}  {a['fp']:>4}/{a['empty']:<3} = {fa*100:>3.0f}%  {a['miss']:>7}")

    (out / "threshold_sweep.json").write_text(
        json.dumps({"folds": folds, "rows": table}, indent=2), encoding="utf-8")
    print(f"\n-> {out / 'threshold_sweep.json'}")
    print("\nSensitivity falls as the threshold rises; that is the trade, not a bug.")
    print("Pick the point where false alarms become tolerable without losing lesions,")
    print("then re-run with --apply <t>.")


if __name__ == "__main__":
    main()
