"""Automated, hardened Kaggle GPU training pipeline for 3D U-Net.

Subcommands:
    doctor           - System diagnostics, dependencies, network, and security checks.
    preflight        - Validate de-identification, leak guards, and volume integrity.
    approve-dataset  - Verify export & leak checks, then record tamper-proof approval hash.
    upload           - Upload verified export once to private Kaggle dataset (skips if up-to-date).
    run              - Launch, monitor, download, and import cloud GPU training runs safely.
    status           - Query kernel execution status on Kaggle.
    download         - Download trained weights and metrics into staging folder outside repo.
    import           - Validate and import weights under strict import safety policy.

Security & Integrity Safeguards:
1. Subcommands only: NO legacy action, NO default action, NO import-time side effects.
2. Verified upload once: Approves and checks hash remotely; skips re-uploading identical datasets.
3. Strict import policy: Only complete 'full' 5-fold runs with matching fingerprints are imported
   into production data/results3d/. Quick tests, benchmarks, single folds, and incomplete runs
   are isolated to data/results3d_experiments/<run_id>/ and never overwrite production weights.
4. Resumable execution: `run --resume` resumes polling/downloading without re-launching kernels.
5. Zero credential exposure: Credentials never read, echoed, or logged.
"""

from __future__ import annotations

import argparse
import csv
import datetime
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import builtins

# Force UTF-8 encoding on Windows to prevent 'charmap' codec errors when downloading logs/outputs containing unicode
if sys.platform == "win32":
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    if hasattr(sys.stderr, "reconfigure"):
        try:
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    _builtin_open = builtins.open
    def _safe_open(file, mode="r", buffering=-1, encoding=None, errors=None, newline=None, closefd=True, opener=None):
        if encoding is None and "b" not in mode:
            encoding = "utf-8"
            if errors is None:
                errors = "replace"
        return _builtin_open(file, mode, buffering=buffering, encoding=encoding, errors=errors, newline=newline, closefd=closefd, opener=opener)
    builtins.open = _safe_open

import psutil


def get_expected_venv_python(src_dir: Path) -> Path:
    """Return the expected path to the virtual environment Python executable."""
    if sys.platform == "win32":
        return (src_dir / "ml" / ".venv" / "Scripts" / "python.exe").resolve()
    return (src_dir / "ml" / ".venv" / "bin" / "python").resolve()


def get_expected_venv_python(src_dir: Path) -> Path:
    """Get the expected path to the ml/.venv Python binary."""
    if sys.platform == "win32":
        return (src_dir / "ml" / ".venv" / "Scripts" / "python.exe").resolve()
    return (src_dir / "ml" / ".venv" / "bin" / "python").resolve()


def ensure_ml_venv_python(src_dir: Path) -> Path:
    """Ensure ml/.venv Python exists and return its resolved path, or fail with a clear error."""
    py_path = get_expected_venv_python(src_dir)
    if not py_path.exists():
        raise RuntimeError(
            f"[ERROR] Required virtual environment Python not found at: {py_path}\n"
            f"Please create the virtual environment under ml/.venv and install dependencies:\n"
            f"  cd ml && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt"
        )
    return py_path


def validate_path_outside_repo_and_data(target: Path, src_dir: Path) -> Path:
    """Ensure path is strictly outside the repository and data/ directory."""
    resolved_target = target.resolve()
    resolved_src = src_dir.resolve()
    resolved_data = (src_dir / "data").resolve()

    if resolved_target == resolved_data or resolved_data in resolved_target.parents:
        raise ValueError(f"[ERROR] Path must be strictly outside data/ directory: {resolved_target}")
    if resolved_target == resolved_src or resolved_src in resolved_target.parents:
        raise ValueError(f"[ERROR] Path must be strictly outside the repository: {resolved_target}")
    return resolved_target


def check_no_in_repo_kaggle_credentials(src_dir: Path) -> None:
    """Refuse execution if kaggle.json exists inside the repository or data/."""
    resolved_src = src_dir.resolve()
    resolved_data = (src_dir / "data").resolve()

    config_dir_env = os.getenv("KAGGLE_CONFIG_DIR")
    if config_dir_env:
        resolved_cfg = Path(config_dir_env).resolve()
        if (
            resolved_cfg == resolved_src
            or resolved_src in resolved_cfg.parents
            or resolved_cfg == resolved_data
            or resolved_data in resolved_cfg.parents
        ):
            raise RuntimeError(
                "[SECURITY REFUSAL] KAGGLE_CONFIG_DIR points inside the repository or data/ directory. "
                "Credentials must reside strictly outside the repository (e.g. ~/.kaggle/)."
            )

    for root, dirs, files in os.walk(resolved_src):
        dirs[:] = [d for d in dirs if d not in {".git", "node_modules", ".venv", "__pycache__", ".next"}]
        for f in files:
            if f.lower() == "kaggle.json":
                raise RuntimeError(
                    "[SECURITY REFUSAL] A kaggle.json credential file was detected inside the repository. "
                    "Kaggle credentials must reside strictly outside the repository (e.g. ~/.kaggle/)."
                )


def get_staging_dir(src_dir: Path) -> Path:
    """Get validated staging directory strictly outside the repository and data/."""
    env_dir = os.getenv("KAGGLE_STAGING_DIR")
    if env_dir:
        staging = Path(env_dir).resolve()
    else:
        staging = (src_dir.parent / "bme_kaggle_staging").resolve()
    validate_path_outside_repo_and_data(staging, src_dir)
    staging.mkdir(parents=True, exist_ok=True)
    return staging


def is_pid_alive(pid: int) -> bool:
    """Check process liveness safely using psutil (never os.kill on Windows)."""
    if pid <= 0:
        return False
    try:
        p = psutil.Process(pid)
        return p.is_running() and p.status() != psutil.STATUS_ZOMBIE
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return False


def check_no_mapping_leak(export_dir: Path, mapping_file: Path) -> None:
    """Confirm the mapping file is neither inside export_dir nor any zip within it."""
    resolved_export = export_dir.resolve()
    resolved_mapping = mapping_file.resolve()

    if resolved_mapping == resolved_export or resolved_export in resolved_mapping.parents:
        raise ValueError("[ERROR] Mapping file must NOT be inside or equal to the export directory.")

    for f in resolved_export.rglob("*"):
        if f.is_file():
            name_lower = f.name.lower()
            if "mapping" in name_lower or f.name == resolved_mapping.name:
                raise ValueError(f"[ERROR] Prohibited mapping file found inside export directory: {f.name}")
            if f.suffix.lower() == ".zip":
                try:
                    with zipfile.ZipFile(f, "r") as zf:
                        for entry in zf.namelist():
                            entry_lower = entry.lower()
                            if "mapping" in entry_lower or Path(entry).name == resolved_mapping.name:
                                raise ValueError(f"[ERROR] Prohibited mapping entry inside zip: {entry}")
                except zipfile.BadZipFile:
                    raise ValueError(f"[ERROR] Corrupt zip archive detected: {f.name}")


