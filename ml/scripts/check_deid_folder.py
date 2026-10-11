"""Standalone de-identification and integrity verifier for exported datasets.

Verifies:
1. File and directory naming conformance (case_NNN, patient_NNN, <id>_primary.nii.gz,
   <id>_labels.nii.gz, worklist.csv, dataset-metadata.json).
2. NIfTI-1 format and header sanitization (empty data_type, db_name, descrip,
   aux_file, intent_name, and zero header extensions).
3. worklist.csv schema and pseudonymized values (case_NNN, patient_NNN, class=bme).
4. Heuristic identifier scanning (regex patterns across text-like files, headers, names).
5. Inter-case shape/voxel-size consistency (summary metrics).

SAFETY GUARANTEE:
Reports counts and min/max metrics ONLY. Never prints filenames, patient IDs,
case IDs, or file paths in output or logs.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple


DEFAULT_FORBIDDEN_PATTERNS = [
    r"BME-\d+",
    r"BME_\d+",
]

ALLOWED_CONTAINER_DIRS = {"data", "nifti", "annotations"}
ALLOWED_SPECIAL_FILES = {"worklist.csv", "dataset-metadata.json"}

RE_CASE_DIR = re.compile(r"^case_\d+$")
RE_PATIENT_DIR = re.compile(r"^patient_\d+$")
RE_PRIMARY_NII = re.compile(r"^(case_\d+)_primary\.nii\.gz$")
RE_LABELS_NII = re.compile(r"^(case_\d+)_labels\.nii\.gz$")
RE_CASE_ID = re.compile(r"^case_\d+$")
RE_PATIENT_ID = re.compile(r"^patient_\d+$")
RE_CLASS = re.compile(r"^bme$")

NIFTI_TEXT_FIELDS = ["data_type", "db_name", "descrip", "aux_file", "intent_name"]


def validate_folder_outside_repo_and_data(folder_path: Path, src_dir: Path) -> Path:
    """Ensure folder exists, is a directory, and is strictly outside repo and data/."""
    resolved_folder = folder_path.resolve()
    resolved_src = src_dir.resolve()
    resolved_data = (src_dir / "data").resolve()

    if not resolved_folder.exists() or not resolved_folder.is_dir():
        raise ValueError("[ERROR] Target folder does not exist or is not a directory.")

    if resolved_folder == resolved_data or resolved_data in resolved_folder.parents:
        raise ValueError("[ERROR] Target folder must be strictly outside data/ directory.")

    if resolved_folder == resolved_src or resolved_src in resolved_folder.parents:
        raise ValueError("[ERROR] Target folder must be strictly outside the repository.")

    return resolved_folder


def check_allowed_names(folder_path: Path) -> Dict[str, int]:
    """Check that all files and folders match allowed de-identified naming patterns."""
    bad_filenames = 0
    bad_dirnames = 0
    total_files = 0
    total_dirs = 0

    for root, dirs, files in os.walk(folder_path):
        for d in dirs:
            total_dirs += 1
            d_name = d.strip()
            is_allowed = (
                bool(RE_CASE_DIR.match(d_name))
                or bool(RE_PATIENT_DIR.match(d_name))
                or (d_name.lower() in ALLOWED_CONTAINER_DIRS)
            )
            if not is_allowed:
                bad_dirnames += 1

        for f in files:
            total_files += 1
            f_name = f.strip()
            is_allowed = (
                f_name in ALLOWED_SPECIAL_FILES
                or bool(RE_PRIMARY_NII.match(f_name))
                or bool(RE_LABELS_NII.match(f_name))
            )
            if not is_allowed:
                bad_filenames += 1

    return {
        "total_files": total_files,
        "total_dirs": total_dirs,
        "bad_filenames": bad_filenames,
        "bad_dirnames": bad_dirnames,
    }


def check_nifti_headers(folder_path: Path) -> Dict[str, int]:
    """Verify that every .nii.gz loads as NIfTI-1 with zero extensions and cleared text fields."""
    import nibabel as nib

    counts: Dict[str, int] = {
        "total_nifti": 0,
        "load_failed": 0,
        "not_nifti1": 0,
        "data_type_non_empty": 0,
        "db_name_non_empty": 0,
        "descrip_non_empty": 0,
        "aux_file_non_empty": 0,
        "intent_name_non_empty": 0,
        "header_extensions_present": 0,
    }

    nii_paths = [p for p in folder_path.rglob("*.nii.gz") if p.is_file()]
    counts["total_nifti"] = len(nii_paths)

    for p in nii_paths:
        try:
            img = nib.load(str(p))
            hdr = img.header

            if not isinstance(hdr, nib.Nifti1Header):
                counts["not_nifti1"] += 1
                continue

            for field in NIFTI_TEXT_FIELDS:
                try:
                    val = bytes(hdr[field]).strip(b"\x00")
                    if val != b"":
                        counts[f"{field}_non_empty"] += 1
                except Exception:
                    counts[f"{field}_non_empty"] += 1

            if len(hdr.extensions) > 0:
                counts["header_extensions_present"] += 1

        except Exception:
            counts["load_failed"] += 1

    return counts


def check_worklist(folder_path: Path) -> Dict[str, int]:
    """Verify worklist.csv has exactly case_id, patient_id, class with valid pseudonyms."""
    counts = {
        "worklist_present": 0,
        "bad_columns": 0,
        "bad_rows": 0,
        "valid_rows": 0,
    }

    worklist_file = folder_path / "worklist.csv"
    if not worklist_file.exists() or not worklist_file.is_file():
        return counts

    counts["worklist_present"] = 1

    try:
        with worklist_file.open("r", encoding="utf-8", errors="replace") as f:
            reader = csv.reader(f)
            header = next(reader, None)
            if header is None or header != ["case_id", "patient_id", "class"]:
                counts["bad_columns"] += 1
                return counts

            for row in reader:
                if not row or all(c.strip() == "" for c in row):
                    continue
                if len(row) != 3:
                    counts["bad_rows"] += 1
                    continue
                cid, pid, cls = row[0].strip(), row[1].strip(), row[2].strip()
                if (
                    not RE_CASE_ID.match(cid)
                    or not RE_PATIENT_ID.match(pid)
                    or not RE_CLASS.match(cls)
                ):
                    counts["bad_rows"] += 1
                else:
                    counts["valid_rows"] += 1

    except Exception:
        counts["bad_columns"] += 1

    return counts


def check_forbidden_patterns(folder_path: Path, patterns: Sequence[str]) -> Dict[str, int]:
    """Scan all text-like files, filenames, and NIfTI headers for forbidden identifier regexes."""
    compiled = [re.compile(p, re.IGNORECASE) for p in patterns if p.strip()]

    hits_by_pattern: Dict[str, int] = {p: 0 for p in patterns}
    total_hits = 0

    # 1. Scan file and directory names
    for root, dirs, files in os.walk(folder_path):
        for name in dirs + files:
            for pat, comp in zip(patterns, compiled):
                if comp.search(name):
                    hits_by_pattern[pat] += 1
                    total_hits += 1

    # 2. Scan text-like files
    for p in folder_path.rglob("*"):
        if not p.is_file():
            continue
        ext = p.suffix.lower()
        if ext in {".csv", ".json", ".txt", ".md", ".log", ".tsv", ".xml", ".html"} or (
            p.name in ALLOWED_SPECIAL_FILES
        ):
            try:
                content = p.read_text(encoding="utf-8", errors="ignore")
                for pat, comp in zip(patterns, compiled):
                    matches = len(comp.findall(content))
                    if matches > 0:
                        hits_by_pattern[pat] += matches
                        total_hits += matches
            except Exception:
                pass

    # 3. Scan NIfTI header raw strings
    import nibabel as nib

    for p in folder_path.rglob("*.nii.gz"):
        if not p.is_file():
            continue
        try:
            img = nib.load(str(p))
            hdr = img.header
            raw_bytes = bytes(hdr.raw_data)
            decoded = raw_bytes.decode("latin-1", errors="ignore")
            for pat, comp in zip(patterns, compiled):
                matches = len(comp.findall(decoded))
                if matches > 0:
                    hits_by_pattern[pat] += matches
                    total_hits += matches
        except Exception:
            pass

    res = {"total_forbidden_hits": total_hits}
    res.update({f"hits_pattern_{i+1}": c for i, (p, c) in enumerate(hits_by_pattern.items())})
    return res


def check_consistency_and_dimensions(folder_path: Path) -> Dict[str, Any]:
    """Check pairing, shape consistency, and extract aggregated min/max dimension bounds."""
    import nibabel as nib

    cases: Dict[str, Dict[str, Path]] = {}

    for p in folder_path.rglob("*.nii.gz"):
        if not p.is_file():
            continue
        m_pri = RE_PRIMARY_NII.match(p.name)
        if m_pri:
            cid = m_pri.group(1)
            cases.setdefault(cid, {})["primary"] = p
            continue
        m_lab = RE_LABELS_NII.match(p.name)
        if m_lab:
            cid = m_lab.group(1)
            cases.setdefault(cid, {})["labels"] = p
            continue

    total_cases = len(cases)
    unpaired_cases = 0
    shape_mismatches = 0
    zoom_mismatches = 0

    all_shapes: List[Tuple[int, int, int]] = []
    all_zooms: List[Tuple[float, float, float]] = []

    for cid, pair in cases.items():
        prim_path = pair.get("primary")
        lab_path = pair.get("labels")

        if not prim_path or not lab_path:
            unpaired_cases += 1
            continue

        try:
            prim_img = nib.load(str(prim_path))
            lab_img = nib.load(str(lab_path))

            p_shape = tuple(prim_img.shape[:3])
            l_shape = tuple(lab_img.shape[:3])

            if p_shape != l_shape:
                shape_mismatches += 1
            else:
                all_shapes.append(p_shape)

            p_zooms = tuple(round(float(z), 3) for z in prim_img.header.get_zooms()[:3])
            l_zooms = tuple(round(float(z), 3) for z in lab_img.header.get_zooms()[:3])

            if p_zooms != l_zooms:
                zoom_mismatches += 1
            else:
                all_zooms.append(p_zooms)

        except Exception:
            shape_mismatches += 1

    min_shape = None
    max_shape = None
    if all_shapes:
        min_shape = (
            min(s[0] for s in all_shapes),
            min(s[1] for s in all_shapes),
            min(s[2] for s in all_shapes),
        )
        max_shape = (
            max(s[0] for s in all_shapes),
            max(s[1] for s in all_shapes),
            max(s[2] for s in all_shapes),
        )

    min_zoom = None
    max_zoom = None
    if all_zooms:
        min_zoom = (
            min(z[0] for z in all_zooms),
            min(z[1] for z in all_zooms),
            min(z[2] for z in all_zooms),
        )
        max_zoom = (
            max(z[0] for z in all_zooms),
            max(z[1] for z in all_zooms),
            max(z[2] for z in all_zooms),
        )

    return {
        "cases_count": total_cases,
        "unpaired_cases": unpaired_cases,
        "shape_mismatches": shape_mismatches,
        "zoom_mismatches": zoom_mismatches,
        "min_shape": min_shape,
        "max_shape": max_shape,
        "min_zoom": min_zoom,
        "max_zoom": max_zoom,
    }


def verify_folder(
    folder_path: Path,
    src_dir: Optional[Path] = None,
    forbidden_patterns: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    """Execute all checks against target folder and return structured count report."""
    if src_dir is None:
        src_dir = Path(".").resolve()

    valid_folder = validate_folder_outside_repo_and_data(folder_path, src_dir)

    patterns = list(DEFAULT_FORBIDDEN_PATTERNS)
    if forbidden_patterns:
        patterns.extend(forbidden_patterns)

    name_results = check_allowed_names(valid_folder)
    nii_results = check_nifti_headers(valid_folder)
    worklist_results = check_worklist(valid_folder)
    pattern_results = check_forbidden_patterns(valid_folder, patterns)
    consistency_results = check_consistency_and_dimensions(valid_folder)

    total_failures = (
        name_results["bad_filenames"]
        + name_results["bad_dirnames"]
        + nii_results["load_failed"]
        + nii_results["not_nifti1"]
        + nii_results["data_type_non_empty"]
        + nii_results["db_name_non_empty"]
        + nii_results["descrip_non_empty"]
        + nii_results["aux_file_non_empty"]
        + nii_results["intent_name_non_empty"]
        + nii_results["header_extensions_present"]
        + worklist_results["bad_columns"]
        + worklist_results["bad_rows"]
        + (1 if worklist_results["worklist_present"] == 0 else 0)
        + pattern_results["total_forbidden_hits"]
        + consistency_results["unpaired_cases"]
        + consistency_results["shape_mismatches"]
        + consistency_results["zoom_mismatches"]
    )

    return {
        "status": "FULL PASS" if total_failures == 0 else "FAIL",
        "total_failures": total_failures,
        "names": name_results,
        "nifti": nii_results,
        "worklist": worklist_results,
        "patterns": pattern_results,
        "consistency": consistency_results,
    }


def print_report(results: Dict[str, Any]) -> None:
    """Print strictly aggregated counts and min/max summaries (counts only)."""
    print("=" * 65)
    print("DE-IDENTIFICATION FOLDER VERIFICATION AUDIT")
    print("=" * 65)

    names = results["names"]
    print(f"Total Files Inspected          : {names['total_files']}")
    print(f"Total Folders Inspected        : {names['total_dirs']}")
    print(f"  Unallowed Filenames Count    : {names['bad_filenames']}")
    print(f"  Unallowed Directory Count    : {names['bad_dirnames']}")

    nii = results["nifti"]
    print("-" * 65)
    print(f"Total NIfTI Files Inspected    : {nii['total_nifti']}")
    print(f"  Load Failure Count           : {nii['load_failed']}")
    print(f"  Non NIfTI-1 Count            : {nii['not_nifti1']}")
    print(f"  Non-Empty data_type Count    : {nii['data_type_non_empty']}")
    print(f"  Non-Empty db_name Count      : {nii['db_name_non_empty']}")
    print(f"  Non-Empty descrip Count      : {nii['descrip_non_empty']}")
    print(f"  Non-Empty aux_file Count     : {nii['aux_file_non_empty']}")
    print(f"  Non-Empty intent_name Count  : {nii['intent_name_non_empty']}")
    print(f"  Header Extensions Count      : {nii['header_extensions_present']}")

    wl = results["worklist"]
    print("-" * 65)
    print(f"Worklist Present               : {bool(wl['worklist_present'])}")
    print(f"  Valid Cases in Worklist      : {wl['valid_rows']}")
    print(f"  Column Mismatch Count        : {wl['bad_columns']}")
    print(f"  Invalid Row Value Count      : {wl['bad_rows']}")

    pats = results["patterns"]
    print("-" * 65)
    print(f"Forbidden Identifier Hits      : {pats['total_forbidden_hits']}")

    cons = results["consistency"]
    print("-" * 65)
    print(f"Total Case Pairs Inspected     : {cons['cases_count']}")
    print(f"  Unpaired Cases Count         : {cons['unpaired_cases']}")
    print(f"  Shape Mismatch Count         : {cons['shape_mismatches']}")
    print(f"  Voxel Zoom Mismatch Count    : {cons['zoom_mismatches']}")
    if cons["min_shape"] and cons["max_shape"]:
        print(f"  Dimensions Min Bound         : {cons['min_shape']}")
        print(f"  Dimensions Max Bound         : {cons['max_shape']}")
    if cons["min_zoom"] and cons["max_zoom"]:
        print(f"  Voxel Size Min Bound (mm)    : {cons['min_zoom']}")
        print(f"  Voxel Size Max Bound (mm)    : {cons['max_zoom']}")

    print("=" * 65)
    print(f"Overall Status: {results['status']} (Total Failure Count: {results['total_failures']})")
    print("=" * 65)


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Verify de-identification and integrity of exported MRI folder (counts only)."
    )
    ap.add_argument("folder", type=str, help="Path to exported dataset folder to verify")
    ap.add_argument("--src", type=str, default=".", help="Root repository path (must be outside)")
    ap.add_argument(
        "--forbidden-pattern",
        action="append",
        dest="forbidden_patterns",
        default=[],
        help="Additional forbidden identifier regex patterns to check",
    )
    ap.add_argument("--json", action="store_true", help="Output machine-readable JSON counts only")

    args = ap.parse_args()

    try:
        folder_path = Path(args.folder).resolve()
        src_path = Path(args.src).resolve()
        res = verify_folder(
            folder_path=folder_path,
            src_dir=src_path,
            forbidden_patterns=args.forbidden_patterns,
        )

        if args.json:
            print(json.dumps(res, indent=2))
        else:
            print_report(res)

        if res["status"] != "FULL PASS":
            sys.exit(1)
        sys.exit(0)

    except Exception as e:
        print(f"[ERROR] Verification failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
