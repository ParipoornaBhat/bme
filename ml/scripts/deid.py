"""De-identify the case archives into `data/raw/<CASE_ID>/`.

Assigns pseudonymous IDs (BME-001…, NBME-001…), strips PHI from DICOM headers,
remaps UIDs deterministically, and writes the ID mapping to a file that lives
under `data/` and is therefore gitignored.

  python ml/scripts/deid.py "D:/Final yr Prj/bme" --dry-run
  python ml/scripts/deid.py "D:/Final yr Prj/bme"

Nothing is overwritten: an existing output directory for a case is skipped unless
--force is passed. The mapping file is append-safe — rerunning keeps the IDs it
already assigned, so annotations made against a case ID never go stale.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import sys
import zipfile
from collections import Counter
from pathlib import Path

try:
    import pydicom
    from pydicom.errors import InvalidDicomError
    from pydicom.uid import generate_uid
except ImportError:
    sys.exit("pydicom missing.  pip install pydicom")


# Tags removed outright. Follows the spirit of the DICOM PS3.15 Basic Application
# Level Confidentiality Profile, trimmed to what these archives actually carry.
PHI_TAGS = [
    "PatientName", "PatientID", "OtherPatientIDs", "OtherPatientNames",
    "PatientBirthDate", "PatientBirthTime", "PatientAge", "PatientSex",
    "PatientAddress", "PatientTelephoneNumbers", "PatientMotherBirthName",
    "PatientWeight", "PatientSize", "EthnicGroup", "Occupation",
    "MilitaryRank", "BranchOfService", "MedicalRecordLocator",
    "IssuerOfPatientID", "PatientInsurancePlanCodeSequence",
    "ReferringPhysicianName", "ReferringPhysicianAddress",
    "ReferringPhysicianTelephoneNumbers", "PerformingPhysicianName",
    "NameOfPhysiciansReadingStudy", "PhysiciansOfRecord",
    "RequestingPhysician", "OperatorsName", "ResponsiblePerson",
    "InstitutionName", "InstitutionAddress", "InstitutionalDepartmentName",
    "StationName", "DeviceSerialNumber",
    "AccessionNumber", "StudyID", "RequestAttributesSequence",
    "PerformedProcedureStepID", "PerformedProcedureStepDescription",
    "ScheduledProcedureStepID", "ScheduledProcedureStepDescription",
    "RequestedProcedureID", "RequestedProcedureDescription",
    "AdmissionID", "IssuerOfAdmissionID",
    "StudyDate", "SeriesDate", "AcquisitionDate", "ContentDate",
    "StudyTime", "SeriesTime", "AcquisitionTime", "ContentTime",
    "AcquisitionDateTime", "InstanceCreationDate", "InstanceCreationTime",
    "PatientComments", "StudyComments", "ImageComments", "AdditionalPatientHistory",
    "DerivationDescription", "ContentSequence",
]

# Kept deliberately — needed for preprocessing, not identifying:
#   PixelData, Rows, Columns, PixelSpacing, SliceThickness, SpacingBetweenSlices,
#   ImagePositionPatient, ImageOrientationPatient, InstanceNumber, SeriesNumber,
#   RepetitionTime, EchoTime, InversionTime, FlipAngle, MagneticFieldStrength,
#   ScanningSequence, SequenceVariant, ScanOptions, MRAcquisitionType,
#   SeriesDescription, ProtocolName, BodyPartExamined, PatientPosition,
#   Manufacturer, ManufacturerModelName, RescaleSlope, RescaleIntercept

UID_TAGS = ["StudyInstanceUID", "SeriesInstanceUID", "SOPInstanceUID",
            "FrameOfReferenceUID", "MediaStorageSOPInstanceUID"]


def stable_uid(case_id: str, original: str) -> str:
    """Deterministic replacement UID, so series grouping survives the scrub."""
    if not original:
        return generate_uid()
    h = hashlib.sha256(f"{case_id}|{original}".encode()).hexdigest()
    return f"2.25.{int(h[:32], 16)}"


def scrub(ds, case_id: str):
    for tag in PHI_TAGS:
        if tag in ds:
            try:
                delattr(ds, tag)
            except (AttributeError, KeyError):
                pass
    for tag in UID_TAGS:
        if tag in ds and getattr(ds, tag, None):
            setattr(ds, tag, stable_uid(case_id, str(getattr(ds, tag))))
    ds.PatientName = case_id
    ds.PatientID = case_id
    ds.PatientIdentityRemoved = "YES"
    ds.DeidentificationMethod = "bme/ml/scripts/deid.py"
    ds.remove_private_tags()
    if hasattr(ds, "file_meta") and ds.file_meta is not None:
        for tag in ("MediaStorageSOPInstanceUID",):
            if tag in ds.file_meta and "SOPInstanceUID" in ds:
                setattr(ds.file_meta, tag, ds.SOPInstanceUID)
    return ds


def is_dicom(name: str) -> bool:
    if name.endswith("/"):
        return False
    base = name.rsplit("/", 1)[-1]
    return bool(base) and (name.lower().endswith((".dcm", ".ima")) or "." not in base)


def process(zpath: Path, case_id: str, outdir: Path, dry: bool, force: bool):
    rec = {"case_id": case_id, "n_dicom": 0, "n_series": 0, "skipped_other": 0,
           "phi_found": 0, "burned_in": "", "status": "ok", "notes": ""}
    dest = outdir / case_id
    if dest.exists() and not force and any(dest.iterdir()):
        rec["status"] = "exists"
        return rec

    try:
        zf = zipfile.ZipFile(zpath)
    except zipfile.BadZipFile:
        rec["status"] = "bad_zip"
        return rec

    names = zf.namelist()
    dicoms = [n for n in names if is_dicom(n)]
    others = [n for n in names if not n.endswith("/") and n not in dicoms]
    rec["skipped_other"] = len(others)
    if others:
        exts = sorted({("." + n.rsplit(".", 1)[-1].lower()) if "." in n.rsplit("/", 1)[-1] else "?"
                       for n in others})
        rec["notes"] = "skipped:" + ",".join(exts[:5])

    if not dicoms:
        rec["status"] = "no_dicom"
        zf.close()
        return rec

    series_seen, burned = set(), set()
    for n in dicoms:
        try:
            ds = pydicom.dcmread(io.BytesIO(zf.read(n)), force=True)
        except (InvalidDicomError, OSError, ValueError, EOFError):
            continue
        if not hasattr(ds, "PixelData"):
            continue

        rec["phi_found"] += sum(1 for t in PHI_TAGS if t in ds)
        bia = str(getattr(ds, "BurnedInAnnotation", "") or "").upper()
        if bia:
            burned.add(bia)

        orig_series = str(getattr(ds, "SeriesInstanceUID", "") or "0")
        ds = scrub(ds, case_id)
        series_seen.add(orig_series)

        if not dry:
            sdir = dest / hashlib.sha1(orig_series.encode()).hexdigest()[:8]
            sdir.mkdir(parents=True, exist_ok=True)
            # Name by InstanceNumber (so a directory listing is in slice order)
            # PLUS a hash of the SOPInstanceUID. InstanceNumber alone is not
            # unique: some archives here contain every image twice, and a
            # dual-echo series can legitimately repeat it. The UID suffix means
            # byte-identical duplicates collapse onto one filename (correct
            # dedupe) while genuinely distinct images can never overwrite each
            # other. Observed: PRASHEEDA/BME-029 ships 394 files that are 197
            # images duplicated.
            inst = str(getattr(ds, "InstanceNumber", "") or "0")
            idx = int(inst) if inst.isdigit() else 0
            sop = hashlib.sha1(str(getattr(ds, "SOPInstanceUID", n)).encode()).hexdigest()[:8]
            ds.save_as(sdir / f"{idx:05d}_{sop}.dcm", enforce_file_format=False)
        rec["n_dicom"] += 1

    rec["n_series"] = len(series_seen)
    rec["burned_in"] = "|".join(sorted(burned))
    zf.close()
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    base = Path(args.base)
    outdir = base / "data" / "raw"
    mapfile = base / "data" / "deid_map.csv"

    sources = [("BME", base / "BME"), ("NBME", base / "Non BME" / "3d")]

    existing = {}
    if mapfile.exists():
        with open(mapfile, encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                existing[row["source_archive"]] = row["case_id"]

    todo = []
    for prefix, d in sources:
        if not d.is_dir():
            print(f"!! missing {d}", file=sys.stderr)
            continue
        n = 0
        for z in sorted(d.glob("*.zip")):
            key = f"{d.name}/{z.name}"
            if key in existing:
                cid = existing[key]
            else:
                n += 1
                cid = f"{prefix}-{n:03d}"
                while cid in existing.values():
                    n += 1
                    cid = f"{prefix}-{n:03d}"
            todo.append((prefix, key, z, cid))

    if not args.dry_run:
        outdir.mkdir(parents=True, exist_ok=True)

    print(f"{'DRY RUN — nothing written' if args.dry_run else 'de-identifying'}: "
          f"{len(todo)} archives -> {outdir}\n")

    rows, stats = [], Counter()
    for prefix, key, z, cid in todo:
        rec = process(z, cid, outdir, args.dry_run, args.force)
        rec["source_archive"] = key
        rec["class"] = prefix
        rows.append(rec)
        stats[rec["status"]] += 1
        flag = "" if rec["status"] == "ok" else f"  <-- {rec['status']}"
        burn = "  BURNED-IN!" if rec["burned_in"].startswith("YES") else ""
        print(f"  {cid}  {rec['n_dicom']:4d} img  {rec['n_series']:2d} ser  "
              f"phi={rec['phi_found']:4d}{flag}{burn}  {rec['notes']}")

    if not args.dry_run:
        cols = ["case_id", "class", "source_archive", "n_dicom", "n_series",
                "phi_found", "burned_in", "skipped_other", "status", "notes"]
        with open(mapfile, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=cols)
            w.writeheader()
            w.writerows([{c: r.get(c, "") for c in cols} for r in rows])

    print("\n" + "=" * 60)
    print("status:", dict(stats))
    print(f"images: {sum(r['n_dicom'] for r in rows)}")
    burned = [r["case_id"] for r in rows if r["burned_in"].startswith("YES")]
    if burned:
        print(f"\n!! BurnedInAnnotation=YES on {len(burned)} case(s): {', '.join(burned[:10])}")
        print("   Header flag only — inspect the pixels before releasing these.")
    skipped = [r for r in rows if r["skipped_other"]]
    if skipped:
        print(f"\n!! {len(skipped)} archive(s) contained non-DICOM files (reports?), not copied:")
        for r in skipped[:10]:
            print(f"   {r['case_id']}: {r['skipped_other']} file(s)  {r['notes']}")
    if not args.dry_run:
        print(f"\nmapping -> {mapfile}   (under data/, gitignored — keep it off shared drives)")
    print("=" * 60)


if __name__ == "__main__":
    main()
