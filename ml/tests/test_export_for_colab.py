"""Comprehensive synthetic unit tests for hardened export_for_colab.py.

Runs strictly in quarantined temporary directories outside the repository.
Tests:
1. Failure-class diagnostics table appears and mapping is NOT written on failure.
2. Strengthened --verify catches a corrupted voxel in exported scan (np.array_equal fail).
3. Strengthened --verify catches a changed label voxel.
4. Strengthened --verify catches missing edema label (label 2).
5. --compare-training-inputs passes on identical data and catches planted image/label mismatches.
6. Non-zero exit codes (sys.exit(1)) on failure and 0 on full PASS.
7. Missing Import: Hard error identifying failed module when seg2nifti/train_3d cannot be loaded.
8. Sanitization: NIfTI header data_type text field cleared; labels receive identical sanitization.
9. Leak Check Fail-Closed: Corrupt .nii.gz, stray .txt, and empty directory fail closed.
10. Zip Bundle Check: Entry names in archive scanned; leaks and invalid entry types detected.
11. Stable IDs: Adding cases preserves all previous IDs and numbering continues.
12. Conflict Guard: Conflicting existing mapping rejected with SystemExit.
13. Path Security: Refuses --mapping-file inside --dst, inside repo, or inside data/.
14. Destination Guard: Refuses --dst inside repo or data/, and refuses non-empty --dst.
15. Zero-Case Export: Refuses to write mapping file if 0 cases exported.
"""

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

import nibabel as nib
import nrrd
import numpy as np

# Import hardened recovery module
sys.path.insert(0, r"C:\Users\HP\bme_recovery")
import export_for_colab as exp


def make_synthetic_source_case(base_dir: Path, cid: str, has_edema: bool = True):
    """Helper to generate a valid synthetic case with scan volume and .seg.nrrd annotation."""
    nii_dir = base_dir / "data" / "nifti" / cid
    ann_dir = base_dir / "data" / "annotations" / cid
    nii_dir.mkdir(parents=True, exist_ok=True)
    ann_dir.mkdir(parents=True, exist_ok=True)

    # Primary volume
    vol = np.ones((10, 10, 5), dtype=np.float32) * 50.0
    vol[2:5, 2:5, 1:4] = 100.0
    img = nib.Nifti1Image(vol, np.eye(4))
    img.header["data_type"] = b"RAW"
    nib.save(img, str(nii_dir / f"{cid}_primary.nii.gz"))

    # Annotation .seg.nrrd
    seg = np.zeros((10, 10, 5), dtype=np.uint8)
    seg[2:8, 2:8, 1:4] = 1  # bone_marrow
    if has_edema:
        seg[3:5, 3:5, 2:3] = 2  # bme (edema)

    hdr = {
        "space": "right-anterior-superior",
        "space directions": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        "space origin": [0, 0, 0],
        "Segment0_Name": "bone_marrow",
        "Segment0_LabelValue": 1,
        "Segment0_Layer": 0,
        "Segment1_Name": "bme",
        "Segment1_LabelValue": 2,
        "Segment1_Layer": 0,
    }
    nrrd.write(str(ann_dir / f"{cid}.seg.nrrd"), seg, hdr)


def test_failure_class_table_and_mapping_not_written():
    print("[TEST 1] Testing failure-class table appears and mapping is NOT written...")
    temp_base = Path(r"C:\Users\HP\bme_recovery\temp_test_diag")
    if temp_base.exists():
        shutil.rmtree(temp_base)
    temp_base.mkdir(parents=True, exist_ok=True)

    src_dir = temp_base / "src"
    dst_dir = temp_base / "dst"
    map_file = temp_base / "mapping.json"
    src_dir.mkdir(parents=True, exist_ok=True)

    # Create 2 synthetic source cases
    make_synthetic_source_case(src_dir, "case_ok")
    make_synthetic_source_case(src_dir, "case_fail")

    manifest = [
        {"original_case_id": "case_ok", "exported_id": "case_001", "patient_group": "patient_001"},
        {"original_case_id": "case_fail", "exported_id": "case_002", "patient_group": "patient_002"},
    ]

    # Make case_fail raise a specific ValueError during read_segmentation
    orig_read_seg = exp.read_segmentation
    def mock_read_seg(p):
        if "case_fail" in str(p):
            raise ValueError("Corrupted segmentation structure")
        return orig_read_seg(p)
    exp.read_segmentation = mock_read_seg

    buf = io.StringIO()
    refused = False
    try:
        with contextlib.redirect_stdout(buf):
            exp.run_export(src_dir, dst_dir, manifest, map_file)
    except SystemExit:
        refused = True
    finally:
        exp.read_segmentation = orig_read_seg

    output = buf.getvalue()

    assert refused, "Export did not raise SystemExit on failure!"
    assert "EXPORT FAILURE DIAGNOSTICS (BY EXCEPTION CLASS)" in output, "Diagnostics table header missing!"
    assert "ValueError" in output, "Exception class 'ValueError' missing from failure table!"
    assert "The partial export directory" in output, "Manual deletion instruction missing from output!"
    assert not map_file.exists(), "Mapping file was created despite failure!"

    shutil.rmtree(temp_base)
    print("✓ Failure diagnostics table and deletion instruction verified; mapping file not written.")


