"""Read DICOM headers straight out of the case zips — no full extraction.

Answers the three questions blocking Phase 0:
  1. Which joint / body part are these?
  2. Is T1 present alongside STIR/T2-FS?
  3. How much PHI is in the headers?

Writes inventory.csv + series.csv. Prints no patient identifiers.
"""
import csv
import io
import sys
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import pydicom
from pydicom.errors import InvalidDicomError

DICOM_EXT = (".dcm", ".ima", ".img")

PHI_TAGS = [
    "PatientName", "PatientID", "PatientBirthDate", "PatientAge", "PatientSex",
    "InstitutionName", "InstitutionAddress", "ReferringPhysicianName",
    "PerformingPhysicianName", "OperatorsName", "StudyDate", "AccessionNumber",
    "StationName", "InstitutionalDepartmentName",
]


def looks_dicom(name: str) -> bool:
    base = name.rsplit("/", 1)[-1]
    if not base or name.endswith("/"):
        return False
    return name.lower().endswith(DICOM_EXT) or "." not in base


def read_header(zf: zipfile.ZipFile, name: str):
    try:
        with zf.open(name) as fh:
            raw = fh.read(160_000)  # header lives near the front
        return pydicom.dcmread(io.BytesIO(raw), stop_before_pixels=True, force=True)
    except (InvalidDicomError, OSError, ValueError, EOFError):
        return None


def g(ds, tag, default=""):
    v = getattr(ds, tag, default)
    if v in (None, ""):
        return default
    return str(v).strip()


def main(roots):
    case_rows, series_rows = [], []
    body_parts, seq_kinds, manufacturers, phi_hits = Counter(), Counter(), Counter(), Counter()

    zips = []
    for label, root in roots:
        p = Path(root)
        if p.is_dir():
            zips += [(label, z) for z in sorted(p.glob("*.zip"))]

    print(f"scanning {len(zips)} archives...\n", file=sys.stderr)

    for label, zpath in zips:
        try:
            zf = zipfile.ZipFile(zpath)
        except zipfile.BadZipFile:
            case_rows.append({"class": label, "archive": zpath.name, "status": "BAD_ZIP"})
            continue

        names = [n for n in zf.namelist() if looks_dicom(n)]
        if not names:
            case_rows.append({
                "class": label, "archive": zpath.name, "status": "NO_DICOM",
                "n_files": len(zf.namelist()),
            })
            zf.close()
            continue

        # group by SeriesInstanceUID, sampling to keep this fast
        series = defaultdict(list)
        sample = names if len(names) <= 400 else names[:: max(1, len(names) // 400)]
        first_ds = None
        for n in sample:
            ds = read_header(zf, n)
            if ds is None:
                continue
            if first_ds is None:
                first_ds = ds
            series[g(ds, "SeriesInstanceUID", "?")].append(ds)

        if first_ds is None:
            case_rows.append({"class": label, "archive": zpath.name, "status": "UNREADABLE"})
            zf.close()
            continue

        present = [t for t in PHI_TAGS if g(first_ds, t)]
        for t in present:
            phi_hits[t] += 1

        bp = g(first_ds, "BodyPartExamined", "?").upper()
        body_parts[bp] += 1
        manufacturers[f'{g(first_ds, "Manufacturer", "?")} {g(first_ds, "ManufacturerModelName", "")}'.strip()] += 1

        for uid, dss in series.items():
            d = dss[0]
            desc = g(d, "SeriesDescription", "?")
            scanning = g(d, "ScanningSequence")
            opts = g(d, "ScanOptions")
            tr, te, ti = g(d, "RepetitionTime"), g(d, "EchoTime"), g(d, "InversionTime")

            blob = f"{desc} {scanning} {opts}".upper()
            if ti and ti not in ("0", "0.0"):
                kind = "STIR/IR"
            elif "STIR" in blob:
                kind = "STIR/IR"
            elif "T1" in blob:
                kind = "T1"
            elif "T2" in blob or "PD" in blob:
                kind = "T2/PD" + ("-FS" if any(k in blob for k in ("FS", "FAT", "SPAIR", "SPIR")) else "")
            else:
                kind = "other"
            seq_kinds[kind] += 1

            series_rows.append({
                "class": label, "archive": zpath.name, "series_desc": desc,
                "kind": kind, "scanning_seq": scanning, "scan_options": opts,
                "TR": tr, "TE": te, "TI": ti,
                "n_sampled": len(dss),
                "rows": g(d, "Rows"), "cols": g(d, "Columns"),
                "slice_thickness": g(d, "SliceThickness"),
                "pixel_spacing": g(d, "PixelSpacing"),
                "body_part": g(d, "BodyPartExamined"),
                "field_strength": g(d, "MagneticFieldStrength"),
            })

        kinds_here = {r["kind"] for r in series_rows if r["archive"] == zpath.name}
        case_rows.append({
            "class": label, "archive": zpath.name, "status": "OK",
            "n_dicom": len(names), "n_series": len(series),
            "body_part": bp, "kinds": "|".join(sorted(kinds_here)),
            "has_stir": "STIR/IR" in kinds_here,
            "has_t1": "T1" in kinds_here,
            "phi_tags": len(present),
        })
        zf.close()

    out = Path(__file__).parent
    for fn, rows in (("inventory.csv", case_rows), ("series.csv", series_rows)):
        if not rows:
            continue
        keys = sorted({k for r in rows for k in r})
        with open(out / fn, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=keys)
            w.writeheader()
            w.writerows(rows)

    ok = [r for r in case_rows if r.get("status") == "OK"]
    print("=" * 62)
    print(f"cases scanned      : {len(case_rows)}   readable: {len(ok)}")
    for st, c in Counter(r.get("status") for r in case_rows).items():
        if st != "OK":
            print(f"  !! {st}: {c}")
    print(f"\nBODY PART        : {dict(body_parts)}")
    print(f"SEQUENCE KINDS   : {dict(seq_kinds)}")
    print(f"\nhas STIR/IR      : {sum(1 for r in ok if r.get('has_stir'))} / {len(ok)}")
    print(f"has T1           : {sum(1 for r in ok if r.get('has_t1'))} / {len(ok)}")
    print(f"has BOTH         : {sum(1 for r in ok if r.get('has_stir') and r.get('has_t1'))} / {len(ok)}")
    print(f"\nSCANNERS         : {dict(manufacturers)}")
    print(f"\nPHI TAGS PRESENT (n cases carrying each):")
    for t, c in phi_hits.most_common():
        print(f"  {t:32s} {c}")
    print("=" * 62)


if __name__ == "__main__":
    base = Path(sys.argv[1])
    main([("BME", base / "BME"), ("NonBME", base / "Non BME" / "3d")])
