"""Tests for Kaggle Cloud GPU Pipeline safeguards and integrity.

Mocked KaggleApi client tests (zero network calls, zero credential reading).
Covers:
1. Preflight refuses on a failing verify
2. Upload refuses without --confirm-upload
3. Mapping file or extra files are never included in the upload file list
4. Dataset creation is always called with private visibility (public=False, isPrivate=True)
5. Staging directory inside repository or data/ is refused
6. Import runs through verify_and_import_weights and never writes outside data/results3d
7. No credential string ever appears in any log line (planted fake key test)
"""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

repo_root = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(repo_root / "ml" / "scripts"))

from kaggle_pipeline import (
    check_no_in_repo_kaggle_credentials,
    check_no_mapping_leak,
    get_staging_dir,
    run_download,
    run_import,
    run_launch,
    run_preflight,
    run_upload,
    validate_path_outside_repo_and_data,
)


class MockKaggleDataset:
    def __init__(self, ref: str):
        self.ref = ref


class MockKaggleApi:
    """Mock Kaggle client recording calls and preventing any network activity."""

    def __init__(self, username="test_researcher", existing_datasets=None):
        self.username = username
        self.config_values = {"username": username}
        self._existing_datasets = [MockKaggleDataset(d) for d in (existing_datasets or [])]
        self.create_new_calls = []
        self.create_version_calls = []
        self.kernels_push_calls = []
        self.kernels_status_calls = []
        self.kernels_output_calls = []

    def authenticate(self):
        return True

    def dataset_list(self, user=None):
        return self._existing_datasets

    def dataset_create_new(self, folder, public=False, dir_mode="skip", quiet=False):
        meta_file = Path(folder) / "dataset-metadata.json"
        meta = json.loads(meta_file.read_text(encoding="utf-8")) if meta_file.exists() else {}
        self.create_new_calls.append({
            "folder": folder,
            "public": public,
            "metadata": meta,
            "files": [p.name for p in Path(folder).rglob("*") if p.is_file()],
        })
        return MagicMock()

    def dataset_create_version(self, folder, version_notes, dir_mode="skip", quiet=False):
        meta_file = Path(folder) / "dataset-metadata.json"
        meta = json.loads(meta_file.read_text(encoding="utf-8")) if meta_file.exists() else {}
        self.create_version_calls.append({
            "folder": folder,
            "version_notes": version_notes,
            "metadata": meta,
            "files": [p.name for p in Path(folder).rglob("*") if p.is_file()],
        })
        return MagicMock()

    def kernels_push(self, folder):
        meta_file = Path(folder) / "kernel-metadata.json"
        meta = json.loads(meta_file.read_text(encoding="utf-8")) if meta_file.exists() else {}
        self.kernels_push_calls.append({
            "folder": folder,
            "metadata": meta,
            "files": [p.name for p in Path(folder).iterdir() if p.is_file()],
        })
        return MagicMock()

    def kernels_status(self, kernel):
        self.kernels_status_calls.append(kernel)
        res = MagicMock()
        res.status = "COMPLETE"
        res.failure_message = None
        return res

    def kernels_output(self, kernel, path):
        self.kernels_output_calls.append({"kernel": kernel, "path": path})
        out_dir = Path(path)
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "metrics.json").write_text('{"summary": {}}', encoding="utf-8")
        return [str(out_dir / "metrics.json")], ""


