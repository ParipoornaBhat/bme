"""Build a 2D SEGMENTATION dataset from the 3D annotations.

    python ml/scripts/make_2d_seg.py "D:/Final yr Prj/bme"
    python ml/scripts/make_2d_seg.py "D:/Final yr Prj/bme" --force

Writes data/seg2d3d/ — one PNG image and one PNG mask per kept axial slice,
plus index.csv. Train on it with:

    python ml/scripts/train_2d_seg.py <base> --data seg2d3d --out results2dseg3d

WHY THIS EXISTS
    data/slices2d/ feeds a CLASSIFIER: it answers "does this scan have edema"
    from a per-case label and needs no drawing. Useful, but it cannot mark
    anything, and a per-case label applied to every slice is noisy by
    construction.

    This builds the other thing: image/mask pairs that train a model to outline
    the edema. It needs real annotations — but NOT a second round of drawing. A
    3D annotation is a stack of 2D ones, so the same .seg.nrrd that trains the
    3D model also yields every 2D slice for free.

WHY ITS OWN FOLDER
    data/seg2d/ holds the hand-painted 2D images (build_2d.py,
    make_seg2d_from_masks.py). Volume slices are a different distribution, so
    the two are kept apart and a rebuild here never touches that set.

WHAT THE MODEL SEES
    Exactly what "AI suggestions" on the 3D page feeds it (suggest_3d.py, whose
    functions are reused here): the axial axis from the affine, the slice laid
    out as the viewer draws it, the whole volume windowed to its 1st-99th
    percentile, and padded to a square in millimetres on the 256 canvas rather
    than squashed. A model trained here and run there sees the same pictures.

WHICH SLICES ARE KEPT
    Every slice with bone painted, whether or not it also has edema. Slices
    with bone but no lesion are the negatives that teach the model what healthy
    marrow looks like. A slice with edema but no bone is dropped and counted:
    the bone channel would learn that real bone is background. Slices with
    nothing painted carry no information and are skipped.
"""

from __future__ import annotations

import argparse
import csv
import shutil
import sys
from pathlib import Path

try:
    import numpy as np
    import nibabel as nib
    from PIL import Image
except ImportError:
    sys.exit("missing deps.  pip install numpy nibabel pillow")

sys.path.insert(0, str(Path(__file__).parent))
from suggest_3d import derive_axes, gray_volume, plane_view, to_canvas  # noqa: E402

BONE, BME, UNCERTAIN = 1, 2, 3


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--out", default="seg2d3d", help="folder under data/ (default seg2d3d)")
    ap.add_argument("--force", action="store_true", help="delete and rebuild the output folder")
    args = ap.parse_args()

    base = Path(args.base)
    ann_dir = base / "data" / "annotations"
    if args.out == "seg2d":
        sys.exit("data/seg2d is the hand-painted 2D set; pick another --out")
    out = base / "data" / args.out

    labels = sorted(ann_dir.glob("*/*_labels.nii.gz")) if ann_dir.is_dir() else []
    if not labels:
        sys.exit(
            "no annotations yet.\n"
            "  1. annotate in the web app (/annotate) or 3D Slicer\n"
            "  2. run ml/scripts/seg2nifti.py to produce *_labels.nii.gz\n"
            "  3. run this again"
        )
    if out.exists():
        if not args.force:
            sys.exit(f"{out} exists. Use --force to rebuild.")
        print(f"removing old {out}")
        shutil.rmtree(out)

    print(f"{len(labels)} annotated case(s) -> {out}\n")
    (out / "images").mkdir(parents=True)
    (out / "masks").mkdir(parents=True)

    rows = []
    dropped_total = 0
    for lp in labels:
        cid = lp.parent.name
        vp = base / "data" / "nifti" / cid / f"{cid}_primary.nii.gz"
        if not vp.exists():
            print(f"  {cid}  !! no matching volume, skipped")
            continue

        img = nib.load(str(vp))
        vol = np.asarray(img.dataobj, dtype=np.float32)
        if vol.ndim > 3:
            vol = vol.reshape(vol.shape[:3])
        lab = np.asanyarray(nib.load(str(lp)).dataobj).astype(np.uint8)
        if vol.shape != lab.shape:
            print(f"  {cid}  !! shape mismatch {vol.shape} vs {lab.shape}, skipped")
            continue

        ax = derive_axes(img.affine)
        spacing = [abs(float(z)) or 1.0 for z in img.header.get_zooms()[:3]]
        mm_w = vol.shape[ax["h"]] * spacing[ax["h"]]
        mm_h = vol.shape[ax["v"]] * spacing[ax["v"]]
        gray = gray_volume(vol)

        kept = with_lesion = dropped = 0
        for i in range(vol.shape[ax["slice"]]):
            msk = np.ascontiguousarray(plane_view(lab, ax, i))
            has_bone = bool((msk == BONE).any())
            has = bool((msk == BME).any())
            if not has_bone:
                dropped += int(has)
                continue

            im, _ = to_canvas(np.ascontiguousarray(plane_view(gray, ax, i)), mm_w, mm_h)
            mk, _ = to_canvas(msk, mm_w, mm_h, resample=Image.NEAREST)

            name = f"{cid}_z{i:03d}.png"
            im.save(out / "images" / name)
            mk.save(out / "masks" / name)

            rows.append({
                "case_id": cid, "slice": i, "image": f"images/{name}",
                "mask": f"masks/{name}", "has_lesion": str(has),
                "bone_px": int((msk == BONE).sum()), "bme_px": int((msk == BME).sum()),
            })
            kept += 1
            with_lesion += int(has)

        dropped_total += dropped
        note = f", {dropped} edema slice(s) dropped: no bone painted" if dropped else ""
        print(f"  {cid:10s} {kept:3d} slice(s), {with_lesion} with edema{note}")

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
    print(f"dropped : {dropped_total} edema slice(s) with no bone painted")
    print(f"out     : {out}")
    print(f"\nnext:  python ml/scripts/train_2d_seg.py <base> --data {args.out} --out results2dseg3d")
    print("=" * 58)


if __name__ == "__main__":
    main()
