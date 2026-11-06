"""nnU-Net v2 on the same cases and folds as train_3d.py, so the scores compare.

    python ml/scripts/nnunet_prep.py convert <base>    data/nnunet/raw/Dataset501_BMEKnee
    python ml/scripts/nnunet_prep.py splits  <base>    splits_final.json after planning
    python ml/scripts/nnunet_prep.py metrics <base> --config 3d_fullres --out results-nnunet-3d

Run inside a Slurm job on the H200 (ml/slurm/nnunet.sbatch), never on the login
node: reading every scan is compute.

LABELS
    0 background, 1 bone_marrow, 2 bme, 3 ignore. "uncertain" voxels become
    nnU-Net's ignore label: left out of the loss, same as train_3d.py does.
    Labels are placed on each scan's own grid by train_3d.load_case, and the
    image is rewritten with that same affine, so nnU-Net's geometry check holds.

FOLDS
    train_3d.py's case-level folds (seed 1337, each case its own patient,
    shuffled, then each to the smallest fold), written as splits_final.json.
    nnU-Net's own random split would put different cases in each fold.

METRICS
    Computed from nnU-Net's own held-out predictions (fold_k/validation) with
    train_3d.py's functions: bone Dice counts edema as bone, edema Dice, lesion
    sensitivity, false-positive lesions per case. Mean +- std across folds.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

import nibabel as nib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_3d import SEED, dice, lesion_stats, load_case, rates, summarise  # noqa: E402

DATASET = "Dataset501_BMEKnee"
DATASET_ID = 501
PLANS = "nnUNetResEncUNetMPlans"
TRAINER = "nnUNetTrainer_100epochs"


def nn_id(case_id: str) -> str:
    return case_id.replace("-", "_")


def case_id_of(nn: str) -> str:
    return nn.replace("_", "-")


def annotated_cases(base: Path) -> list[str]:
    ann = base / "data" / "annotations"
    return sorted(d.name for d in ann.iterdir() if d.is_dir() and (d / f"{d.name}.seg.nrrd").exists())


def folds_like_train_3d(case_ids: list[str], folds_n: int = 5) -> list[list[str]]:
    """Same assignment as train_3d.py's case-level folds."""
    ids = sorted(case_ids)
    random.Random(SEED).shuffle(ids)
    groups: list[list[str]] = [[] for _ in range(folds_n)]
    for cid in ids:
        groups[min(range(folds_n), key=lambda f: len(groups[f]))].append(cid)
    return groups


def cmd_convert(base: Path):
    raw = base / "data" / "nnunet" / "raw" / DATASET
    (raw / "imagesTr").mkdir(parents=True, exist_ok=True)
    (raw / "labelsTr").mkdir(parents=True, exist_ok=True)
    print(f"writing {raw}")
    kept = []
    for n, cid in enumerate(annotated_cases(base), 1):
        img_out = raw / "imagesTr" / f"{nn_id(cid)}_0000.nii.gz"
        lab_out = raw / "labelsTr" / f"{nn_id(cid)}.nii.gz"
        if img_out.exists() and lab_out.exists():
            kept.append(cid)
            continue
        item = load_case(base, cid)
        if not item:
            continue
        from train_3d import volume_path

        src = nib.load(str(volume_path(base, cid)))
        data = np.asanyarray(src.dataobj)
        if data.ndim != 3 or data.shape != item["labels"].shape:
            print(f"  {cid}  skipped (scan {data.shape} vs labels {item['labels'].shape})", flush=True)
            continue
        nib.save(nib.Nifti1Image(np.asarray(data, dtype=np.float32), src.affine), str(img_out))
        nib.save(nib.Nifti1Image(item["labels"].astype(np.uint8), src.affine), str(lab_out))
        kept.append(cid)
        print(f"  {n}  {cid}  ok", flush=True)
    meta = {
        "channel_names": {"0": "MRI"},
        "labels": {"background": 0, "bone_marrow": 1, "bme": 2, "ignore": 3},
        "numTraining": len(kept),
        "file_ending": ".nii.gz",
        "name": "BME knee",
        "description": "Bone marrow and bone marrow edema, clinical axial knee MRI. Pseudonymised IDs only.",
    }
    (raw / "dataset.json").write_text(json.dumps(meta, indent=2, sort_keys=False), encoding="utf-8")
    (raw / "cases.json").write_text(json.dumps(kept), encoding="utf-8")
    print(f"{len(kept)} cases in {raw}")


