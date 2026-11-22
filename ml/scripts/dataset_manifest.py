"""Snapshot of the dataset a training run starts with.

    python ml/scripts/dataset_manifest.py <base> --out data/<run>/dataset_manifest.json [--all]

Lists every annotated case on this PC with a hash of its annotation file, its
voxel counts, and whether it is used. A case is used only when its annotation
is complete:

  - bone_marrow is drawn (the model learns bone on every scan), and
  - on a BME-class scan, bme (edema) is drawn too.

Cases still being annotated are left out with the reason. --all keeps every
annotated case (for a run that was already started on all of them, so its
later parts and folds keep the same set).

train_3d.py --case-list <file> then trains, splits folds and resumes on
exactly these cases. Reads the annotations only, one at a time.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from seg2nifti import build_labelmap, read_segmentation  # noqa: E402
from train_3d import load_worklist_metadata, volume_path  # noqa: E402

# An annotation marked on fewer slices than this (all labels together) is a stray
# mark, not an annotation. A single label may be small: edema on one slice is fine.
MIN_MARKED_SLICES = 5
RULE = (f"used = marked on at least {MIN_MARKED_SLICES} slices overall, bone_marrow drawn, "
        f"and on BME-class scans bme drawn")


def slices_with(lab: np.ndarray, value: int | None = None) -> int:
    """Slices holding this label (or any label when value is None). The slice axis is the
    shortest one (slices are 3-6 mm apart)."""
    axis = int(np.argmin(lab.shape))
    other = tuple(i for i in range(lab.ndim) if i != axis)
    mask = lab > 0 if value is None else lab == value
    return int(np.any(mask, axis=other).sum())


def incomplete_reason(lab: np.ndarray, cls: str) -> str:
    """Why this annotation is not complete yet, or "" when it can be trained on."""
    if not np.any(lab == 1):
        return "no bone_marrow drawn yet"
    if cls == "bme" and not np.any(lab == 2):
        return "BME scan with no edema drawn yet"
    marked = slices_with(lab)
    if marked < MIN_MARKED_SLICES:
        return f"marked on only {marked} slice(s)"
    return ""


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git_commit(base: Path) -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=base, capture_output=True, text=True).stdout.strip()
    except OSError:
        return ""


def build(base: Path, keep_all: bool) -> dict:
    classes, _patients = load_worklist_metadata(base)
    ann = base / "data" / "annotations"
    if not ann.is_dir():
        raise SystemExit("data/annotations is not on this PC.")
    rows = []
    for d in sorted(p for p in ann.iterdir() if p.is_dir()):
        seg = d / f"{d.name}.seg.nrrd"
        if not seg.exists():
            continue
        cls = classes.get(d.name) or ("bme" if d.name.startswith("BME-") else "non_bme")
        row = {"id": d.name, "cls": cls, "seg_sha256": sha256(seg), "bone_voxels": 0, "bme_voxels": 0,
               "bone_slices": 0, "bme_slices": 0}
        reason = ""
        if not volume_path(base, d.name).exists():
            reason = "scan missing on this PC"
        else:
            try:
                data, _h, segments = read_segmentation(seg)
                lab, _, _ = build_labelmap(data, segments)
                row["bone_voxels"] = int((lab == 1).sum())
                row["bme_voxels"] = int((lab == 2).sum())
                row["bone_slices"] = slices_with(lab, 1)
                row["bme_slices"] = slices_with(lab, 2)
                row["marked_slices"] = slices_with(lab)
                reason = incomplete_reason(lab, cls)
            except Exception as e:  # noqa: BLE001
                reason = f"annotation unreadable ({type(e).__name__})"
        hard = reason in ("scan missing on this PC",) or reason.startswith("annotation unreadable")
        row["used"] = (not reason) or (keep_all and not hard)
        row["reason"] = reason
        rows.append(row)
        print(f"  {d.name}  {'used' if row['used'] else 'left out: ' + reason}", flush=True)
    used = [r for r in rows if r["used"]]
    return {
        "created": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "git_commit": git_commit(base),
        "rule": "every annotated case (run started before the snapshot existed)" if keep_all else RULE,
        "counts": {
            "annotated": len(rows),
            "used": len(used),
            "left_out": len(rows) - len(used),
            "used_bme": sum(1 for r in used if r["cls"] == "bme"),
            "used_non_bme": sum(1 for r in used if r["cls"] != "bme"),
        },
        "cases": rows,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("base", nargs="?", default=".")
    ap.add_argument("--out", required=True)
    ap.add_argument("--all", action="store_true", help="keep every annotated case")
    a = ap.parse_args()
    base = Path(a.base).resolve()
    out = Path(a.out)
    if not out.is_absolute():
        out = base / out
    print(f"Dataset snapshot -> {out.relative_to(base).as_posix() if out.is_relative_to(base) else out}")
    m = build(base, a.all)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(m, indent=1) + "\n", encoding="utf-8")
    c = m["counts"]
    print(f"SNAPSHOT {c['used']} of {c['annotated']} annotated cases used "
          f"({c['used_bme']} BME, {c['used_non_bme']} non-BME), {c['left_out']} left out. Rule: {m['rule']}.")


if __name__ == "__main__":
    main()
