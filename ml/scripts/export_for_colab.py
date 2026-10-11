"""De-identify and export BME dataset for cloud training (Colab / Kaggle).

Usage:
    python export_for_colab.py --dry-run
    python export_for_colab.py --src <repo> --dst <export_folder> --mapping-file <path_outside_repo>
    python export_for_colab.py --verify --src <repo> --dst <export_folder> --mapping-file <path_outside_repo>
    python export_for_colab.py --compare-training-inputs --src <repo> --dst <export_folder> --mapping-file <path_outside_repo>

Hardened Features:
1. Path Guards:
   - Refuses if --dst is inside the repository or data/ directory.
   - Refuses if --mapping-file is inside the repository or data/ directory.
   - Refuses if --mapping-file is inside or equals --dst (to prevent uploading mapping).
2. Existing Destination Guard:
   - Refuses execution if --dst exists and is non-empty (no deleting or overwriting).
3. Stable & Incremental Identifiers:
   - Reuses existing case and patient mappings if --mapping-file already exists.
   - Detects and refuses conflicting or corrupted existing mappings.
   - Assigns new IDs continuing numbering using seeded shuffle for new cases only.
   - Writes mapping atomically using a temporary file and replace within the folder.
4. Fail-Closed Data Sanitization & Leak Check:
   - Clears NIfTI-1 header text fields: data_type, db_name, descrip, aux_file, intent_name.
   - Strips all NIfTI header extensions and zeroes extender bytes.
   - Sanitizes both volume scans and label volumes identically.
   - Fail-closed leak check in --verify:
     * Any unreadable or unparsable NIfTI file counts as failure.
     * Any file type other than .nii.gz, worklist.csv, and directory structure counts as failure.
     * Full text scanning of worklist.csv and all text-like files.
     * Missing or empty export folder counts as failure.
     * Scans entry names inside the zip bundle archive.
     * Reports leak checks as counts only (no leaked text printed).
5. Pre-Mapping Export Validation & Diagnostics:
   - Diagnoses per-failure-class counts by exception class name only.
   - Refuses to write mapping file if 0 cases exported or if exported count differs
     from eligible cases (cases with both volume and segmentation).
   - On any failure, instructs user to manually delete partial --dst before retrying.
6. Strengthened Full-Volume Verification & Training Inputs Comparison:
   - In --verify: compares full volume array, shape, dtype, affine against source.
   - In --verify: checks label volume shape, affine, dtype uint8, values in {0,1,2}, and >=1 edema voxel.
   - In --compare-training-inputs: reuses train_3d.load_case directly to compare arrays loaded from
     original source vs exported NIfTI files.
   - Both modes exit non-zero (1) on any failure and 0 only on full PASS.
7. Integrity & Safety:
   - Computes and prints the combined SHA-256 hash of the exported files.
   - Prints reminder to back up mapping file to a second location outside the repository.
   - Zero patient identifiers, case IDs, or raw paths printed.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import random
import sys
import zipfile
from pathlib import Path

import nibabel as nib
import numpy as np

# Module-level references populated by load_ml_modules
build_labelmap = None
read_segmentation = None
to_volume_grid = None
volume_path = None
load_case = None


def locate_scripts_dir(custom_dir: Path | str | None = None) -> Path:
    """Locate ml/scripts directory relative to script file or via optional custom directory."""
    if custom_dir:
        p = Path(custom_dir).resolve()
        if not p.is_dir():
            raise ImportError(f"Failed to import required modules: --scripts-dir does not exist: {p}")
        return p

    this_dir = Path(__file__).resolve().parent
    candidates = [
        this_dir,
        this_dir.parent / "ml" / "scripts",
        this_dir.parent / "bme" / "ml" / "scripts",
    ]
    for cand in candidates:
        if cand.is_dir() and (cand / "seg2nifti.py").exists() and (cand / "train_3d.py").exists():
            return cand.resolve()

    return this_dir


def load_ml_modules(scripts_dir: Path | str | None = None):
    """Import seg2nifti and train_3d; raise hard ImportError identifying failed module if any."""
    global build_labelmap, read_segmentation, to_volume_grid, volume_path, load_case

    target_dir = locate_scripts_dir(scripts_dir)
    if not (target_dir / "seg2nifti.py").exists():
        raise ImportError(f"Failed to import required module 'seg2nifti' from {target_dir}: seg2nifti.py not found")
    if not (target_dir / "train_3d.py").exists():
        raise ImportError(f"Failed to import required module 'train_3d' from {target_dir}: train_3d.py not found")

    target_str = str(target_dir)
    if target_str not in sys.path:
        sys.path.insert(0, target_str)

    try:
        import seg2nifti
        build_labelmap = seg2nifti.build_labelmap
        read_segmentation = seg2nifti.read_segmentation
        to_volume_grid = seg2nifti.to_volume_grid
    except Exception as e:
        raise ImportError(f"Failed to import required module 'seg2nifti' from {target_dir}: {e}") from e

    try:
        import train_3d
        volume_path = train_3d.volume_path
        load_case = getattr(train_3d, "load_case", None)
    except Exception as e:
        raise ImportError(f"Failed to import required module 'train_3d' from {target_dir}: {e}") from e


# Extract CLI --scripts-dir early if passed
_cli_scripts_dir = None
for _i, _arg in enumerate(sys.argv):
    if _arg == "--scripts-dir" and _i + 1 < len(sys.argv):
        _cli_scripts_dir = sys.argv[_i + 1]
    elif _arg.startswith("--scripts-dir="):
        _cli_scripts_dir = _arg.split("=", 1)[1]

load_ml_modules(_cli_scripts_dir)


def sanitize_nifti_header(img: nib.Nifti1Image) -> nib.Nifti1Image:
    """Clear metadata text fields (data_type, db_name, descrip, aux_file, intent_name) and strip extensions."""
    hdr = img.header.copy()
    if isinstance(hdr, nib.Nifti1Header):
        hdr["data_type"] = b""
        hdr["db_name"] = b""
        hdr["descrip"] = b""
        hdr["aux_file"] = b""
        hdr["intent_name"] = b""
        hdr.extensions.clear()
    data = np.asanyarray(img.dataobj)
    sanitized = nib.Nifti1Image(data, img.affine, hdr)
    sanitized.header.extensions.clear()
    return sanitized


def validate_paths(src_dir: Path, dst_dir: Path, mapping_file: Path | None):
    """Enforce strict security boundaries for source, destination, and mapping paths."""
    src_res = src_dir.resolve()
    dst_res = dst_dir.resolve()
    data_res = (src_res / "data").resolve()

    # 1. Validate destination path
    if (
        dst_res == src_res or
        src_res in dst_res.parents or
        dst_res == data_res or
        data_res in dst_res.parents or
        "data" in [p.lower() for p in dst_res.parts]
    ):
        raise SystemExit(
            f"[ERROR] Security check failed: --dst ({dst_res}) must be located strictly "
            f"OUTSIDE the repository ({src_res}) and data/ directory."
        )

    # 2. Validate mapping file path if provided
    if mapping_file is not None:
        map_res = mapping_file.resolve()
        # Refuse if inside repository or data/
        if (
            map_res == src_res or
            src_res in map_res.parents or
            map_res == data_res or
            data_res in map_res.parents or
            "data" in [p.lower() for p in map_res.parts]
        ):
            raise SystemExit(
                f"[ERROR] Security check failed: --mapping-file ({map_res}) must be located strictly "
                f"OUTSIDE the repository ({src_res}) and data/ directory."
            )

        # Refuse if inside or equals destination folder
        if (
            map_res == dst_res or
            dst_res in map_res.parents
        ):
            raise SystemExit(
                f"[ERROR] Security check failed: --mapping-file ({map_res}) must NOT be inside or equal to "
                f"the export directory --dst ({dst_res}), as --dst is intended for cloud upload!"
            )


def find_source_cases(base_dir: Path) -> list[str]:
    ann = base_dir / "data" / "annotations"
    if not ann.is_dir():
        return []
    cases = sorted(
        p.parent.name
        for p in ann.glob("*/*.seg.nrrd")
        if p.name == f"{p.parent.name}.seg.nrrd"
    )
    return cases


def load_source_patient_map(base_dir: Path) -> dict[str, str]:
    """Load patient group mapping from deid_map.csv if available."""
    deid_file = base_dir / "data" / "deid_map.csv"
    patient_map = {}
    if deid_file.exists():
        try:
            with deid_file.open(newline="", encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    cid = row.get("case_id")
                    pid = row.get("source_archive") or cid
                    if cid and pid:
                        patient_map[cid] = pid
        except Exception:
            pass
    return patient_map


def load_and_validate_existing_mapping(mapping_file: Path, patient_map: dict[str, str]) -> list[dict]:
    """Load existing mapping file and validate for internal consistency and conflicts."""
    if not mapping_file.exists():
        return []

    try:
        data = json.loads(mapping_file.read_text(encoding="utf-8"))
    except Exception as e:
        raise SystemExit(f"[ERROR] Existing mapping file {mapping_file} is corrupted or not valid JSON: {e}")

    cases = data.get("cases", [])
    if not isinstance(cases, list):
        raise SystemExit(f"[ERROR] Existing mapping file {mapping_file} has invalid structure (missing 'cases' list).")

    seen_orig_cids = set()
    seen_exported_ids = set()
    patient_to_group = {}

    for entry in cases:
        orig_cid = entry.get("original_case_id")
        exp_id = entry.get("exported_id")
        grp = entry.get("patient_group")

        if not orig_cid or not exp_id or not grp:
            raise SystemExit(f"[ERROR] Existing mapping entry is missing required fields: {entry}")

        if orig_cid in seen_orig_cids:
            raise SystemExit(f"[ERROR] Conflicting mapping: duplicate original_case_id in {mapping_file}")
        seen_orig_cids.add(orig_cid)

        if exp_id in seen_exported_ids:
            raise SystemExit(f"[ERROR] Conflicting mapping: duplicate exported_id '{exp_id}' in {mapping_file}")
        seen_exported_ids.add(exp_id)

        orig_patient = patient_map.get(orig_cid, orig_cid)
        if orig_patient in patient_to_group and patient_to_group[orig_patient] != grp:
            raise SystemExit(
                f"[ERROR] Conflicting mapping: patient grouping contradiction for '{orig_cid}' in {mapping_file}"
            )
        patient_to_group[orig_patient] = grp

    return cases


def build_export_manifest(
    case_ids: list[str],
    patient_map: dict[str, str],
    seed: int = 42,
    existing_manifest: list[dict] | None = None
) -> list[dict]:
    """Deterministic export manifest: reuses existing IDs if present, assigns stable incremental IDs to new cases."""
    existing_cases = existing_manifest or []
    manifest_by_orig = {entry["original_case_id"]: dict(entry) for entry in existing_cases}

    # Find highest existing case and patient numbers
    max_c_num = 0
    max_p_num = 0
    patient_to_pseudonym: dict[str, str] = {}

    for entry in existing_cases:
        exp_id = entry["exported_id"]
        grp = entry["patient_group"]
        if exp_id.startswith("case_"):
            try:
                max_c_num = max(max_c_num, int(exp_id.split("_")[-1]))
            except ValueError:
                pass
        if grp.startswith("patient_"):
            try:
                max_p_num = max(max_p_num, int(grp.split("_")[-1]))
            except ValueError:
                pass

        orig_cid = entry["original_case_id"]
        orig_patient = patient_map.get(orig_cid, orig_cid)
        patient_to_pseudonym[orig_patient] = grp

    c_counter = max_c_num + 1
    p_counter = max_p_num + 1

    # Deterministically order and shuffle only NEW cases
    new_cases = sorted([c for c in case_ids if c not in manifest_by_orig])
    rng = random.Random(seed)
    rng.shuffle(new_cases)

    manifest = list(existing_cases)
    for cid in new_cases:
        rand_id = f"case_{c_counter:03d}"
        c_counter += 1

        orig_patient = patient_map.get(cid, cid)
        if orig_patient not in patient_to_pseudonym:
            patient_to_pseudonym[orig_patient] = f"patient_{p_counter:03d}"
            p_counter += 1

        new_entry = {
            "original_case_id": cid,
            "exported_id": rand_id,
            "patient_group": patient_to_pseudonym[orig_patient],
        }
        manifest.append(new_entry)

    # Return entries sorted deterministically by exported_id
    manifest.sort(key=lambda x: x["exported_id"])
    return manifest


def write_mapping_atomically(mapping_file: Path, payload: dict):
    """Write mapping payload atomically via a temporary file in the same directory."""
    mapping_file.parent.mkdir(parents=True, exist_ok=True)
    temp_file = mapping_file.with_name(f".{mapping_file.name}.tmp_{os.getpid()}")
    try:
        temp_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        os.replace(temp_file, mapping_file)
    finally:
        if temp_file.exists():
            try:
                temp_file.unlink()
            except Exception:
                pass


def compute_directory_combined_sha256(directory: Path) -> str:
    """Compute deterministic combined SHA-256 over all files in a directory."""
    comb_h = hashlib.sha256()
    for f in sorted(directory.rglob("*")):
        if f.is_file():
            rel = f.relative_to(directory).as_posix()
            fh = hashlib.sha256()
            with f.open("rb") as stream:
                while chunk := stream.read(65536):
                    fh.update(chunk)
            comb_h.update(f"{rel}:{fh.hexdigest()}\n".encode("utf-8"))
    return comb_h.hexdigest()


def run_dry_run(src_dir: Path, manifest: list[dict]):
    print("=" * 60)
    print("BME DATASET DE-IDENTIFIED EXPORT (DRY-RUN)")
    print("=" * 60)
    print(f"Source directory: {src_dir}")
    print(f"Total candidate cases discovered: {len(manifest)}")

    unique_patients = len(set(m["patient_group"] for m in manifest))
    print(f"Unique patient groups identified: {unique_patients}")

    multi_case_patients = sum(
        1 for p in set(m["patient_group"] for m in manifest)
        if sum(1 for m in manifest if m["patient_group"] == p) > 1
    )
    print(f"Patient groups with >1 case: {multi_case_patients}")
    print("Header fields to be wiped: data_type, db_name, descrip, aux_file, intent_name, extensions")
    print("Output format per case: <rand_id>_primary.nii.gz, <rand_id>_labels.nii.gz")
    print("No files were exported (dry-run mode active).")
    print("=" * 60)


def run_export(src_dir: Path, dst_dir: Path, manifest: list[dict], mapping_file: Path):
    # Requirement: Refuse to run when dst_dir exists and is non-empty
    if dst_dir.exists():
        existing_items = list(dst_dir.iterdir())
        if existing_items:
            raise SystemExit(
                f"[ERROR] Destination directory ({dst_dir}) already exists and is non-empty ({len(existing_items)} items found). "
                "Refusing to overwrite or merge. Please specify an empty or non-existent destination."
            )

    # Count eligible cases that have both volume and segmentation
    eligible_count = 0
    for entry in manifest:
        cid = entry["original_case_id"]
        seg_path = src_dir / "data" / "annotations" / cid / f"{cid}.seg.nrrd"
        vol_path = volume_path(src_dir, cid) if volume_path else None
        if seg_path.exists() and vol_path is not None and vol_path.exists():
            eligible_count += 1

    dst_dir.mkdir(parents=True, exist_ok=True)
    dst_ann = dst_dir / "data" / "annotations"
    dst_nii = dst_dir / "data" / "nifti"
    dst_ann.mkdir(parents=True, exist_ok=True)
    dst_nii.mkdir(parents=True, exist_ok=True)

    exported_count = 0
    worklist_rows = []
    failure_counts: dict[str, int] = {}

    for entry in manifest:
        cid = entry["original_case_id"]
        rand_id = entry["exported_id"]

        seg_path = src_dir / "data" / "annotations" / cid / f"{cid}.seg.nrrd"
        vol_path = volume_path(src_dir, cid) if volume_path else None

        if not seg_path.exists() or vol_path is None or not vol_path.exists():
            continue

        case_ann_dir = dst_ann / rand_id
        case_nii_dir = dst_nii / rand_id
        out_vol = case_nii_dir / f"{rand_id}_primary.nii.gz"
        out_lab = case_ann_dir / f"{rand_id}_labels.nii.gz"

        try:
            # 1. Load source scan and sanitize
            src_img = nib.load(str(vol_path))
            sanitized_img = sanitize_nifti_header(src_img)

            # 2. Build aligned labelmap and sanitize
            data, header, segments = read_segmentation(seg_path)
            lab, _, _ = build_labelmap(data, segments)
            placed, _ = to_volume_grid(lab, header, src_img)

            lab_hdr = sanitized_img.header.copy()
            lab_hdr.set_data_dtype(np.uint8)
            sanitized_lab = nib.Nifti1Image(placed.astype(np.uint8), sanitized_img.affine, lab_hdr)
            sanitized_lab = sanitize_nifti_header(sanitized_lab)
            sanitized_lab.header.set_data_dtype(np.uint8)
            sanitized_lab.header.extensions.clear()

            # 3. Save to destination
            case_ann_dir.mkdir(parents=True, exist_ok=True)
            case_nii_dir.mkdir(parents=True, exist_ok=True)

            nib.save(sanitized_img, str(out_vol))
            nib.save(sanitized_lab, str(out_lab))

            worklist_rows.append({
                "case_id": rand_id,
                "patient_id": entry["patient_group"],
                "class": "bme",
            })
            exported_count += 1
        except Exception as e:
            cls_name = type(e).__name__
            failure_counts[cls_name] = failure_counts.get(cls_name, 0) + 1

    total_candidates = len(manifest)
    skipped_count = total_candidates - exported_count

    # Task 1: Print failure diagnostics table by exception class name only
    if failure_counts:
        print("\n" + "=" * 50)
        print("EXPORT FAILURE DIAGNOSTICS (BY EXCEPTION CLASS)")
        print("=" * 50)
        print(f"{'Exception Class':<35} {'Count':>10}")
        print("-" * 50)
        for cls_name, count in sorted(failure_counts.items()):
            print(f"{cls_name:<35} {count:>10}")
        print("=" * 50)

    # Task 1: Stop with clear error BEFORE writing mapping file
    if exported_count == 0 or exported_count != eligible_count:
        print("\n[ACTION REQUIRED] Export failed to complete successfully.")
        print(f"The partial export directory '{dst_dir.name}' must be deleted manually before retrying.")
        if exported_count == 0:
            raise SystemExit(
                f"[ERROR] Zero cases exported (eligible: {eligible_count}, exported: 0, skipped: {skipped_count}). "
                "Stopping before writing mapping file."
            )
        else:
            raise SystemExit(
                f"[ERROR] Export count mismatch: exported {exported_count} cases, but expected {eligible_count} eligible cases "
                f"(skipped: {skipped_count}). Stopping before writing mapping file."
            )

    # Write sanitized worklist
    wl_path = dst_dir / "data" / "worklist.csv"
    with wl_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["case_id", "patient_id", "class"])
        writer.writeheader()
        writer.writerows(worklist_rows)

    # Save mapping file atomically strictly outside repository
    mapping_payload = {
        "count": exported_count,
        "cases": manifest,
    }
    write_mapping_atomically(mapping_file, mapping_payload)

    # Package dataset into zip
    zip_dest = dst_dir.parent / f"{dst_dir.name}.zip"
    with zipfile.ZipFile(zip_dest, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(dst_dir.rglob("*")):
            if file_path.is_file():
                arcname = file_path.relative_to(dst_dir)
                zf.write(file_path, arcname=str(arcname))

    # Print counts, combined SHA-256, and backup reminder
    combined_sha = compute_directory_combined_sha256(dst_dir)
    total_files = sum(1 for p in dst_dir.rglob("*") if p.is_file())

    print("\n" + "=" * 65)
    print("BME DATASET EXPORT & INTEGRITY SUMMARY")
    print("=" * 65)
    print(f"Total cases exported     : {exported_count}")
    print(f"Total files in export    : {total_files}")
    print(f"Archive bundle size      : {zip_dest.stat().st_size / (1024*1024):.2f} MB")
    print(f"Combined Export SHA-256  : {combined_sha}")
    print("=" * 65)
    print("CRITICAL SECURITY REMINDER:")
    print("  1. Back up your mapping file to a second secure location outside the repository.")
    print("  2. Do NOT copy, commit, or push the mapping file into Git.")
    print("  3. Do NOT upload the mapping file to Kaggle, Colab, or any cloud instance.")
    print("=" * 65)


def check_privacy_leaks(
    dst_dir: Path,
    mapping_file: Path,
    patient_map: dict[str, str],
    manifest: list[dict],
) -> tuple[int, int]:
    """Fail-closed check across destination directory and zip bundle.
    
    Returns (fs_fail_count, zip_fail_count).
    """
    # Fail closed on missing or empty export directory
    if not dst_dir.exists() or not dst_dir.is_dir():
        return (1, 1)

    all_files = [p for p in dst_dir.rglob("*") if p.is_file()]
    if not all_files:
        return (1, 1)

    forbidden_tokens = set()
    for entry in manifest:
        orig_cid = entry.get("original_case_id", "").strip()
        if len(orig_cid) >= 3:
            forbidden_tokens.add(orig_cid.lower())
        orig_p = patient_map.get(orig_cid, "").strip()
        if len(orig_p) >= 3:
            forbidden_tokens.add(orig_p.lower())

    mapping_basename = mapping_file.name.lower()
    leaking_items = set()

    for item in dst_dir.rglob("*"):
        rel_parts = [part.lower() for part in item.relative_to(dst_dir).parts]

        # Directory name check
        if item.is_dir():
            if mapping_basename in rel_parts or any(token in item.name.lower() for token in forbidden_tokens):
                leaking_items.add(item)
            continue

        # File validation: any file other than .nii.gz and worklist.csv fails
        is_allowed_file = (
            item.name == "worklist.csv" or
            item.name.endswith(".nii.gz")
        )
        if not is_allowed_file:
            leaking_items.add(item)
            continue

        # Check path and filename against mapping file name and forbidden tokens
        if mapping_basename in rel_parts or item.name.lower() == mapping_basename:
            leaking_items.add(item)
            continue

        for token in forbidden_tokens:
            if any(token in part for part in rel_parts):
                leaking_items.add(item)
                break

        if item in leaking_items:
            continue

        # Scan text-like files fully
        if item.name == "worklist.csv" or item.suffix in [".csv", ".txt", ".json"]:
            try:
                content = item.read_text(encoding="utf-8", errors="replace").lower()
                for token in forbidden_tokens:
                    if token in content:
                        leaking_items.add(item)
                        break
            except Exception:
                leaking_items.add(item)

        # Scan NIfTI image headers (fail closed if cannot be loaded or inspected)
        if item.name.endswith(".nii.gz"):
            try:
                nii = nib.load(str(item))
                h = nii.header
                if not isinstance(h, nib.Nifti1Header):
                    leaking_items.add(item)
                else:
                    for field in ["data_type", "db_name", "descrip", "aux_file", "intent_name"]:
                        val_bytes = bytes(h[field]).strip(b"\x00")
                        if val_bytes != b"":
                            leaking_items.add(item)
                            break
                        val_str = bytes(h[field]).decode("latin-1", errors="ignore").lower()
                        for token in forbidden_tokens:
                            if token in val_str:
                                leaking_items.add(item)
                                break
                    if len(h.extensions) > 0:
                        leaking_items.add(item)
            except Exception:
                leaking_items.add(item)

    fs_fail_count = len(leaking_items)

    # Check entry names inside zip bundle
    zip_dest = dst_dir.parent / f"{dst_dir.name}.zip"
    zip_fail_count = 0
    if not zip_dest.exists() or not zip_dest.is_file():
        zip_fail_count = 1
    else:
        try:
            with zipfile.ZipFile(zip_dest, "r") as zf:
                entry_names = zf.namelist()
                if not entry_names:
                    zip_fail_count = 1
                else:
                    zip_leaking_entries = set()
                    for entry in entry_names:
                        entry_lower = entry.lower().replace("\\", "/")
                        parts = [p for p in entry_lower.split("/") if p]

                        is_allowed_entry = (
                            entry.endswith("/") or
                            entry_lower.endswith("worklist.csv") or
                            entry_lower.endswith(".nii.gz")
                        )
                        if not is_allowed_entry:
                            zip_leaking_entries.add(entry)
                            continue

                        if mapping_basename in parts or mapping_basename in entry_lower:
                            zip_leaking_entries.add(entry)
                            continue

                        for token in forbidden_tokens:
                            if any(token in part for part in parts):
                                zip_leaking_entries.add(entry)
                                break

                    zip_fail_count = len(zip_leaking_entries)
        except Exception:
            zip_fail_count = 1

    return (fs_fail_count, zip_fail_count)


def run_verify(src_dir: Path, dst_dir: Path, mapping_file: Path) -> bool:
    """Verify integrity and perform exhaustive fail-closed privacy leak check (reporting counts only)."""
    if not mapping_file.exists():
        print(f"[ERROR] Mapping file not found: {mapping_file.name}")
        sys.exit(1)

    try:
        mapping_data = json.loads(mapping_file.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[ERROR] Corrupted mapping file: {type(e).__name__}")
        sys.exit(1)

    manifest = mapping_data.get("cases", [])
    patient_map = load_source_patient_map(src_dir)

    print(f"Verifying {len(manifest)} cases...")

    category_failures: dict[str, int] = {}

    def record_failure(category: str):
        category_failures[category] = category_failures.get(category, 0) + 1

    # Fail closed on missing/empty export directory
    if not dst_dir.exists() or not dst_dir.is_dir() or not any(dst_dir.iterdir()):
        print(f"Verification Results: 0 passed, {len(manifest)} failed (Total: {len(manifest)})")
        print("Privacy Leak Check  : FAIL (export directory is missing or empty)")
        print("Zip Bundle Leak Check: FAIL (archive bundle is missing)")
        sys.exit(1)

    passed = 0
    failed = 0

    for entry in manifest:
        cid = entry["original_case_id"]
        rand_id = entry["exported_id"]

        src_vol_path = volume_path(src_dir, cid) if volume_path else None
        dst_vol_path = dst_dir / "data" / "nifti" / rand_id / f"{rand_id}_primary.nii.gz"
        dst_lab_path = dst_dir / "data" / "annotations" / rand_id / f"{rand_id}_labels.nii.gz"

        if src_vol_path is None or not src_vol_path.exists():
            record_failure("missing_source_scan")
            failed += 1
            continue

        if not dst_vol_path.exists():
            record_failure("missing_exported_scan")
            failed += 1
            continue

        if not dst_lab_path.exists():
            record_failure("missing_exported_label")
            failed += 1
            continue

        case_failed = False
        try:
            src_img = nib.load(str(src_vol_path))
            dst_img = nib.load(str(dst_vol_path))
            dst_lab = nib.load(str(dst_lab_path))

            src_data = np.asanyarray(src_img.dataobj)
            dst_data = np.asanyarray(dst_img.dataobj)
            dst_lab_data = np.asanyarray(dst_lab.dataobj)

            # Task 2 Primary Scan: full volume data comparison, shape, dtype, affine
            if not np.array_equal(src_data, dst_data):
                record_failure("scan_data_mismatch")
                case_failed = True

            if src_img.shape != dst_img.shape:
                record_failure("scan_shape_mismatch")
                case_failed = True

            if src_data.dtype != dst_data.dtype:
                record_failure("scan_dtype_mismatch")
                case_failed = True

            if not np.allclose(src_img.affine, dst_img.affine, atol=1e-4):
                record_failure("scan_affine_mismatch")
                case_failed = True

            # Task 2 Label Volume: same shape and affine as source scan, dtype uint8, values in {0,1,2}, >=1 edema
            if dst_lab.shape != src_img.shape:
                record_failure("label_shape_mismatch")
                case_failed = True

            if not np.allclose(dst_lab.affine, src_img.affine, atol=1e-4):
                record_failure("label_affine_mismatch")
                case_failed = True

            if dst_lab_data.dtype != np.uint8:
                record_failure("label_dtype_not_uint8")
                case_failed = True

            unique_vals = np.unique(dst_lab_data)
            if not set(unique_vals).issubset({0, 1, 2}):
                record_failure("label_invalid_values")
                case_failed = True

            if not (dst_lab_data == 2).any():
                record_failure("label_missing_edema")
                case_failed = True

            # Header fields (data_type, db_name, descrip, aux_file, intent_name) and extensions
            for img_obj in [dst_img, dst_lab]:
                hdr = img_obj.header
                if not isinstance(hdr, nib.Nifti1Header):
                    record_failure("header_not_nifti1")
                    case_failed = True
                    break
                if any(bytes(hdr[k]).strip(b"\x00") for k in ["data_type", "db_name", "descrip", "aux_file", "intent_name"]):
                    record_failure("header_text_not_cleared")
                    case_failed = True
                    break
                if len(hdr.extensions) > 0:
                    record_failure("header_extensions_present")
                    case_failed = True
                    break

        except Exception as e:
            record_failure(f"load_exception_{type(e).__name__}")
            case_failed = True

        if case_failed:
            failed += 1
        else:
            passed += 1

    print(f"Verification Results: {passed} passed, {failed} failed (Total: {len(manifest)})")

    if category_failures:
        print("\n" + "=" * 50)
        print("VERIFICATION FAILURES BY CATEGORY")
        print("=" * 50)
        print(f"{'Category':<35} {'Failures':>10}")
        print("-" * 50)
        for cat, cnt in sorted(category_failures.items()):
            print(f"{cat:<35} {cnt:>10}")
        print("=" * 50)

    # Run fail-closed leak checks
    fs_fail_count, zip_fail_count = check_privacy_leaks(dst_dir, mapping_file, patient_map, manifest)

    if fs_fail_count == 0:
        print("Privacy Leak Check  : PASS (0 leaks detected across all files, folders, worklist, and headers)")
    else:
        print(f"Privacy Leak Check  : FAIL ({fs_fail_count} leaking or invalid files detected)")

    if zip_fail_count == 0:
        print("Zip Bundle Leak Check: PASS (0 leaks detected across archive entries)")
    else:
        print(f"Zip Bundle Leak Check: FAIL ({zip_fail_count} leaking or invalid archive entries detected)")

    is_full_pass = (failed == 0 and fs_fail_count == 0 and zip_fail_count == 0)
    if is_full_pass:
        print("\nOverall Verification: FULL PASS")
        sys.exit(0)
    else:
        print("\nOverall Verification: FAIL")
        sys.exit(1)


def run_compare_training_inputs(src_dir: Path, dst_dir: Path, mapping_file: Path) -> bool:
    """Compare training inputs loaded via train_3d.load_case from source vs exported NIfTI."""
    if not mapping_file.exists():
        print(f"[ERROR] Mapping file not found: {mapping_file.name}")
        sys.exit(1)

    if load_case is None:
        print("[ERROR] train_3d.load_case is not available.")
        sys.exit(1)

    try:
        mapping_data = json.loads(mapping_file.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[ERROR] Corrupted mapping file: {type(e).__name__}")
        sys.exit(1)

    manifest = mapping_data.get("cases", [])
    print(f"Comparing training inputs for {len(manifest)} cases...")

    cases_compared = 0
    identical_images = 0
    identical_labels = 0
    mismatches_by_category: dict[str, int] = {}

    def record_mismatch(cat: str):
        mismatches_by_category[cat] = mismatches_by_category.get(cat, 0) + 1

    for entry in manifest:
        orig_cid = entry["original_case_id"]
        rand_id = entry["exported_id"]

        # Load (a) from source repo using train_3d.load_case
        try:
            src_loaded = load_case(src_dir, orig_cid)
        except Exception as e:
            record_mismatch(f"src_load_{type(e).__name__}")
            continue

        if src_loaded is None:
            record_mismatch("src_load_skipped_or_missing")
            continue

        # Load (b) from exported folder using train_3d.load_case
        try:
            dst_loaded = load_case(dst_dir, rand_id)
        except Exception as e:
            record_mismatch(f"dst_load_{type(e).__name__}")
            continue

        if dst_loaded is None:
            record_mismatch("dst_load_skipped_or_missing")
            continue

        cases_compared += 1

        src_img = src_loaded.get("image")
        dst_img = dst_loaded.get("image")
        src_lab = src_loaded.get("labels")
        dst_lab = dst_loaded.get("labels")

        # Compare images
        if src_img is None or dst_img is None:
            record_mismatch("image_missing")
        elif src_img.shape != dst_img.shape:
            record_mismatch("image_shape_mismatch")
        elif src_img.dtype != dst_img.dtype:
            record_mismatch("image_dtype_mismatch")
        elif not np.array_equal(src_img, dst_img):
            record_mismatch("image_value_mismatch")
        else:
            identical_images += 1

        # Compare labels
        if src_lab is None or dst_lab is None:
            record_mismatch("labels_missing")
        elif src_lab.shape != dst_lab.shape:
            record_mismatch("labels_shape_mismatch")
        elif src_lab.dtype != dst_lab.dtype:
            record_mismatch("labels_dtype_mismatch")
        elif not np.array_equal(src_lab, dst_lab):
            record_mismatch("labels_value_mismatch")
        else:
            identical_labels += 1

    print("\n" + "=" * 55)
    print("TRAINING INPUTS COMPARISON SUMMARY")
    print("=" * 55)
    print(f"Cases mapped           : {len(manifest)}")
    print(f"Cases compared         : {cases_compared}")
    print(f"Identical images       : {identical_images}")
    print(f"Identical labels       : {identical_labels}")

    if mismatches_by_category:
        print("\n" + "-" * 55)
        print("MISMATCHES BY CATEGORY")
        print("-" * 55)
        print(f"{'Category':<35} {'Count':>15}")
        print("-" * 55)
        for cat, cnt in sorted(mismatches_by_category.items()):
            print(f"{cat:<35} {cnt:>15}")
        print("=" * 55)

    is_full_pass = (
        cases_compared == len(manifest) and
        identical_images == cases_compared and
        identical_labels == cases_compared and
        len(mismatches_by_category) == 0
    )

    if is_full_pass:
        print("\nCompare Training Inputs: FULL PASS")
        sys.exit(0)
    else:
        print("\nCompare Training Inputs: FAIL")
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description="De-identify and export BME dataset for Colab/Kaggle")
    ap.add_argument("--src", type=str, default=os.getenv("BME_DATASET_DIR", "."), help="Source project repository")
    ap.add_argument("--dst", type=str, default="../bme_colab_export", help="Destination export folder")
    ap.add_argument("--mapping-file", type=str, required=False, default=None,
                    help="Path to mapping file (MUST be strictly OUTSIDE repository, data/, and --dst)")
    ap.add_argument("--scripts-dir", type=str, default=None,
                    help="Directory containing ml/scripts (seg2nifti, train_3d)")
    ap.add_argument("--dry-run", action="store_true", help="Print summary counts without exporting")
    ap.add_argument("--verify", action="store_true", help="Verify exported files against source data")
    ap.add_argument("--compare-training-inputs", action="store_true",
                    help="Compare arrays loaded by train_3d.load_case between source and exported data")
    args = ap.parse_args()

    # Re-apply scripts_dir if passed
    if args.scripts_dir:
        load_ml_modules(args.scripts_dir)

    src_dir = Path(args.src).resolve()
    dst_dir = Path(args.dst).resolve()
    mapping_file = Path(args.mapping_file).resolve() if args.mapping_file else None

    # Validate paths before proceeding
    validate_paths(src_dir, dst_dir, mapping_file)

    cases = find_source_cases(src_dir)
    patient_map = load_source_patient_map(src_dir)

    if args.dry_run:
        manifest = build_export_manifest(cases, patient_map)
        run_dry_run(src_dir, manifest)
        return

    if not mapping_file:
        raise SystemExit("[ERROR] Please provide --mapping-file <path_outside_repo> explicitly.")

    if args.verify:
        run_verify(src_dir, dst_dir, mapping_file)
        return

    if args.compare_training_inputs:
        run_compare_training_inputs(src_dir, dst_dir, mapping_file)
        return

    existing_manifest = load_and_validate_existing_mapping(mapping_file, patient_map)
    manifest = build_export_manifest(cases, patient_map, existing_manifest=existing_manifest)
    run_export(src_dir, dst_dir, manifest, mapping_file)


if __name__ == "__main__":
    main()
