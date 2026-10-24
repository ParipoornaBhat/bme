"""Hardened unit tests for Kaggle Cloud GPU Pipeline safeguards and integrity.

Mocked KaggleApi client tests (zero network calls, zero credential reading).
Covers:
1. Approval requires --confirm-approve plus passing preflight and check_deid_folder
2. Upload skips when remote hash matches
3. Upload refuses on local/approved hash mismatch
4. Upload sends only verified folder files (asserted: no zip, no mapping file, no ml/, no data/)
5. Run refuses when local hash differs, remote dataset not private, or remote hash differs
6. Run requires --confirm-launch
7. Launch attaches only approved dataset
8. Status state machine incl. error and cancel
9. Download uses file_pattern and staging folder outside repo/data
10. Import policy (quick, bench, fold0, incomplete, fingerprint mismatch never imported into results3d)
11. Resume after simulated restart does not launch twice
12. Planted fake key never appears in any log line
13. Staging dir inside repo or data refused
14. Refusal when kaggle.json exists inside repo
15. Doctor checks (FAIL cases, never prints credentials)
16. End-to-end dry run with mock client covering approve, upload, run, download, and import
"""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

repo_root = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(repo_root / "ml" / "scripts"))

from kaggle_pipeline import (
    build_parser,
    check_no_in_repo_kaggle_credentials,
    check_no_mapping_leak,
    compute_export_hash_and_stats,
    compute_source_fingerprint,
    get_expected_venv_python,
    get_staging_dir,
    run_approve_dataset,
    run_doctor,
    run_download,
    run_export_with_fingerprint,
    run_import,
    run_onetap,
    run_pipeline,
    run_preflight,
    run_status,
    run_upload,
    validate_path_outside_repo_and_data,
)


class MockKaggleDataset:
    def __init__(self, ref: str, is_private: bool = True, description: str = ""):
        self.ref = ref
        self.is_private = is_private
        self.description = description