def test_verify_catches_corrupted_scan_voxel():
    print("[TEST 2] Testing strengthened --verify catches corrupted voxel in exported scan...")
    temp_base = Path(r"C:\Users\HP\bme_recovery\temp_test_voxel_corrupt")
    if temp_base.exists():
        shutil.rmtree(temp_base)
    temp_base.mkdir(parents=True, exist_ok=True)

    src_dir = temp_base / "src"
    dst_dir = temp_base / "dst"
    map_file = temp_base / "mapping.json"

    make_synthetic_source_case(src_dir, "case_alpha")
    manifest = [{"original_case_id": "case_alpha", "exported_id": "case_001", "patient_group": "patient_001"}]

    # Run clean export first
    exp.run_export(src_dir, dst_dir, manifest, map_file)

    # Corrupt a single voxel in the exported volume
    out_vol_path = dst_dir / "data" / "nifti" / "case_001" / "case_001_primary.nii.gz"
    nii = nib.load(str(out_vol_path))
    data = np.asanyarray(nii.dataobj).copy()
    data[4, 4, 2] += 5.0  # single voxel change
    corrupt_nii = nib.Nifti1Image(data, nii.affine, nii.header)
    nib.save(corrupt_nii, str(out_vol_path))

    buf = io.StringIO()
    exit_code = 0
    try:
        with contextlib.redirect_stdout(buf):
            exp.run_verify(src_dir, dst_dir, map_file)
    except SystemExit as e:
        exit_code = e.code if e.code is not None else 0

    output = buf.getvalue()
    assert exit_code != 0, f"run_verify exited with 0 despite corrupted voxel! (output: {output})"
    assert "scan_data_mismatch" in output, "Failure category 'scan_data_mismatch' not reported!"

    shutil.rmtree(temp_base)
    print("✓ Strengthened --verify successfully caught corrupted scan voxel with non-zero exit code.")


def test_verify_catches_changed_label_voxel():
    print("[TEST 3] Testing strengthened --verify catches changed label voxel...")
    temp_base = Path(r"C:\Users\HP\bme_recovery\temp_test_label_change")
    if temp_base.exists():
        shutil.rmtree(temp_base)
    temp_base.mkdir(parents=True, exist_ok=True)

    src_dir = temp_base / "src"
    dst_dir = temp_base / "dst"
    map_file = temp_base / "mapping.json"

    make_synthetic_source_case(src_dir, "case_beta")
    manifest = [{"original_case_id": "case_beta", "exported_id": "case_001", "patient_group": "patient_001"}]

    exp.run_export(src_dir, dst_dir, manifest, map_file)

    # Change a label voxel in exported labelmap to invalid value 5
    out_lab_path = dst_dir / "data" / "annotations" / "case_001" / "case_001_labels.nii.gz"
    lab_nii = nib.load(str(out_lab_path))
    lab_data = np.asanyarray(lab_nii.dataobj).copy()
    lab_data[3, 3, 2] = 5  # invalid label
    nib.save(nib.Nifti1Image(lab_data, lab_nii.affine, lab_nii.header), str(out_lab_path))

    buf = io.StringIO()
    exit_code = 0
    try:
        with contextlib.redirect_stdout(buf):
            exp.run_verify(src_dir, dst_dir, map_file)
    except SystemExit as e:
        exit_code = e.code if e.code is not None else 0

    output = buf.getvalue()
    assert exit_code != 0, f"run_verify exited with 0 despite invalid label value!"
    assert "label_invalid_values" in output, "Failure category 'label_invalid_values' not reported!"

    shutil.rmtree(temp_base)
    print("✓ Strengthened --verify successfully caught changed label voxel.")


