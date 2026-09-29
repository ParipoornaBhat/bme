"""Add Slicer cases from data/newbme without touching the cases already imported.

    python ml/scripts/import_newbme.py "D:/Final yr Prj/bme"
    python ml/scripts/import_newbme.py "D:/Final yr Prj/bme" --apply

Each patient is one subfolder that contains one .zip. The zip holds the scans
(.nrrd) and one Segmentation.seg.nrrd. The zip is extracted in a temp folder
and imported as the next free BME-nnn.

The scan the edema was drawn on becomes <CASE>_primary.nii.gz, so the paint
lines up. Every other scan is saved too, including a `_1` copy, as
<CASE>_tra.nii.gz, <CASE>_cor.nii.gz, <CASE>_cor-1.nii.gz. Those labels come
from the filenames. The site can open each one.

name.json, beside the zip or inside it, holds the patient name. It is written
only to data/deid_map.csv. A missing name.json is fine: the zip filename is
kept instead. Accepted shapes:

    { "name": "the patient name" }
    { "patient": "the patient name" }

The one segment is named bme. Bone is painted later in the web app. The zip
filename is the patient link, appended to data/deid_map.csv, which is
gitignored. The source folder is deleted only after that write succeeds.
Folders with no zip are left untouched. Without --apply, nothing is written
and nothing is deleted.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

import nibabel as nib
import nrrd
from io import TextIOWrapper

sys.path.insert(0, str(Path(__file__).resolve().parent))
from import_slicer import import_case  # noqa: E402
from import_slicer_all import DEID_FIELDS, grid_matches  # noqa: E402
from rename_segments import segments_in  # noqa: E402
from seg2nifti import canonical, seg_affine_ras  # noqa: E402

WORKLIST_FIELDS = [
    "case_id", "class", "n_series", "primary_dir", "primary_kind", "plane",
    "n_slices", "slice_thickness", "fat_suppressed", "has_t1", "isotropic",
    "annotated", "annotator", "nifti", "status", "assigned_to", "is_overlap",
]


def file_header(path: Path):
    with path.open("rb") as f:
        return nrrd.read_header(TextIOWrapper(f, encoding="latin-1"))


def used_ids(base: Path) -> set[str]:
    found = set()
    worklist = base / "data" / "worklist.csv"
    if worklist.exists():
        with worklist.open(newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                if row.get("case_id"):
                    found.add(row["case_id"])
    for folder in ("nifti", "annotations"):
        root = base / "data" / folder
        if root.is_dir():
            found.update(p.name for p in root.iterdir() if p.is_dir())
    return found


def next_ids(used: set[str], n: int) -> list[str]:
    """Ids after the highest BME number already used. Gaps are left alone."""
    highest = 0
    for cid in used:
        if cid.startswith("BME-") and cid[4:].isdigit():
            highest = max(highest, int(cid[4:]))
    return [f"BME-{highest + i:03d}" for i in range(1, n + 1)]


def known_sources(base: Path) -> set[str]:
    path = base / "data" / "deid_map.csv"
    if not path.exists():
        return set()
    with path.open(newline="", encoding="utf-8") as f:
        return {row.get("source_archive", "") for row in csv.DictReader(f)}


def series_kind(name: str) -> str:
    n = name.lower()
    if "cor" in n:
        return "cor"
    if "sag" in n:
        return "sag"
    if "tra" in n or "ax" in n:
        return "tra"
    return "other"


def series_slug(name: str) -> str:
    """tra, cor, sag, or cor-1 when the filename ends in _1."""
    stem = Path(name).stem.lower()
    kind = series_kind(stem)
    copy = re.search(r"_(\d+)$", stem)
    if copy:
        return f"{kind}-{copy.group(1)}"
    return kind


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.strip().lower()).strip("-")
    return (slug or "scan")[:32]


def patient_name(paths: list[Path]) -> str:
    """Name from name.json. Empty when the file is missing or has no name."""
    for path in paths:
        if not path.is_file():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
        if isinstance(raw, dict):
            for key in ("name", "patient", "patient_name"):
                value = raw.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
    return ""


def load_name_map(paths: list[Path]) -> dict[str, str]:
    """filename -> slug. Missing or unreadable files yield an empty map."""
    found: dict[str, str] = {}
    for path in paths:
        if not path.is_file():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        rows: list[tuple[str, str]] = []
        if isinstance(raw, list):
            for item in raw:
                if not isinstance(item, dict):
                    continue
                file = item.get("file") or item.get("nrrd") or item.get("scan")
                label = item.get("name") or item.get("id") or item.get("label")
                if isinstance(file, str) and isinstance(label, str):
                    rows.append((file, label))
        elif isinstance(raw, dict):
            scans = raw.get("scans") if isinstance(raw.get("scans"), dict) else raw
            if isinstance(scans, dict):
                for key, val in scans.items():
                    if key in ("name", "patient", "annotated") or not isinstance(val, str):
                        continue
                    if val.lower().endswith(".nrrd"):
                        rows.append((val, str(key)))
                    elif str(key).lower().endswith(".nrrd"):
                        rows.append((str(key), val))
        for file, label in rows:
            found[Path(file).name.lower()] = slugify(label)
    return found


def assign_slugs(scans: list[Path], name_map: dict[str, str] | None = None) -> list[tuple[str, Path]]:
    used: dict[str, Path] = {}
    out = []
    for scan in scans:
        base = (name_map or {}).get(scan.name.lower()) or series_slug(scan.name)
        slug = base
        n = 2
        while slug in used:
            slug = f"{base}-{n}"
            n += 1
        used[slug] = scan
        out.append((slug, scan))
    return out


def matching_slug(pairs: list[tuple[str, Path]], seg_h) -> str:
    """The scan the segmentation was drawn on. A `_1` copy loses to the original."""
    hits = []
    for slug, scan in pairs:
        try:
            if grid_matches(file_header(scan), seg_h):
                hits.append(slug)
        except Exception:
            continue
    if not hits:
        raise ValueError("segmentation does not sit on any scan in the zip")
    hits.sort(key=lambda s: (bool(re.search(r"-\d+$", s)), s))
    return hits[0]


def inspect(path: Path):
    if path.is_file() and path.suffix.lower() == ".zip":
        zips = [path]
    else:
        zips = [p for p in path.iterdir() if p.is_file() and p.suffix.lower() == ".zip"]
        if len(zips) != 1:
            return None, "no zip" if not zips else f"{len(zips)} zip files"
    try:
        with zipfile.ZipFile(zips[0]) as zf:
            names = [n for n in zf.namelist() if n.lower().endswith(".nrrd") and not n.endswith("/")]
    except zipfile.BadZipFile:
        return None, "zip could not be opened"
    segs = [n for n in names if n.lower().endswith(".seg.nrrd")]
    scans = [n for n in names if n not in segs]
    if len(segs) != 1:
        return None, "no segmentation" if not segs else f"{len(segs)} segmentation files"
    if not scans:
        return None, "segmentation but no scan"
    return {"zip": zips[0], "zip_name": zips[0].name}, None


def materialise(item: dict, dest: Path) -> dict:
    """Extract the zip and return the primary scan, extras, and segmentation."""
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(item["zip"]) as zf:
        zf.extractall(dest)
    nrrds = [p for p in dest.rglob("*") if p.is_file() and p.suffix.lower() == ".nrrd"]
    segs = [p for p in nrrds if p.name.lower().endswith(".seg.nrrd")]
    scans = [p for p in nrrds if p not in segs]
    seg = segs[0]
    seg_h = file_header(seg)
    named = segments_in(seg_h)
    if len(named) != 1:
        raise ValueError(f"{len(named)} segments")
    name_files = list(dest.rglob("name.json"))
    if item["zip"].parent != item.get("src"):
        name_files += list(item["zip"].parent.glob("name.json"))
    pairs = assign_slugs(scans, load_name_map(name_files))
    who = patient_name(name_files)
    annotated = matching_slug(pairs, seg_h)
    primary = next(scan for slug, scan in pairs if slug == annotated)
    name = next(iter(named))
    return {
        "scan": primary,
        "pairs": pairs,
        "annotated": annotated,
        "seg": seg,
        "renames": {} if canonical(name) == "bme" else {name: "bme"},
        "zip_name": item["zip_name"],
        "patient": who,
    }


def save_series(base: Path, cid: str, pairs: list[tuple[str, Path]], annotated: str):
    folder = base / "data" / "nifti" / cid
    folder.mkdir(parents=True, exist_ok=True)
    listing = []
    for slug, scan in pairs:
        data, header = nrrd.read(str(scan))
        out = folder / f"{cid}_{slug}.nii.gz"
        nib.save(nib.Nifti1Image(data, seg_affine_ras(header)), str(out))
        listing.append({"id": slug, "label": f"{cid} {slug}"})
    (folder / "series.json").write_text(
        json.dumps({"annotated": annotated, "series": listing}, indent=2),
        encoding="utf-8",
    )


def append_rows(path: Path, fields: list[str], rows: list[dict]):
    new = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        if new:
            writer.writeheader()
        writer.writerows(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--src", default="data/newbme", help="folder of one subfolder per patient")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    base = Path(args.base)
    src = Path(args.src) if Path(args.src).is_absolute() else base / args.src
    if not src.is_dir():
        sys.exit(f"missing {src}\nPut one folder per patient inside it, then run this again.")

    incoming = sorted(
        p for p in src.iterdir()
        if p.is_dir() or (p.is_file() and p.suffix.lower() == ".zip")
    )
    if not incoming:
        sys.exit(f"no zips or patient folders in {src}")

    seen = known_sources(base)
    plan, skipped = [], []
    for entry in incoming:
        item, why = inspect(entry)
        if why:
            skipped.append((entry.name, why))
            continue
        if item["zip_name"] in seen:
            skipped.append((entry.name, "zip already imported"))
            continue
        item["src"] = src
        plan.append((entry, item))

    ids = next_ids(used_ids(base), len(plan))
    print(f"{len(incoming)} items: {len(plan)} to import, {len(skipped)} skipped")
    if plan:
        print(f"new ids: {ids[0]} .. {ids[-1]}" if len(ids) > 1 else f"new id: {ids[0]}")
    for i, (_, why) in enumerate(skipped, 1):
        print(f"  skip {i:2d}  {why}")

    if not args.apply:
        print("\ndry run: nothing written and nothing deleted. Add --apply to import.")
        return

    worklist = base / "data" / "worklist.csv"
    fields = WORKLIST_FIELDS
    if worklist.exists():
        with worklist.open(newline="", encoding="utf-8") as f:
            fields = csv.DictReader(f).fieldnames or fields

    report = base / "data" / "newbme_import_report.csv"
    imported = 0
    for cid, (folder, item) in zip(ids, plan):
        tmp = Path(tempfile.mkdtemp(prefix="bme-newbme-"))
        try:
            ready = materialise(item, tmp)
            if ready["patient"] and ready["patient"] in seen:
                print(f"  {cid}  skipped: patient already imported")
                continue
            row = import_case(
                base, cid, ready["scan"], ready["seg"], ready["renames"], "bme", fields,
            )
            save_series(base, cid, ready["pairs"], ready["annotated"])
        except (ValueError, zipfile.BadZipFile, OSError) as e:
            skipped.append((folder.name, str(e)))
            print(f"  {cid}  skipped: {e}")
            continue
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        names = " ".join(slug for slug, _ in ready["pairs"])
        source = ready["patient"] or item["zip_name"]
        append_rows(worklist, fields, [row])
        append_rows(base / "data" / "deid_map.csv", DEID_FIELDS, [{
            **{k: "" for k in DEID_FIELDS},
            "case_id": cid,
            "class": "BME",
            "source_archive": source,
            "status": "ok",
            "notes": f"edema on {ready['annotated']}; scans={names}",
        }])
        if folder.is_dir():
            shutil.rmtree(folder)
        else:
            folder.unlink()
        imported += 1
        print(f"  {cid}  imported ({names}; edema on {ready['annotated']}), source folder removed")

    with report.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["folder", "reason"])
        writer.writerows(skipped)
    print(f"\nimported {imported}. Names stay in data/deid_map.csv only.")
    if skipped:
        print(f"skipped folders: {report}")


if __name__ == "__main__":
    main()
