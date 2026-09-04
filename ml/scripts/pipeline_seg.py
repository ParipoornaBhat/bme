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
    ap.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    args = ap.parse_args()

    base = Path(args.base)
    scripts = base / "ml" / "scripts"

    ann3d = base / "data" / "annotations"
    ann2d = base / "data" / "annotations2d"
    n_3d = len(list(ann3d.glob("*/*.seg.nrrd"))) if ann3d.is_dir() else 0
    n_2d_masks = len(list(ann2d.glob("*/*.png"))) if ann2d.is_dir() else 0

    if n_3d == 0 and n_2d_masks == 0:
        sys.exit(
            "No annotations found.\n\n"
            "  Annotate cases first: open /annotate (either 2D slices or 3D volume),\n"
            "  paint bone_marrow and bme, and save. Then run this again.\n\n"
            "  The segmentation model cannot be trained without labels — that is\n"
            "  the whole difference between it and the yes/no classifier."
        )

    print(f"{n_3d} 3D volume case(s) and {n_2d_masks} 2D slice mask(s) found")

    steps_ok = True
    if n_3d > 0:
        steps_ok = (
            run("1/3  Converting and validating 3D annotations",
                [str(scripts / "seg2nifti.py"), str(base), "--force"])
            and run("2/3  Extracting 2D pairs from 3D annotations",
                    [str(scripts / "make_2d_seg.py"), str(base), "--force"])
        )

    if n_2d_masks > 0 and steps_ok:
        steps_ok = run("2b/3 Assembling 2D slice masks",
                       [str(scripts / "make_seg2d_from_masks.py"), str(base), "--apply"])

    ok = steps_ok and run("3/3  Training the 2D U-Net segmentation model",
                          [str(scripts / "train_2d_seg.py"), str(base),
                           "--folds", str(args.folds), "--epochs", str(args.epochs),
                           "--batch", str(args.batch), "--device", args.device])

    if ok:
        print("\n" + "=" * 64)
        print("Done. Results in data/results2dseg/ and on the Model Results page.")
        print("=" * 64)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