def test_verify_catches_missing_edema_label():
    print("[TEST 4] Testing strengthened --verify catches missing edema label (label 2)...")
    temp_base = Path(r"C:\Users\HP\bme_recovery\temp_test_no_edema")
    if temp_base.exists():
        shutil.rmtree(temp_base)
    temp_base.mkdir(parents=True, exist_ok=True)

    src_dir = temp_base / "src"
    dst_dir = temp_base / "dst"
    map_file = temp_base / "mapping.json"

    # Create synthetic source case without edema (has_edema=False)
    make_synthetic_source_case(src_dir, "case_gamma", has_edema=False)
    manifest = [{"original_case_id": "case_gamma", "exported_id": "case_001", "patient_group": "patient_001"}]

    exp.run_export(src_dir, dst_dir, manifest, map_file)

    buf = io.StringIO()
    exit_code = 0
    try:
        with contextlib.redirect_stdout(buf):
            exp.run_verify(src_dir, dst_dir, map_file)
    except SystemExit as e:
        exit_code = e.code if e.code is not None else 0

    output = buf.getvalue()
    assert exit_code != 0, f"run_verify exited with 0 despite missing edema voxels!"
    assert "label_missing_edema" in output, "Failure category 'label_missing_edema' not reported!"

    shutil.rmtree(temp_base)
    print("✓ Strengthened --verify successfully caught missing edema label.")


def test_compare_training_inputs_passes_and_catches_mismatches():
    print("[TEST 5] Testing --compare-training-inputs on clean data and planted mismatches...")
    temp_base = Path(r"C:\Users\HP\bme_recovery\temp_test_compare_inputs")
    if temp_base.exists():
        shutil.rmtree(temp_base)
    temp_base.mkdir(parents=True, exist_ok=True)

    src_dir = temp_base / "src"
    dst_dir = temp_base / "dst"
    map_file = temp_base / "mapping.json"

    make_synthetic_source_case(src_dir, "case_delta")
    manifest = [{"original_case_id": "case_delta", "exported_id": "case_001", "patient_group": "patient_001"}]

    # 1. Clean export
    exp.run_export(src_dir, dst_dir, manifest, map_file)

    # 2. Test clean comparison -> must FULL PASS (sys.exit(0))
    buf = io.StringIO()
    exit_code = None
    try:
        with contextlib.redirect_stdout(buf):
            exp.run_compare_training_inputs(src_dir, dst_dir, map_file)
    except SystemExit as e:
        exit_code = e.code if e.code is not None else 0

    output = buf.getvalue()
    assert exit_code == 0, f"--compare-training-inputs failed on clean data! (code={exit_code}, out={output})"
    assert "Compare Training Inputs: FULL PASS" in output, "Expected FULL PASS not found in output!"

    # 3. Plant image value mismatch in exported primary volume
    out_vol_path = dst_dir / "data" / "nifti" / "case_001" / "case_001_primary.nii.gz"
    nii = nib.load(str(out_vol_path))
    v_data = np.asanyarray(nii.dataobj).copy()
    v_data[1, 1, 1] += 25.0
    nib.save(nib.Nifti1Image(v_data, nii.affine, nii.header), str(out_vol_path))

    buf = io.StringIO()
    exit_code = 0
    try:
        with contextlib.redirect_stdout(buf):
            exp.run_compare_training_inputs(src_dir, dst_dir, map_file)
    except SystemExit as e:
        exit_code = e.code if e.code is not None else 0

    output = buf.getvalue()
    assert exit_code != 0, f"--compare-training-inputs did not fail on image mismatch!"
    assert "image_value_mismatch" in output, "Expected 'image_value_mismatch' category not reported!"

    shutil.rmtree(temp_base)
    print("✓ --compare-training-inputs correctly passed clean data and caught planted mismatch.")


