"""Import Non-BME scans into NBME-nnn cases.

    python ml/scripts/import_newnonbme.py "D:/Final yr Prj/bme"
    python ml/scripts/import_newnonbme.py "D:/Final yr Prj/bme" --apply --limit 3 --keep

Reads whichever of these exist:

    Non BME/new/<n>/     name.json optional, one or more .nrrd scans
    data/newnonbme/      a zip per patient, or the same kind of folder

Every scan is kept (tra, cor, sag, tra-1, ...). A Segmentation.seg.nrrd is
attached to the scan it was drawn on. A folder with no segmentation is still
imported. name.json `{ "name": "..." }` is stored only in data/deid_map.csv.
Without it, the folder name or the zip filename is stored.

--keep leaves the source in place. --limit N imports only the first N.
Without --apply, nothing is written and nothing is deleted.
"""

from __future__ import annotations

import argparse
import csv
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

import nibabel as nib
import nrrd
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from import_newbme import (  # noqa: E402
    WORKLIST_FIELDS,
    append_rows,
    assign_slugs,
    file_header,
    inspect,
    known_sources,
    load_name_map,
    matching_slug,
    materialise,
    patient_name,
    save_series,
    used_ids,
)
from import_slicer import PLANES, import_case  # noqa: E402
from import_slicer_all import DEID_FIELDS  # noqa: E402
from rename_segments import segments_in  # noqa: E402
from seg2nifti import canonical, seg_affine_ras  # noqa: E402


def next_ids(used: set[str], n: int) -> list[str]:
    highest = 0
    for cid in used:
        if cid.startswith("NBME-") and cid[5:].isdigit():
            highest = max(highest, int(cid[5:]))
    return [f"NBME-{highest + i:03d}" for i in range(1, n + 1)]


def sort_key(path: Path):
    return (0, int(path.name)) if path.name.isdigit() else (1, path.name.lower())


def collect(base: Path) -> list[Path]:
    found = []
    for root in (base / "Non BME" / "new", base / "data" / "newnonbme"):
        if not root.is_dir():
            continue
        for child in root.iterdir():
            if child.name.startswith("."):
                continue
            if child.is_dir() or (child.is_file() and child.suffix.lower() == ".zip"):
                found.append(child)
    return sorted(found, key=sort_key)


def folder_parts(folder: Path):
    nrrds = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() == ".nrrd"]
    segs = [p for p in nrrds if p.name.lower().endswith(".seg.nrrd")]
    scans = [p for p in nrrds if p not in segs]
    return scans, (segs[0] if len(segs) == 1 else None), len(segs)


def write_primary(base: Path, cid: str, scan: Path, fields: list[str]) -> dict:
    data, header = nrrd.read(str(scan))
    affine = seg_affine_ras(header)
    out = base / "data" / "nifti" / cid / f"{cid}_primary.nii.gz"
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        raise ValueError(f"{cid} already has a volume")
    nib.save(nib.Nifti1Image(data, affine), str(out))
    spacing = np.linalg.norm(affine[:3, :3], axis=0)
    row = {k: "" for k in fields}
    row.update({
        "case_id": cid,
        "class": "non_bme",
        "plane": PLANES[int(np.argmax(np.abs(affine[:3, 2])))],
        "n_slices": str(data.shape[2]),
        "slice_thickness": f"{spacing[2]:.4f}",
        "isotropic": str(bool(spacing.max() / max(spacing.min(), 1e-6) < 2)),
        "nifti": f"data/nifti/{cid}/{cid}_primary.nii.gz",
        "status": "ok",
        "assigned_to": "ALL",
        "is_overlap": "False",
    })
    return row


def import_folder(base: Path, cid: str, folder: Path, fields: list[str]):
    scans, seg, n_segs = folder_parts(folder)
    if n_segs > 1:
        raise ValueError("more than one segmentation")
    if not scans:
        raise ValueError("no scan")
    names = list(folder.glob("name.json"))
    pairs = assign_slugs(scans, load_name_map(names))
    who = patient_name(names)
    if seg is not None:
        annotated = matching_slug(pairs, file_header(seg))
        primary = next(scan for slug, scan in pairs if slug == annotated)
        named = segments_in(file_header(seg))
        seg_name = next(iter(named))
        renames = {} if canonical(seg_name) == "bme" else {seg_name: "bme"}
        row = import_case(base, cid, primary, seg, renames, "non_bme", fields)
        note = f"scans={' '.join(s for s, _ in pairs)}; edema on {annotated}"
    else:
        annotated = next((s for s, _ in pairs if s == "tra" or s.startswith("tra-")), pairs[0][0])
        primary = next(scan for slug, scan in pairs if slug == annotated)
        row = write_primary(base, cid, primary, fields)
        note = f"scans={' '.join(s for s, _ in pairs)}; no segmentation"
    save_series(base, cid, pairs, annotated if seg is not None else pairs[0][0])
    return row, who or f"{folder.parent.name}/{folder.name}", note


