"""Extract and package Non-BME (NBME) annotations for team sharing and training.

Four team members annotate 15 cases each:
    1-15:  Paripoorna  (NBME-001 to NBME-015)
    16-30: Elvin        (NBME-016 to NBME-030)
    31-45: Aditi        (NBME-031 to NBME-045)
    46-60: Reegan       (NBME-046 to NBME-060)

Each teammate runs their command on their own machine to export all the cases
they have annotated patient-wise:
    pnpm zipnbme:paripoorna
    pnpm zipnbme:elvin
    pnpm zipnbme:aditi
    pnpm zipnbme:reegan

Or via python:
    python ml/scripts/export_nbme.py --who paripoorna
    python ml/scripts/export_nbme.py --who elvin
    python ml/scripts/export_nbme.py --who aditi
    python ml/scripts/export_nbme.py --who reegan

WHAT IS EXPORTED:
    Each patient's files in their own folder inside the zip:
        NBME-xxx/
            NBME-xxx.seg.nrrd              (main segmentation)
            NBME-xxx__<Annotator>.seg.nrrd (personal copy)
            NBME-xxx_labels.json           (voxel counts & label mapping)
            NBME-xxx_labels.nii.gz         (validated labelmap on primary scan grid)
    manifest.json with scan fingerprints and case metadata.

COMBINING ALL ANNOTATIONS FOR TRAINING:
    On the hub laptop (or after receiving teammate zips in data/exports/ or repo root):
        pnpm zipnbme:combine
    Or:
        python ml/scripts/export_nbme.py --combine

    This imports teammate zips into data/annotations/ and bundles all 60 cases
    patient-wise into data/exports/nbme_annotations_all.zip for 2D/3D training.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import zipfile
from datetime import datetime
from pathlib import Path

# Add ml/scripts directory to path
script_dir = Path(__file__).resolve().parent
if str(script_dir) not in sys.path:
    sys.path.insert(0, str(script_dir))

try:
    import nibabel as nib
    import numpy as np
    from seg2nifti import (
        LABELS,
        build_labelmap,
        read_segmentation,
        to_volume_grid,
        validate,
    )
    from team_annotations import has_bone, scan_fingerprint
except ImportError as err:
    sys.exit(f"Required package or module missing: {err}\nEnsure ml virtualenv is active.")

NBME_TEAM = {
    "paripoorna": (1, 15),
    "elvin": (16, 30),
    "aditi": (31, 45),
    "reegan": (46, 60),
}


def case_range_ids(start: int, end: int) -> list[str]:
    return [f"NBME-{i:03d}" for i in range(start, end + 1)]


def ensure_case_labels(base: Path, cid: str, force: bool = False) -> tuple[bool, str]:
    """Ensure <cid>_labels.json and <cid>_labels.nii.gz exist and are valid."""
    ann_dir = base / "data" / "annotations" / cid
    seg_path = ann_dir / f"{cid}.seg.nrrd"
    if not seg_path.exists():
        return False, f"Missing {seg_path}"

    out_nii = ann_dir / f"{cid}_labels.nii.gz"
    out_json = ann_dir / f"{cid}_labels.json"

    if out_nii.exists() and out_json.exists() and not force:
        return True, "Labels already up-to-date"

    try:
        data, header, segments = read_segmentation(seg_path)
    except Exception as exc:
        return False, f"Unreadable segmentation: {exc}"

    if not segments:
        return False, "No segment metadata found in .seg.nrrd"

    vol_path = base / "data" / "nifti" / cid / f"{cid}_primary.nii.gz"
    if not vol_path.exists():
        return False, f"No primary scan volume at {vol_path}"

    try:
        vol_img = nib.load(str(vol_path))
    except Exception as exc:
        return False, f"Failed loading volume: {exc}"

    lab, found, problems = build_labelmap(data, segments)
    if not problems:
        try:
            lab, _ = to_volume_grid(lab, header, vol_img)
            found = {k: int((lab == v).sum()) for k, v in LABELS.items() if (lab == v).any()}
        except ValueError as exc:
            problems.append(str(exc))

    try:
        problems += validate(lab, found)
    except Exception:
        pass

    if problems:
        return False, "; ".join(problems)

    out_nii.parent.mkdir(parents=True, exist_ok=True)
    nib.save(nib.Nifti1Image(lab, vol_img.affine), str(out_nii))
    out_json.write_text(
        json.dumps({"case_id": cid, "labels": LABELS, "voxel_counts": found}, indent=2),
        encoding="utf-8",
    )
    return True, f"Generated labels: {found}"


def export_annotator(base: Path, who: str, force: bool = False) -> Path:
    who_clean = who.strip().lower()
    if who_clean not in NBME_TEAM:
        valid_names = ", ".join(sorted(NBME_TEAM.keys()))
        sys.exit(f"Unknown annotator '{who}'. Must be one of: {valid_names}")

    start, end = NBME_TEAM[who_clean]
    assigned_cases = case_range_ids(start, end)
    ann_dir = base / "data" / "annotations"
    out_dir = base / "data" / "exports"
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    out_zip = out_dir / f"nbme_annotations_{who_clean}_{stamp}.zip"
    latest_zip = out_dir / f"nbme_annotations_{who_clean}.zip"

    manifest = {
        "dataset": "non_bme",
        "who": who_clean,
        "range": f"{start}-{end}",
        "created": stamp,
        "cases": {},
    }

    files_to_pack: list[tuple[Path, str]] = []  # (source_path, arcname)

    print("=" * 65)
    print(f"EXPORTING NBME ANNOTATIONS FOR: {who_clean.upper()}")
    print(f"Assigned Range: NBME-{start:03d} to NBME-{end:03d} ({len(assigned_cases)} cases)")
    print("=" * 65)

    valid_cases = 0
    for cid in assigned_cases:
        case_folder = ann_dir / cid
        main_seg = case_folder / f"{cid}.seg.nrrd"

        if not main_seg.exists():
            print(f"  {cid:9s} -- Not annotated yet (no {cid}.seg.nrrd)")
            continue

        if not has_bone(main_seg):
            print(f"  {cid:9s} !! No bone_marrow painted yet; skipping")
            continue

        ok, msg = ensure_case_labels(base, cid, force=force)
        if not ok:
            print(f"  {cid:9s} !! Validation failed: {msg}")
            continue

        fp = scan_fingerprint(base, cid)
        if fp is None:
            print(f"  {cid:9s} !! No primary scan NIfTI found; skipping")
            continue

        # Collect all files for this patient
        patient_files = sorted(case_folder.glob(f"{cid}*"))
        rel_names = []
        for p in patient_files:
            if p.is_file() and not p.name.startswith("."):
                arcname = f"{cid}/{p.name}"
                files_to_pack.append((p, arcname))
                rel_names.append(p.name)

        manifest["cases"][cid] = {
            "scan": fp,
            "files": rel_names,
        }
        valid_cases += 1
        print(f"  {cid:9s} OK -> {len(rel_names)} file(s): {', '.join(rel_names)}")

    if not files_to_pack:
        sys.exit("\nNo validated NBME cases ready to export.")

    out_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, indent=2))
        for src, arc in files_to_pack:
            z.write(src, arc)

    # Also make a copy with the standard filename
    shutil.copy2(out_zip, latest_zip)

    print("\n" + "=" * 65)
    print(f"SUCCESS: Exported {valid_cases}/{len(assigned_cases)} patient case(s) ({len(files_to_pack)} files)")
    print(f"Primary zip: {out_zip}")
    print(f"Shared copy: {latest_zip}")
    print("Send this zip to the hub laptop for combination and training.")
    print("=" * 65)
    return out_zip


def find_nbme_zips(base: Path) -> list[Path]:
    """Find all incoming NBME annotation zips (newest per person)."""
    search_dirs = [base, base / "data" / "exports"]
    seen: dict[str, Path] = {}
    newest: dict[str, tuple[str, Path]] = {}

    for d in search_dirs:
        if not d.is_dir():
            continue
        for zp in sorted(d.glob("nbme_annotations_*.zip")):
            if "all" in zp.name.lower():
                continue
            h = hashlib.sha256(zp.read_bytes()).hexdigest()
            if h in seen:
                continue
            seen[h] = zp
            try:
                with zipfile.ZipFile(zp) as z:
                    man = json.loads(z.read("manifest.json"))
                    who = man.get("who", "")
                    created = str(man.get("created", ""))
                    if who and (who not in newest or created >= newest[who][0]):
                        newest[who] = (created, zp)
            except Exception:
                continue
    return [zp for _, zp in sorted(newest.values(), key=lambda t: t[1].name)]


def import_teammate_zips(base: Path, zips: list[Path]) -> int:
    """Import files from teammate zips into data/annotations/."""
    ann_dir = base / "data" / "annotations"
    imported_files = 0

    for zp in zips:
        print(f"Importing {zp.name}...")
        with zipfile.ZipFile(zp) as z:
            for item in z.infolist():
                if item.filename == "manifest.json" or item.filename.endswith("/"):
                    continue
                parts = item.filename.split("/")
                if len(parts) == 2 and parts[0].startswith("NBME-"):
                    cid, fname = parts[0], parts[1]
                    dest = ann_dir / cid / fname
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    data = z.read(item.filename)
                    if not dest.exists() or dest.read_bytes() != data:
                        dest.write_bytes(data)
                        imported_files += 1
    return imported_files


def combine_all_nbme(base: Path, force: bool = False) -> Path:
    ann_dir = base / "data" / "annotations"
    out_dir = base / "data" / "exports"
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    out_zip = out_dir / f"nbme_annotations_all_{stamp}.zip"
    latest_zip = out_dir / "nbme_annotations_all.zip"

    # Step 1: Ingest teammate zips if present
    incoming = find_nbme_zips(base)
    if incoming:
        print(f"Found {len(incoming)} teammate zip(s) in exports/root.")
        count = import_teammate_zips(base, incoming)
        print(f"Merged {count} updated file(s) into data/annotations/\n")

    print("=" * 65)
    print("COMBINING ALL NBME ANNOTATIONS FOR TRAINING (1-60)")
    print("=" * 65)

    all_cases = [f"NBME-{i:03d}" for i in range(1, 61)]
    manifest = {
        "dataset": "non_bme",
        "description": "Complete NBME dataset combined for training",
        "created": stamp,
        "cases": {},
    }

    files_to_pack: list[tuple[Path, str]] = []
    cases_by_person: dict[str, list[str]] = {p: [] for p in NBME_TEAM}

    for cid in all_cases:
        num = int(cid.split("-")[1])
        owner = next(k for k, (s, e) in NBME_TEAM.items() if s <= num <= e)
        case_folder = ann_dir / cid
        main_seg = case_folder / f"{cid}.seg.nrrd"

        if not main_seg.exists() or not has_bone(main_seg):
            continue

        ok, _ = ensure_case_labels(base, cid, force=force)
        if not ok:
            continue

        fp = scan_fingerprint(base, cid)
        patient_files = sorted(case_folder.glob(f"{cid}*"))
        rel_names = []
        for p in patient_files:
            if p.is_file() and not p.name.startswith("."):
                arcname = f"{cid}/{p.name}"
                files_to_pack.append((p, arcname))
                rel_names.append(p.name)

        manifest["cases"][cid] = {
            "owner": owner,
            "scan": fp,
            "files": rel_names,
        }
        cases_by_person[owner].append(cid)

    out_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, indent=2))
        for src, arc in files_to_pack:
            z.write(src, arc)

    shutil.copy2(out_zip, latest_zip)

    total_ready = sum(len(v) for v in cases_by_person.values())
    print("\nNBME TEAM STATUS BREAKDOWN:")
    for person, (s, e) in NBME_TEAM.items():
        found_cnt = len(cases_by_person[person])
        target_cnt = e - s + 1
        status = "COMPLETE" if found_cnt == target_cnt else f"{found_cnt}/{target_cnt}"
        print(f"  {person:12s} (NBME-{s:03d}..{e:03d}): {status}")

    print("\n" + "=" * 65)
    print(f"TOTAL DATASET: {total_ready}/60 patients ready for training ({len(files_to_pack)} files)")
    print(f"Archive: {out_zip}")
    print(f"Shared copy: {latest_zip}")
    print("=" * 65)
    return out_zip


def main():
    parser = argparse.ArgumentParser(
        description="Extract and package patient-wise NBME annotations.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("base", nargs="?", default=".", help="Project root directory (default: current directory)")
    parser.add_argument("--who", choices=list(NBME_TEAM.keys()), help="Teammate name to export assigned cases for")
    parser.add_argument("--combine", action="store_true", help="Combine all teammate exports into one master zip")
    parser.add_argument("--force", action="store_true", help="Force regenerate labelmaps and json summaries")

    args = parser.parse_args()
    base = Path(args.base).resolve()

    if args.combine:
        combine_all_nbme(base, force=args.force)
    elif args.who:
        export_annotator(base, args.who, force=args.force)
    else:
        # Prompt or print help
        parser.print_help()
        print("\nExamples:")
        print("  python ml/scripts/export_nbme.py --who paripoorna")
        print("  python ml/scripts/export_nbme.py --who elvin")
        print("  python ml/scripts/export_nbme.py --who aditi")
        print("  python ml/scripts/export_nbme.py --who reegan")
        print("  python ml/scripts/export_nbme.py --combine")


if __name__ == "__main__":
    main()