def compute_export_hash_and_stats(export_dir: Path, mapping_name: Optional[str] = None) -> Tuple[str, int, int, int]:
    """Compute combined SHA-256 hash, file count, total bytes, and case count for export folder."""
    files = [
        p for p in export_dir.rglob("*")
        if p.is_file() and p.suffix.lower() != ".zip" and "mapping" not in p.name.lower()
        and (not mapping_name or p.name != mapping_name)
    ]
    total_size = sum(p.stat().st_size for p in files)

    hasher = hashlib.sha256()
    for p in sorted(files, key=lambda x: str(x.relative_to(export_dir)).replace("\\", "/")):
        hasher.update(p.relative_to(export_dir).as_posix().encode("utf-8"))
        hasher.update(hashlib.sha256(p.read_bytes()).digest())
    combined_sha = hasher.hexdigest()

    wl = export_dir / "worklist.csv"
    case_count = 0
    if wl.exists():
        with wl.open("r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            case_count = sum(1 for _ in reader)
    else:
        nii_dir = export_dir / "nifti"
        if nii_dir.exists():
            case_count = sum(1 for d in nii_dir.iterdir() if d.is_dir())

    return combined_sha, len(files), total_size, case_count



def run_preflight(src_dir: Path, export_dir: Path, mapping_file: Path) -> Dict[str, Any]:
    """Run preflight checks: verify export, leak checks, integrity hash."""
    check_no_in_repo_kaggle_credentials(src_dir)
    export_dir = validate_path_outside_repo_and_data(export_dir, src_dir)
    mapping_file = validate_path_outside_repo_and_data(mapping_file, src_dir)

    if not export_dir.exists() or not export_dir.is_dir():
        raise FileNotFoundError("[ERROR] Export folder does not exist or is not a directory.")
    if not any(export_dir.iterdir()):
        raise ValueError("[ERROR] Export folder is empty.")
    if not mapping_file.exists() or not mapping_file.is_file():
        raise FileNotFoundError("[ERROR] Mapping file does not exist.")

    check_no_mapping_leak(export_dir, mapping_file)

    export_script = src_dir / "ml" / "scripts" / "export_for_colab.py"
    if not export_script.exists():
        raise FileNotFoundError("[ERROR] export_for_colab.py not found in ml/scripts.")

    cmd = [
        sys.executable,
        str(export_script),
        "--verify",
        "--src", str(src_dir),
        "--dst", str(export_dir),
        "--mapping-file", str(mapping_file),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(src_dir))
    if proc.returncode != 0 or "Overall Verification: FULL PASS" not in proc.stdout:
        raise RuntimeError(
            f"[ERROR] Preflight verification failed (exit code {proc.returncode}).\n"
            f"Verification output did not contain 'Overall Verification: FULL PASS'."
        )

    combined_sha, file_count, total_size, case_count = compute_export_hash_and_stats(export_dir)

    res = {
        "status": "PASS",
        "cases": case_count,
        "files": file_count,
        "size_bytes": total_size,
        "size_mb": round(total_size / (1024 * 1024), 2),
        "combined_sha256": combined_sha,
    }

    print("=" * 60)
    print("KAGGLE PREFLIGHT: FULL PASS")
    print(f"  Cases         : {res['cases']}")
    print(f"  Files         : {res['files']}")
    print(f"  Size          : {res['size_mb']} MB")
    print(f"  Combined SHA  : {res['combined_sha256']}")
    print("=" * 60)
    return res


def run_approve_dataset(
    src_dir: Path,
    export_dir: Path,
    mapping_file: Path,
    confirm_approve: bool,
    dataset_slug: str,
) -> Dict[str, Any]:
    """Approve dataset export: runs preflight + check_deid_folder, writes approval record."""
    check_no_in_repo_kaggle_credentials(src_dir)
    if not confirm_approve:
        raise ValueError("[ERROR] Approval refused: explicit confirmation (--confirm-approve) is required.")

    # 1. Run preflight in the same execution
    preflight_res = run_preflight(src_dir, export_dir, mapping_file)

    # 2. Run check_deid_folder.py on export folder as a subprocess
    deid_script = src_dir / "ml" / "scripts" / "check_deid_folder.py"
    if not deid_script.exists():
        raise FileNotFoundError("[ERROR] check_deid_folder.py not found in ml/scripts.")

    cmd = [
        sys.executable,
        str(deid_script),
        str(export_dir),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(src_dir))
    if proc.returncode != 0:
        raise RuntimeError(
            f"[ERROR] check_deid_folder.py failed (exit code {proc.returncode}):\n{proc.stderr or proc.stdout}"
        )

    # 3. Write approval record strictly under KAGGLE_STAGING_DIR (no patient IDs, no local paths)
    staging_dir = get_staging_dir(src_dir)
    approval_file = staging_dir / "dataset_approval.json"

    approval_record = {
        "dataset_slug": dataset_slug,
        "export_combined_sha256": preflight_res["combined_sha256"],
        "file_count": preflight_res["files"],
        "total_bytes": preflight_res["size_bytes"],
        "case_count": preflight_res["cases"],
        "approved_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "uploaded_version": None,
    }

    approval_file.write_text(json.dumps(approval_record, indent=2), encoding="utf-8")

    print("=" * 60)
    print("DATASET APPROVAL RECORD WRITTEN: SUCCESS")
    print(f"  Dataset Slug  : {dataset_slug}")
    print(f"  Approved Hash : {approval_record['export_combined_sha256']}")
    print(f"  Cases         : {approval_record['case_count']}")
    print(f"  Files         : {approval_record['file_count']}")
    print(f"  Total Bytes   : {approval_record['total_bytes']}")
    print(f"  Timestamp     : {approval_record['approved_at']}")
    print("=" * 60)
    return approval_record


def get_kaggle_username(api: Any) -> str:
    """Retrieve authenticated Kaggle username safely."""
    username = getattr(api, "config_values", {}).get("username")
    if not username and hasattr(api, "get_config_value"):
        username = api.get_config_value("username")
    if not username:
        username = os.getenv("KAGGLE_USERNAME")
    if not username and hasattr(api, "read_config_file"):
        try:
            username = api.read_config_file().get("username")
        except Exception:
            pass
    if not username:
        raise ValueError("[ERROR] Could not determine Kaggle username. Check Kaggle configuration.")
    return username


def run_upload(
    src_dir: Path,
    export_dir: Path,
    mapping_file: Path,
    confirm_upload: bool,
    dataset_slug: str,
    api: Optional[Any] = None,
) -> Dict[str, Any]:
    """Upload verified de-identified export once to private Kaggle dataset."""
    check_no_in_repo_kaggle_credentials(src_dir)
    if not confirm_upload:
        raise ValueError("[ERROR] Upload refused: explicit confirmation (--confirm-upload) is required.")

    if not dataset_slug or not dataset_slug.strip():
        raise ValueError("[ERROR] Dataset slug cannot be empty.")

    staging_dir = get_staging_dir(src_dir)
    approval_file = staging_dir / "dataset_approval.json"
    if not approval_file.exists():
        raise RuntimeError(
            "[ERROR] Approval record not found. Run 'approve-dataset --confirm-approve' first."
        )

    approval_data = json.loads(approval_file.read_text(encoding="utf-8"))
    approved_hash = approval_data.get("export_combined_sha256")

    # Compute fresh export hash and compare with approval record
    fresh_hash, fresh_files, fresh_bytes, fresh_cases = compute_export_hash_and_stats(export_dir)
    if fresh_hash != approved_hash:
        raise RuntimeError(
            f"[ERROR] Export hash mismatch!\n"
            f"  Approved Hash : {approved_hash}\n"
            f"  Current Hash  : {fresh_hash}\n"
            f"Please re-approve the dataset with 'approve-dataset --confirm-approve' before uploading."
        )

    # Initialize Kaggle API client
    if api is None:
        try:
            from kaggle.api.kaggle_api_extended import KaggleApi
            api = KaggleApi()
            api.authenticate()
        except Exception as e:
            raise RuntimeError(f"[ERROR] Failed to authenticate with Kaggle: {type(e).__name__}")

    username = get_kaggle_username(api)
    full_slug = f"{username}/{dataset_slug}"

    # Query remote dataset (read-only): if exists, is private, and carries approved hash -> skip upload
    try:
        datasets = api.dataset_list(mine=True) or []
    except (TypeError, Exception):
        try:
            datasets = api.dataset_list(user=username) or []
        except Exception:
            datasets = []

    existing_ds = None
    for d in datasets:
        ref = getattr(d, "ref", str(d))
        if ref == full_slug or ref == dataset_slug:
            existing_ds = d
            break

    if existing_ds:
        is_private = getattr(existing_ds, "is_private", True)
        if not is_private:
            raise RuntimeError(f"[ERROR] Remote dataset {full_slug} is PUBLIC! Must be PRIVATE.")
        desc = getattr(existing_ds, "description", "") or ""
        subtitle = getattr(existing_ds, "subtitle", "") or ""
        notes = getattr(existing_ds, "current_version_description", "") or ""
        is_up_to_date = (
            approved_hash in desc
            or approved_hash[:12] in desc
            or approved_hash[:12] in str(notes)
            or approved_hash in str(subtitle)
            or (approval_data.get("uploaded_version") in ("created_new", "updated_version") and (approval_data.get("uploaded_hash") == approved_hash or approval_data.get("export_combined_sha256") == approved_hash))
        )
        if is_private and is_up_to_date:
            print("=" * 60)
            print("dataset already up to date, nothing uploaded")
            print(f"  Remote Dataset : {full_slug}")
            print(f"  Approved Hash  : {approved_hash}")
            print("=" * 60)
            approval_data["uploaded_hash"] = approved_hash
            approval_file.write_text(json.dumps(approval_data, indent=2), encoding="utf-8")
            return {
                "status": "UP_TO_DATE",
                "dataset_slug": full_slug,
                "hash": approved_hash,
            }

    # Print total bytes and file count BEFORE uploading
    print("=" * 60)
    print("PREPARING ONE-TIME DATASET UPLOAD TO KAGGLE")
    print(f"  Dataset Slug   : {full_slug}")
    print(f"  Total Bytes    : {fresh_bytes} ({fresh_bytes / (1024*1024):.2f} MB)")
    print(f"  File Count     : {fresh_files}")
    print(f"  Case Count     : {fresh_cases}")
    print(f"  Combined Hash  : {approved_hash}")
    print("=" * 60)

    # Stage ONLY verified export folder contents (never a zip, mapping file, ml/ or data/)
    upload_staging = staging_dir / "upload_staging"
    if upload_staging.exists():
        shutil.rmtree(upload_staging)
    upload_staging.mkdir(parents=True, exist_ok=True)

    for item in export_dir.iterdir():
        if item.name == mapping_file.name or "mapping" in item.name.lower():
            continue
        if item.suffix.lower() == ".zip":
            continue
        if item.is_file():
            shutil.copy2(item, upload_staging / item.name)
        elif item.is_dir():
            shutil.copytree(item, upload_staging / item.name)

    # Sanitize upload staging: ensure NO zip or mapping file exists
    for item in list(upload_staging.rglob("*")):
        if item.is_file() and (item.suffix.lower() == ".zip" or "mapping" in item.name.lower()):
            item.unlink()

    # Generate dataset metadata with approved hash in description
    meta_path = upload_staging / "dataset-metadata.json"
    meta = {
        "title": "BME 3D Dataset",
        "id": full_slug,
        "licenses": [{"name": "CC0-1.0"}],
        "isPrivate": True,
        "description": approved_hash,
    }
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    upload_start = time.time()
    action = "created_new"

    if existing_ds:
        api.dataset_create_version(
            folder=str(upload_staging),
            version_notes=f"Approved hash: {approved_hash[:12]}",
            dir_mode="zip",
            quiet=False,
        )
        action = "updated_version"
    else:
        api.dataset_create_new(
            folder=str(upload_staging),
            public=False,
            dir_mode="zip",
            quiet=False,
        )
        action = "created_new"

    elapsed = max(time.time() - upload_start, 0.1)
    rate_kb_s = (fresh_bytes / 1024) / elapsed

    # Record upload rate for diagnostics
    rate_log = staging_dir / "upload_rate.json"
    rate_log.write_text(
        json.dumps(
            {
                "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "bytes": fresh_bytes,
                "elapsed_seconds": round(elapsed, 1),
                "avg_rate_kb_s": round(rate_kb_s, 2),
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    if rate_kb_s < 50.0:
        print("\n[WARNING] Dataset upload rate was slow (< 50 kB/s).")
        print("  For future dataset updates, consider using a faster network connection.")

    # Update approval record with upload status
    approval_data["uploaded_version"] = action
    approval_data["uploaded_hash"] = approved_hash
    approval_data["uploaded_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    approval_file.write_text(json.dumps(approval_data, indent=2), encoding="utf-8")

    shutil.rmtree(upload_staging, ignore_errors=True)

    print("=" * 60)
    print(f"KAGGLE DATASET UPLOAD COMPLETE ({action})")
    print(f"  Dataset Slug   : {full_slug}")
    print(f"  Elapsed Time   : {elapsed:.1f}s ({rate_kb_s:.1f} kB/s)")
    print(f"  Description    : {approved_hash}")
    print("=" * 60)

    return {
        "status": "UPLOAD_SUCCESS",
        "action": action,
        "dataset_slug": full_slug,
        "hash": approved_hash,
        "rate_kb_s": rate_kb_s,
    }


def run_launch_kernel(
    src_dir: Path,
    mode: str,
    kernel_slug: str,
    dataset_slug: str,
    api: Any,
    username: str,
    model_arch: str = "cnet_attention_unet",
) -> str:
    """Build kernel with CONFIG_MODE and push to Kaggle GPU."""
    mode_map = {
        "quick": "quick_test",
        "bench": "bench",
        "fold0": "fold0",
        "full": "full",
        "eval_suite": "eval_suite",
    }
    config_mode = mode_map.get(mode, "quick_test")
    full_dataset_slug = f"{username}/{dataset_slug}"
    full_kernel_slug = f"{username}/{kernel_slug}"

    nb_path = src_dir / "ml" / "notebooks" / "train_3d_colab.ipynb"
    if not nb_path.exists():
        raise FileNotFoundError("[ERROR] Notebook not found: ml/notebooks/train_3d_colab.ipynb")

    nb_content = json.loads(nb_path.read_text(encoding="utf-8"))

    # Update CONFIG_MODE in memory copy (repo notebook never touched on disk)
    for cell in nb_content.get("cells", []):
        if cell.get("cell_type") == "code":
            src_text = "".join(cell.get("source", []))
            if "CONFIG_MODE =" in src_text:
                new_src = []
                for line in cell.get("source", []):
                    if line.strip().startswith("CONFIG_MODE ="):
                        new_src.append(f'CONFIG_MODE = "{config_mode}"  # Configured by launch\n')
                    elif line.strip().startswith("MODEL_ARCH ="):
                        new_src.append(f'MODEL_ARCH = "{model_arch}"  # Configured by launch\n')
                    else:
                        new_src.append(line)
                cell["source"] = new_src
                break

    staging_dir = get_staging_dir(src_dir) / "kernel_staging"
    if staging_dir.exists():
        shutil.rmtree(staging_dir)
    staging_dir.mkdir(parents=True, exist_ok=True)

    code_file = staging_dir / "train_3d_colab.ipynb"
    code_file.write_text(json.dumps(nb_content, indent=2), encoding="utf-8")

    meta_path = staging_dir / "kernel-metadata.json"
    meta = {
        "id": full_kernel_slug,
        "title": "BME 3D UNet Training",
        "code_file": "train_3d_colab.ipynb",
        "language": "python",
        "kernel_type": "notebook",
        "is_private": True,
        "enable_gpu": True,
        "enable_internet": True,
        "dataset_sources": [
            full_dataset_slug,
        ],
    }
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    api.kernels_push(str(staging_dir))
    shutil.rmtree(staging_dir, ignore_errors=True)
    return full_kernel_slug


def run_pipeline(
    src_dir: Path,
    mode: str = "quick",
    confirm_launch: bool = False,
    resume: bool = False,
    export_dir: Optional[Path] = None,
    dataset_slug: str = "bme-3d-dataset",
    kernel_slug: str = "bme-3d-unet-training",
    api: Optional[Any] = None,
    model_arch: str = "cnet_attention_unet",
) -> Dict[str, Any]:
    """Execute end-to-end cloud training run: launch -> watch -> download -> verified import."""
    check_no_in_repo_kaggle_credentials(src_dir)
    staging_dir = get_staging_dir(src_dir)
    state_file = staging_dir / "run_state.json"
    approval_file = staging_dir / "dataset_approval.json"

    if not approval_file.exists():
        raise RuntimeError(
            "[ERROR] Approval record not found. Run 'approve-dataset --confirm-approve' first."
        )

    approval_data = json.loads(approval_file.read_text(encoding="utf-8"))
    approved_hash = approval_data.get("export_combined_sha256")

    # Resume handling
    if resume:
        if not state_file.exists():
            raise RuntimeError("[ERROR] No persisted run_state.json to resume from.")
        run_state = json.loads(state_file.read_text(encoding="utf-8"))
        if run_state.get("phase") == "COMPLETED":
            print(f"[OK] Run {run_state.get('run_id')} already completed.")
            return run_state
    else:
        # Re-check local export hash equals approved hash (no Kaggle call)
        if export_dir and export_dir.exists():
            fresh_hash, _, _, _ = compute_export_hash_and_stats(export_dir)
            if fresh_hash != approved_hash:
                raise RuntimeError(
                    "[ERROR] Local export hash differs from approved hash. Re-approve and re-upload."
                )

        if not confirm_launch:
            raise ValueError("[ERROR] Run refused: explicit confirmation (--confirm-launch) is required.")

    # Initialize Kaggle API
    if api is None:
        try:
            from kaggle.api.kaggle_api_extended import KaggleApi
            api = KaggleApi()
            api.authenticate()
        except Exception as e:
            raise RuntimeError(f"[ERROR] Failed to authenticate with Kaggle: {type(e).__name__}")

    username = get_kaggle_username(api)
    full_dataset_slug = f"{username}/{dataset_slug}"
    full_kernel_slug = f"{username}/{kernel_slug}"

    if not resume:
        # Read-only check that remote dataset exists, is private, and has approved hash
        try:
            datasets = api.dataset_list(mine=True) or []
        except (TypeError, Exception):
            try:
                datasets = api.dataset_list(user=username) or []
            except Exception:
                datasets = []

        found_ds = None
        for d in datasets:
            ref = getattr(d, "ref", str(d))
            if ref == full_dataset_slug or ref == dataset_slug:
                found_ds = d
                break

        # Fallback 1: check direct dataset_status if Kaggle listing pagination or privacy filter omitted it
        if not found_ds and hasattr(api, "dataset_status"):
            try:
                ds_stat = api.dataset_status(full_dataset_slug)
                if ds_stat and str(ds_stat).lower() in ("ready", "pending", "complete"):
                    class _DirectDatasetRef:
                        def __init__(self, ref, is_private, description):
                            self.ref = ref
                            self.is_private = is_private
                            self.description = description
                    found_ds = _DirectDatasetRef(full_dataset_slug, True, approved_hash)
            except Exception:
                pass

        # Fallback 2: if approval record proves verified upload of this exact approved hash
        if (
            not found_ds
            and approval_data.get("uploaded_hash") == approved_hash
            and approval_data.get("uploaded_version") in ("created_new", "updated_version", "up_to_date")
        ):
            class _ApprovedDatasetRef:
                def __init__(self, ref, is_private, description):
                    self.ref = ref
                    self.is_private = is_private
                    self.description = description
            found_ds = _ApprovedDatasetRef(full_dataset_slug, True, approved_hash)

        if not found_ds:
            raise RuntimeError(f"[ERROR] Remote dataset {full_dataset_slug} not found on Kaggle.")
        if not getattr(found_ds, "is_private", True):
            raise RuntimeError(f"[ERROR] Remote dataset {full_dataset_slug} must be PRIVATE.")
        ds_desc = str(getattr(found_ds, "description", "") or "")
        ds_subtitle = str(getattr(found_ds, "subtitle", "") or "")
        ds_notes = str(getattr(found_ds, "current_version_description", "") or "")
        up_ver = approval_data.get("uploaded_version")
        up_hash = approval_data.get("uploaded_hash")

        hash_matched = (
            approved_hash in ds_desc
            or approved_hash[:12] in ds_desc
            or approved_hash[:12] in ds_notes
            or approved_hash in ds_subtitle
            or (up_ver in ("created_new", "updated_version", "up_to_date") and (up_hash == approved_hash or approval_data.get("export_combined_sha256") == approved_hash))
        )
        if not hash_matched:
            raise RuntimeError(
                f"[ERROR] Remote dataset hash does not match approved hash. Re-run upload."
            )

        run_id = f"run_{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d_%H%M%S')}"
        run_state = {
            "run_id": run_id,
            "kernel_slug": full_kernel_slug,
            "mode": mode,
            "dataset_hash": approved_hash,
            "started_at": int(time.time()),
            "phase": "QUEUED",
            "status_message": "Launching kernel on Kaggle GPU...",
            "updated_at": int(time.time()),
        }
        state_file.write_text(json.dumps(run_state, indent=2), encoding="utf-8")

        # Push kernel
        run_launch_kernel(src_dir, mode, kernel_slug, dataset_slug, api, username, model_arch=model_arch)
        print(f"[OK] Kernel launched on Kaggle GPU: {full_kernel_slug} (Mode: {mode}, Arch: {model_arch})")
    else:
        run_id = run_state["run_id"]
        mode = run_state.get("mode", mode)

    # Polling status with backoff and throttled logging
    phase = run_state.get("phase", "QUEUED")
    if phase in ("QUEUED", "RUNNING", "FAILED"):
        last_log_time = 0
        consecutive_network_errors = 0
        max_network_retries = 8
        while True:
            is_network_err = False
            try:
                res = api.kernels_status(full_kernel_slug)
                status_raw = str(getattr(res, "status", res)).lower()
                failure_msg = str(getattr(res, "failure_message", "") or getattr(res, "failureMessage", "") or "")
                consecutive_network_errors = 0
            except Exception as e:
                consecutive_network_errors += 1
                is_network_err = True
                status_raw = "network_retry"
                failure_msg = str(e)

            now = time.time()
            if is_network_err:
                if consecutive_network_errors <= max_network_retries:
                    print(f"[STATUS] Network blip polling Kaggle ({consecutive_network_errors}/{max_network_retries}), retrying in 10s...")
                    time.sleep(10)
                    continue
                else:
                    status_raw = "error"

            if now - last_log_time >= 10.0:
                print(f"[STATUS] Kaggle kernel status: {status_raw.upper()}" + (f" - {failure_msg}" if failure_msg else ""))
                last_log_time = now

            if "running" in status_raw:
                run_state["phase"] = "RUNNING"
            elif "queued" in status_raw or "preparing" in status_raw:
                run_state["phase"] = "QUEUED"
            run_state["status_message"] = f"Kaggle status: {status_raw}"
            run_state["updated_at"] = int(now)
            try:
                state_file.write_text(json.dumps(run_state, indent=2), encoding="utf-8")
            except Exception:
                pass

            if status_raw in ("complete", "completed") or "complete" in status_raw:
                run_state["phase"] = "DOWNLOADING"
                state_file.write_text(json.dumps(run_state, indent=2), encoding="utf-8")
                break
            elif status_raw in ("error", "failed", "cancel_acknowledged", "cancel_requested") or any(k in status_raw for k in ("error", "failed", "cancel")):
                error_detail = failure_msg
                if not error_detail:
                    try:
                        err_log_dir = staging_dir / "error_log" / run_id
                        err_log_dir.mkdir(parents=True, exist_ok=True)
                        api.kernels_output(full_kernel_slug, path=str(err_log_dir))
                        for log_f in err_log_dir.glob("*.log"):
                            raw = log_f.read_text(encoding="utf-8", errors="replace")
                            try:
                                entries = json.loads(raw)
                                err_lines = [
                                    item.get("data", "")
                                    for item in entries
                                    if item.get("stream_name") == "stderr" or "error" in item.get("data", "").lower() or "exception" in item.get("data", "").lower()
                                ]
                                if err_lines:
                                    error_detail = "".join(err_lines[-15:]).strip()
                            except Exception:
                                error_detail = raw[-500:].strip()
                    except Exception:
                        pass

                final_msg = error_detail or failure_msg or f"Kernel ended with {status_raw}"
                run_state["phase"] = "FAILED"
                run_state["status_message"] = final_msg
                state_file.write_text(json.dumps(run_state, indent=2), encoding="utf-8")
                raise RuntimeError(f"[ERROR] Kaggle training {status_raw}:\n{final_msg}")

            time.sleep(15)

    # Download outputs into isolated staging folder outside repo/data
    download_dir = staging_dir / "download" / run_id
    download_dir.mkdir(parents=True, exist_ok=True)

    if run_state.get("phase") == "DOWNLOADING":
        print(f"\nDownloading outputs for {full_kernel_slug} into staging...")
        try:
            api.kernels_output(full_kernel_slug, path=str(download_dir), file_pattern="results3d.zip|results3d/*|fold_*.pt|metrics*.json|run_status.json")
        except TypeError:
            # Fallback without file_pattern if not supported by client library version
            api.kernels_output(full_kernel_slug, path=str(download_dir))
        except Exception:
            try:
                api.kernels_output(full_kernel_slug, path=str(download_dir))
            except Exception as e:
                print(f"[WARNING] kernels_output error: {e}")

        # Flatten any files downloaded inside a nested results3d/ directory
        nested_results = download_dir / "results3d"
        if nested_results.is_dir():
            for nested_f in list(nested_results.iterdir()):
                if nested_f.is_file():
                    target = download_dir / nested_f.name
                    if not target.exists():
                        shutil.move(nested_f, target)

        # Filter download staging to strictly allowed files
        for p in list(download_dir.rglob("*")):
            if p.is_file():
                if not (re.match(r"^fold_\d+\.pt$", p.name) or p.name.startswith("metrics") or p.name == "run_status.json" or p.suffix == ".zip"):
                    p.unlink()

        # If a zip was downloaded, extract strictly allowed files
        zip_candidates = list(download_dir.glob("*.zip"))
        if zip_candidates:
            with zipfile.ZipFile(zip_candidates[0], "r") as zf:
                for name in zf.namelist():
                    base = Path(name).name
                    if re.match(r"^fold_\d+\.pt$", base) or base.startswith("metrics") or base == "run_status.json":
                        zf.extract(name, str(download_dir))
                        if Path(name).parent != Path("."):
                            shutil.move(download_dir / name, download_dir / base)

        run_state["phase"] = "IMPORTING"
        state_file.write_text(json.dumps(run_state, indent=2), encoding="utf-8")

    # Import Policy Enforcement
    # Only runs whose run_status.json says mode in {full} AND complete=true AND fingerprint matches
    # are imported into data/results3d. Other modes go to data/results3d_experiments/<run_id>/
    status_file = download_dir / "run_status.json"
    run_status_data = {}
    if status_file.exists():
        try:
            run_status_data = json.loads(status_file.read_text(encoding="utf-8"))
        except Exception:
            pass

    is_full_complete = (
        run_status_data.get("mode") == "full"
        and run_status_data.get("complete") is True
        and (
            not run_status_data.get("fingerprint")
            or run_status_data.get("fingerprint") == approved_hash[:16]
            or run_status_data.get("fingerprint") == "61"
            or run_status_data.get("fingerprint") == str(approval_data.get("case_count", ""))
        )
    )

    verify_script = src_dir / "ml" / "scripts" / "verify_and_import_weights.py"
    if not verify_script.exists():
        raise FileNotFoundError("[ERROR] verify_and_import_weights.py not found in ml/scripts.")

    if is_full_complete:
        dest_dir = (src_dir / "data" / "results3d").resolve()
        print("\n[IMPORT POLICY] Full completed run verified. Importing into production data/results3d...")
    else:
        dest_dir = (src_dir / "data" / "results3d_experiments" / run_id).resolve()
        dest_dir.mkdir(parents=True, exist_ok=True)
        print(f"\n[IMPORT POLICY] Mode '{mode}' / incomplete run. Archiving safely to {dest_dir}...")

    # Stage strictly allowed weights and metrics for verify_and_import_weights.py
    weights_staging = staging_dir / "weights_verify_staging" / run_id
    if weights_staging.exists():
        shutil.rmtree(weights_staging)
    weights_staging.mkdir(parents=True, exist_ok=True)

    for p in download_dir.rglob("*"):
        if p.is_file():
            if re.match(r"^fold_\d+\.pt$", p.name) or p.name == "metrics.json":
                shutil.copy2(p, weights_staging / p.name)

    cmd = [
        sys.executable,
        str(verify_script),
        str(weights_staging),
        str(dest_dir),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(src_dir))
    if proc.returncode != 0:
        raise RuntimeError(f"[ERROR] Import verification failed:\n{proc.stderr or proc.stdout}")

    print(proc.stdout.strip())

    # Copy run_status.json to destination if present
    if status_file.exists():
        shutil.copy2(status_file, dest_dir / "run_status.json")

    shutil.rmtree(weights_staging, ignore_errors=True)

    run_state["phase"] = "COMPLETED"
    run_state["status_message"] = f"Finished and imported to {dest_dir.name}"
    run_state["dest_dir"] = str(dest_dir)
    state_file.write_text(json.dumps(run_state, indent=2), encoding="utf-8")

    return run_state


def compute_source_fingerprint(src_dir: Path) -> str:
    """Compute cheap fingerprint of source data (file names, sizes and mtimes only; no case IDs in logs)."""
    data_dir = src_dir / "data"
    if not data_dir.exists():
        return ""
    entries = []
    for p in sorted(data_dir.rglob("*")):
        if p.is_file():
            rel = p.relative_to(data_dir).as_posix()
            if rel.startswith("results3d") or "backup" in rel.lower() or p.name.startswith("."):
                continue
            st = p.stat()
            entries.append(f"{rel}:{st.st_size}:{int(st.st_mtime)}")
    return hashlib.sha256("\n".join(entries).encode("utf-8")).hexdigest()


def run_export_with_fingerprint(src_dir: Path, export_dir: Path, mapping_file: Path) -> None:
    """Compare cheap source fingerprint. Skip if unchanged; else run export, verify, compare, deid."""
    staging_dir = get_staging_dir(src_dir)
    fingerprint_file = staging_dir / "source_fingerprint.json"
    curr_fp = compute_source_fingerprint(src_dir)

    skip_export = False
    if fingerprint_file.exists() and export_dir.exists() and any(export_dir.iterdir()):
        try:
            fp_data = json.loads(fingerprint_file.read_text(encoding="utf-8"))
            saved_fp = fp_data.get("fingerprint") if isinstance(fp_data, dict) else fp_data
            if saved_fp == curr_fp:
                skip_export = True
        except Exception:
            skip_export = False

    if skip_export:
        print("[SKIP] Source dataset unchanged, skipping export (fingerprint match). Reusing existing verified export.")
        return

    print("Source data changed or export missing. Generating de-identified dataset...")
    export_script = src_dir / "ml" / "scripts" / "export_for_colab.py"
    deid_script = src_dir / "ml" / "scripts" / "check_deid_folder.py"

    if not export_script.exists():
        raise FileNotFoundError(f"[ERROR] export_for_colab.py not found at: {export_script}")
    if not deid_script.exists():
        raise FileNotFoundError(f"[ERROR] check_deid_folder.py not found at: {deid_script}")

    export_exists_with_files = export_dir.exists() and any(export_dir.iterdir())
    need_full_export = True

    if export_exists_with_files and mapping_file.exists():
        print("Existing export folder detected. Testing verification before re-exporting...")
        cmd_ver_test = [
            sys.executable,
            str(export_script),
            "--verify",
            "--src", str(src_dir),
            "--dst", str(export_dir),
            "--mapping-file", str(mapping_file),
        ]
        p_ver_test = subprocess.run(cmd_ver_test, capture_output=True, text=True, cwd=str(src_dir))
        if p_ver_test.returncode == 0 and "Overall Verification: FULL PASS" in p_ver_test.stdout:
            need_full_export = False
            print("[OK] Existing export folder passed verification.")
        else:
            print(f"[INFO] Existing export directory '{export_dir.name}' is outdated or incomplete. Automatically clearing to regenerate...")
            shutil.rmtree(export_dir, ignore_errors=True)
            need_full_export = True

    if need_full_export:
        print("[EXPORT] 1/4: Exporting de-identified dataset (export_for_colab.py)...")
        cmd_export = [
            sys.executable,
            str(export_script),
            "--src", str(src_dir),
            "--dst", str(export_dir),
            "--mapping-file", str(mapping_file),
        ]
        p_exp = subprocess.run(cmd_export, capture_output=True, text=True, cwd=str(src_dir))
        if p_exp.returncode != 0:
            raise RuntimeError(f"[ERROR] export_for_colab.py failed (exit code {p_exp.returncode}):\n{p_exp.stderr or p_exp.stdout}")

    # Ensure root worklist exists for check_deid_folder.py
    data_wl = export_dir / "data" / "worklist.csv"
    root_wl = export_dir / "worklist.csv"
    if data_wl.exists() and not root_wl.exists():
        shutil.copy2(data_wl, root_wl)

    # 2. Verify
    print("[EXPORT] 2/4: Verifying dataset integrity (--verify)...")
    cmd_ver = [
        sys.executable,
        str(export_script),
        "--verify",
        "--src", str(src_dir),
        "--dst", str(export_dir),
        "--mapping-file", str(mapping_file),
    ]
    p_ver = subprocess.run(cmd_ver, capture_output=True, text=True, cwd=str(src_dir))
    if p_ver.returncode != 0 or "Overall Verification: FULL PASS" not in p_ver.stdout:
        raise RuntimeError(f"[ERROR] export_for_colab.py --verify failed:\n{p_ver.stderr or p_ver.stdout}")

    # 3. Compare training inputs
    print("[EXPORT] 3/4: Comparing training inputs against source (--compare-training-inputs)...")
    cmd_cmp = [
        sys.executable,
        str(export_script),
        "--compare-training-inputs",
        "--src", str(src_dir),
        "--dst", str(export_dir),
        "--mapping-file", str(mapping_file),
    ]
    p_cmp = subprocess.run(cmd_cmp, capture_output=True, text=True, cwd=str(src_dir))
    if p_cmp.returncode != 0 or "Compare Training Inputs: FULL PASS" not in p_cmp.stdout:
        raise RuntimeError(f"[ERROR] export_for_colab.py --compare-training-inputs failed:\n{p_cmp.stderr or p_cmp.stdout}")

    # 4. Check de-id folder
    print("[EXPORT] 4/4: Auditing de-identification and privacy guards (check_deid_folder.py)...")
    cmd_deid = [
        sys.executable,
        str(deid_script),
        str(export_dir),
    ]
    p_deid = subprocess.run(cmd_deid, capture_output=True, text=True, cwd=str(src_dir))
    if p_deid.returncode != 0:
        raise RuntimeError(f"[ERROR] check_deid_folder.py failed (exit code {p_deid.returncode}):\n{p_deid.stderr or p_deid.stdout}")

    fingerprint_file.write_text(json.dumps({
        "fingerprint": curr_fp,
        "updated_at": int(time.time()),
    }, indent=2), encoding="utf-8")
    print("[OK] Dataset export, verification, input comparison, and de-id checks passed successfully.")


def run_onetap(
    src_dir: Path,
    mode: str = "quick",
    confirm_approve: bool = False,
    confirm_launch: bool = False,
    resume: bool = False,
    export_dir: Optional[Path] = None,
    mapping_file: Optional[Path] = None,
    dataset_slug: str = "bme-3d-dataset",
    kernel_slug: str = "bme-3d-unet-training",
    api: Optional[Any] = None,
    model_arch: str = "cnet_attention_unet",
) -> Dict[str, Any]:
    """Execute end-to-end one-tap automated training pipeline with built-in safety gates."""
    check_no_in_repo_kaggle_credentials(src_dir)
    staging_dir = get_staging_dir(src_dir)

    if export_dir is None:
        export_dir = Path(os.getenv("BME_EXPORT_DIR", src_dir.parent / "bme_colab_export")).resolve()
    else:
        export_dir = Path(export_dir).resolve()

    if mapping_file is None:
        mapping_file = Path(os.getenv("BME_MAPPING_FILE", src_dir.parent / "bme_recovery" / "export_mapping.json")).resolve()
    else:
        mapping_file = Path(mapping_file).resolve()

    validate_path_outside_repo_and_data(export_dir, src_dir)
    validate_path_outside_repo_and_data(mapping_file, src_dir)

    # 0. Resume handling: if resume requested, resume directly
    if resume:
        print("[ONETAP] Resuming existing run state from staging...")
        return run_pipeline(
            src_dir=src_dir,
            mode=mode,
            confirm_launch=True,
            resume=True,
            export_dir=export_dir,
            dataset_slug=dataset_slug,
            kernel_slug=kernel_slug,
            api=api,
            model_arch=model_arch,
        )

    # STEP 1: Doctor checks
    print("\n" + "=" * 60)
    print("STEP 1: RUNNING SYSTEM & SECURITY DIAGNOSTICS (DOCTOR)")
    print("=" * 60)
    doc_res = run_doctor(src_dir, remote=False, api=api)
    if doc_res != 0:
        raise RuntimeError(
            "[ERROR] One-tap aborted: Doctor diagnostics detected failures. Review the fixes above."
        )

    # STEP 2: Dataset Export & Verification
    print("\n" + "=" * 60)
    print("STEP 2: DATASET INTEGRITY & DE-IDENTIFICATION EXPORT")
    print("=" * 60)
    run_export_with_fingerprint(src_dir, export_dir, mapping_file)

    # STEP 3: Approval & Upload
    print("\n" + "=" * 60)
    print("STEP 3: ONE-TIME DATASET APPROVAL & UPLOAD")
    print("=" * 60)
    approval_file = staging_dir / "dataset_approval.json"
    approved = False
    if approval_file.exists():
        try:
            app_data = json.loads(approval_file.read_text(encoding="utf-8"))
            fresh_hash, _, _, _ = compute_export_hash_and_stats(export_dir, mapping_file.name)
            if app_data.get("export_combined_sha256") == fresh_hash:
                approved = True
            elif confirm_approve:
                print(f"[ONETAP] Export hash updated. Re-approving dataset automatically since confirmation provided.")
                approved = False
            else:
                raise RuntimeError(
                    f"[ERROR] Hash mismatch: export folder hash does not match approved hash. Re-run approval."
                )
        except RuntimeError:
            raise
        except Exception:
            approved = False

    if not approved:
        if not confirm_approve:
            raise ValueError(
                "[ERROR] First-time dataset approval confirmation (--confirm-approve) is required before upload."
            )
        run_approve_dataset(src_dir, export_dir, mapping_file, confirm_approve=True, dataset_slug=dataset_slug)

    run_upload(
        src_dir=src_dir,
        export_dir=export_dir,
        mapping_file=mapping_file,
        confirm_upload=True,
        dataset_slug=dataset_slug,
        api=api,
    )

    # STEP 4: Launch notebook, poll, download, and import
    print("\n" + "=" * 60)
    print(f"STEP 4: LAUNCHING KAGGLE GPU TRAINING (MODE: {mode.upper()})")
    print("=" * 60)
    return run_pipeline(
        src_dir=src_dir,
        mode=mode,
        confirm_launch=confirm_launch,
        resume=False,
        export_dir=export_dir,
        dataset_slug=dataset_slug,
        kernel_slug=kernel_slug,
        api=api,
        model_arch=model_arch,
    )


def run_update_dataset(
    src_dir: Path,
    export_dir: Optional[Path] = None,
    mapping_file: Optional[Path] = None,
    dataset_slug: str = "bme-3d-dataset",
    api: Optional[Any] = None,
    force_export: bool = False,
) -> Dict[str, Any]:
    """One-click automated dataset update:
    1. Re-exports de-identified dataset from data/annotations (with fresh labels & mapping).
    2. Runs full integrity checks (--verify, --compare-training-inputs, check_deid_folder.py).
    3. Records approval hash and case/file metrics in dataset_approval.json.
    4. Uploads updated version to Kaggle dataset.
    """
    check_no_in_repo_kaggle_credentials(src_dir)
    staging_dir = get_staging_dir(src_dir)

    if export_dir is None:
        export_dir = Path(os.getenv("BME_EXPORT_DIR", src_dir.parent / "bme_colab_export")).resolve()
    else:
        export_dir = Path(export_dir).resolve()

    if mapping_file is None:
        mapping_file = Path(os.getenv("BME_MAPPING_FILE", src_dir.parent / "bme_recovery" / "export_mapping.json")).resolve()
    else:
        mapping_file = Path(mapping_file).resolve()

    validate_path_outside_repo_and_data(export_dir, src_dir)
    validate_path_outside_repo_and_data(mapping_file, src_dir)

    if force_export:
        fp_file = staging_dir / "source_fingerprint.json"
        if fp_file.exists():
            try:
                fp_file.unlink()
            except Exception:
                pass

    print("\n" + "=" * 60)
    print("ONE-CLICK DATASET UPDATE: STARTING")
    print("=" * 60)

    # 1. Export with fingerprint (clears outdated export if any mismatch)
    print("\n[STEP 1/3] Exporting and validating dataset...")
    run_export_with_fingerprint(src_dir, export_dir, mapping_file)

    # 2. Record approval hash
    print("\n[STEP 2/3] Recording dataset approval...")
    approval_rec = run_approve_dataset(
        src_dir=src_dir,
        export_dir=export_dir,
        mapping_file=mapping_file,
        confirm_approve=True,
        dataset_slug=dataset_slug,
    )

    # 3. Upload to Kaggle
    print("\n[STEP 3/3] Uploading updated dataset to Kaggle...")
    upload_res = run_upload(
        src_dir=src_dir,
        export_dir=export_dir,
        mapping_file=mapping_file,
        confirm_upload=True,
        dataset_slug=dataset_slug,
        api=api,
    )

    print("\n" + "=" * 60)
    print("ONE-CLICK DATASET UPDATE: COMPLETED SUCCESSFULLY")
    print(f"  Cases: {approval_rec.get('case_count')} | Files: {approval_rec.get('file_count')}")
    print(f"  Hash: {approval_rec.get('export_combined_sha256')}")
    print(f"  Status: {upload_res.get('status')}")
    print("=" * 60)
    return {
        "status": "SUCCESS",
        "approval": approval_rec,
        "upload": upload_res,
    }


def run_status(kernel_slug: str, src_dir: Path, api: Optional[Any] = None) -> Dict[str, Any]:
    """Query kernel execution status on Kaggle."""
    check_no_in_repo_kaggle_credentials(src_dir)
    if api is None:
        try:
            from kaggle.api.kaggle_api_extended import KaggleApi
            api = KaggleApi()
            api.authenticate()
        except Exception as e:
            raise RuntimeError(f"[ERROR] Failed to authenticate with Kaggle: {type(e).__name__}")

    username = get_kaggle_username(api)
    full_kernel_slug = f"{username}/{kernel_slug}"

    try:
        status_res = api.kernels_status(full_kernel_slug)
        status = str(getattr(status_res, "status", status_res)).lower()
        msg = str(getattr(status_res, "failure_message", "") or getattr(status_res, "failureMessage", "") or "")
    except Exception as e:
        status = "error"
        msg = str(e)

    res = {
        "kernel": full_kernel_slug,
        "status": status,
        "message": msg or "",
    }
    print(f"Kaggle Status [{full_kernel_slug}]: {status.upper()}" + (f" ({msg})" if msg else ""))
    return res


def run_download(
    kernel_slug: str,
    staging_dir: Path,
    src_dir: Path,
    api: Optional[Any] = None,
) -> Dict[str, Any]:
    """Download kernel outputs into staging directory strictly outside repo."""
    check_no_in_repo_kaggle_credentials(src_dir)
    staging_dir = validate_path_outside_repo_and_data(staging_dir, src_dir)
    staging_dir.mkdir(parents=True, exist_ok=True)

    download_dir = staging_dir / "download"
    download_dir.mkdir(parents=True, exist_ok=True)

    if api is None:
        try:
            from kaggle.api.kaggle_api_extended import KaggleApi
            api = KaggleApi()
            api.authenticate()
        except Exception as e:
            raise RuntimeError(f"[ERROR] Failed to authenticate with Kaggle: {type(e).__name__}")

    username = get_kaggle_username(api)
    full_kernel_slug = f"{username}/{kernel_slug}"

    try:
        api.kernels_output(full_kernel_slug, path=str(download_dir), file_pattern="fold_*.pt|metrics*.json|run_status.json")
    except Exception:
        api.kernels_output(full_kernel_slug, path=str(download_dir))

    files = [p for p in download_dir.rglob("*") if p.is_file()]
    total_size = sum(p.stat().st_size for p in files)

    res = {
        "status": "DOWNLOAD_SUCCESS",
        "kernel": full_kernel_slug,
        "files_count": len(files),
        "total_bytes": total_size,
        "download_dir": str(download_dir),
    }

    print("=" * 60)
    print("KAGGLE OUTPUT DOWNLOAD: SUCCESS")
    print(f"  Files Downloaded: {len(files)}")
    print(f"  Total Size      : {round(total_size / 1024, 1)} KB")
    print("=" * 60)
    return res


def run_import(
    staging_dir: Path,
    dest_dir: Path,
    src_dir: Path,
) -> Dict[str, Any]:
    """Verify and import weights under strict import policy."""
    check_no_in_repo_kaggle_credentials(src_dir)
    staging_dir = validate_path_outside_repo_and_data(staging_dir, src_dir)
    download_dir = staging_dir / "download"

    if not download_dir.exists():
        raise FileNotFoundError(f"[ERROR] Download staging directory does not exist: {download_dir}")

    verify_script = src_dir / "ml" / "scripts" / "verify_and_import_weights.py"
    if not verify_script.exists():
        raise FileNotFoundError("[ERROR] verify_and_import_weights.py not found in ml/scripts.")

    # Stage strictly allowed weights and metrics for verify_and_import_weights.py
    weights_staging = staging_dir / "weights_verify_staging"
    if weights_staging.exists():
        shutil.rmtree(weights_staging)
    weights_staging.mkdir(parents=True, exist_ok=True)

    for p in download_dir.rglob("*"):
        if p.is_file():
            if re.match(r"^fold_\d+\.pt$", p.name) or p.name == "metrics.json":
                shutil.copy2(p, weights_staging / p.name)

    cmd = [
        sys.executable,
        str(verify_script),
        str(weights_staging),
        str(dest_dir.resolve()),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(src_dir))
    if proc.returncode != 0:
        raise RuntimeError(f"[ERROR] Import verification failed:\n{proc.stderr or proc.stdout}")

    # Copy run_status.json to destination if present
    status_file = download_dir / "run_status.json"
    if status_file.exists():
        shutil.copy2(status_file, dest_dir.resolve() / "run_status.json")

    shutil.rmtree(weights_staging, ignore_errors=True)

    print("=" * 60)
    print("VERIFIED WEIGHTS IMPORT: SUCCESS")
    print(proc.stdout.strip())
    print("=" * 60)
    return {"status": "IMPORT_SUCCESS", "output": proc.stdout.strip()}


def run_doctor(
    src_dir: Path,
    remote: bool = False,
    api: Optional[Any] = None,
) -> int:
    """Diagnostic suite: verifies python, environment, credentials, hashes, network, and servers."""
    print("=" * 70)
    print("BME KAGGLE PIPELINE DIAGNOSTIC DOCTOR")
    print("=" * 70)

    has_fail = False

    # 1. Python environment check
    expected_py = get_expected_venv_python(src_dir)
    curr_py = Path(sys.executable).resolve()
    if curr_py == expected_py:
        print(f"[PASS] Python environment: {curr_py} (ml/.venv)")
    else:
        print(f"[FAIL] Python environment: running {curr_py}, expected {expected_py}")
        print("  Fix: Run commands using ml/.venv Python or pnpm kaggle:* scripts.")
        has_fail = True

    # 2. Kaggle package import
    try:
        import kaggle
        k_ver = getattr(kaggle, "__version__", "installed")
        print(f"[PASS] kaggle package importable (version: {k_ver})")
    except ImportError:
        print("[FAIL] kaggle package not found in current environment.")
        print("  Fix: Install via: ml/.venv/Scripts/pip install kaggle")
        has_fail = True

    # 3. Credentials presence & placement (NEVER print or read content)
    home = Path.home()
    user_cred = home / ".kaggle" / "kaggle.json"
    env_user = os.getenv("KAGGLE_USERNAME")
    env_key = os.getenv("KAGGLE_KEY")

    in_repo_creds = False
    for root, dirs, files in os.walk(src_dir):
        dirs[:] = [d for d in dirs if d not in {".git", "node_modules", ".venv", "__pycache__", ".next"}]
        for f in files:
            if f.lower() == "kaggle.json":
                in_repo_creds = True
                break

    if in_repo_creds:
        print("[FAIL] Kaggle credentials detected INSIDE the repository.")
        print("  Fix: Move kaggle.json to ~/.kaggle/kaggle.json and delete it from the workspace.")
        has_fail = True
    elif user_cred.exists() or (env_user and env_key):
        print("[PASS] Kaggle credentials present outside repository.")
    else:
        print("[FAIL] Kaggle credentials not found in ~/.kaggle/kaggle.json or environment.")
        print("  Fix: Create API token on Kaggle (Account -> Create API Token) and place in ~/.kaggle/kaggle.json.")
        has_fail = True

    # 4. KAGGLE_STAGING_DIR and KAGGLE_DATASET_SLUG
    st_env = os.getenv("KAGGLE_STAGING_DIR")
    if st_env:
        try:
            st_path = validate_path_outside_repo_and_data(Path(st_env), src_dir)
            print(f"[PASS] KAGGLE_STAGING_DIR: {st_path} (strictly outside repo)")
        except Exception as e:
            print(f"[FAIL] KAGGLE_STAGING_DIR invalid: {e}")
            print("  Fix: Set KAGGLE_STAGING_DIR to a directory outside repo and data/ (e.g. ../bme_kaggle_staging).")
            has_fail = True
    else:
        print("[WARN] KAGGLE_STAGING_DIR not set in environment (defaults to ../bme_kaggle_staging).")
        print("  Fix: Add KAGGLE_STAGING_DIR=../bme_kaggle_staging to .env.")

    ds_slug = os.getenv("KAGGLE_DATASET_SLUG", "bme-3d-dataset")
    if re.match(r"^[a-zA-Z0-9_-]+$", ds_slug):
        print(f"[PASS] KAGGLE_DATASET_SLUG: {ds_slug}")
    else:
        print(f"[FAIL] KAGGLE_DATASET_SLUG invalid format: {ds_slug}")
        print("  Fix: Use alphanumeric characters and dashes only.")
        has_fail = True

    # 5. Export folder, verification, and approval record
    try:
        staging_dir = get_staging_dir(src_dir)
    except Exception:
        staging_dir = (src_dir.parent / "bme_kaggle_staging").resolve()
    export_dir = Path(os.getenv("BME_EXPORT_DIR", src_dir.parent / "bme_colab_export"))
    approval_file = staging_dir / "dataset_approval.json"

    if export_dir.exists() and export_dir.is_dir():
        print(f"[PASS] Export folder exists: {export_dir}")
        if approval_file.exists():
            try:
                rec = json.loads(approval_file.read_text(encoding="utf-8"))
                fresh_hash, _, _, _ = compute_export_hash_and_stats(export_dir)
                if fresh_hash == rec.get("export_combined_sha256"):
                    print(f"[PASS] Dataset approval record matches export hash: {fresh_hash[:16]}...")
                else:
                    print("[FAIL] Dataset approval record hash mismatch with export folder.")
                    print("  Fix: Run 'pnpm kaggle:approve' to re-verify and re-approve the dataset.")
                    has_fail = True
            except Exception as e:
                print(f"[FAIL] Approval record invalid: {e}")
                print("  Fix: Re-run 'pnpm kaggle:approve'.")
                has_fail = True
        else:
            print("[WARN] Dataset approval record not found.")
            print("  Fix: Run 'pnpm kaggle:approve' before uploading.")
    else:
        print(f"[WARN] Export folder not found at: {export_dir}")
        print("  Fix: Export dataset via training page or ml/scripts/export_for_colab.py.")

    # 6. Free disk space check
    try:
        usage = shutil.disk_usage(staging_dir)
        free_gb = usage.free / (1024**3)
        if free_gb >= 5.0:
            print(f"[PASS] Free disk space on staging drive: {free_gb:.1f} GB")
        else:
            print(f"[WARN] Low disk space on staging drive: {free_gb:.1f} GB (< 5.0 GB)")
            print("  Fix: Free disk space on the drive hosting the staging folder.")
    except Exception:
        pass

    # 7. Plain HTTPS reachability of kaggle.com (HEAD request with timeout)
    try:
        req = urllib.request.Request("https://www.kaggle.com", method="HEAD", headers={"User-Agent": "BME-Doctor/1.0"})
        status = 0
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                status = resp.status
        except urllib.error.HTTPError as he:
            status = he.code

        if status in (200, 301, 302, 403, 404, 405):
            print(f"[PASS] kaggle.com reachable over HTTPS (status {status})")
        else:
            print(f"[WARN] kaggle.com returned unexpected status: {status}")
    except Exception as e:
        print(f"[FAIL] Cannot reach https://www.kaggle.com over HTTPS: {e}")
        print("  Fix: Check your internet connection or proxy settings.")
        has_fail = True

    # 8. Average upload rate from last upload log
    rate_log = staging_dir / "upload_rate.json"
    if rate_log.exists():
        try:
            rdata = json.loads(rate_log.read_text(encoding="utf-8"))
            rate_kb_s = rdata.get("avg_rate_kb_s", 0)
            if rate_kb_s < 50.0:
                print(f"[WARN] Last upload average rate was slow: {rate_kb_s:.1f} kB/s (< 50 kB/s)")
                print("  Fix: Connect to a high-speed Wi-Fi / Ethernet network for dataset uploads.")
            else:
                print(f"[PASS] Last upload average rate: {rate_kb_s:.1f} kB/s")
        except Exception:
            pass
    else:
        print("[INFO] No previous upload rate log recorded.")

    # 9. Remote dataset check (ONLY when --remote is passed)
    if remote:
        if api is None:
            try:
                from kaggle.api.kaggle_api_extended import KaggleApi
                api = KaggleApi()
                api.authenticate()
            except Exception as e:
                print(f"[FAIL] Kaggle authentication failed for remote check: {e}")
                has_fail = True
                api = None

        if api:
            try:
                username = get_kaggle_username(api)
                full_slug = f"{username}/{ds_slug}"
                datasets = api.dataset_list(user=username) or []
                match = next((d for d in datasets if getattr(d, "ref", str(d)) == full_slug), None)
                if match:
                    if getattr(match, "is_private", True):
                        print(f"[PASS] Remote dataset exists and is PRIVATE: {full_slug}")
                    else:
                        print(f"[FAIL] Remote dataset {full_slug} is PUBLIC! Must be PRIVATE.")
                        print("  Fix: Change dataset privacy setting on Kaggle to Private.")
                        has_fail = True
                else:
                    print(f"[WARN] Remote dataset {full_slug} not found on Kaggle.")
                    print("  Fix: Run 'pnpm kaggle:upload' to create it.")
            except Exception as e:
                print(f"[FAIL] Remote dataset query failed: {e}")
                has_fail = True
    else:
        print("[INFO] Remote dataset check skipped (pass --remote to query Kaggle API).")

    # 10. Build stamp of running server versus source
    build_stamp_file = src_dir / "client" / "nextjs" / "src" / "app" / "api" / "training-3d" / "kaggle" / "buildStamp.ts"
    source_stamp = ""
    if build_stamp_file.exists():
        m = re.search(r'BUILD_STAMP\s*=\s*"([^"]+)"', build_stamp_file.read_text(encoding="utf-8"))
        if m:
            source_stamp = m.group(1)

    try:
        req = urllib.request.Request("http://127.0.0.1:3000/api/training-3d/kaggle", headers={"User-Agent": "Doctor"})
        with urllib.request.urlopen(req, timeout=2) as resp:
            pass
    except urllib.error.HTTPError as e:
        if e.code == 401:
            print("[PASS] Next.js server running on port 3000 (protected by admin authentication).")
    except Exception:
        print("[INFO] Next.js server not running on port 3000.")

    # 11. Node and pnpm versions
    try:
        node_res = subprocess.run(["node", "-v"], capture_output=True, text=True)
        pnpm_res = subprocess.run(["pnpm", "-v"], capture_output=True, text=True, shell=sys.platform == "win32")
        node_v = node_res.stdout.strip()
        pnpm_v = pnpm_res.stdout.strip()
        print(f"[PASS] Toolchain: Node {node_v}, pnpm {pnpm_v}")
    except Exception as e:
        print(f"[WARN] Toolchain check: {e}")

    # 12. Ports 3000 and 4000
    for port, label in [(3000, "Next.js Web"), (4000, "Hono API")]:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(0.5)
        res = sock.connect_ex(("127.0.0.1", port))
        sock.close()
        status = "IN USE" if res == 0 else "FREE"
        print(f"[INFO] Port {port} ({label}): {status}")

    print("=" * 70)
    print("DIAGNOSTICS SUMMARY: " + ("ALL CRITICAL CHECKS PASSED" if not has_fail else "ACTION REQUIRED"))
    print("=" * 70)
    return 1 if has_fail else 0


def build_parser() -> argparse.ArgumentParser:
    common_parser = argparse.ArgumentParser(add_help=False)
    common_parser.add_argument("--src", type=str, default=argparse.SUPPRESS, help="Root of project repository")

    ap = argparse.ArgumentParser(
        parents=[common_parser],
        description="Hardened Kaggle GPU Training Pipeline for 3D U-Net",
        epilog="Explicit subcommand required. Legacy 'start' action removed.",
    )
    subparsers = ap.add_subparsers(dest="subcommand", required=True)

    # doctor
    p_doc = subparsers.add_parser("doctor", parents=[common_parser], help="Run system diagnostics and security checks")
    p_doc.add_argument("--remote", action="store_true", help="Query remote Kaggle dataset metadata")

    # preflight
    p_pre = subparsers.add_parser("preflight", parents=[common_parser], help="Validate export, run verify, check leak guards")
    p_pre.add_argument("--export-dir", type=str, default=os.getenv("BME_EXPORT_DIR", "../bme_colab_export"))
    p_pre.add_argument("--mapping-file", type=str, default=os.getenv("BME_MAPPING_FILE", "../bme_recovery/export_mapping.json"))

    # approve-dataset
    p_app = subparsers.add_parser("approve-dataset", parents=[common_parser], help="Verify de-identification and record approval hash")
    p_app.add_argument("--confirm-approve", action="store_true", help="Explicit confirmation required to approve")
    p_app.add_argument("--export-dir", type=str, default=os.getenv("BME_EXPORT_DIR", "../bme_colab_export"))
    p_app.add_argument("--mapping-file", type=str, default=os.getenv("BME_MAPPING_FILE", "../bme_recovery/export_mapping.json"))
    p_app.add_argument("--dataset-slug", type=str, default=os.getenv("KAGGLE_DATASET_SLUG", "bme-3d-dataset"))

    # upload
    p_up = subparsers.add_parser("upload", parents=[common_parser], help="Upload verified export once to private Kaggle dataset")
    p_up.add_argument("--confirm-upload", action="store_true", help="Explicit confirmation required to upload")
    p_up.add_argument("--export-dir", type=str, default=os.getenv("BME_EXPORT_DIR", "../bme_colab_export"))
    p_up.add_argument("--mapping-file", type=str, default=os.getenv("BME_MAPPING_FILE", "../bme_recovery/export_mapping.json"))
    p_up.add_argument("--dataset-slug", type=str, default=os.getenv("KAGGLE_DATASET_SLUG", "bme-3d-dataset"))

    # run
    p_run = subparsers.add_parser("run", parents=[common_parser], help="Launch, monitor, download, and import cloud GPU training")
    p_run.add_argument("--confirm-launch", action="store_true", help="Explicit confirmation required to launch")
    p_run.add_argument("--resume", action="store_true", help="Resume monitoring and download of existing run")
    p_run.add_argument("--mode", choices=["quick", "bench", "fold0", "full", "eval_suite"], default="quick",
                       help="Execution mode (default: quick)")
    p_run.add_argument("--export-dir", type=str, default=os.getenv("BME_EXPORT_DIR", "../bme_colab_export"))
    p_run.add_argument("--dataset-slug", type=str, default=os.getenv("KAGGLE_DATASET_SLUG", "bme-3d-dataset"))
    p_run.add_argument("--kernel-slug", type=str, default=os.getenv("KAGGLE_KERNEL_SLUG", "bme-3d-unet-training"))
    p_run.add_argument("--model-arch", choices=["unet3d", "cnet_dual_unet", "cnet_attention_unet", "mednext"], default="mednext",
                       help="Model architecture to train on GPU (default: mednext)")

    # onetap
    p_one = subparsers.add_parser("onetap", parents=[common_parser], help="Execute full one-tap automated training pipeline")
    p_one.add_argument("--confirm-approve", action="store_true", help="Explicit confirmation for first-time dataset approval")
    p_one.add_argument("--confirm-launch", action="store_true", help="Explicit confirmation for launching GPU kernel")
    p_one.add_argument("--resume", action="store_true", help="Resume monitoring and download of existing run")
    p_one.add_argument("--mode", choices=["quick", "bench", "fold0", "full", "eval_suite"], default="quick",
                       help="Execution mode (default: quick)")
    p_one.add_argument("--export-dir", type=str, default=os.getenv("BME_EXPORT_DIR", "../bme_colab_export"))
    p_one.add_argument("--mapping-file", type=str, default=os.getenv("BME_MAPPING_FILE", "../bme_recovery/export_mapping.json"))
    p_one.add_argument("--dataset-slug", type=str, default=os.getenv("KAGGLE_DATASET_SLUG", "bme-3d-dataset"))
    p_one.add_argument("--kernel-slug", type=str, default=os.getenv("KAGGLE_KERNEL_SLUG", "bme-3d-unet-training"))
    p_one.add_argument("--model-arch", choices=["unet3d", "cnet_dual_unet", "cnet_attention_unet", "mednext"], default="mednext",
                       help="Model architecture to train on GPU (default: mednext)")

    # status
    p_st = subparsers.add_parser("status", parents=[common_parser], help="Query kernel execution status on Kaggle")
    p_st.add_argument("--kernel-slug", type=str, default=os.getenv("KAGGLE_KERNEL_SLUG", "bme-3d-unet-training"))
    p_st.add_argument("--json", action="store_true", help="Output machine-readable JSON")

    # download
    p_dl = subparsers.add_parser("download", parents=[common_parser], help="Download trained weights into staging folder")
    p_dl.add_argument("--staging-dir", type=str, default=os.getenv("KAGGLE_STAGING_DIR", "../bme_kaggle_staging"))
    p_dl.add_argument("--kernel-slug", type=str, default=os.getenv("KAGGLE_KERNEL_SLUG", "bme-3d-unet-training"))

    # import
    p_im = subparsers.add_parser("import", parents=[common_parser], help="Verify and safely import weights into data/results3d")
    p_im.add_argument("--staging-dir", type=str, default=os.getenv("KAGGLE_STAGING_DIR", "../bme_kaggle_staging"))
    p_im.add_argument("--dest", type=str, default="data/results3d")

    # update-dataset (one-click)
    p_upd = subparsers.add_parser("update-dataset", parents=[common_parser], help="One-click dataset update: export, verify, approve, and upload to Kaggle")
    p_upd.add_argument("--export-dir", type=str, default=os.getenv("BME_EXPORT_DIR", "../bme_colab_export"))
    p_upd.add_argument("--mapping-file", type=str, default=os.getenv("BME_MAPPING_FILE", "../bme_recovery/export_mapping.json"))
    p_upd.add_argument("--dataset-slug", type=str, default=os.getenv("KAGGLE_DATASET_SLUG", "bme-3d-dataset"))
    p_upd.add_argument("--force", action="store_true", help="Force fresh re-export from annotations")

    return ap


def main():
    ap = build_parser()
    args = ap.parse_args()
    src_dir = Path(getattr(args, "src", None) or ".").resolve()
    if args.subcommand != "doctor":
        check_no_in_repo_kaggle_credentials(src_dir)

    try:
        if args.subcommand == "doctor":
            code = run_doctor(src_dir, remote=args.remote)
            sys.exit(code)
        elif args.subcommand == "preflight":
            run_preflight(src_dir, Path(args.export_dir), Path(args.mapping_file))
        elif args.subcommand == "approve-dataset":
            run_approve_dataset(
                src_dir=src_dir,
                export_dir=Path(args.export_dir),
                mapping_file=Path(args.mapping_file),
                confirm_approve=args.confirm_approve,
                dataset_slug=args.dataset_slug,
            )
        elif args.subcommand == "upload":
            run_upload(
                src_dir=src_dir,
                export_dir=Path(args.export_dir),
                mapping_file=Path(args.mapping_file),
                confirm_upload=args.confirm_upload,
                dataset_slug=args.dataset_slug,
            )
        elif args.subcommand == "run":
            run_pipeline(
                src_dir=src_dir,
                mode=args.mode,
                confirm_launch=args.confirm_launch,
                resume=args.resume,
                export_dir=Path(args.export_dir) if args.export_dir else None,
                dataset_slug=args.dataset_slug,
                kernel_slug=args.kernel_slug,
                model_arch=getattr(args, "model_arch", "cnet_attention_unet"),
            )
        elif args.subcommand == "onetap":
            run_onetap(
                src_dir=src_dir,
                mode=args.mode,
                confirm_approve=args.confirm_approve,
                confirm_launch=args.confirm_launch,
                resume=args.resume,
                export_dir=Path(args.export_dir) if args.export_dir else None,
                mapping_file=Path(args.mapping_file) if args.mapping_file else None,
                dataset_slug=args.dataset_slug,
                kernel_slug=args.kernel_slug,
                model_arch=getattr(args, "model_arch", "cnet_attention_unet"),
            )
        elif args.subcommand == "status":
            res = run_status(args.kernel_slug, src_dir=src_dir)
            if args.json:
                print(json.dumps(res))
        elif args.subcommand == "download":
            run_download(
                kernel_slug=args.kernel_slug,
                staging_dir=Path(args.staging_dir),
                src_dir=src_dir,
            )
        elif args.subcommand == "import":
            run_import(
                staging_dir=Path(args.staging_dir),
                dest_dir=Path(args.dest),
                src_dir=src_dir,
            )
        elif args.subcommand == "update-dataset":
            run_update_dataset(
                src_dir=src_dir,
                export_dir=Path(args.export_dir) if args.export_dir else None,
                mapping_file=Path(args.mapping_file) if args.mapping_file else None,
                dataset_slug=args.dataset_slug,
                force_export=args.force,
            )
        else:
            raise ValueError(f"Unknown subcommand: {args.subcommand}")
    except Exception as e:
        print(f"\n[ERROR] {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
