"""The fixed 80/20 split for the one-round (holdout) method.

    python ml/scripts/holdout_split.py <base>            show it (or the proposal if none is saved)
    python ml/scripts/holdout_split.py <base> --create   save the proposal; never overwrites
    python ml/scripts/holdout_split.py <base> --remake   keep the old file under a dated name, save a new one

The split is made once and then fixed: every `train_3d.py --holdout` run reads
this file, so their scores are on the same validation scans. Validation is the
first of the five stratified, patient-grouped folds the cross-validation uses
(negatives and three lesion-size tertiles, seed 1337), so it holds about 20% of
the patients and a fair share of each lesion size.

Reads only the annotations (not the scans' pixels), one at a time.
"""

from __future__ import annotations

import argparse
import datetime
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from seg2nifti import build_labelmap, read_segmentation  # noqa: E402
from train_3d import HOLDOUT_FILE, SEED, load_worklist_metadata, stratified_patient_groups, volume_path  # noqa: E402

FOLDS = 5


def annotated_cases(base: Path) -> list[dict]:
    """Cases with a complete annotation and its scan on this PC (the dataset_manifest.py rule:
    bone_marrow drawn, and edema drawn on BME-class scans). Incomplete ones never enter the split."""
    classes, patients = load_worklist_metadata(base)
    ann = base / "data" / "annotations"
    if not ann.is_dir():
        raise SystemExit("data/annotations is not on this PC, so there is nothing to split.")
    cases = []
    for d in sorted(p for p in ann.iterdir() if p.is_dir()):
        seg = d / f"{d.name}.seg.nrrd"
        if not seg.exists() or not volume_path(base, d.name).exists():
            continue
        try:
            data, _header, segments = read_segmentation(seg)
            lab, _, _ = build_labelmap(data, segments)
        except Exception as e:
            print(f"  {d.name}  skipped ({type(e).__name__})")
            continue
        cls = classes.get(d.name) or ("bme" if d.name.startswith("BME-") else "non_bme")
        if int((lab == 1).sum()) == 0 or (cls == "bme" and int((lab == 2).sum()) == 0):
            print(f"  {d.name}  skipped (annotation not complete yet)")
            continue
        cases.append({
            "id": d.name,
            "patient_id": (patients.get(d.name) or "").strip() or d.name,
            "bme_voxels": int((lab == 2).sum()),
        })
    return cases


def describe(name: str, ids: list[str], by_id: dict[str, dict]) -> None:
    n_bme = sum(1 for i in ids if by_id.get(i, {}).get("bme_voxels", 0) > 0)
    print(f"\n{name}: {len(ids)} scans ({n_bme} with edema, {len(ids) - n_bme} without)")
    for k in range(0, len(ids), 8):
        print(("  " + "  ".join(f"{i:<9}" for i in ids[k:k + 8])).rstrip())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("base", nargs="?", default=".")
    ap.add_argument("--create", action="store_true", help="save the proposed split if none is saved")
    ap.add_argument("--remake", action="store_true", help="replace a saved split (the old file is kept, renamed)")
    args = ap.parse_args()
    base = Path(args.base).resolve()
    path = base / HOLDOUT_FILE

    cases = annotated_cases(base)
    if len(cases) < 5:
        raise SystemExit(f"Only {len(cases)} annotated scans here; a 80/20 split needs at least 5.")
    by_id = {c["id"]: c for c in cases}

    if path.exists() and not args.remake:
        split = json.loads(path.read_text(encoding="utf-8"))
        print(f"Fixed split, saved {split.get('created', '?')} in {HOLDOUT_FILE}. It does not change.")
        describe("Training (80%)", split["train"], by_id)
        describe("Validation (20%)", split["val"], by_id)
        known = set(split["train"]) | set(split["val"])
        new = [c["id"] for c in cases if c["id"] not in known]
        gone = sorted(known - set(by_id))
        if new:
            print(f"\nNewer than the split ({len(new)}): {', '.join(new)}")
            print("A holdout run puts these in training. Validation stays the same.")
        if gone:
            print(f"\nIn the split but not on this PC ({len(gone)}): {', '.join(gone)}. A run skips them.")
        return

    groups = stratified_patient_groups(cases, FOLDS, SEED)
    val = sorted(c["id"] for c in groups[0])
    train = sorted(c["id"] for g in groups[1:] for c in g)
    print(f"{'New' if args.remake else 'Proposed'} split of {len(cases)} annotated scans "
          f"(patient-grouped, stratified by lesion size, seed {SEED}):")
    describe("Training (80%)", train, by_id)
    describe("Validation (20%)", val, by_id)

    if not (args.create or args.remake):
        print(f"\nNot saved yet. Save it with --create; from then on it is fixed in {HOLDOUT_FILE}.")
        return
    if path.exists():
        stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M")
        kept = path.with_name(f"{path.stem}_before_{stamp}.json")
        path.rename(kept)
        print(f"\nThe previous split is kept as {kept.relative_to(base).as_posix()}.")
        print("Scores from runs on the old split are not comparable with runs on this one.")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "created": datetime.date.today().isoformat(),
        "rule": "validation = fold 0 of 5 stratified patient-grouped folds (negatives + 3 lesion-size tertiles)",
        "seed": SEED,
        "train": train,
        "val": val,
    }, indent=1) + "\n", encoding="utf-8")
    print(f"\nSaved to {HOLDOUT_FILE}. Every holdout run uses exactly these lists.")


if __name__ == "__main__":
    main()