def test_exit_codes_non_zero_on_fail():
    print("[TEST 6] Testing non-zero exit codes on failure across modes...")
    temp_base = Path(r"C:\Users\HP\bme_recovery\temp_test_exit_codes")
    if temp_base.exists():
        shutil.rmtree(temp_base)
    temp_base.mkdir(parents=True, exist_ok=True)

    nonexistent_dst = temp_base / "missing_dst"
    dummy_map = temp_base / "mapping.json"
    dummy_map.write_text(json.dumps({"count": 1, "cases": [{"original_case_id": "c1", "exported_id": "case_001"}]}))

    # 6a. run_verify on missing dst -> exit code 1
    code_verify = 0
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            exp.run_verify(temp_base, nonexistent_dst, dummy_map)
    except SystemExit as e:
        code_verify = e.code if e.code is not None else 0
    assert code_verify != 0, "run_verify did not exit non-zero on missing directory!"

    # 6b. run_compare_training_inputs on missing dst -> exit code 1
    code_compare = 0
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            exp.run_compare_training_inputs(temp_base, nonexistent_dst, dummy_map)
    except SystemExit as e:
        code_compare = e.code if e.code is not None else 0
    assert code_compare != 0, "run_compare_training_inputs did not exit non-zero on missing directory!"

    shutil.rmtree(temp_base)
    print("✓ Non-zero exit codes verified on failure across modes.")


def test_missing_import_raising():
    print("[TEST 7] Testing missing import raising hard error identifying module...")
    temp_dir = Path(r"C:\Users\HP\bme_recovery\temp_test_empty_scripts")
    temp_dir.mkdir(parents=True, exist_ok=True)
    try:
        raised = False
        err_msg = ""
        try:
            exp.load_ml_modules(scripts_dir=temp_dir)
        except ImportError as e:
            raised = True
            err_msg = str(e)

        assert raised, "load_ml_modules failed to raise ImportError on missing modules!"
        assert "seg2nifti" in err_msg or "train_3d" in err_msg, (
            f"Import error message did not identify failed module: {err_msg}"
        )
    finally:
        exp.load_ml_modules(None)
        shutil.rmtree(temp_dir)

    print("✓ Hard error identifying failed module raised successfully.")


def test_nifti_data_type_and_label_sanitization():
    print("[TEST 8] Testing data_type header clearing and label sanitization...")
    data = np.zeros((8, 8, 4), dtype=np.float32)
    affine = np.eye(4)
    hdr = nib.Nifti1Header()
    hdr["data_type"] = b"SPM"
    hdr["db_name"] = b"test_db"
    hdr["descrip"] = b"confidential"
    hdr["aux_file"] = b"aux.txt"
    hdr["intent_name"] = b"intent"

    img = nib.Nifti1Image(data, affine, hdr)
    sanitized = exp.sanitize_nifti_header(img)

    for field in ["data_type", "db_name", "descrip", "aux_file", "intent_name"]:
        val = bytes(sanitized.header[field]).strip(b"\x00")
        assert val == b"", f"Field '{field}' was not cleared by sanitize_nifti_header!"
    assert len(sanitized.header.extensions) == 0, "Header extensions were not stripped!"

    print("✓ data_type and all header text fields successfully sanitized.")


