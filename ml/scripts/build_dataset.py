"""Assemble nnU-Net v2 datasets from the annotated cases.

    python ml/scripts/build_dataset.py "D:/Final yr Prj/bme" --stage bone
    python ml/scripts/build_dataset.py "D:/Final yr Prj/bme" --stage bme
    python ml/scripts/build_dataset.py "D:/Final yr Prj/bme" --stage bone --dry-run

Builds one dataset per cascade stage (docs/PRD.md §4.2, §4.3):

    Dataset001_BMEBone    input: fat-suppressed volume
                          target: bone_marrow
    Dataset002_BMELesion  input: fat-suppressed volume + mirrored copy + bone mask
                          target: bme, with `uncertain` mapped to nnU-Net's
                                  ignore label so those voxels leave the loss

Two things here are easy to get wrong and expensive to discover late:

  * **Splits are patient-level.** Slices from one case must never straddle a
    fold boundary. nnU-Net will happily generate random splits if you let it —
    we write `splits_final.json` ourselves so it cannot.
  * **The test set is locked out entirely.** Held-out cases are not copied into
    imagesTr at all, so they cannot leak into training or into fold validation.
"""

from __future__ import annotations

import argparse
import json
import random
import shutil
import sys
from collections import defaultdict
from pathlib import Path

try:
    import numpy as np
    import nibabel as nib
except ImportError:
    sys.exit("numpy/nibabel missing.  pip install numpy nibabel")

SEED = 20260826  # fixed: an unreproducible split is not a result
N_FOLDS = 5
TEST_FRACTION = 0.15

STAGES = {
    "bone": {
        "dataset_id": 1,
        "name": "Dataset001_BMEBone",
        "channels": {"0": "FS"},
        "labels": {"background": 0, "bone_marrow": 1},
    },
    "bme": {
        "dataset_id": 2,
        "name": "Dataset002_BMELesion",
        "channels": {"0": "FS", "1": "FSmirror", "2": "boneMask"},
        # nnU-Net v2 treats the label literally named "ignore" as excluded from
        # the loss. This is how `uncertain` stops teaching the model that
        # ambiguous edema is normal — exactly the early-stage case we care about.
        "labels": {"background": 0, "bme": 1, "ignore": 2},
    },
}


def load(p: Path):
    img = nib.load(str(p))
    return img, np.asanyarray(img.dataobj)


def save(arr, ref, out: Path):
    out.parent.mkdir(parents=True, exist_ok=True)
    nib.save(nib.Nifti1Image(arr, ref.affine, ref.header), str(out))


def collect(base: Path):
    """Cases that have both a converted volume and a usable labelmap."""
    nifti, ann = base / "data" / "nifti", base / "data" / "annotations"
    cases, missing = [], []
    if not ann.is_dir():
        return cases, ["data/annotations does not exist — nothing annotated yet"]

    for lab in sorted(ann.glob("*/*_labels.nii.gz")):
        cid = lab.parent.name
        vol = nifti / cid / f"{cid}_primary.nii.gz"
        if not vol.exists():
            missing.append(f"{cid}: no converted volume — rerun convert.py")
            continue
        cases.append({"case_id": cid, "volume": vol, "labels": lab,
                      "cls": "bme" if cid.startswith("BME") else "non_bme"})
    return cases, missing


def make_splits(case_ids: list[str], classes: dict[str, str]):
    """Patient-level, class-stratified: locked test set + 5 CV folds."""
    rng = random.Random(SEED)
    by_class = defaultdict(list)
    for cid in case_ids:
        by_class[classes[cid]].append(cid)

    test, trainval = [], []
    for cls, ids in by_class.items():
        ids = sorted(ids)
        rng.shuffle(ids)
        n_test = max(1, round(len(ids) * TEST_FRACTION)) if len(ids) >= 7 else 0
        test += ids[:n_test]
        trainval += ids[n_test:]

    # Round-robin, with the counter carried ACROSS classes rather than reset per
    # class. Resetting leaves late folds empty at small n: 4 positives + 4
    # negatives each restarting at fold 0 fills folds 0-3 and leaves fold 4 with
    # no validation cases at all. Carrying the counter also offsets the classes
    # against each other, which keeps folds class-balanced.
    folds = [[] for _ in range(N_FOLDS)]
    trainval_set = set(trainval)
    i = 0
    for cls in sorted(by_class):
        pool = [c for c in sorted(by_class[cls]) if c in trainval_set]
        rng.shuffle(pool)
        for cid in pool:
            folds[i % N_FOLDS].append(cid)
            i += 1

    splits = []
    for k in range(N_FOLDS):
        val = sorted(folds[k])
        train = sorted(c for j, f in enumerate(folds) if j != k for c in f)
        splits.append({"train": train, "val": val})
    return splits, sorted(test), sorted(trainval)


