"""Assemble 2D segmentation dataset from 2D slice masks.

    python ml/scripts/make_seg2d_from_masks.py "D:/Final yr Prj/bme"
    python ml/scripts/make_seg2d_from_masks.py "D:/Final yr Prj/bme" --apply

Scans data/annotations2d/<case_id>/<stem>.mask.png, pairs with
data/slices2d/<cls>/<stem>.png, and builds:

data/seg2d/
    index.csv         case_id,image,mask,has_lesion
    images/<stem>.png grayscale slice
    masks/<stem>.png  uint8 mask (0=bg, 1=bone, 2=bme, 3=uncertain)
"""

from __future__ import annotations

import argparse
import csv
import shutil
import sys
from pathlib import Path
from PIL import Image
import numpy as np

BONE, BME, UNCERTAIN = 1, 2, 3


def find_image(slices_dir: Path, stem: str) -> Path | None:
    for sub in ("bme", "non_bme"):
        p = slices_dir / sub / f"{stem}.png"
        if p.exists():
            return p
    found = list(slices_dir.glob(f"**/{stem}.png"))
    return found[0] if found else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base", help="Base repository path")
    ap.add_argument("--apply", action="store_true", help="Write files to data/seg2d")
    args = ap.parse_args()

    base = Path(args.base)
    ann_dir = base / "data" / "annotations2d"
    slices_dir = base / "data" / "slices2d"
    out_dir = base / "data" / "seg2d"

    if not ann_dir.exists():
        print(f"Directory {ann_dir} does not exist yet.")
        print("Create annotations via the web app (/annotate -> 2D slices) first.")
        sys.exit(0)

    mask_files = sorted(ann_dir.glob("*/*.png"))
    if not mask_files:
        print(f"No mask files found under {ann_dir}.")
        print("Annotate at least one 2D case to build data/seg2d.")
        sys.exit(0)

    print(f"Found {len(mask_files)} mask file(s) in {ann_dir}")

    pairs = []
    skipped = []

    for mf in mask_files:
        case_id = mf.parent.name
        stem = mf.stem
        if stem.endswith(".mask"):
            stem = stem[:-5]

        img_path = find_image(slices_dir, stem)
        if img_path is None:
            skipped.append(f"Image for stem '{stem}' not found in {slices_dir}")
            continue

        pairs.append((case_id, stem, img_path, mf))

    if skipped:
        print(f"Skipped {len(skipped)} files:")
        for s in skipped[:5]:
            print(f"  - {s}")

    print(f"Valid image/mask pairs: {len(pairs)}")

    if not args.apply:
        print("\nDRY RUN. Pass --apply to write data/seg2d.")
        return

    images_out = out_dir / "images"
    masks_out = out_dir / "masks"
    images_out.mkdir(parents=True, exist_ok=True)
    masks_out.mkdir(parents=True, exist_ok=True)

    rows = []
    cases = set()
    n_with_lesion = 0

    for case_id, stem, img_path, mask_path in pairs:
        im = Image.open(img_path).convert("L")
        m = Image.open(mask_path)

        if m.size != im.size:
            m = m.resize(im.size, Image.NEAREST)

        arr = np.asarray(m, dtype=np.uint8)
        has_lesion = int(np.any(arr == BME))
        if has_lesion:
            n_with_lesion += 1

        dest_img = images_out / f"{stem}.png"
        dest_msk = masks_out / f"{stem}.png"

        im.save(dest_img)
        m.save(dest_msk)

        rows.append({
            "case_id": case_id,
            "image": f"images/{stem}.png",
            "mask": f"masks/{stem}.png",
            "has_lesion": has_lesion,
        })
        cases.add(case_id)

    idx_csv = out_dir / "index.csv"
    with idx_csv.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["case_id", "image", "mask", "has_lesion"])
        w.writeheader()
        w.writerows(rows)

    print(f"\nWrote {len(rows)} slice pairs across {len(cases)} case(s) to {out_dir}")
    print(f"Lesion positive slices: {n_with_lesion} / {len(rows)}")
    print(f"Index written to {idx_csv}")


if __name__ == "__main__":
    main()