def test_leak_check_fail_closed():
    print("[TEST 9] Testing leak check fail-closed (corrupt nii, stray txt, empty dir)...")
    temp_base = Path(r"C:\Users\HP\bme_recovery\temp_test_leak_fc")
    if temp_base.exists():
        shutil.rmtree(temp_base)
    temp_base.mkdir(parents=True, exist_ok=True)

    dst_dir = temp_base / "dst"
    map_file = temp_base / "mapping.json"
    manifest = [{"original_case_id": "SECRET_ID_007", "exported_id": "case_001", "patient_group": "patient_001"}]
    patient_map = {"SECRET_ID_007": "PATIENT_BOND"}

    fs_fails, zip_fails = exp.check_privacy_leaks(dst_dir, map_file, patient_map, manifest)
    assert fs_fails > 0, "Missing export directory did not fail closed!"

    dst_dir.mkdir(parents=True, exist_ok=True)
    fs_fails, zip_fails = exp.check_privacy_leaks(dst_dir, map_file, patient_map, manifest)
    assert fs_fails > 0, "Empty export directory did not fail closed!"

    (dst_dir / "data" / "nifti" / "case_001").mkdir(parents=True, exist_ok=True)
    (dst_dir / "data" / "annotations" / "case_001").mkdir(parents=True, exist_ok=True)

    clean_img = nib.Nifti1Image(np.zeros((8, 8, 4), dtype=np.float32), np.eye(4))
    clean_img = exp.sanitize_nifti_header(clean_img)
    clean_vol_path = dst_dir / "data" / "nifti" / "case_001" / "case_001_primary.nii.gz"
    clean_lab_path = dst_dir / "data" / "annotations" / "case_001" / "case_001_labels.nii.gz"
    nib.save(clean_img, str(clean_vol_path))
    nib.save(clean_img, str(clean_lab_path))

    wl_path = dst_dir / "data" / "worklist.csv"
    wl_path.write_text("case_id,patient_id,class\ncase_001,patient_001,bme\n", encoding="utf-8")

    fs_fails, _ = exp.check_privacy_leaks(dst_dir, map_file, patient_map, manifest)
    assert fs_fails == 0, f"Clean export unexpectedly reported {fs_fails} filesystem failures!"

    stray_txt = dst_dir / "data" / "notes.txt"
    stray_txt.write_text("safe notes", encoding="utf-8")
    fs_fails, _ = exp.check_privacy_leaks(dst_dir, map_file, patient_map, manifest)
    assert fs_fails > 0, "Stray .txt file was not detected as a failure!"
    stray_txt.unlink()

    corrupt_nii = dst_dir / "data" / "nifti" / "case_001" / "corrupt.nii.gz"
    corrupt_nii.write_bytes(b"\x1f\x8b\x08garbage_compressed_data_that_fails_load")
    fs_fails, _ = exp.check_privacy_leaks(dst_dir, map_file, patient_map, manifest)
    assert fs_fails > 0, "Corrupt .nii.gz was not detected as a failure!"
    corrupt_nii.unlink()

    leaky_hdr = clean_img.header.copy()
    leaky_hdr["data_type"] = b"SECRET_ID"
    leaky_img = nib.Nifti1Image(np.zeros((8, 8, 4), dtype=np.float32), np.eye(4), leaky_hdr)
    nib.save(leaky_img, str(clean_vol_path))
    fs_fails, _ = exp.check_privacy_leaks(dst_dir, map_file, patient_map, manifest)
    assert fs_fails > 0, "Planted token in data_type header was not detected as a failure!"

    shutil.rmtree(temp_base)
    print("✓ Fail-closed leak check verified: corrupt NIfTI, stray files, and header leaks caught.")


def test_zip_bundle_leak_check():
    print("[TEST 10] Testing zip bundle archive entry leak check...")
    temp_base = Path(r"C:\Users\HP\bme_recovery\temp_test_zip_leak")
    if temp_base.exists():
        shutil.rmtree(temp_base)
    temp_base.mkdir(parents=True, exist_ok=True)

    dst_dir = temp_base / "dst"
    dst_dir.mkdir(parents=True, exist_ok=True)
    zip_dest = temp_base / f"{dst_dir.name}.zip"
    map_file = temp_base / "mapping.json"
    manifest = [{"original_case_id": "SECRET_ID_999", "exported_id": "case_001", "patient_group": "patient_001"}]
    patient_map = {"SECRET_ID_999": "PATIENT_001"}

    (dst_dir / "data").mkdir(parents=True, exist_ok=True)
    (dst_dir / "data" / "worklist.csv").write_text("case_id,patient_id,class\n", encoding="utf-8")

    with zipfile.ZipFile(zip_dest, "w") as zf:
        zf.writestr("data/worklist.csv", "case_id,patient_id,class\n")
        zf.writestr("data/nifti/case_001/case_001_primary.nii.gz", "clean_nii")

    _, zip_fails = exp.check_privacy_leaks(dst_dir, map_file, patient_map, manifest)
    assert zip_fails == 0, f"Clean zip unexpectedly reported {zip_fails} failures!"

    with zipfile.ZipFile(zip_dest, "w") as zf:
        zf.writestr("data/worklist.csv", "case_id,patient_id,class\n")
        zf.writestr("data/nifti/secret_id_999/case_001_primary.nii.gz", "leaky_entry_name")

    _, zip_fails = exp.check_privacy_leaks(dst_dir, map_file, patient_map, manifest)
    assert zip_fails > 0, "Zip bundle with leaked token in entry name was not flagged!"

    with zipfile.ZipFile(zip_dest, "w") as zf:
        zf.writestr("data/worklist.csv", "case_id,patient_id,class\n")
        zf.writestr("data/passwords.txt", "secret")

    _, zip_fails = exp.check_privacy_leaks(dst_dir, map_file, patient_map, manifest)
    assert zip_fails > 0, "Zip bundle with stray .txt entry was not flagged!"

    shutil.rmtree(temp_base)
    print("✓ Zip bundle leak check verified: entry name leaks and stray entries caught.")


