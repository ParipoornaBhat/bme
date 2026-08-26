"""Convert de-identified DICOM into NIfTI and build the annotation worklist.

For every case in `data/raw/`, classify each series, pick the one to annotate,
convert it to NIfTI, and write a worklist so nobody has to guess which of a
case's 16 hash-named directories is the right one.

    python ml/scripts/convert.py "D:/Final yr Prj/bme"
    python ml/scripts/convert.py "D:/Final yr Prj/bme" --dry-run

Outputs
    data/nifti/<CASE>/<CASE>_primary.nii.gz   the series to annotate
    data/nifti/<CASE>/<CASE>_t1.nii.gz        if a T1 exists (18 of 107 cases)
    data/nifti/<CASE>/<CASE>_meta.json
    data/worklist.csv                         the annotation queue

Nothing is overwritten unless --force. Runs on Python 3.14 — only PyTorch needs 3.11/3.12.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

try:
    import SimpleITK as sitk
except ImportError:
    sys.exit("SimpleITK missing.  pip install SimpleITK")

try:
    import pydicom
except ImportError:
    sys.exit("pydicom missing.  pip install pydicom")


FS_MARKERS = ("FS", "SPA", "SPAIR", "SPIR", "SAT", "STIR", "TIRM", "FATSAT")


def f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def read_one(series_dir: Path):
    """Header of the first readable image in a series directory."""
    for p in sorted(series_dir.glob("*.dcm")):
        try:
            return pydicom.dcmread(p, stop_before_pixels=True, force=True)
        except Exception:
            continue
    return None


def is_fat_suppressed(ds) -> bool:
    blob = " ".join(
        str(getattr(ds, t, "") or "")
        for t in ("ScanOptions", "SeriesDescription", "ProtocolName", "ImageType", "SequenceName")
    ).upper()
    return any(m in blob for m in FS_MARKERS)


def classify(ds) -> str:
    """Physics-first sequence kind. Descriptions are missing on ~2/3 of series."""
    tr, te, ti = (f(getattr(ds, t, None)) for t in ("RepetitionTime", "EchoTime", "InversionTime"))
    desc = str(getattr(ds, "SeriesDescription", "") or "").upper()
    fs = is_fat_suppressed(ds)

    if (ti and ti > 50) or "STIR" in desc or "TIRM" in desc:
        return "edema"
    if tr is None or te is None:
        return "unknown"
    if tr < 900 and te < 30:
        return "t1"
    if tr >= 1300 and te < 60:
        return "edema" if fs else "pd"
    if tr >= 1300 and te >= 60:
        return "edema" if fs else "t2"
    return "edema" if fs else "other"


def plane_of(ds) -> str:
    """Acquisition plane from the direction cosines."""
    iop = getattr(ds, "ImageOrientationPatient", None)
    if not iop or len(iop) != 6:
        return "unknown"
    r, c = [float(v) for v in iop[:3]], [float(v) for v in iop[3:]]
    n = [r[1] * c[2] - r[2] * c[1], r[2] * c[0] - r[0] * c[2], r[0] * c[1] - r[1] * c[0]]
    ax = max(range(3), key=lambda i: abs(n[i]))
    return {0: "sagittal", 1: "coronal", 2: "axial"}[ax]


def describe(series_dir: Path):
    ds = read_one(series_dir)
    if ds is None:
        return None
    n = len(list(series_dir.glob("*.dcm")))
    ps = getattr(ds, "PixelSpacing", None)
    return {
        "dir": series_dir.name,
        "kind": classify(ds),
        "fat_suppressed": is_fat_suppressed(ds),
        "plane": plane_of(ds),
        "n_instances": n,
        "rows": int(getattr(ds, "Rows", 0) or 0),
        "cols": int(getattr(ds, "Columns", 0) or 0),
        "slice_thickness": f(getattr(ds, "SliceThickness", None)),
        "pixel_spacing": [float(ps[0]), float(ps[1])] if ps else None,
        "TR": f(getattr(ds, "RepetitionTime", None)),
        "TE": f(getattr(ds, "EchoTime", None)),
        "TI": f(getattr(ds, "InversionTime", None)),
        "description": str(getattr(ds, "SeriesDescription", "") or ""),
        "series_uid": str(getattr(ds, "SeriesInstanceUID", "") or ""),
        "manufacturer": str(getattr(ds, "Manufacturer", "") or "").strip(),
        "model": str(getattr(ds, "ManufacturerModelName", "") or "").strip(),
        "field_strength": f(getattr(ds, "MagneticFieldStrength", None)),
        "body_part": str(getattr(ds, "BodyPartExamined", "") or "").strip(),
    }


def pick_primary(cands: list[dict]) -> dict | None:
    """
    The series to annotate.

    Prefer edema-sensitive; among those prefer more slices (better through-plane
    coverage) and then thinner slices. A 3D isotropic SPAIR volume wins over a
    20-slice 2D stack, which is what we want — those reconstruct cleanly in all
    three planes and give a usable 3D surface.
    """
    edema = [c for c in cands if c["kind"] == "edema"]
    pool = edema or [c for c in cands if c["fat_suppressed"]] or cands
    if not pool:
        return None
    return sorted(
        pool,
        key=lambda c: (-c["n_instances"], c["slice_thickness"] or 99),
    )[0]


def convert(series_dir: Path, out: Path) -> tuple[bool, str]:
    reader = sitk.ImageSeriesReader()
    files = reader.GetGDCMSeriesFileNames(str(series_dir))
    if not files:
        files = [str(p) for p in sorted(series_dir.glob("*.dcm"))]
    if not files:
        return False, "no files"
    try:
        reader.SetFileNames(files)
        img = reader.Execute()
        out.parent.mkdir(parents=True, exist_ok=True)
        sitk.WriteImage(img, str(out), useCompression=True)
        z = img.GetSize()[2]
        return True, f"{img.GetSize()} spacing={tuple(round(s, 3) for s in img.GetSpacing())} z={z}"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    base = Path(args.base)
    raw = base / "data" / "raw"
    nifti = base / "data" / "nifti"
    if not raw.is_dir():
        sys.exit(f"missing {raw} — run ml/scripts/deid.py first")

    cases = sorted([d for d in raw.iterdir() if d.is_dir()])
    print(f"{'DRY RUN — ' if args.dry_run else ''}{len(cases)} cases\n")

    work, failures = [], []
    for case in cases:
        cid = case.name
        cands = [d for d in (describe(s) for s in sorted(case.iterdir()) if s.is_dir()) if d]
        if not cands:
            failures.append((cid, "no readable series"))
            print(f"  {cid}  !! no readable series")
            continue

        primary = pick_primary(cands)
        t1 = next((c for c in sorted(cands, key=lambda c: -c["n_instances"]) if c["kind"] == "t1"), None)

        row = {
            "case_id": cid,
            "class": "bme" if cid.startswith("BME") else "non_bme",
            "n_series": len(cands),
            "primary_dir": primary["dir"] if primary else "",
            "primary_kind": primary["kind"] if primary else "",
            "plane": primary["plane"] if primary else "",
            "n_slices": primary["n_instances"] if primary else 0,
            "slice_thickness": primary["slice_thickness"] if primary else "",
            "fat_suppressed": primary["fat_suppressed"] if primary else False,
            "has_t1": bool(t1),
            "isotropic": bool(primary and (primary["slice_thickness"] or 9) <= 1.5),
            "annotated": "",  # fill in as you go
            "annotator": "",
            "nifti": "",
            "status": "",
        }

        if primary and not args.dry_run:
            out = nifti / cid / f"{cid}_primary.nii.gz"
            if out.exists() and not args.force:
                row["status"] = "exists"
                row["nifti"] = str(out.relative_to(base)).replace("\\", "/")
            else:
                ok, msg = convert(case / primary["dir"], out)
                row["status"] = "ok" if ok else "FAILED"
                row["nifti"] = str(out.relative_to(base)).replace("\\", "/") if ok else ""
                if not ok:
                    failures.append((cid, msg))
            if t1:
                convert(case / t1["dir"], nifti / cid / f"{cid}_t1.nii.gz")

            (nifti / cid).mkdir(parents=True, exist_ok=True)
            (nifti / cid / f"{cid}_meta.json").write_text(
                json.dumps({"case_id": cid, "primary": primary, "t1": t1, "all_series": cands}, indent=2),
                encoding="utf-8",
            )
        elif primary:
            row["status"] = "dry"

        work.append(row)
        iso = " ISO" if row["isotropic"] else ""
        t1f = " +T1" if row["has_t1"] else ""
        print(
            f"  {cid}  {row['n_series']:2d} ser -> {row['primary_kind']:7s} "
            f"{row['plane']:9s} {row['n_slices']:4d} sl @ {row['slice_thickness']}mm"
            f"{iso}{t1f}  {row['status']}"
        )

    if not args.dry_run and work:
        wl = base / "data" / "worklist.csv"
        with open(wl, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(work[0].keys()))
            w.writeheader()
            w.writerows(work)

    ok = [r for r in work if r["status"] in ("ok", "exists")]
    iso = [r for r in work if r["isotropic"]]
    print("\n" + "=" * 64)
    print(f"cases            : {len(work)}")
    if not args.dry_run:
        print(f"converted        : {len(ok)}")
    print(f"edema-sensitive  : {sum(1 for r in work if r['primary_kind'] == 'edema')}")
    print(f"with T1          : {sum(1 for r in work if r['has_t1'])}")
    print(f"isotropic (<=1.5): {len(iso)}  <- annotate these first, best 3D")
    if iso:
        print("  " + ", ".join(r["case_id"] for r in iso[:12]))
    if failures:
        print(f"\n!! {len(failures)} problem(s):")
        for cid, msg in failures[:10]:
            print(f"   {cid}: {msg}")
    if not args.dry_run:
        print(f"\nworklist -> data/worklist.csv")
    print("=" * 64)


if __name__ == "__main__":
    main()
