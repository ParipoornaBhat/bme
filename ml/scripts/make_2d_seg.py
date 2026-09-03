"""Build a 2D SEGMENTATION dataset from the 3D annotations.

    python ml/scripts/make_2d_seg.py "D:/Final yr Prj/bme"

Writes data/seg2d/ — one PNG image and one PNG mask per annotated slice, plus
index.csv.

WHY THIS EXISTS
    data/slices2d/ feeds a CLASSIFIER: it answers "does this scan have edema"
    from a per-case label and needs no drawing. Useful, but it cannot mark
    anything, and a per-case label applied to every slice is noisy by
    construction.

    This builds the other thing: image/mask pairs that train a model to outline
    the edema. It needs real annotations — but NOT a second round of drawing. A
    3D annotation is a stack of 2D ones, so the same .seg.nrrd that trains the
    3D model also yields every 2D slice for free.

WHICH SLICES ARE KEPT
    Every slice containing labelled bone, whether or not it also contains
    edema. Slices with bone but no lesion are the negatives that teach the model
    what healthy marrow looks like — dropping them would leave a model that
    reports edema on every slice it is shown. Slices with no bone at all carry
    no information and are skipped.
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

try:
    import numpy as np
    import nibabel as nib
    from PIL import Image
except ImportError:
    sys.exit("missing deps.  pip install numpy nibabel pillow")

BONE, BME, UNCERTAIN = 1, 2, 3


def window(sl: np.ndarray) -> np.ndarray:
    lo, hi = np.percentile(sl, [1.0, 99.0])
    if hi <= lo:
        lo, hi = float(sl.min()), float(sl.max())
    if hi <= lo:
        return np.zeros(sl.shape, np.uint8)
    return (((np.clip(sl, lo, hi) - lo) / (hi - lo)) * 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--size", type=int, default=256)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    base = Path(args.base)
    ann_dir = base / "data" / "annotations"
    out = base / "data" / "seg2d"

    labels = sorted(ann_dir.glob("*/*_labels.nii.gz")) if ann_dir.is_dir() else []
    if not labels:
        sys.exit(
            "no annotations yet.\n"
            "  1. annotate in the web app (/annotate) or 3D Slicer\n"
            "  2. run ml/scripts/seg2nifti.py to produce *_labels.nii.gz\n"
            "  3. run this again"
        )
    if out.exists() and not args.force:
        sys.exit(f"{out} exists. Use --force to rebuild.")

    (out / "images").mkdir(parents=True, exist_ok=True)
    (out / "masks").mkdir(parents=True, exist_ok=True)

    rows = []
    print(f"{len(labels)} annotated case(s)\n")

    for lp in labels:
        cid = lp.parent.name
        vp = base / "data" / "nifti" / cid / f"{cid}_primary.nii.gz"
        if not vp.exists():
            print(f"  {cid}  !! no matching volume, skipped")
            continue

        vol = np.asanyarray(nib.load(str(vp)).dataobj).astype(np.float32)
        lab = np.asanyarray(nib.load(str(lp)).dataobj).astype(np.uint8)
        if vol.shape != lab.shape:
            print(f"  {cid}  !! shape mismatch {vol.shape} vs {lab.shape}, skipped")
            continue

        # Slice along the through-plane axis — the one with fewest samples.
        z = int(np.argmin(vol.shape))
        v = np.moveaxis(vol, z, 0)
        m = np.moveaxis(lab, z, 0)

        kept = with_lesion = 0
        for i in range(v.shape[0]):
            msk = m[i]
            if not (msk == BONE).any() and not (msk == BME).any():
                continue  # no bone in this slice: nothing to learn from

            img = Image.fromarray(window(v[i])).convert("L").resize(
                (args.size, args.size), Image.BILINEAR)
            # NEAREST for the mask: any smoothing invents label values that do
            # not exist and blurs the boundary we are trying to learn.
            mk = Image.fromarray(msk).resize((args.size, args.size), Image.NEAREST)

            name = f"{cid}_z{i:03d}.png"
            img.save(out / "images" / name)
            mk.save(out / "masks" / name)

            has = bool((msk == BME).any())
            rows.append({
                "case_id": cid, "slice": i, "image": f"images/{name}",
                "mask": f"masks/{name}", "has_lesion": str(has),
                "bone_px": int((msk == BONE).sum()), "bme_px": int((msk == BME).sum()),
            })
            kept += 1
            with_lesion += int(has)

        print(f"  {cid:10s} {kept:3d} slice(s), {with_lesion} with edema")

    if not rows:
        sys.exit("\nnothing written — no slice contained labelled bone")

    with open(out / "index.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    pos = sum(1 for r in rows if r["has_lesion"] == "True")
    print("\n" + "=" * 58)
    print(f"cases   : {len({r['case_id'] for r in rows})}")
    print(f"slices  : {len(rows)}   with edema: {pos}   without: {len(rows) - pos}")
    print(f"out     : {out}")
    print("\nnext:  python ml/scripts/train_2d_seg.py <base>")
    print("=" * 58)


if __name__ == "__main__":
    main()