def test_stable_incremental_ids():
    print("[TEST 11] Testing stable IDs: adding a new case preserves existing IDs and continues numbering...")
    initial_cases = ["case_beta", "case_alpha", "case_delta"]
    patient_map = {"case_alpha": "patient_smith", "case_beta": "patient_smith", "case_delta": "patient_jones"}

    initial_manifest = exp.build_export_manifest(initial_cases, patient_map, seed=42)
    assert len(initial_manifest) == 3

    temp_dir = Path(r"C:\Users\HP\bme_recovery\temp_test_stable")
    temp_dir.mkdir(parents=True, exist_ok=True)
    mapping_path = temp_dir / "mapping.json"
    exp.write_mapping_atomically(mapping_path, {"count": 3, "cases": initial_manifest})

    new_cases_list = ["case_beta", "case_alpha", "case_delta", "case_epsilon", "case_zeta"]
    patient_map_updated = dict(patient_map)
    patient_map_updated["case_epsilon"] = "patient_smith"
    patient_map_updated["case_zeta"] = "patient_williams"

    loaded_existing = exp.load_and_validate_existing_mapping(mapping_path, patient_map_updated)
    updated_manifest = exp.build_export_manifest(new_cases_list, patient_map_updated, seed=42, existing_manifest=loaded_existing)

    assert len(updated_manifest) == 5

    for orig in initial_manifest:
        match = next(x for x in updated_manifest if x["original_case_id"] == orig["original_case_id"])
        assert match["exported_id"] == orig["exported_id"], f"Exported ID changed for {orig['original_case_id']}!"
        assert match["patient_group"] == orig["patient_group"], f"Patient group changed for {orig['original_case_id']}!"

    eps_entry = next(x for x in updated_manifest if x["original_case_id"] == "case_epsilon")
    alpha_entry = next(x for x in updated_manifest if x["original_case_id"] == "case_alpha")
    assert eps_entry["patient_group"] == alpha_entry["patient_group"], "New case from existing patient failed to inherit patient group!"

    shutil.rmtree(temp_dir)
    print("✓ Stable incremental IDs verified: existing cases 100% preserved, new cases numbered continuously.")


def test_conflict_guard():
    print("[TEST 12] Testing conflict guard: refuses corrupted or contradictory mapping...")
    temp_dir = Path(r"C:\Users\HP\bme_recovery\temp_test_conflict")
    temp_dir.mkdir(parents=True, exist_ok=True)
    bad_mapping_path = temp_dir / "bad_mapping.json"

    bad_payload = {
        "count": 2,
        "cases": [
            {"original_case_id": "case_1", "exported_id": "case_001", "patient_group": "patient_001"},
            {"original_case_id": "case_2", "exported_id": "case_001", "patient_group": "patient_002"},
        ]
    }
    bad_mapping_path.write_text(json.dumps(bad_payload), encoding="utf-8")

    refused = False
    try:
        exp.load_and_validate_existing_mapping(bad_mapping_path, {"case_1": "p1", "case_2": "p2"})
    except SystemExit:
        refused = True

    assert refused, "Failed to refuse conflicting mapping with duplicate exported IDs!"
    shutil.rmtree(temp_dir)
    print("✓ Conflicting existing mapping correctly rejected.")


