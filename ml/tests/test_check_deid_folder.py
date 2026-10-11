"""Unit and integration tests for check_deid_folder.py.

Uses SYNTHETIC data only (generated on-the-fly in isolated temp directories).
Verifies:
1. Clean de-identified folder passes (exit code 0, 0 failures).
2. Planted bad filename triggers failure.
3. Planted header text triggers failure.
4. Planted NIfTI header extension triggers failure.
5. Planted forbidden pattern (e.g. BME-001 in worklist.csv) triggers failure.
6. Folder inside repo or data/ is strictly refused.
"""

from __future__ import annotations

import csv
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import nibabel as nib
import numpy as np

repo_root = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(repo_root / "ml" / "scripts"))

from check_deid_folder import (
    validate_folder_outside_repo_and_data,
    verify_folder,
)


def create_synthetic_nii(
    path: Path,
    shape=(16, 16, 8),
    zooms=(1.0, 1.0, 2.0),
    descrip: bytes = b"",
    with_extension: bool = False,
) -> None:
    """Create synthetic NIfTI-1 image with clean or tainted header fields."""
    data = np.zeros(shape, dtype=np.uint8)
    affine = np.eye(4)
    hdr = nib.Nifti1Header()
    hdr.set_data_shape(shape)
    hdr.set_zooms(zooms)

    for field in ["data_type", "db_name", "descrip", "aux_file", "intent_name"]:
        hdr[field] = b""

    if descrip:
        hdr["descrip"] = descrip

    hdr.extensions.clear()
    if with_extension:
        ext = nib.nifti1.Nifti1Extension(code=0, content=b"planted_extension_data")
        hdr.extensions.append(ext)

    img = nib.Nifti1Image(data, affine, hdr)
    nib.save(img, str(path))


def create_synthetic_clean_dataset(target_dir: Path) -> None:
    """Generate a valid, fully de-identified synthetic dataset bundle."""
    target_dir.mkdir(parents=True, exist_ok=True)

    # 1. worklist.csv
    wl = target_dir / "worklist.csv"
    with wl.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["case_id", "patient_id", "class"])
        writer.writerow(["case_001", "patient_001", "bme"])
        writer.writerow(["case_002", "patient_002", "bme"])

    # 2. metadata
    meta = target_dir / "dataset-metadata.json"
    meta.write_text(json.dumps({"title": "Clean Synthetic Dataset", "isPrivate": True}), encoding="utf-8")

    # 3. Case folders and NIfTI volumes
    for cid in ["case_001", "case_002"]:
        cdir = target_dir / cid
        cdir.mkdir(parents=True, exist_ok=True)
        create_synthetic_nii(cdir / f"{cid}_primary.nii.gz")
        create_synthetic_nii(cdir / f"{cid}_labels.nii.gz")


def test_clean_folder_passes():
    """Clean synthetic dataset passes all de-identification and consistency checks."""
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        fake_repo = tmp / "fake_repo"
        fake_repo.mkdir()
        (fake_repo / "data").mkdir()

        export_folder = tmp / "clean_export"
        create_synthetic_clean_dataset(export_folder)

        res = verify_folder(export_folder, src_dir=fake_repo)
        assert res["status"] == "FULL PASS"
        assert res["total_failures"] == 0
        assert res["names"]["bad_filenames"] == 0
        assert res["nifti"]["descrip_non_empty"] == 0
        assert res["worklist"]["valid_rows"] == 2
        assert res["patterns"]["total_forbidden_hits"] == 0
        print("[PASS] test_clean_folder_passes")


def test_planted_bad_filename_fails():
    """Planted unallowed filename triggers failure."""
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        fake_repo = tmp / "fake_repo"
        fake_repo.mkdir()
        (fake_repo / "data").mkdir()

        export_folder = tmp / "bad_name_export"
        create_synthetic_clean_dataset(export_folder)

        # Plant unallowed filename
        planted_file = export_folder / "case_001" / "original_patient_scan.nii.gz"
        planted_file.write_bytes(b"bad")

        res = verify_folder(export_folder, src_dir=fake_repo)
        assert res["status"] == "FAIL"
        assert res["names"]["bad_filenames"] >= 1
        print("[PASS] test_planted_bad_filename_fails")


def test_planted_header_text_fails():
    """Planted non-empty header text (e.g. descrip) triggers failure."""
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        fake_repo = tmp / "fake_repo"
        fake_repo.mkdir()
        (fake_repo / "data").mkdir()

        export_folder = tmp / "bad_header_export"
        create_synthetic_clean_dataset(export_folder)

        # Overwrite case_001_primary with tainted descrip header
        tainted_vol = export_folder / "case_001" / "case_001_primary.nii.gz"
        create_synthetic_nii(tainted_vol, descrip=b"Planted Medical Center DICOM")

        res = verify_folder(export_folder, src_dir=fake_repo)
        assert res["status"] == "FAIL"
        assert res["nifti"]["descrip_non_empty"] >= 1
        print("[PASS] test_planted_header_text_fails")