def make_isolated_env(tmp_path: Path):
    fake_repo = tmp_path / "fake_repo"
    fake_repo.mkdir(parents=True, exist_ok=True)
    (fake_repo / "data" / "results3d").mkdir(parents=True, exist_ok=True)
    (fake_repo / "ml" / "scripts").mkdir(parents=True, exist_ok=True)
    (fake_repo / "ml" / "notebooks").mkdir(parents=True, exist_ok=True)
    (fake_repo / "ml" / "scripts" / "export_for_colab.py").write_text("# export script", encoding="utf-8")
    (fake_repo / "ml" / "scripts" / "verify_and_import_weights.py").write_text("# verify script", encoding="utf-8")
    (fake_repo / "ml" / "notebooks" / "train_3d_colab.ipynb").write_text(
        json.dumps({"cells": [{"cell_type": "code", "source": ['CONFIG_MODE = "quick_test"\n']}]}),
        encoding="utf-8",
    )

    export_dir = tmp_path / "export_dst"
    export_dir.mkdir(parents=True, exist_ok=True)
    mapping_file = tmp_path / "export_mapping.json"
    mapping_file.write_text(json.dumps({"count": 1, "cases": []}), encoding="utf-8")

    nii_dir = export_dir / "case_001"
    nii_dir.mkdir(parents=True, exist_ok=True)
    (nii_dir / "case_001_primary.nii.gz").write_bytes(b"dummy_nii")
    (export_dir / "worklist.csv").write_text("case_id,patient_id,class\ncase_001,P1,bme\n", encoding="utf-8")

    return {
        "export_dir": export_dir,
        "mapping_file": mapping_file,
        "fake_repo": fake_repo,
    }


def test_staging_dir_inside_repo_or_data_refused():
    """Staging directory inside repo or inside data/ MUST be strictly refused."""
    with tempfile.TemporaryDirectory() as tmp_str:
        fake_repo = Path(tmp_str) / "fake_repo"
        fake_repo.mkdir()
        (fake_repo / "data").mkdir()

        try:
            validate_path_outside_repo_and_data(fake_repo / "staging", fake_repo)
            assert False, "Should have raised ValueError for staging inside repo"
        except ValueError as e:
            assert "strictly outside the repository" in str(e)

        try:
            validate_path_outside_repo_and_data(fake_repo / "data" / "staging", fake_repo)
            assert False, "Should have raised ValueError for staging inside data/"
        except ValueError as e:
            assert "strictly outside data/" in str(e)

        outside = Path(tmp_str) / "bme_test_staging"
        res = validate_path_outside_repo_and_data(outside, fake_repo)
        assert res == outside.resolve()
        print("[PASS] test_staging_dir_inside_repo_or_data_refused")


def test_preflight_refuses_on_mapping_leak():
    """Preflight refuses if mapping file is inside export directory or inside a zip."""
    with tempfile.TemporaryDirectory() as tmp_str:
        env = make_isolated_env(Path(tmp_str))
        export_dir = env["export_dir"]
        mapping_file = env["mapping_file"]

        # 1. Direct file leak
        leaked_mapping = export_dir / "export_mapping.json"
        leaked_mapping.write_text("{}", encoding="utf-8")
        try:
            check_no_mapping_leak(export_dir, mapping_file)
            assert False, "Should have detected mapping file leak"
        except ValueError as e:
            assert "Prohibited mapping file found" in str(e)
        leaked_mapping.unlink()

        # 2. Leaked entry inside zip
        leaked_zip = export_dir / "bundle.zip"
        with zipfile.ZipFile(leaked_zip, "w") as zf:
            zf.writestr("export_mapping.json", "{}")
        try:
            check_no_mapping_leak(export_dir, mapping_file)
            assert False, "Should have detected zip mapping entry leak"
        except ValueError as e:
            assert "Prohibited mapping entry inside zip" in str(e)
        leaked_zip.unlink()

        print("[PASS] test_preflight_refuses_on_mapping_leak")


def test_preflight_refuses_failing_verify():
    """Preflight raises RuntimeError if export_for_colab.py --verify does not pass."""
    with tempfile.TemporaryDirectory() as tmp_str:
        env = make_isolated_env(Path(tmp_str))
        export_dir = env["export_dir"]
        mapping_file = env["mapping_file"]
        fake_repo = env["fake_repo"]

        with patch("subprocess.run") as mock_run:
            mock_run.return_value = subprocess.CompletedProcess(
                args=[], returncode=1, stdout="Integrity check failed: corrupt files", stderr="Error"
            )
            try:
                run_preflight(fake_repo, export_dir, mapping_file)
                assert False, "Should have raised RuntimeError for failing verify"
            except RuntimeError as e:
                assert "Preflight verification failed" in str(e)

        print("[PASS] test_preflight_refuses_failing_verify")