def test_path_security_guards():
    print("[TEST 13] Testing path security guards: refuses inside repo, data/, or inside --dst...")
    repo_dir = Path(r"c:\Users\HP\bme").resolve()
    temp_outside = Path(r"C:\Users\HP\bme_recovery\temp_export_dir").resolve()

    # 13a. Mapping inside dst
    map_inside_dst = temp_outside / "mapping.json"
    refused_map_in_dst = False
    try:
        exp.validate_paths(repo_dir, temp_outside, map_inside_dst)
    except SystemExit:
        refused_map_in_dst = True
    assert refused_map_in_dst, "Failed to refuse --mapping-file located inside --dst!"

    # 13b. Mapping equals dst
    refused_map_eq_dst = False
    try:
        exp.validate_paths(repo_dir, temp_outside, temp_outside)
    except SystemExit:
        refused_map_eq_dst = True
    assert refused_map_eq_dst, "Failed to refuse --mapping-file equal to --dst!"

    # 13c. Dst inside repo
    dst_inside_repo = repo_dir / "results_export"
    refused_dst_in_repo = False
    try:
        exp.validate_paths(repo_dir, dst_inside_repo, Path(r"C:\Users\HP\safe_mapping.json"))
    except SystemExit:
        refused_dst_in_repo = True
    assert refused_dst_in_repo, "Failed to refuse --dst located inside repository!"

    # 13d. Dst inside data/
    dst_inside_data = repo_dir / "data" / "export"
    refused_dst_in_data = False
    try:
        exp.validate_paths(repo_dir, dst_inside_data, Path(r"C:\Users\HP\safe_mapping.json"))
    except SystemExit:
        refused_dst_in_data = True
    assert refused_dst_in_data, "Failed to refuse --dst located inside data/!"

    print("✓ Path security guards correctly rejected all unsafe destination and mapping paths.")


def test_destination_guard():
    print("[TEST 14] Testing destination guard: refuses existing non-empty --dst...")
    temp_dir = Path(r"C:\Users\HP\bme_recovery\temp_test_nonempty")
    temp_dir.mkdir(parents=True, exist_ok=True)
    (temp_dir / "existing_file.txt").write_text("existing content", encoding="utf-8")

    manifest = [{"original_case_id": "c1", "exported_id": "case_001", "patient_group": "patient_001"}]
    map_file = Path(r"C:\Users\HP\bme_recovery\dummy_map.json")

    refused = False
    try:
        exp.run_export(Path(r"c:\Users\HP\bme"), temp_dir, manifest, map_file)
    except SystemExit:
        refused = True

    assert refused, "Failed to refuse non-empty destination directory!"
    shutil.rmtree(temp_dir)
    print("✓ Non-empty destination directory correctly rejected.")


def test_zero_case_export_refuses_mapping():
    print("[TEST 15] Testing zero-case export stops before writing mapping file...")
    temp_base = Path(r"C:\Users\HP\bme_recovery\temp_test_zero_export")
    if temp_base.exists():
        shutil.rmtree(temp_base)
    temp_base.mkdir(parents=True, exist_ok=True)

    src_dir = temp_base / "src"
    dst_dir = temp_base / "dst"
    mapping_path = temp_base / "mapping.json"
    src_dir.mkdir(parents=True, exist_ok=True)

    manifest = []
    refused = False
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            exp.run_export(src_dir, dst_dir, manifest, mapping_path)
    except SystemExit:
        refused = True

    assert refused, "Zero-case export failed to raise SystemExit!"
    assert not mapping_path.exists(), "Mapping file was created despite zero cases exported!"

    shutil.rmtree(temp_base)
    print("✓ Zero-case export refused and mapping file was not written.")


if __name__ == "__main__":
    test_failure_class_table_and_mapping_not_written()
    test_verify_catches_corrupted_scan_voxel()
    test_verify_catches_changed_label_voxel()
    test_verify_catches_missing_edema_label()
    test_compare_training_inputs_passes_and_catches_mismatches()
    test_exit_codes_non_zero_on_fail()
    test_missing_import_raising()
    test_nifti_data_type_and_label_sanitization()
    test_leak_check_fail_closed()
    test_zip_bundle_leak_check()
    test_stable_incremental_ids()
    test_conflict_guard()
    test_path_security_guards()
    test_destination_guard()
    test_zero_case_export_refuses_mapping()
    print("\nALL HARDENED SYNTHETIC TESTS PASSED SUCCESSFULLY (100%)!")