def cmd_splits(base: Path):
    raw = base / "data" / "nnunet" / "raw" / DATASET
    kept = json.loads((raw / "cases.json").read_text(encoding="utf-8"))
    groups = folds_like_train_3d(kept)
    splits = [
        {"train": [nn_id(c) for g in groups if g is not val for c in g], "val": [nn_id(c) for c in val]}
        for val in groups
    ]
    out = base / "data" / "nnunet" / "preprocessed" / DATASET / "splits_final.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(splits, indent=2), encoding="utf-8")
    print(f"wrote {out}: " + ", ".join(f"fold {i} val {len(s['val'])}" for i, s in enumerate(splits)))


def cmd_metrics(base: Path, config: str, out_name: str):
    raw = base / "data" / "nnunet" / "raw" / DATASET
    run = base / "data" / "nnunet" / "results" / DATASET / f"{TRAINER}__{PLANS}__{config}"
    rows = []
    for fold in range(5):
        vdir = run / f"fold_{fold}" / "validation"
        preds = sorted(vdir.glob("*.nii.gz")) if vdir.is_dir() else []
        if not preds:
            sys.exit(f"fold {fold} has no validation predictions yet ({vdir}); metrics need all 5 folds")
        bone_d, bme_d, sens, fps = [], [], [], []
        bone_box, edema_box, present_hit = [0, 0, 0], [0, 0, 0], 0
        for p in preds:
            gt = np.asanyarray(nib.load(str(raw / "labelsTr" / p.name)).dataobj).astype(np.uint8)
            pr = np.asanyarray(nib.load(str(p)).dataobj).astype(np.uint8)
            bone_d.append(dice(gt, pr, 1))
            bme_d.append(dice(gt, pr, 2))
            gb, pb = (gt == 1) | (gt == 2), (pr == 1) | (pr == 2)
            bone_box = [bone_box[0] + int((gb & pb).sum()), bone_box[1] + int((~gb & pb).sum()), bone_box[2] + int((gb & ~pb).sum())]
            ge, pe = gt == 2, pr == 2
            edema_box = [edema_box[0] + int((ge & pe).sum()), edema_box[1] + int((~ge & pe).sum()), edema_box[2] + int((ge & ~pe).sum())]
            s, fp = lesion_stats(gt, pr)
            sens.append(s)
            fps.append(fp)
            present_hit += int(bool(ge.any()) == bool(pe.any()))
        b = rates(*bone_box)
        e = rates(*edema_box)
        rows.append({
            "fold": fold,
            "val": [case_id_of(p.name[:-7]) for p in preds],
            "bone_dice": float(np.mean(bone_d)), "bme_dice": float(np.mean(bme_d)),
            "lesion_sensitivity": float(np.mean(sens)), "fp_per_case": float(np.mean(fps)),
            "presence_correct": present_hit, "presence_n": len(preds),
            "bone_precision": b[0], "bone_recall": b[1], "bone_f1": b[2], "bone_iou": b[3],
            "edema_precision": e[0], "edema_recall": e[1], "edema_f1": e[2], "edema_iou": e[3],
        })
        print(f"fold {fold}: {len(preds)} cases  bone {rows[-1]['bone_dice']:.3f}  edema {rows[-1]['bme_dice']:.3f}", flush=True)
    kept = json.loads((raw / "cases.json").read_text(encoding="utf-8"))
    n_bme = sum(1 for c in kept if c.startswith("BME-"))
    metrics = {
        "model": f"nnunet-resenc-m-{config}",
        "folds": 5,
        "fold_mode": "case_level",
        "epochs": 100,
        "seed": SEED,
        "n_cases": len(kept),
        "n_bme": n_bme,
        "n_negative": len(kept) - n_bme,
        "summary": summarise(rows),
        "presence_correct": sum(r["presence_correct"] for r in rows),
        "presence_n": sum(r["presence_n"] for r in rows),
        "per_fold": rows,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "note": (
            f"nnU-Net v2 ResEnc M, {config}, {TRAINER}, train_3d.py's folds. "
            "Scored with train_3d.py's functions; mean +- std across folds."
        ),
    }
    out = base / "data" / out_name
    out.mkdir(parents=True, exist_ok=True)
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    for key, s in metrics["summary"].items():
        if s:
            print(f"  {key}  {s['mean']:.3f} +- {s['std']:.3f}", flush=True)
    print(f"-> {out / 'metrics.json'}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["convert", "splits", "metrics"])
    ap.add_argument("base", type=Path)
    ap.add_argument("--config", default="3d_fullres")
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    base = a.base.resolve()
    if a.cmd == "convert":
        cmd_convert(base)
    elif a.cmd == "splits":
        cmd_splits(base)
    else:
        cmd_metrics(base, a.config, a.out or f"results-nnunet-{a.config}")


if __name__ == "__main__":
    main()