def test_upload_refuses_without_confirm_upload():
    """Upload refuses unless explicit --confirm-upload flag is passed."""
    with tempfile.TemporaryDirectory() as tmp_str:
        env = make_isolated_env(Path(tmp_str))
        export_dir = env["export_dir"]
        mapping_file = env["mapping_file"]
        fake_repo = env["fake_repo"]
        mock_api = MockKaggleApi()

        try:
            run_upload(
                src_dir=fake_repo,
                export_dir=export_dir,
                mapping_file=mapping_file,
                confirm_upload=False,
                dataset_slug="bme-3d-dataset",
                api=mock_api,
            )
            assert False, "Should have raised ValueError when --confirm-upload is False"
        except ValueError as e:
            assert "--confirm-upload" in str(e)

        print("[PASS] test_upload_refuses_without_confirm_upload")


def test_dataset_creation_always_private_and_excludes_mapping():
    """Dataset creation must specify public=False, isPrivate=True, and exclude mapping files and zip archives."""
    with tempfile.TemporaryDirectory() as tmp_str:
        env = make_isolated_env(Path(tmp_str))
        export_dir = env["export_dir"]
        mapping_file = env["mapping_file"]
        fake_repo = env["fake_repo"]
        mock_api = MockKaggleApi()

        # Place a zip file NEXT to the export directory (e.g. export_dst.zip)
        zip_next_to_export = export_dir.parent / f"{export_dir.name}.zip"
        zip_next_to_export.write_bytes(b"PK fake zip content next to export")

        # Place a zip file INSIDE the export directory
        zip_inside_export = export_dir / "extra_stray.zip"
        zip_inside_export.write_bytes(b"PK fake zip content inside export")

        with patch("kaggle_pipeline.run_preflight") as mock_pf:
            mock_pf.return_value = {
                "cases": 1,
                "files": 2,
                "size_mb": 0.1,
                "combined_sha256": "abc123sha",
            }
            res = run_upload(
                src_dir=fake_repo,
                export_dir=export_dir,
                mapping_file=mapping_file,
                confirm_upload=True,
                dataset_slug="bme-3d-dataset",
                api=mock_api,
            )

            assert res["status"] == "UPLOAD_SUCCESS"
            assert len(mock_api.create_new_calls) == 1
            call = mock_api.create_new_calls[0]

            assert call["public"] is False, "dataset_create_new must be called with public=False"
            assert call["metadata"]["isPrivate"] is True, "dataset metadata must have isPrivate=True"

            uploaded_files = [f.lower() for f in call["files"]]
            assert not any("mapping" in f for f in uploaded_files), "No mapping files allowed in upload"
            assert not any(f.endswith(".zip") for f in uploaded_files), "Zip files must NEVER be uploaded!"
            assert "dataset-metadata.json" in uploaded_files, "Staged dataset-metadata.json must be present in staging upload"

        print("[PASS] test_dataset_creation_always_private_and_excludes_mapping")


