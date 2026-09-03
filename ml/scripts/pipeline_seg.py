"""Run the whole annotation -> trained segmenter chain in one go.

    python ml/scripts/pipeline_seg.py "D:/Final yr Prj/bme"
    python ml/scripts/pipeline_seg.py "D:/Final yr Prj/bme" --epochs 40 --folds 5

Three steps that used to be run by hand:

    1. seg2nifti.py     .seg.nrrd  ->  validated *_labels.nii.gz
    2. make_2d_seg.py   labels     ->  2D image/mask pairs
    3. train_2d_seg.py  pairs      ->  a U-Net that marks edema

Stopping at the first failure is deliberate. Step 1 is a validator as much as a
converter — it rejects unknown segment names, empty required segments, and
lesion voxels outside bone. Pushing past a case it refused would train on labels
already known to be wrong, and the resulting number would look fine.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def run(step: str, args: list[str]) -> bool:
    print(f"\n{'=' * 64}\n{step}\n{'=' * 64}", flush=True)
    proc = subprocess.run([sys.executable, "-u", *args], text=True)
    if proc.returncode != 0:
        print(f"\n!! {step} failed (exit {proc.returncode}). Stopping.", flush=True)
        return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch", type=int, default=8)
    args = ap.parse_args()

    base = Path(args.base)
    scripts = base / "ml" / "scripts"

    ann = base / "data" / "annotations"
    n = len(list(ann.glob("*/*.seg.nrrd"))) if ann.is_dir() else 0
    if n == 0:
        sys.exit(
            "No annotations found.\n\n"
            "  Annotate a few cases first: open /annotate, pick a case, paint\n"
            "  bone_marrow and bme, and save. Then run this again.\n\n"
            "  The segmentation model cannot be trained without labels — that is\n"
            "  the whole difference between it and the yes/no classifier."
        )
    print(f"{n} annotated case(s) found")
    if n < args.folds:
        print(f"!! only {n} case(s) but {args.folds} folds requested — "
              f"dropping to {max(2, n)}-fold")
        args.folds = max(2, n)
    if n < 5:
        print("!! fewer than 5 cases: treat any number from this run as a smoke "
              "test, not a result.")

    ok = (
        run("1/3  Converting and validating annotations",
            [str(scripts / "seg2nifti.py"), str(base), "--force"])
        and run("2/3  Building 2D image/mask pairs",
                [str(scripts / "make_2d_seg.py"), str(base), "--force"])
        and run("3/3  Training the segmentation model",
                [str(scripts / "train_2d_seg.py"), str(base),
                 "--folds", str(args.folds), "--epochs", str(args.epochs),
                 "--batch", str(args.batch)])
    )

    if ok:
        print("\n" + "=" * 64)
        print("Done. Results in data/results2dseg/ and on the Model Results page.")
        print("=" * 64)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
