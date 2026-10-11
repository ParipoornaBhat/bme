"""Automated, hardened Kaggle GPU training pipeline for 3D U-Net.

Security & Integrity Safeguards:
1. Subcommands only, NO default action or import-time side effects.
2. Mandatory Preflight Check:
   - Validates export folder is outside repo and data/.
   - Re-runs export_for_colab.py --verify (requires exit code 0 and FULL PASS).
   - Confirms mapping file is NOT inside export folder or any zip inside it.
   - Outputs counts and hashes only (no patient identifiers or private paths).
3. Explicit Upload Confirmation:
   - Refuses unless --confirm-upload flag is passed.
   - Re-runs preflight in the same run before uploading.
   - Dataset is always created as PRIVATE (public=False, isPrivate=True).
   - Uploads ONLY verified export folder contents (never mapping, ml/, or data/).
4. Explicit Launch Confirmation:
   - Refuses unless --confirm-launch flag is passed.
   - Pushes notebook kernel with GPU, Internet, and Private flags enabled.
   - Defaults to quick_test; flag --full switches to full 5x40 configuration.
5. Strict Staging & Verification for Downloads/Imports:
   - Kernel outputs download ONLY into staging folder strictly outside repo and data/.
   - Import executes verify_and_import_weights.py (weights_only loading, allowlist,
     shape validation, zip-slip checks) before writing to data/results3d/.
6. Zero Credential Exposure:
   - Credentials handled internally by Kaggle client; never logged, echoed, or printed.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any, Dict, Optional


def validate_path_outside_repo_and_data(target: Path, src_dir: Path) -> Path:
    """Ensure path is strictly outside the repository and data/ directory."""
    resolved_target = target.resolve()
    resolved_src = src_dir.resolve()
    resolved_data = (src_dir / "data").resolve()

    if resolved_target == resolved_data or resolved_data in resolved_target.parents:
        raise ValueError(f"[ERROR] Path must be strictly outside data/ directory: {resolved_target.name}")
    if resolved_target == resolved_src or resolved_src in resolved_target.parents:
        raise ValueError(f"[ERROR] Path must be strictly outside the repository: {resolved_target.name}")
    return resolved_target


def check_no_in_repo_kaggle_credentials(src_dir: Path) -> None:
    """Refuse to run if kaggle.json exists anywhere inside the repo,
    or if KAGGLE_CONFIG_DIR points inside the repo or data/.
    """
    resolved_src = src_dir.resolve()
    resolved_data = (src_dir / "data").resolve()

    # 1. Refuse if KAGGLE_CONFIG_DIR points inside repo or data/
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
                "Credentials must reside outside the repository (e.g. ~/.kaggle/)."
            )

    # 2. Refuse if kaggle.json exists anywhere inside the repository
    for root, dirs, files in os.walk(resolved_src):
        dirs[:] = [d for d in dirs if d not in {".git", "node_modules", ".venv", "__pycache__", ".next"}]
        for f in files:
            if f.lower() == "kaggle.json":
                raise RuntimeError(
                    "[SECURITY REFUSAL] A kaggle.json credential file was detected inside the repository. "
                    "Kaggle credentials must reside outside the repository (e.g. ~/.kaggle/). "
                    "Move or remove the credential file from the workspace before running."
                )



def get_staging_dir(src_dir: Path) -> Path:
    """Get validated staging directory outside the repository."""
    env_dir = os.getenv("KAGGLE_STAGING_DIR")
    if env_dir:
        staging = Path(env_dir).resolve()
    else:
        staging = (src_dir.parent / "bme_kaggle_staging").resolve()
    validate_path_outside_repo_and_data(staging, src_dir)
    staging.mkdir(parents=True, exist_ok=True)
    return staging


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

    files = [p for p in export_dir.rglob("*") if p.is_file()]
    total_size = sum(p.stat().st_size for p in files)

    hasher = hashlib.sha256()
    for p in sorted(files, key=lambda x: str(x.relative_to(export_dir))):
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

    res = {
        "status": "PASS",
        "cases": case_count,
        "files": len(files),
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
    """Upload verified de-identified export to private Kaggle dataset."""
    check_no_in_repo_kaggle_credentials(src_dir)
    if not confirm_upload:
        raise ValueError("[ERROR] Upload refused: explicit confirmation (--confirm-upload) is required.")

    if not dataset_slug or not dataset_slug.strip():
        raise ValueError("[ERROR] Dataset slug cannot be empty. Specify via --dataset-slug or KAGGLE_DATASET_SLUG.")

    # 1. Preflight validation must pass in the exact same run
    preflight_res = run_preflight(src_dir, export_dir, mapping_file)

    # 2. Kaggle client initialization
    if api is None:
        try:
            from kaggle.api.kaggle_api_extended import KaggleApi
            api = KaggleApi()
            api.authenticate()
        except Exception as e:
            raise RuntimeError(f"[ERROR] Failed to authenticate with Kaggle: {type(e).__name__}")

    username = get_kaggle_username(api)
    full_slug = f"{username}/{dataset_slug}"

    # 3. Create isolated staging folder containing strictly the verified export files
    staging_dir = get_staging_dir(src_dir) / "upload_staging"
    if staging_dir.exists():
        shutil.rmtree(staging_dir)
    staging_dir.mkdir(parents=True, exist_ok=True)

    for item in export_dir.iterdir():
        if item.name == mapping_file.name or "mapping" in item.name.lower():
            continue
        if item.suffix.lower() == ".zip":
            continue
        if item.is_file():
            shutil.copy2(item, staging_dir / item.name)
        elif item.is_dir():
            shutil.copytree(item, staging_dir / item.name)

    # Ensure no zip or mapping file exists anywhere inside upload staging
    for item in list(staging_dir.rglob("*")):
        if item.is_file() and (item.suffix.lower() == ".zip" or "mapping" in item.name.lower()):
            item.unlink()

    # 4. Generate dataset metadata with explicit private visibility
    meta_path = staging_dir / "dataset-metadata.json"
    meta = {
        "title": "BME 3D Dataset",
        "id": full_slug,
        "licenses": [{"name": "CC0-1.0"}],
        "isPrivate": True,
    }
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    # 5. Check if dataset already exists to create version vs new dataset
    existing = [getattr(d, "ref", str(d)) for d in api.dataset_list(user=username)]
    if full_slug in existing:
        api.dataset_create_version(
            folder=str(staging_dir),
            version_notes="Verified de-identified export update",
            dir_mode="zip",
            quiet=False,
        )
        action = "updated_version"
    else:
        api.dataset_create_new(
            folder=str(staging_dir),
            public=False,  # Explicitly private dataset
            dir_mode="zip",
            quiet=False,
        )
        action = "created_new"

    # Cleanup staging directory
    shutil.rmtree(staging_dir, ignore_errors=True)

    res = {
        "status": "UPLOAD_SUCCESS",
        "action": action,
        "dataset_slug": full_slug,
        "cases": preflight_res["cases"],
        "files": preflight_res["files"],
        "size_mb": preflight_res["size_mb"],
    }

    print("=" * 60)
    print(f"KAGGLE DATASET UPLOAD: SUCCESS ({action})")
    print(f"  Dataset Slug  : {full_slug}")
    print(f"  Visibility    : PRIVATE")
    print(f"  Cases         : {res['cases']}")
    print(f"  Files         : {res['files']}")
    print(f"  Size          : {res['size_mb']} MB")
    print("=" * 60)
    return res


def run_launch(
    src_dir: Path,
    confirm_launch: bool,
    mode: str = "quick",
    folds: Optional[List[int]] = None,
    dataset_slug: str = "bme-3d-dataset",
    kernel_slug: str = "bme-3d-unet-training",
    api: Optional[Any] = None,
) -> Dict[str, Any]:
    """Build and push GPU training kernel to Kaggle."""
    check_no_in_repo_kaggle_credentials(src_dir)
    if not confirm_launch:
        raise ValueError("[ERROR] Launch refused: explicit confirmation (--confirm-launch) is required.")

    mode_map = {
        "bench": "bench",
        "quick": "quick_test",
        "fold0": "fold0",
        "full": "full",
    }
    if mode not in mode_map:
        raise ValueError(f"[ERROR] Invalid mode '{mode}'. Choose from: {list(mode_map.keys())}")
    config_mode = mode_map[mode]

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

    nb_path = src_dir / "ml" / "notebooks" / "train_3d_colab.ipynb"
    if not nb_path.exists():
        raise FileNotFoundError("[ERROR] Notebook not found: ml/notebooks/train_3d_colab.ipynb")

    nb_content = json.loads(nb_path.read_text(encoding="utf-8"))

    # Update CONFIG_MODE and RUN_FOLDS in notebook cell (in-memory copy only)
    for cell in nb_content.get("cells", []):
        if cell.get("cell_type") == "code":
            src_text = "".join(cell.get("source", []))
            if "CONFIG_MODE =" in src_text:
                new_src = []
                for line in cell.get("source", []):
                    if line.strip().startswith("CONFIG_MODE ="):
                        new_src.append(f'CONFIG_MODE = "{config_mode}"  # Configured by launch\n')
                    elif line.strip().startswith("RUN_FOLDS =") and folds is not None:
                        new_src.append(f"RUN_FOLDS = {folds}  # Configured by launch\n")
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

    res = {
        "status": "LAUNCH_SUCCESS",
        "kernel_slug": full_kernel_slug,
        "dataset_slug": full_dataset_slug,
        "mode": mode,
        "config_mode": config_mode,
        "folds": folds,
        "gpu": True,
        "internet": True,
        "private": True,
    }

    print("=" * 60)
    print("KAGGLE KERNEL LAUNCH: SUCCESS")
    print(f"  Kernel Slug   : {full_kernel_slug}")
    print(f"  Dataset Source: {full_dataset_slug}")
    print(f"  Launch Mode   : {mode} (CONFIG_MODE={config_mode.upper()})")
    if folds is not None:
        print(f"  Run Folds     : {folds}")
    print("  GPU Enabled   : True")
    print("  Internet      : True")
    print("  Visibility    : PRIVATE")
    print("=" * 60)
    return res


def run_status(kernel_slug: str, api: Optional[Any] = None, src_dir: Optional[Path] = None) -> Dict[str, Any]:
    """Check read-only kernel status on Kaggle."""
    if src_dir is not None:
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
        if hasattr(status_res, "status"):
            raw_s = status_res.status
            status = getattr(raw_s, "name", str(raw_s)).lower()
            if "kernelworkerstatus." in status:
                status = status.split("kernelworkerstatus.")[-1].lower()
            msg = getattr(status_res, "failure_message", "") or getattr(status_res, "failureMessage", "") or ""
        elif isinstance(status_res, dict):
            status = str(status_res.get("status", "unknown")).lower()
            msg = status_res.get("failureMessage", "") or ""
        else:
            status = str(status_res).lower()
            msg = ""
    except Exception as e:
        err_str = str(e).lower()
        if "cannot access kernel" in err_str or "404" in err_str:
            status = "idle"
            msg = "Kernel not yet created or started"
        else:
            status = "error"
            msg = f"Status check error: {type(e).__name__}"

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
    print(f"  Staging Folder  : {download_dir.name}")
    print("=" * 60)
    return res


def run_import(staging_dir: Path, dest_dir: Path, src_dir: Path) -> Dict[str, Any]:
    """Verify and import weights into data/results3d using verify_and_import_weights.py."""
    check_no_in_repo_kaggle_credentials(src_dir)
    staging_dir = validate_path_outside_repo_and_data(staging_dir, src_dir)
    download_dir = staging_dir / "download"

    if not download_dir.exists():
        raise FileNotFoundError(f"[ERROR] Download staging directory does not exist: {download_dir.name}")

    src_target = download_dir
    zip_candidates = list(download_dir.glob("*.zip"))
    if zip_candidates:
        src_target = zip_candidates[0]

    verify_script = src_dir / "ml" / "scripts" / "verify_and_import_weights.py"
    if not verify_script.exists():
        raise FileNotFoundError("[ERROR] verify_and_import_weights.py not found in ml/scripts.")

    expected_dest = (src_dir / "data" / "results3d").resolve()
    resolved_dest = dest_dir.resolve()
    if resolved_dest != expected_dest:
        raise ValueError(f"[ERROR] Import destination must be strictly {expected_dest}")

    cmd = [
        sys.executable,
        str(verify_script),
        str(src_target),
        str(resolved_dest),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(src_dir))
    if proc.returncode != 0:
        raise RuntimeError(f"[ERROR] Import verification failed:\n{proc.stderr or proc.stdout}")

    print("=" * 60)
    print("VERIFIED WEIGHTS IMPORT: SUCCESS")
    print(proc.stdout.strip())
    print("=" * 60)
    return {"status": "IMPORT_SUCCESS", "output": proc.stdout.strip()}


def main():
    ap = argparse.ArgumentParser(
        description="Automated Kaggle GPU Training Pipeline for 3D U-Net (with safeguards)",
        epilog="Explicit subcommand required. No default actions performed.",
    )
    ap.add_argument("--src", type=str, default=".", help="Root of project repository")

    subparsers = ap.add_subparsers(dest="subcommand", required=True)

    # 1. preflight
    p_pre = subparsers.add_parser("preflight", help="Validate export, run verify, check leak guards")
    p_pre.add_argument("--export-dir", type=str, default=os.getenv("BME_EXPORT_DIR", "../bme_colab_export"))
    p_pre.add_argument("--mapping-file", type=str, default=os.getenv("BME_MAPPING_FILE", "../bme_recovery/export_mapping.json"))

    # 2. upload
    p_up = subparsers.add_parser("upload", help="Upload verified export to private Kaggle dataset")
    p_up.add_argument("--export-dir", type=str, default=os.getenv("BME_EXPORT_DIR", "../bme_colab_export"))
    p_up.add_argument("--mapping-file", type=str, default=os.getenv("BME_MAPPING_FILE", "../bme_recovery/export_mapping.json"))
    p_up.add_argument("--confirm-upload", action="store_true", help="Explicit confirmation required to upload")
    p_up.add_argument("--dataset-slug", type=str, default=os.getenv("KAGGLE_DATASET_SLUG", "bme-3d-dataset"))

    # 3. launch
    p_la = subparsers.add_parser("launch", help="Push and run training kernel on Kaggle GPU")
    p_la.add_argument("--confirm-launch", action="store_true", help="Explicit confirmation required to launch")
    p_la.add_argument("--mode", choices=["bench", "quick", "fold0", "full"], default="quick",
                      help="Launch mode: bench, quick (default), fold0, or full")
    p_la.add_argument("--folds", nargs="+", type=int, default=None,
                      help="Optional fold indices to run (e.g. --folds 0 or --folds 0 1 2)")
    p_la.add_argument("--dataset-slug", type=str, default=os.getenv("KAGGLE_DATASET_SLUG", "bme-3d-dataset"))
    p_la.add_argument("--kernel-slug", type=str, default=os.getenv("KAGGLE_KERNEL_SLUG", "bme-3d-unet-training"))

    # 4. status
    p_st = subparsers.add_parser("status", help="Query kernel execution status on Kaggle")
    p_st.add_argument("--kernel-slug", type=str, default=os.getenv("KAGGLE_KERNEL_SLUG", "bme-3d-unet-training"))
    p_st.add_argument("--json", action="store_true", help="Output machine-readable JSON")

    # 5. download
    p_dl = subparsers.add_parser("download", help="Download trained weights into staging folder")
    p_dl.add_argument("--staging-dir", type=str, default=os.getenv("KAGGLE_STAGING_DIR", "../bme_kaggle_staging"))
    p_dl.add_argument("--kernel-slug", type=str, default=os.getenv("KAGGLE_KERNEL_SLUG", "bme-3d-unet-training"))

    # 6. import
    p_im = subparsers.add_parser("import", help="Verify and safely import weights into data/results3d")
    p_im.add_argument("--staging-dir", type=str, default=os.getenv("KAGGLE_STAGING_DIR", "../bme_kaggle_staging"))
    p_im.add_argument("--dest", type=str, default="data/results3d")

    args = ap.parse_args()
    src_dir = Path(args.src).resolve()
    check_no_in_repo_kaggle_credentials(src_dir)

    try:
        if args.subcommand == "preflight":
            run_preflight(src_dir, Path(args.export_dir), Path(args.mapping_file))
        elif args.subcommand == "upload":
            run_upload(
                src_dir=src_dir,
                export_dir=Path(args.export_dir),
                mapping_file=Path(args.mapping_file),
                confirm_upload=args.confirm_upload,
                dataset_slug=args.dataset_slug,
            )
        elif args.subcommand == "launch":
            run_launch(
                src_dir=src_dir,
                confirm_launch=args.confirm_launch,
                mode=args.mode,
                folds=args.folds,
                dataset_slug=args.dataset_slug,
                kernel_slug=args.kernel_slug,
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
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