def remove_source(path: Path):
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()


def append_deid(base: Path, cid: str, source: str, note: str):
    path = base / "data" / "deid_map.csv"
    fields = list(DEID_FIELDS)
    if path.exists():
        with path.open(newline="", encoding="utf-8") as f:
            fields = csv.DictReader(f).fieldnames or fields
    append_rows(path, fields, [{
        **{k: "" for k in fields},
        "case_id": cid,
        "class": "non_bme",
        "source_archive": source,
        "status": "ok",
        "notes": note,
    }])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--keep", "--no-delete", action="store_true", dest="keep",
                    help="leave Non BME/new and data/newnonbme in place")
    ap.add_argument("--limit", type=int, default=0, help="import at most this many")
    args = ap.parse_args()

    base = Path(args.base)
    incoming = collect(base)
    if not incoming:
        sys.exit("nothing to import. Put folders in Non BME/new or data/newnonbme.")

    seen = known_sources(base)
    plan, skipped = [], []
    for entry in incoming:
        if entry.is_file():
            item, why = inspect(entry)
            if why:
                skipped.append(why)
                continue
            if item["zip_name"] in seen:
                skipped.append("zip already imported")
                continue
            item["src"] = entry.parent
            plan.append(("zip", entry, item))
        else:
            scans, _, n_segs = folder_parts(entry)
            if n_segs > 1:
                skipped.append("more than one segmentation")
                continue
            if not scans:
                skipped.append("no scan")
                continue
            who = patient_name(list(entry.glob("name.json")))
            source = who or f"{entry.parent.name}/{entry.name}"
            if source in seen:
                skipped.append("already imported")
                continue
            plan.append(("folder", entry, {"source": source}))

    if args.limit and args.limit > 0:
        plan = plan[:args.limit]
    ids = next_ids(used_ids(base), len(plan))
    print(f"{len(incoming)} items: {len(plan)} to import, {len(skipped)} skipped")
    if args.keep:
        print("sources will be kept")
    if plan:
        print(f"new ids: {ids[0]} .. {ids[-1]}" if len(ids) > 1 else f"new id: {ids[0]}")
    for i, why in enumerate(skipped, 1):
        print(f"  skip {i:2d}  {why}")
    if not args.apply:
        print("\ndry run: nothing written and nothing deleted. Add --apply to import.")
        return

    worklist = base / "data" / "worklist.csv"
    fields = list(WORKLIST_FIELDS)
    if worklist.exists():
        with worklist.open(newline="", encoding="utf-8") as f:
            fields = csv.DictReader(f).fieldnames or fields

    imported = 0
    for cid, (kind, entry, item) in zip(ids, plan):
        try:
            if kind == "zip":
                tmp = Path(tempfile.mkdtemp(prefix="bme-nbme-"))
                try:
                    ready = materialise(item, tmp)
                    if ready["patient"] and ready["patient"] in seen:
                        print(f"  {cid}  skipped: patient already imported")
                        continue
                    row = import_case(
                        base, cid, ready["scan"], ready["seg"], ready["renames"], "non_bme", fields,
                    )
                    save_series(base, cid, ready["pairs"], ready["annotated"])
                    source = ready["patient"] or item["zip_name"]
                    note = f"scans={' '.join(s for s, _ in ready['pairs'])}; edema on {ready['annotated']}"
                finally:
                    shutil.rmtree(tmp, ignore_errors=True)
            else:
                row, source, note = import_folder(base, cid, entry, fields)
        except (ValueError, zipfile.BadZipFile, OSError) as e:
            print(f"  {cid}  skipped: {e}")
            continue
        append_rows(worklist, fields, [row])
        append_deid(base, cid, source, note)
        seen.add(source)
        if not args.keep:
            remove_source(entry)
        imported += 1
        print(f"  {cid}  imported" + ("" if args.keep else ", source removed"))
    print(f"\nimported {imported}. Names stay in data/deid_map.csv only.")


if __name__ == "__main__":
    main()
