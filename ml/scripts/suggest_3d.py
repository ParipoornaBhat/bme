"""Suggest bone and edema marks on a 3D scan, one axial slice at a time.

    python ml/scripts/suggest_3d.py <base> BME-001 --series tra --out <dir>

This is what "AI suggestions" on the 3D annotate page runs. It loads the
shared 2D weights and never trains. For every slice along the scan's axial
axis it runs:

    - the 2D U-Net (data/results2dseg/checkpoints), through the same
      seg_masks() the Model Results page uses: bone, and edema kept inside
      the predicted bone;
    - the 2D yes/no classifier (data/results2d/checkpoints), for a per-slice
      "BME present" probability.

Coronal and sagittal pictures are never given to either model. The per-slice
masks are stacked back into one volume on the scan's own grid, so the other
two views show the same marks as cuts through that stack.

WHICH AXIS IS AXIAL
    Read from the affine with the same greedy assignment as deriveAxes() in
    client/nextjs/src/app/(dashboard)/annotate/Viewer.tsx. Array axis 2 is not
    assumed to be axial. The result records the axes it used, and the viewer
    refuses the suggestion if they differ from its own.

WHAT THE MODEL SEES
    Each slice is laid out the way the viewer shows it (anterior up), windowed
    to the volume's 1st-99th percentile, and padded to a square in millimetres
    before the resize to the model canvas, so a 624x768 slice is not squashed.
    The 2D models were trained on exported pictures, not on MRI volumes: treat
    the output as a starting point for annotation, not as a measurement.

OUTPUT (in --out)
    labels.bin.gz   uint8 per voxel, 0 none / 1 bone / 2 edema, i fastest
                    (numpy order="F"), the same layout as the viewer's labels
    result.json     dims, axial axes, per-slice pixel counts and probability
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import sys
import time
from pathlib import Path

try:
    import nibabel as nib
    import numpy as np
    import torch
    from PIL import Image
except ImportError as e:
    sys.exit(f"missing dependency: {e}")

sys.path.insert(0, str(Path(__file__).parent))
from gradcam import load_fold  # noqa: E402
from infer_2d import (  # noqa: E402
    SEG_SIZE, THRESHOLD, classify_prob, det_manifest, load_seg_models, seg_manifest, seg_masks,
)

CASE = re.compile(r"^(BME|NBME)-\d{3}$")
SERIES = re.compile(r"^[a-z0-9-]{1,32}$")


def derive_axes(aff: np.ndarray) -> dict:
    """Port of deriveAxes() in Viewer.tsx. Keep the two identical."""
    pairs = sorted(((abs(float(aff[w, a])), w, a) for w in range(3) for a in range(3)),
                   key=lambda t: -t[0])
    for_world: list = [None, None, None]
    taken_w, taken_a = set(), set()
    for _, w, a in pairs:
        if w in taken_w or a in taken_a:
            continue
        taken_w.add(w)
        taken_a.add(a)
        for_world[w] = (a, float(np.sign(aff[w, a])) or 1.0)
        if len(taken_w) == 3:
            break
    for w in range(3):
        if for_world[w] is None:
            free = next((a for a in range(3) if a not in taken_a), w)
            taken_a.add(free)
            for_world[w] = (free, 1.0)
    lr, pa, is_ = for_world
    return {"slice": is_[0], "h": lr[0], "v": pa[0], "flipH": lr[1] < 0, "flipV": pa[1] > 0}


def plane_view(vol: np.ndarray, ax: dict, s: int) -> np.ndarray:
    """Slice s as the viewer draws it: rows top to bottom, columns left to right."""
    idx = [slice(None)] * 3
    idx[ax["slice"]] = s
    sl = vol[tuple(idx)]
    if ax["h"] > ax["v"]:
        sl = sl.T  # now indexed [h, v]
    if ax["flipH"]:
        sl = sl[::-1, :]
    if ax["flipV"]:
        sl = sl[:, ::-1]
    return sl.T[::-1, :]


def put_plane(out: np.ndarray, ax: dict, s: int, img: np.ndarray) -> None:
    """Inverse of plane_view: write a displayed slice back onto the volume grid."""
    sl = img[::-1, :].T
    if ax["flipV"]:
        sl = sl[:, ::-1]
    if ax["flipH"]:
        sl = sl[::-1, :]
    if ax["h"] > ax["v"]:
        sl = sl.T
    idx = [slice(None)] * 3
    idx[ax["slice"]] = s
    out[tuple(idx)] = sl


def to_canvas(gray: np.ndarray, mm_w: float, mm_h: float) -> tuple[Image.Image, tuple]:
    """Fit the slice into a square model canvas, keeping its physical shape."""
    h, w = gray.shape
    m = max(mm_w, mm_h)
    tw = max(1, round(SEG_SIZE * mm_w / m))
    th = max(1, round(SEG_SIZE * mm_h / m))
    x0, y0 = (SEG_SIZE - tw) // 2, (SEG_SIZE - th) // 2
    canvas = Image.new("L", (SEG_SIZE, SEG_SIZE), 0)
    canvas.paste(Image.fromarray(gray).resize((tw, th), Image.BILINEAR), (x0, y0))
    return canvas, (x0, y0, x0 + tw, y0 + th)


def from_canvas(mask: np.ndarray, box: tuple, w: int, h: int) -> np.ndarray:
    crop = Image.fromarray(mask.astype(np.uint8)).crop(box)
    return np.asarray(crop.resize((w, h), Image.NEAREST))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("case")
    ap.add_argument("--series", default="")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    base = Path(args.base)
    if not CASE.match(args.case):
        sys.exit(f"bad case id: {args.case}")
    if args.series and not SERIES.match(args.series):
        sys.exit(f"bad series id: {args.series}")

    d = base / "data" / "nifti" / args.case
    named = d / f"{args.case}_{args.series}.nii.gz" if args.series else None
    src = named if named and named.exists() else d / f"{args.case}_primary.nii.gz"
    if not src.exists():
        sys.exit(f"no volume for {args.case}")

    seg_man = seg_manifest(base)
    if not seg_man:
        sys.exit("No 2D segmentation weights in data/results2dseg/checkpoints.")
    det_man = det_manifest(base)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"reading {args.case} {args.series or 'primary'} -> {out_dir}", flush=True)

    img = nib.load(str(src))
    vol = np.asarray(img.dataobj, dtype=np.float32)
    if vol.ndim > 3:
        vol = vol.reshape(vol.shape[:3])
    dims = [int(x) for x in vol.shape]
    spacing = [abs(float(z)) or 1.0 for z in img.header.get_zooms()[:3]]
    ax = derive_axes(img.affine)

    lo, hi = (float(v) for v in np.percentile(vol, [1, 99]))
    if hi <= lo:
        hi = lo + 1
    gray_vol = (np.clip((vol - lo) / (hi - lo), 0, 1) * 255).astype(np.uint8)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    seg_models = load_seg_models(base, seg_man, device)
    det_models = ([load_fold(base, e, device) for e in det_man["folds"]] if det_man else [])

    w, h = dims[ax["h"]], dims[ax["v"]]
    mm_w, mm_h = w * spacing[ax["h"]], h * spacing[ax["v"]]
    n = dims[ax["slice"]]
    labels = np.zeros(dims, dtype=np.uint8)
    slices = []
    t0 = time.time()
    for s in range(n):
        canvas, box = to_canvas(np.ascontiguousarray(plane_view(gray_vol, ax, s)), mm_w, mm_h)
        bone, lesion, _ = seg_masks(seg_models, canvas, device)
        bone_px = from_canvas(bone, box, w, h).astype(bool)
        lesion_px = from_canvas(lesion, box, w, h).astype(bool) & bone_px
        lab = np.zeros((h, w), dtype=np.uint8)
        lab[bone_px] = 1
        lab[lesion_px] = 2
        put_plane(labels, ax, s, lab)
        prob = round(classify_prob(det_models, canvas, device), 4) if det_models else None
        slices.append({"index": s, "bone": int(bone_px.sum()), "lesion": int(lesion_px.sum()),
                       "prob": prob})
        print(f"progress {s + 1} {n}", flush=True)

    tmp = out_dir / "labels.bin.gz.part"
    with gzip.open(tmp, "wb", compresslevel=6) as fh:
        fh.write(labels.ravel(order="F").tobytes())
    os.replace(tmp, out_dir / "labels.bin.gz")

    result = {
        "ok": True,
        "case": args.case,
        "series": args.series or "primary",
        "dims": dims,
        "axial": ax,
        "threshold": THRESHOLD,
        "device": device,
        "seconds": round(time.time() - t0, 1),
        "slices": slices,
        "segmentation": {"folds": [e.get("fold") for e in seg_man["folds"]],
                         "created_at": seg_man.get("created_at")},
        "detection": ({"folds": [e.get("fold") for e in det_man["folds"]],
                       "created_at": det_man.get("created_at")} if det_man else None),
    }
    tmp = out_dir / "result.json.part"
    tmp.write_text(json.dumps(result), encoding="utf-8")
    os.replace(tmp, out_dir / "result.json")
    print(f"done {n} slices in {result['seconds']}s on {device}", flush=True)


if __name__ == "__main__":
    main()