def build_bone(case, imagesTr: Path, labelsTr: Path):
    cid = case["case_id"]
    vimg, _ = load(case["volume"])
    limg, lab = load(case["labels"])
    if lab.shape != vimg.shape:
        return f"shape mismatch: volume {vimg.shape} vs labels {lab.shape}"

    shutil.copy2(case["volume"], imagesTr / f"{cid}_0000.nii.gz")
    # bme (2) is a subset of marrow, so both count as bone for this stage.
    save(((lab == 1) | (lab == 2)).astype(np.uint8), limg, labelsTr / f"{cid}.nii.gz")
    return None


def build_bme(case, imagesTr: Path, labelsTr: Path):
    cid = case["case_id"]
    vimg, vol = load(case["volume"])
    limg, lab = load(case["labels"])
    if lab.shape != vol.shape:
        return f"shape mismatch: volume {vol.shape} vs labels {lab.shape}"

    bone = ((lab == 1) | (lab == 2)).astype(np.float32)
    if not bone.any():
        return "no bone_marrow voxels — cannot constrain the lesion channel"

    # ch0 volume, ch1 left-right mirror (asymmetry prior, PRD §4.3), ch2 bone mask
    save(vol.astype(np.float32), vimg, imagesTr / f"{cid}_0000.nii.gz")
    save(np.ascontiguousarray(vol[::-1]).astype(np.float32), vimg, imagesTr / f"{cid}_0001.nii.gz")
    save(bone, vimg, imagesTr / f"{cid}_0002.nii.gz")

    out = np.zeros(lab.shape, dtype=np.uint8)
    out[lab == 2] = 1  # bme
    out[lab == 3] = 2  # uncertain -> nnU-Net ignore label
    save(out, limg, labelsTr / f"{cid}.nii.gz")
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--stage", choices=sorted(STAGES), required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    base = Path(args.base)
    spec = STAGES[args.stage]
    root = base / "data" / "nnunet" / "nnUNet_raw" / spec["name"]

    cases, problems = collect(base)
    print(f"stage={args.stage}  dataset={spec['name']}")
    print(f"annotated cases usable: {len(cases)}\n")
    for p in problems:
        print(f"  !! {p}")

    if not cases:
        print(
            "\nNothing to build yet.\n"
            "  1. annotate in Slicer -> data/annotations/<CASE>/<CASE>.seg.nrrd\n"
            "  2. python ml/scripts/seg2nifti.py <base>\n"
            "  3. rerun this\n"
        )
        return

    if len(cases) < N_FOLDS:
        print(f"  !! only {len(cases)} case(s); {N_FOLDS}-fold CV needs at least {N_FOLDS}.")

    classes = {c["case_id"]: c["cls"] for c in cases}
    splits, test, trainval = make_splits([c["case_id"] for c in cases], classes)

    print(f"train/val : {len(trainval)}   locked test: {len(test)}")
    if test:
        print(f"  held out (never copied into imagesTr): {', '.join(test)}")
    empty = []
    for k, s in enumerate(splits):
        n_bme = sum(1 for c in s["val"] if classes[c] == "bme")
        print(f"  fold {k}: train={len(s['train'])} val={len(s['val'])} (val bme={n_bme})")
        if not s["val"]:
            empty.append(k)
    if empty:
        print(f"\n  !! fold(s) {empty} have no validation cases — too few cases for "
              f"{N_FOLDS}-fold CV. Annotate more before trusting any fold metric.")

    if args.dry_run:
        print("\nDRY RUN — nothing written")
        return

    imagesTr, labelsTr = root / "imagesTr", root / "labelsTr"
    for d in (imagesTr, labelsTr):
        d.mkdir(parents=True, exist_ok=True)

    builder = build_bone if args.stage == "bone" else build_bme
    written, failed = 0, []
    test_set = set(test)
    for case in cases:
        if case["case_id"] in test_set:
            continue  # locked out entirely — cannot leak
        err = builder(case, imagesTr, labelsTr)
        if err:
            failed.append((case["case_id"], err))
            print(f"  {case['case_id']}  !! {err}")
        else:
            written += 1

    (root / "dataset.json").write_text(json.dumps({
        "channel_names": spec["channels"],
        "labels": spec["labels"],
        "numTraining": written,
        "file_ending": ".nii.gz",
        "overwrite_image_reader_writer": "SimpleITKIO",
    }, indent=2), encoding="utf-8")

    prep = base / "data" / "nnunet" / "nnUNet_preprocessed" / spec["name"]
    prep.mkdir(parents=True, exist_ok=True)
    (prep / "splits_final.json").write_text(json.dumps(splits, indent=2), encoding="utf-8")

    (base / "data" / "nnunet" / f"{spec['name']}_heldout.json").write_text(
        json.dumps({"test": test, "seed": SEED}, indent=2), encoding="utf-8")

    print(f"\nwrote {written} case(s) -> {root}")
    print(f"splits -> {prep / 'splits_final.json'}  (patient-level, not nnU-Net's random default)")
    if failed:
        print(f"\n!! {len(failed)} failed:")
        for cid, err in failed:
            print(f"   {cid}: {err}")
    print("\nnext:  python ml/scripts/train.py <base> --stage " + args.stage)


if __name__ == "__main__":
    main()