def test_launch_requires_confirm_and_sets_private_gpu():
    """Launch requires --confirm-launch, supports modes/folds, and pushes kernel with GPU, Internet, and Private flags."""
    with tempfile.TemporaryDirectory() as tmp_str:
        env = make_isolated_env(Path(tmp_str))
        fake_repo = env["fake_repo"]
        mock_api = MockKaggleApi()

        try:
            run_launch(
                src_dir=fake_repo,
                confirm_launch=False,
                mode="quick",
                dataset_slug="bme-3d-dataset",
                kernel_slug="bme-3d-unet-training",
                api=mock_api,
            )
            assert False, "Should have raised ValueError when --confirm-launch is False"
        except ValueError as e:
            assert "--confirm-launch" in str(e)

        # Test default mode (quick)
        res = run_launch(
            src_dir=fake_repo,
            confirm_launch=True,
            mode="quick",
            dataset_slug="bme-3d-dataset",
            kernel_slug="bme-3d-unet-training",
            api=mock_api,
        )

        assert res["status"] == "LAUNCH_SUCCESS"
        assert res["mode"] == "quick"
        assert res["config_mode"] == "quick_test"
        assert len(mock_api.kernels_push_calls) == 1
        call = mock_api.kernels_push_calls[0]
        meta = call["metadata"]

        assert meta["is_private"] is True
        assert meta["enable_gpu"] is True
        assert meta["enable_internet"] is True
        assert meta["dataset_sources"] == ["test_researcher/bme-3d-dataset"]

        # Test modes: bench, fold0, full, and folds list
        for mode, expected_cfg in [("bench", "bench"), ("fold0", "fold0"), ("full", "full")]:
            res_m = run_launch(
                src_dir=fake_repo,
                confirm_launch=True,
                mode=mode,
                folds=[0, 1] if mode == "full" else None,
                dataset_slug="bme-3d-dataset",
                kernel_slug="bme-3d-unet-training",
                api=mock_api,
            )
            assert res_m["mode"] == mode
            assert res_m["config_mode"] == expected_cfg

        print("[PASS] test_launch_requires_confirm_and_sets_private_gpu")


def test_import_goes_through_verify_and_import_weights():
    """Import runs verify_and_import_weights and never writes outside data/results3d."""
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        fake_repo = tmp / "fake_repo"
        fake_repo.mkdir()
        (fake_repo / "data" / "results3d").mkdir(parents=True)
        (fake_repo / "ml" / "scripts").mkdir(parents=True)
        (fake_repo / "ml" / "scripts" / "verify_and_import_weights.py").write_text("# verify", encoding="utf-8")

        staging = tmp / "staging"
        staging.mkdir()
        dl_dir = staging / "download"
        dl_dir.mkdir()

        # Destination inside fake_repo data/results3d
        dest_results3d = fake_repo / "data" / "results3d"

        # Mock subprocess.run for verify_and_import_weights.py
        with patch("subprocess.run") as mock_sub:
            mock_sub.return_value = subprocess.CompletedProcess(
                args=[], returncode=0, stdout='{"success": true}', stderr=""
            )
            res = run_import(staging_dir=staging, dest_dir=dest_results3d, src_dir=fake_repo)
            assert res["status"] == "IMPORT_SUCCESS"
            called_cmd = mock_sub.call_args[0][0]
            assert any("verify_and_import_weights.py" in str(arg) for arg in called_cmd)

        # Refuse writing outside data/results3d
        arbitrary_dest = tmp / "arbitrary_location"
        try:
            run_import(staging_dir=staging, dest_dir=arbitrary_dest, src_dir=fake_repo)
            assert False, "Should refuse destination outside data/results3d"
        except ValueError as e:
            assert "strictly" in str(e)

        print("[PASS] test_import_goes_through_verify_and_import_weights")


def test_no_credential_leak_in_logs_planted_fake_key():
    """Assures no credential strings from environment ever appear in pipeline output or logs."""
    fake_key = "FAKE_KAGGLE_SECRET_KEY_999888777_XYZ"
    os.environ["KAGGLE_KEY"] = fake_key
    mock_api = MockKaggleApi()

    buf = io.StringIO()
    with patch("sys.stdout", buf), patch("sys.stderr", buf):
        with tempfile.TemporaryDirectory() as tmp_str:
            tmp = Path(tmp_str)
            fake_repo = tmp / "fake_repo"
            fake_repo.mkdir()
            (fake_repo / "data").mkdir()
            staging = tmp / "staging"
            staging.mkdir()
            run_download(
                kernel_slug="bme-3d-unet-training",
                staging_dir=staging,
                src_dir=fake_repo,
                api=mock_api,
            )

    output = buf.getvalue()
    assert fake_key not in output, "Planted secret key leaked in pipeline stdout/stderr!"
    assert "FAKE" not in output
    print("[PASS] test_no_credential_leak_in_logs_planted_fake_key")


