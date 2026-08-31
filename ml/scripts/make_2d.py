"""Extract 2D PNG slices from the converted volumes, for the 2D baseline model.

    python ml/scripts/make_2d.py "D:/Final yr Prj/bme"

Writes:
    data/slices2d/bme/<CASE>_z###.png
    data/slices2d/non_bme/<CASE>_z###.png
    data/slices2d/index.csv          case_id, class, path  <- used for splits

WHY NOT THE EXISTING PNGs
    `Non BME/Slices/` holds 69 screenshots, but there is no BME equivalent — you
    cannot train a two-class model on one class. The screenshots are also 8-bit
    with the window/level baked in, so a model would partly learn the display
    settings. Extracting from the volumes gives both classes under identical
    preprocessing.

WHAT THE LABEL MEANS — read this before quoting any number
    The label here is CASE-level, applied to every slice of that case. A scan
    from a BME patient has plenty of slices with no edema on them, and those get
    labelled `bme` anyway. That is weak supervision and it puts a ceiling on
    slice-level accuracy that no amount of training removes.

    So: report the CASE-level numbers as the headline, and be explicit that the
    slice-level ones are noisy-label. Aggregating slice predictions up to a case
    vote is the honest way to read this model.
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


def high_intensity_mask(sl: np.ndarray, pct: float = 88.0) -> np.ndarray:
    """Keep only the bright voxels; blank the rest.

    On a fat-suppressed sequence, edema IS brightness. Handing the network the
    bright regions instead of the whole slice means it does not have to first
    learn to ignore ~90% of an image that cannot contain a lesion.

    Threshold is a percentile of the non-background voxels, not a fixed value —
    intensities are not comparable across our three scanners, so any absolute
    number would mask correctly on one vendor and wrongly on another.

    Caveat: growth plates are bright too and survive this mask. Our cases are
    adults so it barely bites, but it would matter on a paediatric dataset.
    """
    body = sl[sl > np.percentile(sl, 10)]
    if body.size == 0:
        return sl
    thr = np.percentile(body, pct)
    out = sl.copy()
    out[out < thr] = 0.0
    return out


def to_uint8(sl: np.ndarray) -> np.ndarray:
    """Percentile window then scale. Robust to the odd very bright voxel."""
    lo, hi = np.percentile(sl, [1.0, 99.0])
    if hi <= lo:
        lo, hi = float(sl.min()), float(sl.max())
    if hi <= lo:
        return np.zeros(sl.shape, np.uint8)
    out = (np.clip(sl, lo, hi) - lo) / (hi - lo)
    return (out * 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--keep", type=float, default=0.6,
                    help="central fraction of slices to keep (default 0.6)")
    ap.add_argument("--max-per-case", type=int, default=24,
                    help="cap slices per case so big volumes do not dominate")
    ap.add_argument("--size", type=int, default=256)
    ap.add_argument("--him", action="store_true",
                    help="high-intensity masking — writes data/slices2d_him/ instead")
    ap.add_argument("--him-pct", type=float, default=88.0,
                    help="percentile kept by the mask (default 88)")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    base = Path(args.base)
    out = base / "data" / ("slices2d_him" if args.him else "slices2d")
    if out.exists() and not args.force:
        sys.exit(f"{out} exists. Use --force to rebuild.")

    vols = sorted((base / "data" / "nifti").glob("*/*_primary.nii.gz"))
    if not vols:
        sys.exit("no volumes — run ml/scripts/convert.py first")

    for cls in ("bme", "non_bme"):
        (out / cls).mkdir(parents=True, exist_ok=True)

    rows = []
    print(f"{len(vols)} volume(s), keeping central {args.keep:.0%}, "
          f"max {args.max_per_case} slices/case\n")

    for vp in vols:
        cid = vp.name.replace("_primary.nii.gz", "")
        cls = "bme" if cid.startswith("BME") else "non_bme"
        img = nib.load(str(vp))
        arr = np.asanyarray(img.dataobj).astype(np.float32)

        # Slice along the axis with the fewest samples — that is the through-plane
        # direction, so each slice is a real anatomical cross-section rather than
        # a thin reformat.
        z_axis = int(np.argmin(arr.shape))
        arr = np.moveaxis(arr, z_axis, 0)
        n = arr.shape[0]

        margin = int(n * (1 - args.keep) / 2)
        idx = list(range(margin, n - margin)) or list(range(n))
        if len(idx) > args.max_per_case:  # even spread, not the first N
            step = len(idx) / args.max_per_case
            idx = [idx[int(i * step)] for i in range(args.max_per_case)]

        kept = 0
        for z in idx:
            sl = arr[z]
            if float(sl.max() - sl.min()) < 1e-6:
                continue  # blank slice
            if args.him:
                sl = high_intensity_mask(sl, args.him_pct)
            png = to_uint8(sl)
            im = Image.fromarray(png).convert("L").resize(
                (args.size, args.size), Image.BILINEAR
            )
            rel = f"{cls}/{cid}_z{z:03d}.png"
            im.save(out / rel)
            rows.append({"case_id": cid, "class": cls, "path": rel})
            kept += 1
        print(f"  {cid:10s} {cls:8s} vol={arr.shape} -> {kept} slice(s)")

    with open(out / "index.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["case_id", "class", "path"])
        w.writeheader()
        w.writerows(rows)

    n_bme = sum(1 for r in rows if r["class"] == "bme")
    cases = len({r["case_id"] for r in rows})
    print("\n" + "=" * 58)
    print(f"cases   : {cases}")
    print(f"slices  : {len(rows)}   bme={n_bme}  non_bme={len(rows)-n_bme}")
    print(f"out     : {out}")
    print("=" * 58)


if __name__ == "__main__":
    main()
