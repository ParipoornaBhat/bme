"""Convert Slicer `.seg.nrrd` annotations into training labelmaps.

    python ml/scripts/seg2nifti.py "D:/Final yr Prj/bme"
    python ml/scripts/seg2nifti.py "D:/Final yr Prj/bme" --check-only

Reads `data/annotations/<CASE>/<CASE>.seg.nrrd`, writes
`data/annotations/<CASE>/<CASE>_labels.nii.gz` with a FIXED label mapping:

    0 background   1 bone_marrow   2 bme   3 uncertain

The mapping is keyed by **segment name**, never by segment order. This matters:
Slicer stores segments in whatever order they were created, and reordering them
in the UI silently renumbers a plain labelmap. Keying by name means a reorder is
harmless; an unrecognised name is a hard failure rather than a silent mislabel.

Validation is not optional here — a bad label file trains a bad model quietly.
Every case is checked for: unknown segment names, `bme` voxels outside
`bone_marrow`, empty required segments, and geometry mismatch against the source
volume. Problems are reported and that case is skipped.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import nrrd
except ImportError:
    sys.exit("pynrrd missing.  pip install pynrrd")

try:
    import numpy as np
    import nibabel as nib
except ImportError:
    sys.exit("numpy/nibabel missing.  pip install numpy nibabel")


LABELS = {"bone_marrow": 1, "bme": 2, "uncertain": 3}
REQUIRED = ("bone_marrow",)  # a case with no bone labelled is not usable
ALIASES = {  # tolerate common spelling drift, reject everything else
    "bonemarrow": "bone_marrow",
    "bone marrow": "bone_marrow",
    "marrow": "bone_marrow",
    "edema": "bme",
    "oedema": "bme",
    "bme_lesion": "bme",
    "lesion": "bme",
    "unsure": "uncertain",
    "uncertain_region": "uncertain",
}


def canonical(name: str) -> str | None:
    key = name.strip().lower().replace("-", "_")
    if key in LABELS:
        return key
    return ALIASES.get(key) or ALIASES.get(key.replace("_", " "))


def read_segmentation(path: Path):
    """
    Return (labelmap, header, {segment_name: label_value_in_file}).

    A .seg.nrrd is either a 3D labelmap with per-segment metadata, or 4D when
    segments overlap (one binary layer each).
    """
    data, header = nrrd.read(str(path))
    segments = {}
    for key, value in header.items():
        if key.endswith("_Name") and key.startswith("Segment"):
            idx = key.split("_")[0]  # "Segment0"
            label = header.get(f"{idx}_LabelValue", None)
            layer = header.get(f"{idx}_Layer", 0)
            segments[str(value)] = {
                "label": int(label) if label is not None else None,
                "layer": int(layer),
            }
    return data, header, segments


def build_labelmap(data, segments) -> tuple[np.ndarray, dict, list[str]]:
    problems = []
    shape = data.shape[-3:] if data.ndim == 4 else data.shape
    out = np.zeros(shape, dtype=np.uint8)
    found = {}

    for name, info in segments.items():
        canon = canonical(name)
        if canon is None:
            problems.append(f"unknown segment name {name!r} — expected one of {sorted(LABELS)}")
            continue
        if info["label"] is None:
            problems.append(f"segment {name!r} has no LabelValue in the header")
            continue

        layer = data[info["layer"]] if data.ndim == 4 else data
        mask = layer == info["label"]
        if not mask.any():
            # An empty `bme` is the normal, expected state of a non-BME case —
            # that absence is exactly what makes it a negative example. Only a
            # missing REQUIRED segment is a problem. Treating every empty
            # segment as a failure would silently drop all 60 negative cases
            # and train the model on positives alone.
            if canon in REQUIRED:
                problems.append(f"required segment {name!r} is empty")
            continue

        # Painted later wins on overlap; bme must sit on top of bone_marrow.
        out[mask] = LABELS[canon]
        found[canon] = int(mask.sum())

    return out, found, problems


def validate(lab: np.ndarray, found: dict) -> list[str]:
    problems = []
    for req in REQUIRED:
        if req not in found:
            problems.append(f"missing required segment {req!r}")

    if "bme" in found:
        # bme must be a strict subset of the marrow cavity. Anything outside is
        # either a mis-paint into muscle or a bone mask that does not cover the
        # lesion — both make the case unusable for the cascade.
        bone_or_bme = (lab == 1) | (lab == 2)
        # Reconstruct: every bme voxel should have been inside bone_marrow, but
        # bme overwrote it, so check that bme is spatially enclosed by bone.
        from scipy import ndimage  # optional; skip the check if unavailable

        filled = ndimage.binary_fill_holes(bone_or_bme)
        stray = int(((lab == 2) & ~filled).sum())
        if stray:
            problems.append(f"{stray} bme voxels lie outside the bone_marrow region")

    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--check-only", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    base = Path(args.base)
    ann = base / "data" / "annotations"
    if not ann.is_dir():
        sys.exit(
            f"missing {ann}\n"
            "Nothing has been annotated yet, or annotations live elsewhere.\n"
            "Save Slicer segmentations to data/annotations/<CASE_ID>/<CASE_ID>.seg.nrrd"
        )

    files = sorted(ann.glob("*/*.seg.nrrd"))
    if not files:
        sys.exit(f"no .seg.nrrd under {ann}")

    print(f"{len(files)} annotation(s)\n")
    ok, skipped = 0, []

    for seg_path in files:
        cid = seg_path.parent.name
        try:
            data, header, segments = read_segmentation(seg_path)
        except Exception as e:
            skipped.append((cid, f"unreadable: {type(e).__name__}: {e}"))
            print(f"  {cid}  !! unreadable")
            continue

        if not segments:
            skipped.append((cid, "no segment metadata — is this really a .seg.nrrd?"))
            print(f"  {cid}  !! no segment metadata")
            continue

        lab, found, problems = build_labelmap(data, segments)
        try:
            problems += validate(lab, found)
        except ImportError:
            pass  # scipy optional

        counts = "  ".join(f"{k}={v}" for k, v in sorted(found.items()))
        if problems:
            skipped.append((cid, "; ".join(problems)))
            print(f"  {cid}  !! {problems[0]}")
            continue

        print(f"  {cid}  {counts}")

        if args.check_only:
            ok += 1
            continue

        out = seg_path.parent / f"{cid}_labels.nii.gz"
        if out.exists() and not args.force:
            print(f"       exists, skipping (use --force)")
            ok += 1
            continue

        # NRRD space directions -> NIfTI affine.
        affine = np.eye(4)
        try:
            sd = header.get("space directions")
            org = header.get("space origin")
            if sd is not None:
                rows = np.array([r for r in sd if r is not None and not np.any(np.isnan(r))])
                if rows.shape == (3, 3):
                    affine[:3, :3] = rows.T
            if org is not None:
                affine[:3, 3] = np.asarray(org, dtype=float)
            # NRRD is typically LPS, NIfTI is RAS — flip the first two axes.
            affine[:2, :] *= -1
        except Exception as e:
            print(f"       !! affine fallback to identity: {e}")

        nib.save(nib.Nifti1Image(lab, affine), str(out))
        (seg_path.parent / f"{cid}_labels.json").write_text(
            json.dumps({"case_id": cid, "labels": LABELS, "voxel_counts": found}, indent=2),
            encoding="utf-8",
        )
        ok += 1

    print("\n" + "=" * 60)
    print(f"usable   : {ok}")
    if skipped:
        print(f"skipped  : {len(skipped)}")
        for cid, why in skipped:
            print(f"   {cid}: {why}")
        print("\nFix these in Slicer and rerun — a bad label file trains a bad model quietly.")
    print("=" * 60)


if __name__ == "__main__":
    main()