def test_refuses_when_in_repo_kaggle_json_or_config_dir():
    """Refuses to run any subcommand if kaggle.json exists in repo or KAGGLE_CONFIG_DIR points inside repo or data/."""
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        fake_repo = tmp / "fake_repo"
        fake_repo.mkdir()
        (fake_repo / "data").mkdir()
        (fake_repo / "subfolder").mkdir()

        # 1. Clean repo passes
        check_no_in_repo_kaggle_credentials(fake_repo)

        # 2. kaggle.json in repo root
        root_key = fake_repo / "kaggle.json"
        root_key.write_text('{"fake": "dummy"}', encoding="utf-8")
        try:
            check_no_in_repo_kaggle_credentials(fake_repo)
            assert False, "Should refuse when kaggle.json is in repo root"
        except RuntimeError as e:
            assert "A kaggle.json credential file was detected inside the repository" in str(e)
        root_key.unlink()

        # 3. kaggle.json in repo subfolder
        sub_key = fake_repo / "subfolder" / "kaggle.json"
        sub_key.write_text('{"fake": "dummy"}', encoding="utf-8")
        try:
            check_no_in_repo_kaggle_credentials(fake_repo)
            assert False, "Should refuse when kaggle.json is in subfolder"
        except RuntimeError as e:
            assert "A kaggle.json credential file was detected inside the repository" in str(e)
        sub_key.unlink()

        # 4. KAGGLE_CONFIG_DIR points inside repo
        with patch.dict(os.environ, {"KAGGLE_CONFIG_DIR": str(fake_repo / ".kaggle")}):
            try:
                check_no_in_repo_kaggle_credentials(fake_repo)
                assert False, "Should refuse when KAGGLE_CONFIG_DIR points inside repo"
            except RuntimeError as e:
                assert "KAGGLE_CONFIG_DIR points inside the repository" in str(e)

        # 5. KAGGLE_CONFIG_DIR points inside data/
        with patch.dict(os.environ, {"KAGGLE_CONFIG_DIR": str(fake_repo / "data" / ".kaggle")}):
            try:
                check_no_in_repo_kaggle_credentials(fake_repo)
                assert False, "Should refuse when KAGGLE_CONFIG_DIR points inside data/"
            except RuntimeError as e:
                assert "KAGGLE_CONFIG_DIR points inside the repository or data/" in str(e)

        # 6. KAGGLE_CONFIG_DIR points outside repo (valid)
        outside_cfg = tmp / "outside_kaggle_cfg"
        outside_cfg.mkdir()
        with patch.dict(os.environ, {"KAGGLE_CONFIG_DIR": str(outside_cfg)}):
            check_no_in_repo_kaggle_credentials(fake_repo)

        print("[PASS] test_refuses_when_in_repo_kaggle_json_or_config_dir")


if __name__ == "__main__":
    print("Running Kaggle Pipeline Security & Safeguards Test Suite...\n")
    test_staging_dir_inside_repo_or_data_refused()
    test_preflight_refuses_on_mapping_leak()
    test_preflight_refuses_failing_verify()
    test_upload_refuses_without_confirm_upload()
    test_dataset_creation_always_private_and_excludes_mapping()
    test_launch_requires_confirm_and_sets_private_gpu()
    test_import_goes_through_verify_and_import_weights()
    test_no_credential_leak_in_logs_planted_fake_key()
    test_refuses_when_in_repo_kaggle_json_or_config_dir()
    print("\n[SUCCESS] ALL KAGGLE PIPELINE SAFEGUARD TESTS PASSED!")
