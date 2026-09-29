"""Place a .seg.nrrd on a case's primary scan and write it as a raw labelmap for the web editor.

    python ml/scripts/read_seg.py <base> <CASE_ID> <seg_file> <out_raw>

Accepts a file saved by the web editor or by 3D Slicer, including Slicer's
cropped extents, overlapping segment layers, and annotations drawn on a
different series of the same study. Segment names are mapped exactly as
seg2nifti.py maps them; an unknown name is an error, never a guess.

`out_raw` is a flat uint8 buffer in the same index order as `_primary.nii.gz`
(x fastest) — the order the editor paints in and write_seg.py reads back.
Prints one JSON line: {"counts": {...}, "warnings": [...]}.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import nibabel as nib  # noqa: E402

from seg2nifti import LABELS, build_labelmap, read_segmentation, to_volume_grid  # noqa: E402


def main():
    if len(sys.argv) < 5:
        sys.exit(__doc__)
    base, case_id = Path(sys.argv[1]), sys.argv[2]
    seg_path, out_path = Path(sys.argv[3]), Path(sys.argv[4])
    series = sys.argv[5] if len(sys.argv) > 5 else ""

    folder = base / "data" / "nifti" / case_id
    named = folder / f"{case_id}_{series}.nii.gz" if series and series != "primary" else None
    vol_path = named if named is not None and named.exists() else folder / f"{case_id}_primary.nii.gz"
    if not vol_path.exists():
        sys.exit(f"no converted volume for {case_id} — run convert.py first")

    try:
        data, header, segments = read_segmentation(seg_path)
    except Exception as e:
        sys.exit(f"not a readable .seg.nrrd ({type(e).__name__}: {e})")
    if not segments:
        sys.exit("no segment metadata — in Slicer, save the Segmentation node as .seg.nrrd")

    lab, _, problems = build_labelmap(data, segments)
    fatal = [p for p in problems if not p.startswith("required segment")]
    if fatal:
        sys.exit("; ".join(fatal) + " — fix with ml/scripts/rename_segments.py")

    try:
        out, warnings = to_volume_grid(lab, header, nib.load(str(vol_path)))
    except ValueError as e:
        sys.exit(str(e))

    out_path.write_bytes(out.ravel(order="F").tobytes())
    counts = {name: int((out == v).sum()) for name, v in LABELS.items()}
    print(json.dumps({"counts": counts, "warnings": warnings}))


if __name__ == "__main__":
    main()