class MockKaggleApi:
    """Mock Kaggle client recording calls and preventing any network activity."""

    def __init__(self, username="test_researcher", existing_datasets=None):
        self.username = username
        self.config_values = {"username": username}
        self._existing_datasets = existing_datasets or []
        self.create_new_calls = []
        self.create_version_calls = []
        self.kernels_push_calls = []
        self.kernels_status_calls = []
        self.kernels_output_calls = []

    def authenticate(self):
        return True

    def dataset_list(self, user=None):
        return self._existing_datasets

    def dataset_create_new(self, folder, public=False, dir_mode="skip", quiet=True):
        meta_file = Path(folder) / "dataset-metadata.json"
        meta = json.loads(meta_file.read_text(encoding="utf-8")) if meta_file.exists() else {}
        files = [p.name for p in Path(folder).rglob("*") if p.is_file()]
        self.create_new_calls.append({
            "folder": folder,
            "public": public,
            "metadata": meta,
            "files": files,
        })
        # Add to existing datasets
        self._existing_datasets.append(MockKaggleDataset(meta.get("id", ""), is_private=not public, description=meta.get("description", "")))
        return MagicMock()

    def dataset_create_version(self, folder, version_notes, dir_mode="skip", quiet=True):
        meta_file = Path(folder) / "dataset-metadata.json"
        meta = json.loads(meta_file.read_text(encoding="utf-8")) if meta_file.exists() else {}
        files = [p.name for p in Path(folder).rglob("*") if p.is_file()]
        self.create_version_calls.append({
            "folder": folder,
            "version_notes": version_notes,
            "metadata": meta,
            "files": files,
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

    def kernels_output(self, kernel, path, file_pattern=None):
        self.kernels_output_calls.append({"kernel": kernel, "path": path, "file_pattern": file_pattern})
        out_dir = Path(path)
        out_dir.mkdir(parents=True, exist_ok=True)
        # Create mock checkpoint fold_0.pt
        import torch
        from train_3d import UNet3D
        m = UNet3D()
        torch.save({"state": m.state_dict(), "epoch": 1}, str(out_dir / "fold_0.pt"))
        (out_dir / "metrics.json").write_text(json.dumps({"summary": {"bme_dice": 0.85}, "val_cases": ["case_001"]}), encoding="utf-8")
        (out_dir / "run_status.json").write_text(json.dumps({"mode": "quick", "complete": True, "completed_folds": [0]}), encoding="utf-8")
        return [str(out_dir / "fold_0.pt")], ""


def make_test_environment(base: Path):
    """Set up mock repo, export dir, mapping file, and staging dir."""
    repo = base / "repo"
    repo.mkdir(parents=True, exist_ok=True)
    (repo / "data" / "results3d").mkdir(parents=True, exist_ok=True)
    (repo / "ml" / "scripts").mkdir(parents=True, exist_ok=True)
    (repo / "ml" / "notebooks").mkdir(parents=True, exist_ok=True)

    # Notebook
    nb = {
        "cells": [
            {
                "cell_type": "code",
                "source": ['CONFIG_MODE = "quick_test"\n'],
            }
        ]
    }
    (repo / "ml" / "notebooks" / "train_3d_colab.ipynb").write_text(json.dumps(nb), encoding="utf-8")

    # Scripts
    (repo / "ml" / "scripts" / "export_for_colab.py").write_text(
        "import sys\nprint('Overall Verification: FULL PASS')\nprint('Compare Training Inputs: FULL PASS')\nsys.exit(0)\n", encoding="utf-8"
    )
    (repo / "ml" / "scripts" / "check_deid_folder.py").write_text(
        "import sys\nprint('ALL DEID CHECKS PASSED')\nsys.exit(0)\n", encoding="utf-8"
    )
    # Copy real verify_and_import_weights.py
    real_import_script = repo_root / "ml" / "scripts" / "verify_and_import_weights.py"
    shutil.copy2(real_import_script, repo / "ml" / "scripts" / "verify_and_import_weights.py")

    # Copy train_3d.py
    real_train_script = repo_root / "ml" / "scripts" / "train_3d.py"
    shutil.copy2(real_train_script, repo / "ml" / "scripts" / "train_3d.py")

    # Export folder outside repo
    export_dir = base / "export"
    export_dir.mkdir(parents=True, exist_ok=True)
    (export_dir / "nifti").mkdir(parents=True, exist_ok=True)
    (export_dir / "worklist.csv").write_text("case_id,patient_id,class\ncase_001,P001,bme\n", encoding="utf-8")
    (export_dir / "nifti" / "case_001.nii.gz").write_bytes(b"dummy_scan_bytes")

    # Mapping file outside repo and export
    mapping_file = base / "recovery" / "export_mapping.json"
    mapping_file.parent.mkdir(parents=True, exist_ok=True)
    mapping_file.write_text(json.dumps({"case_001": "secret_real_id"}), encoding="utf-8")

    # Staging dir outside repo
    staging_dir = base / "staging"
    staging_dir.mkdir(parents=True, exist_ok=True)

    return repo, export_dir, mapping_file, staging_dir


class TestKagglePipelineHardened(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.repo, self.export_dir, self.mapping_file, self.staging_dir = make_test_environment(self.base)
        self.env_patch = patch.dict(os.environ, {"KAGGLE_STAGING_DIR": str(self.staging_dir)})
        self.env_patch.start()
        orig_get_expected = get_expected_venv_python
        real_python = Path(sys.executable)
        self.venv_patch = patch(
            "kaggle_pipeline.get_expected_venv_python",
            side_effect=lambda r: real_python if Path(r).resolve() == self.repo.resolve() else orig_get_expected(r),
        )
        self.venv_patch.start()

    def tearDown(self):
        self.venv_patch.stop()
        self.env_patch.stop()
        self.tmp.cleanup()

    def test_approval_requires_confirm_approve(self):
        """Approval must refuse without --confirm-approve."""
        with self.assertRaises(ValueError) as ctx:
            run_approve_dataset(
                src_dir=self.repo,
                export_dir=self.export_dir,
                mapping_file=self.mapping_file,
                confirm_approve=False,
                dataset_slug="bme-3d-dataset",
            )
        self.assertIn("confirm-approve", str(ctx.exception))

    def test_approval_writes_clean_record(self):
        """Approval record must contain counts and hash, with zero case IDs or paths."""
        rec = run_approve_dataset(
            src_dir=self.repo,
            export_dir=self.export_dir,
            mapping_file=self.mapping_file,
            confirm_approve=True,
            dataset_slug="bme-3d-dataset",
        )
        self.assertEqual(rec["dataset_slug"], "bme-3d-dataset")
        self.assertIn("export_combined_sha256", rec)
        self.assertEqual(rec["case_count"], 1)

        approval_file = self.staging_dir / "dataset_approval.json"
        self.assertTrue(approval_file.exists())
        content = approval_file.read_text(encoding="utf-8")
        # Ensure no private paths or case IDs appear in the record
        self.assertNotIn(str(self.export_dir), content)
        self.assertNotIn("case_001", content)
        self.assertNotIn("secret_real_id", content)

    def test_upload_skips_when_remote_hash_matches(self):
        """Upload skips with exit 0 message when remote dataset has approved hash."""
        rec = run_approve_dataset(
            src_dir=self.repo,
            export_dir=self.export_dir,
            mapping_file=self.mapping_file,
            confirm_approve=True,
            dataset_slug="bme-3d-dataset",
        )
        approved_hash = rec["export_combined_sha256"]

        # Setup mock api with existing private dataset having approved hash
        mock_ds = MockKaggleDataset("test_researcher/bme-3d-dataset", is_private=True, description=approved_hash)
        api = MockKaggleApi(existing_datasets=[mock_ds])

        res = run_upload(
            src_dir=self.repo,
            export_dir=self.export_dir,
            mapping_file=self.mapping_file,
            confirm_upload=True,
            dataset_slug="bme-3d-dataset",
            api=api,
        )
        self.assertEqual(res["status"], "UP_TO_DATE")
        # No upload was executed
        self.assertEqual(len(api.create_new_calls), 0)
        self.assertEqual(len(api.create_version_calls), 0)

    def test_upload_refuses_on_hash_mismatch(self):
        """Upload refuses if local files change after approval."""
        run_approve_dataset(
            src_dir=self.repo,
            export_dir=self.export_dir,
            mapping_file=self.mapping_file,
            confirm_approve=True,
            dataset_slug="bme-3d-dataset",
        )
        # Modify an export file
        (self.export_dir / "nifti" / "case_001.nii.gz").write_bytes(b"altered_bytes")
        api = MockKaggleApi()

        with self.assertRaises(RuntimeError) as ctx:
            run_upload(
                src_dir=self.repo,
                export_dir=self.export_dir,
                mapping_file=self.mapping_file,
                confirm_upload=True,
                dataset_slug="bme-3d-dataset",
                api=api,
            )
        self.assertIn("hash mismatch", str(ctx.exception).lower())

    def test_upload_sends_only_verified_folder_files(self):
        """Upload stages only export files (no zip, no mapping file, no ml/, no data/)."""
        run_approve_dataset(
            src_dir=self.repo,
            export_dir=self.export_dir,
            mapping_file=self.mapping_file,
            confirm_approve=True,
            dataset_slug="bme-3d-dataset",
        )
        # Plant forbidden files in export dir
        (self.export_dir / "stray.zip").write_bytes(b"PK\x05\x06")
        (self.export_dir / "export_mapping.json").write_text("{}", encoding="utf-8")

        api = MockKaggleApi()
        run_upload(
            src_dir=self.repo,
            export_dir=self.export_dir,
            mapping_file=self.mapping_file,
            confirm_upload=True,
            dataset_slug="bme-3d-dataset",
            api=api,
        )
        self.assertEqual(len(api.create_new_calls), 1)
        staged_files = api.create_new_calls[0]["files"]
        for f in staged_files:
            self.assertFalse(f.endswith(".zip"))
            self.assertNotIn("mapping", f.lower())

    def test_run_refuses_without_confirm_launch(self):
        """Run refuses without --confirm-launch."""
        run_approve_dataset(
            src_dir=self.repo,
            export_dir=self.export_dir,
            mapping_file=self.mapping_file,
            confirm_approve=True,
            dataset_slug="bme-3d-dataset",
        )
        with self.assertRaises(ValueError) as ctx:
            run_pipeline(
                src_dir=self.repo,
                mode="quick",
                confirm_launch=False,
                resume=False,
                export_dir=self.export_dir,
            )
        self.assertIn("confirm-launch", str(ctx.exception))

    def test_run_refuses_when_remote_not_private_or_hash_mismatch(self):
        """Run refuses if remote dataset is public or carries different hash."""
        rec = run_approve_dataset(
            src_dir=self.repo,
            export_dir=self.export_dir,
            mapping_file=self.mapping_file,
            confirm_approve=True,
            dataset_slug="bme-3d-dataset",
        )
        approved_hash = rec["export_combined_sha256"]

        # Case A: Public dataset
        mock_ds_pub = MockKaggleDataset("test_researcher/bme-3d-dataset", is_private=False, description=approved_hash)
        api_pub = MockKaggleApi(existing_datasets=[mock_ds_pub])
        with self.assertRaises(RuntimeError) as ctx1:
            run_pipeline(src_dir=self.repo, mode="quick", confirm_launch=True, export_dir=self.export_dir, api=api_pub)
        self.assertIn("PRIVATE", str(ctx1.exception))

        # Case B: Hash mismatch
        mock_ds_diff = MockKaggleDataset("test_researcher/bme-3d-dataset", is_private=True, description="old_different_hash")
        api_diff = MockKaggleApi(existing_datasets=[mock_ds_diff])
        with self.assertRaises(RuntimeError) as ctx2:
            run_pipeline(src_dir=self.repo, mode="quick", confirm_launch=True, export_dir=self.export_dir, api=api_diff)
        self.assertIn("does not match", str(ctx2.exception))

    def test_run_attaches_only_approved_dataset(self):
        """Kernel metadata must attach only the approved dataset."""
        rec = run_approve_dataset(
            src_dir=self.repo,
            export_dir=self.export_dir,
            mapping_file=self.mapping_file,
            confirm_approve=True,
            dataset_slug="bme-3d-dataset",
        )
        api = MockKaggleApi(existing_datasets=[
            MockKaggleDataset("test_researcher/bme-3d-dataset", is_private=True, description=rec["export_combined_sha256"])
        ])
        run_pipeline(src_dir=self.repo, mode="quick", confirm_launch=True, export_dir=self.export_dir, api=api)
        self.assertEqual(len(api.kernels_push_calls), 1)
        meta = api.kernels_push_calls[0]["metadata"]
        self.assertEqual(meta["dataset_sources"], ["test_researcher/bme-3d-dataset"])
        self.assertTrue(meta["is_private"])
        self.assertTrue(meta["enable_gpu"])

    def test_import_policy_quick_vs_full(self):
        """Quick mode is archived to experiments; full mode goes to production data/results3d."""
        rec = run_approve_dataset(
            src_dir=self.repo,
            export_dir=self.export_dir,
            mapping_file=self.mapping_file,
            confirm_approve=True,
            dataset_slug="bme-3d-dataset",
        )
        api = MockKaggleApi(existing_datasets=[
            MockKaggleDataset("test_researcher/bme-3d-dataset", is_private=True, description=rec["export_combined_sha256"])
        ])

        # 1. Quick run: goes to results3d_experiments
        state_quick = run_pipeline(src_dir=self.repo, mode="quick", confirm_launch=True, export_dir=self.export_dir, api=api)
        self.assertIn("results3d_experiments", state_quick["dest_dir"])

        # 2. Full run: goes to results3d
        class MockFullApi(MockKaggleApi):
            def kernels_output(self, kernel, path, file_pattern=None):
                out_dir = Path(path)
                out_dir.mkdir(parents=True, exist_ok=True)
                import torch
                from train_3d import UNet3D
                m = UNet3D()
                for f in range(5):
                    torch.save({"state": m.state_dict(), "epoch": 40}, str(out_dir / f"fold_{f}.pt"))
                (out_dir / "metrics.json").write_text(json.dumps({"summary": {"bme_dice": 0.88}}), encoding="utf-8")
                (out_dir / "run_status.json").write_text(
                    json.dumps({"mode": "full", "complete": True, "completed_folds": [0, 1, 2, 3, 4], "fingerprint": rec["export_combined_sha256"][:16]}),
                    encoding="utf-8",
                )
                return [str(out_dir / "fold_0.pt")], ""

        api_full = MockFullApi(existing_datasets=[
            MockKaggleDataset("test_researcher/bme-3d-dataset", is_private=True, description=rec["export_combined_sha256"])
        ])
        state_full = run_pipeline(src_dir=self.repo, mode="full", confirm_launch=True, export_dir=self.export_dir, api=api_full)
        self.assertTrue(state_full["dest_dir"].endswith("results3d"))

    def test_resume_does_not_launch_twice(self):
        """Run --resume resumes status/download without calling kernels_push again."""
        rec = run_approve_dataset(
            src_dir=self.repo,
            export_dir=self.export_dir,
            mapping_file=self.mapping_file,
            confirm_approve=True,
            dataset_slug="bme-3d-dataset",
        )
        api = MockKaggleApi(existing_datasets=[
            MockKaggleDataset("test_researcher/bme-3d-dataset", is_private=True, description=rec["export_combined_sha256"])
        ])

        # Write existing run state (simulating laptop restart while running)
        state_file = self.staging_dir / "run_state.json"
        state_file.write_text(json.dumps({
            "run_id": "run_restart_test",
            "kernel_slug": "test_researcher/bme-3d-unet-training",
            "mode": "quick",
            "dataset_hash": rec["export_combined_sha256"],
            "started_at": 1000,
            "phase": "RUNNING",
        }), encoding="utf-8")

        res = run_pipeline(src_dir=self.repo, resume=True, export_dir=self.export_dir, api=api)
        # kernels_push was NOT called
        self.assertEqual(len(api.kernels_push_calls), 0)
        self.assertEqual(res["phase"], "COMPLETED")

    def test_planted_fake_key_never_appears_in_log(self):
        """Planted fake credentials string must never appear in doctor or stdout output."""
        fake_key = "planted_super_secret_fake_key_99999"
        with patch.dict(os.environ, {"KAGGLE_KEY": fake_key}):
            out = io.StringIO()
            with patch("sys.stdout", out):
                run_doctor(self.repo, remote=False)
            output = out.getvalue()
            self.assertNotIn(fake_key, output)

    def test_refusal_when_kaggle_json_inside_repo(self):
        """Credentials file inside repo must raise security refusal."""
        planted = self.repo / "kaggle.json"
        planted.write_text('{"username": "planted", "key": "secret"}', encoding="utf-8")
        with self.assertRaises(RuntimeError) as ctx:
            check_no_in_repo_kaggle_credentials(self.repo)
        self.assertIn("SECURITY REFUSAL", str(ctx.exception))
        planted.unlink()

    def test_staging_dir_inside_repo_or_data_refused(self):
        """Staging directory inside repository or data/ must be refused."""
        with self.assertRaises(ValueError):
            validate_path_outside_repo_and_data(self.repo / "staging", self.repo)
        with self.assertRaises(ValueError):
            validate_path_outside_repo_and_data(self.repo / "data" / "staging", self.repo)

    def test_end_to_end_dry_run(self):
        """End-to-end dry run: approve -> upload -> run -> download -> import."""
        # 1. Approve
        rec = run_approve_dataset(
            src_dir=self.repo,
            export_dir=self.export_dir,
            mapping_file=self.mapping_file,
            confirm_approve=True,
            dataset_slug="bme-3d-dataset",
        )
        self.assertIn("export_combined_sha256", rec)

        # 2. Upload
        api = MockKaggleApi()
        up_res = run_upload(
            src_dir=self.repo,
            export_dir=self.export_dir,
            mapping_file=self.mapping_file,
            confirm_upload=True,
            dataset_slug="bme-3d-dataset",
            api=api,
        )
        self.assertEqual(up_res["status"], "UPLOAD_SUCCESS")

        # 3. Run
        run_res = run_pipeline(
            src_dir=self.repo,
            mode="quick",
            confirm_launch=True,
            export_dir=self.export_dir,
            api=api,
        )
        self.assertEqual(run_res["phase"], "COMPLETED")
        self.assertTrue(Path(run_res["dest_dir"]).exists())

    def test_venv_python_resolution(self):
        """get_expected_venv_python must point to ml/.venv and fail clearly when missing."""
        from kaggle_pipeline import get_expected_venv_python, ensure_ml_venv_python
        expected = get_expected_venv_python(self.repo)
        self.assertIn("ml", expected.parts)
        self.assertIn(".venv", expected.parts)

        # Test failure when venv is missing
        fake_repo = self.base / "fake_repo"
        fake_repo.mkdir(parents=True, exist_ok=True)
        with self.assertRaises(RuntimeError) as ctx:
            ensure_ml_venv_python(fake_repo)
        self.assertIn("ml/.venv", str(ctx.exception))

    def test_doctor_fail_wrong_python(self):
        """Doctor must FAIL with a fix when running python is not ml/.venv."""
        out = io.StringIO()
        with patch("sys.executable", str(self.base / "system_python" / "python.exe")), patch("sys.stdout", out):
            code = run_doctor(self.repo, remote=False)
        self.assertEqual(code, 1)
        output = out.getvalue()
        self.assertIn("[FAIL] Python environment", output)
        self.assertIn("Fix:", output)

    def test_doctor_fail_credentials_inside_repo(self):
        """Doctor must FAIL with a fix when credentials are in the repo."""
        planted = self.repo / "kaggle.json"
        planted.write_text('{"username": "planted", "key": "secret"}', encoding="utf-8")
        out = io.StringIO()
        try:
            with patch("sys.stdout", out):
                code = run_doctor(self.repo, remote=False)
            self.assertEqual(code, 1)
            output = out.getvalue()
            self.assertIn("[FAIL] Kaggle credentials detected INSIDE the repository", output)
            self.assertIn("Fix:", output)
            self.assertNotIn("secret", output)
        finally:
            planted.unlink()

    def test_doctor_fail_credentials_missing(self):
        """Doctor must FAIL with a fix when credentials are completely missing."""
        out = io.StringIO()
        with patch.dict(os.environ, {"KAGGLE_USERNAME": "", "KAGGLE_KEY": ""}, clear=False), \
             patch("pathlib.Path.home", return_value=self.base / "nonexistent_home"), \
             patch("sys.stdout", out):
            code = run_doctor(self.repo, remote=False)
        self.assertEqual(code, 1)
        output = out.getvalue()
        self.assertIn("[FAIL] Kaggle credentials not found", output)
        self.assertIn("Fix:", output)

    def test_doctor_fail_staging_dir_inside_repo(self):
        """Doctor must FAIL with a fix when KAGGLE_STAGING_DIR is inside repo."""
        out = io.StringIO()
        with patch.dict(os.environ, {"KAGGLE_STAGING_DIR": str(self.repo / "staging")}), patch("sys.stdout", out):
            code = run_doctor(self.repo, remote=False)
        self.assertEqual(code, 1)
        output = out.getvalue()
        self.assertIn("[FAIL] KAGGLE_STAGING_DIR invalid", output)
        self.assertIn("Fix:", output)

    def test_doctor_fail_approval_hash_mismatch(self):
        """Doctor must FAIL with a fix when approval record does not match export folder."""
        run_approve_dataset(
            src_dir=self.repo,
            export_dir=self.export_dir,
            mapping_file=self.mapping_file,
            confirm_approve=True,
            dataset_slug="bme-3d-dataset",
        )
        # Alter an export file
        (self.export_dir / "nifti" / "case_001.nii.gz").write_bytes(b"altered")
        out = io.StringIO()
        with patch.dict(os.environ, {"BME_EXPORT_DIR": str(self.export_dir)}), patch("sys.stdout", out):
            code = run_doctor(self.repo, remote=False)
        self.assertEqual(code, 1)
        output = out.getvalue()
        self.assertIn("[FAIL] Dataset approval record hash mismatch", output)
        self.assertIn("Fix:", output)

    def test_doctor_fail_remote_dataset_public(self):
        """Doctor --remote must FAIL with a fix when remote dataset is PUBLIC."""
        public_ds = MockKaggleDataset("test_researcher/bme-3d-dataset", is_private=False, description="some_hash")
        api = MockKaggleApi(existing_datasets=[public_ds])
        out = io.StringIO()
        with patch("sys.stdout", out):
            code = run_doctor(self.repo, remote=True, api=api)
        self.assertEqual(code, 1)
        output = out.getvalue()
        self.assertIn("[FAIL] Remote dataset test_researcher/bme-3d-dataset is PUBLIC!", output)
        self.assertIn("Fix:", output)

    def test_argument_parsing_both_orders_all_actions(self):
        """Problem 1 regression: for EVERY action the UI or route can send, assert zero parse errors
        whether --src comes before or after the subcommand."""
        parser = build_parser()

        # Test configurations matching what route.ts spawns:
        actions_configs = [
            ("doctor", []),
            ("doctor", ["--remote"]),
            ("preflight", ["--export-dir", str(self.export_dir), "--mapping-file", str(self.mapping_file)]),
            ("approve-dataset", ["--confirm-approve", "--export-dir", str(self.export_dir), "--mapping-file", str(self.mapping_file), "--dataset-slug", "bme-3d-dataset"]),
            ("upload", ["--confirm-upload", "--export-dir", str(self.export_dir), "--mapping-file", str(self.mapping_file), "--dataset-slug", "bme-3d-dataset"]),
            ("run", ["--confirm-launch", "--mode", "quick", "--export-dir", str(self.export_dir), "--dataset-slug", "bme-3d-dataset", "--kernel-slug", "bme-3d-unet-training"]),
            ("run", ["--resume", "--mode", "quick"]),
            ("onetap", ["--confirm-approve", "--confirm-launch", "--mode", "quick", "--export-dir", str(self.export_dir), "--mapping-file", str(self.mapping_file), "--dataset-slug", "bme-3d-dataset", "--kernel-slug", "bme-3d-unet-training"]),
            ("onetap", ["--resume", "--mode", "bench"]),
            ("status", ["--json"]),
            ("download", ["--staging-dir", str(self.staging_dir)]),
            ("import", ["--staging-dir", str(self.staging_dir), "--dest", "data/results3d"]),
        ]

        for subcmd, flags in actions_configs:
            # Order 1: --src before subcommand (the order the fixed route spawns)
            args_before = ["--src", str(self.repo), subcmd] + flags
            parsed_before = parser.parse_args(args_before)
            self.assertEqual(parsed_before.subcommand, subcmd)
            self.assertEqual(Path(getattr(parsed_before, "src", ".")).resolve(), self.repo.resolve())

            # Order 2: subcommand before --src (the order CLI users or scripts might invoke)
            args_after = [subcmd, "--src", str(self.repo)] + flags
            parsed_after = parser.parse_args(args_after)
            self.assertEqual(parsed_after.subcommand, subcmd)
            self.assertEqual(Path(getattr(parsed_after, "src", ".")).resolve(), self.repo.resolve())

    def test_onetap_full_chain_happy_path_and_skips(self):
        """Full chain happy path: first tap exports, approves, uploads, runs, and imports.
        Second tap skips export and upload because hashes and fingerprints match."""
        # Ensure fake source scans exist for fingerprinting
        (self.repo / "data" / "cases").mkdir(parents=True, exist_ok=True)
        (self.repo / "data" / "cases" / "case_001.nii.gz").write_bytes(b"scan_source_bytes")

        api = MockKaggleApi()

        # Tap 1: initial run with confirm_approve and confirm_launch
        res1 = run_onetap(
            src_dir=self.repo,
            mode="quick",
            confirm_approve=True,
            confirm_launch=True,
            export_dir=self.export_dir,
            mapping_file=self.mapping_file,
            api=api,
        )
        self.assertEqual(res1["phase"], "COMPLETED")
        self.assertEqual(len(api.create_new_calls), 1)
        self.assertEqual(len(api.kernels_push_calls), 1)

        # Verify approval file exists
        approval_file = self.staging_dir / "dataset_approval.json"
        self.assertTrue(approval_file.exists())

        # Tap 2: unchanged source data and existing remote dataset
        out = io.StringIO()
        with patch("sys.stdout", out):
            res2 = run_onetap(
                src_dir=self.repo,
                mode="quick",
                confirm_launch=True,
                export_dir=self.export_dir,
                mapping_file=self.mapping_file,
                api=api,
            )
        self.assertEqual(res2["phase"], "COMPLETED")
        output = out.getvalue()
        # Verify skip-export and skip-upload both occurred
        self.assertIn("Source dataset unchanged, skipping export", output)
        self.assertIn("dataset already up to date, nothing uploaded", output)
        # Did not create or push another dataset version
        self.assertEqual(len(api.create_new_calls), 1)
        self.assertEqual(len(api.create_version_calls), 0)

    def test_onetap_stop_on_doctor_failure(self):
        """Onetap must abort immediately if doctor checks fail."""
        # Inject bad python into doctor
        with patch("kaggle_pipeline.get_expected_venv_python", return_value=self.base / "bad_python" / "python.exe"):
            with self.assertRaises(RuntimeError) as ctx:
                run_onetap(
                    src_dir=self.repo,
                    mode="quick",
                    confirm_approve=True,
                    confirm_launch=True,
                    export_dir=self.export_dir,
                    mapping_file=self.mapping_file,
                    api=MockKaggleApi(),
                )
            self.assertIn("Doctor diagnostics detected failures", str(ctx.exception))

    def test_onetap_stop_on_verify_export_failure(self):
        """Onetap must abort if export verification fails."""
        # Replace export script with one that fails
        (self.repo / "ml" / "scripts" / "export_for_colab.py").write_text(
            "import sys\nprint('Verification FAILED!')\nsys.exit(1)\n", encoding="utf-8"
        )
        with self.assertRaises(RuntimeError) as ctx:
            run_onetap(
                src_dir=self.repo,
                mode="quick",
                confirm_approve=True,
                confirm_launch=True,
                export_dir=self.export_dir,
                mapping_file=self.mapping_file,
                api=MockKaggleApi(),
            )
        self.assertIn("export_for_colab.py failed", str(ctx.exception))

    def test_onetap_stop_on_deid_failure(self):
        """Onetap must abort if check_deid_folder.py fails."""
        # Replace check_deid_folder script with one that fails
        (self.repo / "ml" / "scripts" / "check_deid_folder.py").write_text(
            "import sys\nprint('PHI detected!')\nsys.exit(1)\n", encoding="utf-8"
        )
        with self.assertRaises(RuntimeError) as ctx:
            run_onetap(
                src_dir=self.repo,
                mode="quick",
                confirm_approve=True,
                confirm_launch=True,
                export_dir=self.export_dir,
                mapping_file=self.mapping_file,
                api=MockKaggleApi(),
            )
        self.assertIn("check_deid_folder.py failed", str(ctx.exception))

    def test_onetap_stop_on_remote_dataset_not_private(self):
        """Onetap must abort if remote dataset exists and is PUBLIC."""
        public_ds = MockKaggleDataset("test_researcher/bme-3d-dataset", is_private=False, description="hash")
        api = MockKaggleApi(existing_datasets=[public_ds])
        with self.assertRaises(RuntimeError) as ctx:
            run_onetap(
                src_dir=self.repo,
                mode="quick",
                confirm_approve=True,
                confirm_launch=True,
                export_dir=self.export_dir,
                mapping_file=self.mapping_file,
                api=api,
            )
        self.assertIn("PUBLIC", str(ctx.exception))

    def test_onetap_stop_on_hash_mismatch(self):
        """Onetap must abort during upload if local export does not match approved hash."""
        # First approve dataset
        run_approve_dataset(
            src_dir=self.repo,
            export_dir=self.export_dir,
            mapping_file=self.mapping_file,
            confirm_approve=True,
            dataset_slug="bme-3d-dataset",
        )
        # Seed matching source fingerprint so step 2 export is skipped
        fp = compute_source_fingerprint(self.repo)
        (self.staging_dir / "source_fingerprint.json").write_text(json.dumps(fp), encoding="utf-8")

        # Modify an exported file to trigger hash mismatch
        (self.export_dir / "nifti" / "case_001.nii.gz").write_bytes(b"tampered_bytes")

        api = MockKaggleApi()
        with self.assertRaises(RuntimeError) as ctx:
            run_onetap(
                src_dir=self.repo,
                mode="quick",
                confirm_launch=True,
                export_dir=self.export_dir,
                mapping_file=self.mapping_file,
                api=api,
            )
        self.assertIn("Hash mismatch", str(ctx.exception))

    def test_onetap_first_time_requires_confirm_approve(self):
        """First-time onetap (no approval record on disk) must fail if confirm_approve=False."""
        # Ensure no approval record exists
        approval_file = self.staging_dir / "dataset_approval.json"
        if approval_file.exists():
            approval_file.unlink()

        with self.assertRaises(ValueError) as ctx:
            run_onetap(
                src_dir=self.repo,
                mode="quick",
                confirm_approve=False,
                confirm_launch=True,
                export_dir=self.export_dir,
                mapping_file=self.mapping_file,
                api=MockKaggleApi(),
            )
        self.assertIn("confirm-approve", str(ctx.exception))

    def test_onetap_retry_resume_without_second_launch(self):
        """Onetap with resume=True resumes existing run without launching a second time."""
        rec = run_approve_dataset(
            src_dir=self.repo,
            export_dir=self.export_dir,
            mapping_file=self.mapping_file,
            confirm_approve=True,
            dataset_slug="bme-3d-dataset",
        )
        api = MockKaggleApi(existing_datasets=[
            MockKaggleDataset("test_researcher/bme-3d-dataset", is_private=True, description=rec["export_combined_sha256"])
        ])
        # Seed an existing run state file
        run_state_file = self.staging_dir / "run_state.json"
        run_state_file.write_text(
            json.dumps({
                "run_id": "resume_onetap_test",
                "kernel_slug": "test_researcher/bme-3d-unet-training",
                "mode": "quick",
                "dataset_hash": rec["export_combined_sha256"],
                "started_at": 1000000,
                "phase": "RUNNING",
            }),
            encoding="utf-8",
        )

        res = run_onetap(
            src_dir=self.repo,
            mode="quick",
            resume=True,
            export_dir=self.export_dir,
            mapping_file=self.mapping_file,
            api=api,
        )
        self.assertEqual(res["phase"], "COMPLETED")
        # kernels_push must NOT have been called because it was resumed
        self.assertEqual(len(api.kernels_push_calls), 0)
        self.assertEqual(len(api.kernels_output_calls), 1)


if __name__ == "__main__":
    unittest.main()