def test_planted_extension_fails():
    """Planted NIfTI header extension triggers failure."""
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        fake_repo = tmp / "fake_repo"
        fake_repo.mkdir()
        (fake_repo / "data").mkdir()

        export_folder = tmp / "bad_extension_export"
        create_synthetic_clean_dataset(export_folder)

        # Overwrite with header extension
        ext_vol = export_folder / "case_001" / "case_001_primary.nii.gz"
        create_synthetic_nii(ext_vol, with_extension=True)

        res = verify_folder(export_folder, src_dir=fake_repo)
        assert res["status"] == "FAIL"
        assert res["nifti"]["header_extensions_present"] >= 1
        print("[PASS] test_planted_extension_fails")


def test_planted_bme_in_worklist_fails():
    """Planted forbidden identifier pattern (e.g. BME-001) in worklist triggers failure."""
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        fake_repo = tmp / "fake_repo"
        fake_repo.mkdir()
        (fake_repo / "data").mkdir()

        export_folder = tmp / "bad_worklist_export"
        create_synthetic_clean_dataset(export_folder)

        # Overwrite worklist with forbidden identifier
        wl = export_folder / "worklist.csv"
        with wl.open("w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["case_id", "patient_id", "class"])
            writer.writerow(["BME-001", "patient_001", "bme"])

        res = verify_folder(export_folder, src_dir=fake_repo)
        assert res["status"] == "FAIL"
        assert res["worklist"]["bad_rows"] >= 1
        assert res["patterns"]["total_forbidden_hits"] >= 1
        print("[PASS] test_planted_bme_in_worklist_fails")


def test_folder_inside_repo_or_data_refused():
    """Target folder inside repository or inside data/ MUST be strictly rejected."""
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        fake_repo = tmp / "fake_repo"
        fake_repo.mkdir()
        (fake_repo / "data").mkdir()
        inside_repo = fake_repo / "export_sub"
        inside_repo.mkdir()

        try:
            validate_folder_outside_repo_and_data(inside_repo, fake_repo)
            assert False, "Should refuse folder inside repo"
        except ValueError as e:
            assert "strictly outside the repository" in str(e)

        inside_data = fake_repo / "data" / "export_sub"
        inside_data.mkdir()
        try:
            validate_folder_outside_repo_and_data(inside_data, fake_repo)
            assert False, "Should refuse folder inside data/"
        except ValueError as e:
            assert "strictly outside data/" in str(e)

        print("[PASS] test_folder_inside_repo_or_data_refused")


def test_cli_execution_exit_codes():
    """Test CLI exit code 0 on clean dataset and exit code 1 on planted flaw."""
    script_path = repo_root / "ml" / "scripts" / "check_deid_folder.py"

    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        fake_repo = tmp / "fake_repo"
        fake_repo.mkdir()
        (fake_repo / "data").mkdir()

        # 1. Clean folder CLI run -> 0
        clean_folder = tmp / "cli_clean"
        create_synthetic_clean_dataset(clean_folder)

        cmd_clean = [
            sys.executable,
            str(script_path),
            str(clean_folder),
            "--src",
            str(fake_repo),
        ]
        proc_clean = subprocess.run(cmd_clean, capture_output=True, text=True)
        assert proc_clean.returncode == 0, f"Clean folder CLI must exit 0: {proc_clean.stderr}"
        assert "FULL PASS" in proc_clean.stdout

        # 2. Planted bad file CLI run -> non-zero
        bad_folder = tmp / "cli_bad"
        create_synthetic_clean_dataset(bad_folder)
        (bad_folder / "leak.csv").write_text("PatientID,BME-999\n", encoding="utf-8")

        cmd_bad = [
            sys.executable,
            str(script_path),
            str(bad_folder),
            "--src",
            str(fake_repo),
        ]
        proc_bad = subprocess.run(cmd_bad, capture_output=True, text=True)
        assert proc_bad.returncode != 0, "Planted flaw CLI must exit non-zero"
        assert "FAIL" in proc_bad.stdout

        print("[PASS] test_cli_execution_exit_codes")


if __name__ == "__main__":
    print("Running check_deid_folder Test Suite (Synthetic Data Only)...\n")
    test_clean_folder_passes()
    test_planted_bad_filename_fails()
    test_planted_header_text_fails()
    test_planted_extension_fails()
    test_planted_bme_in_worklist_fails()
    test_folder_inside_repo_or_data_refused()
    test_cli_execution_exit_codes()
    print("\n[SUCCESS] ALL check_deid_folder TESTS PASSED!")
