"""Replace the 3D dataset with a Slicer export downloaded from Drive.

    python ml/scripts/import_slicer_all.py <base> <folder of zips> [--apply]

Drive splits a large folder into several zips; pass the folder they were
downloaded into (or the zips themselves). Works the same on Windows, where the
shell does not expand *.zip. Inside, each
patient is one folder `<top>/<patient>/` holding the scan `.nrrd` and the
`Segmentation.seg.nrrd` drawn on it.

Without --apply this only prints what it would do. With --apply it:
  1. moves the current data/worklist.csv, data/deid_map.csv, data/nifti/ and
     data/annotations/ into data/old_3d/<timestamp>/ (nothing is deleted);
  2. imports each usable patient as BME-001, BME-002, ... in folder-name order,
     so everyone who runs this on the same export gets the same IDs;
  3. writes a new worklist.csv and deid_map.csv (folder -> ID, local only).

A patient is skipped, never guessed at, when its folder has no segmentation,
more than one segmentation file, more than one segment, or no single scan
whose grid matches the segmentation. Skips are listed by ID-free label on
screen and by folder name in data/slicer_import_report.csv, which is under the
gitignored data/ like the rest.

Every segmentation in the export holds one segment, the BME drawn in Slicer, so
a lone segment is mapped to `bme`. Bone marrow is then painted in the 3D tab.
"""

from __future__ import annotations

import argparse
import csv
import shutil
import sys
import tempfile
import zipfile
from collections import defaultdict
from datetime import datetime
from io import TextIOWrapper
from pathlib import Path

import nrrd
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from import_slicer import import_case  # noqa: E402
from rename_segments import segments_in  # noqa: E402
from seg2nifti import seg_affine_ras  # noqa: E402

WORKLIST_FIELDS = ["case_id", "class", "n_series", "primary_dir", "primary_kind", "plane",
                   "n_slices", "slice_thickness", "fat_suppressed", "has_t1", "isotropic",
                   "annotated", "annotator", "nifti", "status", "assigned_to", "is_overlap"]
DEID_FIELDS = ["case_id", "class", "source_archive", "n_dicom", "n_series", "phi_found",
               "burned_in", "skipped_other", "status", "notes"]


def header(zf: zipfile.ZipFile, name: str):
    with zf.open(name) as f:
        return nrrd.read_header(TextIOWrapper(f, encoding="latin-1"))


def grid_matches(scan_h, seg_h) -> bool:
    """True if the segmentation sits on the scan's voxel grid (possibly cropped)."""
    a, b = seg_affine_ras(scan_h), seg_affine_ras(seg_h)
    if not np.allclose(a[:3, :3], b[:3, :3], atol=1e-3):
        return False
    idx = np.linalg.inv(a) @ np.append(b[:3, 3], 1.0)
    start = idx[:3]
    if not np.allclose(start, np.rint(start), atol=1e-2):
        return False
    start = np.rint(start)
    end = start + np.asarray(seg_h["sizes"][-3:]) - 1
    return bool(np.all(start >= 0) and np.all(end < np.asarray(scan_h["sizes"][-3:])))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("zips", nargs="+", help="folder of downloaded zips, or the zips")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    base = Path(args.base)
    data = base / "data"

    folders: dict[str, dict] = defaultdict(lambda: {"scans": [], "segs": []})
    paths = []
    for z in map(Path, args.zips):
        paths += sorted(z.glob("*.zip")) if z.is_dir() else [z]
    if not paths:
        sys.exit(f"no .zip files in {args.zips}")
    zips = [zipfile.ZipFile(z) for z in paths]
    for zf in zips:
        for n in zf.namelist():
            parts = n.split("/")
            if len(parts) != 3 or not parts[2].lower().endswith(".nrrd"):
                continue
            kind = "segs" if parts[2].lower().endswith(".seg.nrrd") else "scans"
            folders[parts[1]][kind].append((zf, n))

    plan, skipped = [], []
    for folder in sorted(folders):
        f = folders[folder]
        label = folder if folder.isdigit() else "named folder"
        if not f["segs"]:
            skipped.append((folder, label, "no segmentation"))
            continue
        if len(f["segs"]) > 1:
            skipped.append((folder, label, f"{len(f['segs'])} segmentation files - which is final?"))
            continue
        seg = f["segs"][0]
        seg_h = header(*seg)
        segs = segments_in(seg_h)
        if len(segs) != 1:
            skipped.append((folder, label, f"{len(segs)} segments - which is BME?"))
            continue
        if not f["scans"]:
            skipped.append((folder, label, "segmentation but no scan file"))
            continue
        matches = [s for s in f["scans"] if grid_matches(header(*s), seg_h)]
        if len(matches) != 1:
            why = "no scan matches the segmentation" if not matches else \
                f"{len(matches)} scans match the segmentation"
            skipped.append((folder, label, why))
            continue
        plan.append((folder, matches[0], seg, next(iter(segs))))

    print(f"{len(folders)} patient folders: {len(plan)} to import, {len(skipped)} skipped\n")
    for i, (folder, label, why) in enumerate(skipped, 1):
        print(f"  skip {i:2d}  {label:<13} {why}")

    if not args.apply:
        print("\ndry run: nothing written. Add --apply to replace the dataset.")
        return

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    old = data / "old_3d" / stamp
    old.mkdir(parents=True)
    for name in ("worklist.csv", "deid_map.csv", "nifti", "annotations"):
        if (data / name).exists():
            shutil.move(str(data / name), str(old / name))
    print(f"\nprevious dataset moved to {old}\n")

    work_rows, deid_rows = [], []
    with tempfile.TemporaryDirectory() as tmp:
        for i, (folder, (vzf, vname), (szf, sname), segname) in enumerate(plan, 1):
            cid = f"BME-{i:03d}"
            vol, seg = Path(tmp) / f"{cid}.nrrd", Path(tmp) / f"{cid}.seg.nrrd"
            with vzf.open(vname) as src, vol.open("wb") as dst:
                shutil.copyfileobj(src, dst)
            with szf.open(sname) as src, seg.open("wb") as dst:
                shutil.copyfileobj(src, dst)
            row = import_case(base, cid, vol, seg, {segname: "bme"}, "bme", WORKLIST_FIELDS)
            work_rows.append(row)
            deid_rows.append({**{k: "" for k in DEID_FIELDS}, "case_id": cid, "class": "bme",
                              "source_archive": folder, "status": "ok",
                              "notes": "3D Slicer export; BME only"})
            vol.unlink()
            seg.unlink()

    for path, fields, rows in ((data / "worklist.csv", WORKLIST_FIELDS, work_rows),
                               (data / "deid_map.csv", DEID_FIELDS, deid_rows)):
        with path.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            w.writerows(rows)
    with (data / "slicer_import_report.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["skip", "folder", "reason"])
        for i, (folder, _, why) in enumerate(skipped, 1):
            w.writerow([i, folder, why])
    print(f"\nimported {len(work_rows)} cases. Skipped folders by name: {data / 'slicer_import_report.csv'}")


if __name__ == "__main__":
    main()
