"""Automated Kaggle GPU Training Pipeline for 3D U-Net.

Features:
1. De-identifies and sanitizes NIfTI headers and assigns pseudonyms (case_001).
2. Packages the dataset into a staging folder outside the repository.
3. Automatically creates/updates private dataset on Kaggle via Kaggle API.
4. Pushes and triggers the GPU kernel on Kaggle (T4 GPU, background cloud execution).
5. Monitors kernel execution status.
6. Automatically downloads trained weights and metrics back into data/results3d/.

Usage:
    # 1. Full automated pipeline: Push to Kaggle GPU, run in cloud:
    python ml/scripts/kaggle_pipeline.py --push

    # 2. Check training status on Kaggle:
    python ml/scripts/kaggle_pipeline.py --status

    # 3. Download trained weights when complete:
    python ml/scripts/kaggle_pipeline.py --download

    # 4. End-to-end watcher: Push, wait for completion, auto-download:
    python ml/scripts/kaggle_pipeline.py --watch
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

# Ensure Kaggle API is available
try:
    import kaggle
    from kaggle.api.kaggle_api_extended import KaggleApi
except ImportError:
    print("[ERROR] kaggle package not found. Run: pip install kaggle")
    sys.exit(1)

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

import nibabel as nib
import numpy as np

# Import helper functions from ml/scripts
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "ml" / "scripts"))
from seg2nifti import build_labelmap, read_segmentation, to_volume_grid  # noqa: E402
from train_3d import volume_path  # noqa: E402

STAGING_DIR = Path.home() / ".kaggle_bme_staging"
DATASET_SLUG = "bme-3d-dataset"
KERNEL_SLUG = "bme-3d-unet-training"


def sanitize_nifti_header(img: nib.Nifti1Image) -> nib.Nifti1Image:
    """Clear metadata text fields and strip extensions while preserving data and affine."""
    hdr = img.header.copy()
    if isinstance(hdr, nib.Nifti1Header):
        hdr["db_name"] = b""
        hdr["descrip"] = b""
        hdr["aux_file"] = b""
        hdr["intent_name"] = b""
        hdr.extensions.clear()
    data = np.asanyarray(img.dataobj)
    sanitized = nib.Nifti1Image(data, img.affine, hdr)
    sanitized.header.extensions.clear()
    return sanitized


def find_source_cases(base_dir: Path) -> list[str]:
    ann = base_dir / "data" / "annotations"
    if not ann.is_dir():
        return []
    return sorted(
        p.parent.name
        for p in ann.glob("*/*.seg.nrrd")
        if p.name == f"{p.parent.name}.seg.nrrd"
    )


def load_source_patient_map(base_dir: Path) -> dict[str, str]:
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


def build_manifest(case_ids: list[str], patient_map: dict[str, str], seed: int = 42) -> list[dict]:
    rng = random.Random(seed)
    shuffled = case_ids[:]
    rng.shuffle(shuffled)
    pat_to_pseudo: dict[str, str] = {}
    p_counter = 1
    manifest = []
    for idx, cid in enumerate(shuffled, start=1):
        rand_id = f"case_{idx:03d}"
        orig_p = patient_map.get(cid, cid)
        if orig_p not in pat_to_pseudo:
            pat_to_pseudo[orig_p] = f"patient_{p_counter:03d}"
            p_counter += 1
        manifest.append({
            "original_case_id": cid,
            "exported_id": rand_id,
            "patient_group": pat_to_pseudo[orig_p],
        })
    return manifest


def export_dataset(src_dir: Path, target_dir: Path) -> tuple[int, Path]:
    target_dir.mkdir(parents=True, exist_ok=True)
    dst_data = target_dir / "data"
    dst_ann = dst_data / "annotations"
    dst_nii = dst_data / "nifti"
    dst_ann.mkdir(parents=True, exist_ok=True)
    dst_nii.mkdir(parents=True, exist_ok=True)

    cases = find_source_cases(src_dir)
    pat_map = load_source_patient_map(src_dir)
    manifest = build_manifest(cases, pat_map)

    print(f"Preparing {len(manifest)} cases for Kaggle export...")
    worklist_rows = []
    exported = 0

    for entry in manifest:
        cid = entry["original_case_id"]
        rand_id = entry["exported_id"]
        seg_path = src_dir / "data" / "annotations" / cid / f"{cid}.seg.nrrd"
        vol_path = volume_path(src_dir, cid)

        if not seg_path.exists() or not vol_path.exists():
            continue

        case_ann_dir = dst_ann / rand_id
        case_nii_dir = dst_nii / rand_id
        out_vol = case_nii_dir / f"{rand_id}_primary.nii.gz"
        out_lab = case_ann_dir / f"{rand_id}_labels.nii.gz"

        # Fast incremental check
        if out_vol.exists() and out_lab.exists():
            try:
                if out_vol.stat().st_mtime >= vol_path.stat().st_mtime:
                    worklist_rows.append({"case_id": rand_id, "patient_id": entry["patient_group"], "class": "bme"})
                    exported += 1
                    continue
            except Exception:
                pass

        src_img = nib.load(str(vol_path))
        sanitized_img = sanitize_nifti_header(src_img)

        data, header, segments = read_segmentation(seg_path)
        lab, _, _ = build_labelmap(data, segments)
        placed, _ = to_volume_grid(lab, header, src_img)

        lab_hdr = sanitized_img.header.copy()
        lab_hdr.set_data_dtype(np.uint8)
        sanitized_lab = nib.Nifti1Image(placed.astype(np.uint8), sanitized_img.affine, lab_hdr)
        sanitized_lab.header.extensions.clear()

        case_ann_dir.mkdir(parents=True, exist_ok=True)
        case_nii_dir.mkdir(parents=True, exist_ok=True)
        nib.save(sanitized_img, str(out_vol))
        nib.save(sanitized_lab, str(out_lab))

        worklist_rows.append({"case_id": rand_id, "patient_id": entry["patient_group"], "class": "bme"})
        exported += 1

    wl_path = dst_data / "worklist.csv"
    with wl_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["case_id", "patient_id", "class"])
        writer.writeheader()
        writer.writerows(worklist_rows)

    # Save private mapping locally in repo
    mapping_path = src_dir / "data" / "export_mapping.json"
    mapping_path.parent.mkdir(parents=True, exist_ok=True)
    mapping_path.write_text(json.dumps({"count": exported, "cases": manifest}, indent=2), encoding="utf-8")

    # Copy ML scripts into target
    dst_ml = target_dir / "ml" / "scripts"
    dst_ml.mkdir(parents=True, exist_ok=True)
    for f in (src_dir / "ml" / "scripts").glob("*.py"):
        shutil.copy2(f, dst_ml / f.name)

    # Build single bundle zip inside staging
    zip_path = target_dir / "bme_dataset_bundle.zip"
    print("Creating compressed dataset archive...")
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_STORED) as zf:
        for f in dst_data.rglob("*"):
            if f.is_file():
                zf.write(f, arcname=str(f.relative_to(target_dir)))
        for f in dst_ml.rglob("*"):
            if f.is_file():
                zf.write(f, arcname=str(f.relative_to(target_dir)))

    print(f"[OK] Dataset prepared: {exported} cases ({zip_path.stat().st_size / 1e6:.1f} MB)")
    return exported, zip_path


def get_kaggle_username(api: KaggleApi) -> str:
    cfg = api.read_config_file()
    username = cfg.get("username")
    if not username:
        # Fallback to env or api config
        username = os.getenv("KAGGLE_USERNAME") or api.get_config_value("username")
    if not username:
        raise ValueError("Could not determine Kaggle username from ~/.kaggle/kaggle.json")
    return username


def push_dataset_to_kaggle(api: KaggleApi, staging_dir: Path, username: str):
    dataset_id = f"{username}/{DATASET_SLUG}"
    meta_path = staging_dir / "dataset-metadata.json"
    meta = {
        "title": "BME 3D Dataset",
        "id": dataset_id,
        "licenses": [{"name": "CC0-1.0"}],
        "isPrivate": True,
    }
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    # Check if dataset already exists
    existing = [d.ref for d in api.dataset_list(user=username)]
    if dataset_id in existing:
        print(f"Dataset {dataset_id} exists on Kaggle. Creating new version...")
        api.dataset_create_version(
            folder=str(staging_dir),
            version_notes="Automated update",
            dir_mode="zip",
            quiet=False,
        )
    else:
        print(f"Creating new private Kaggle dataset: {dataset_id}...")
        api.dataset_create_new(
            folder=str(staging_dir),
            dir_mode="zip",
            quiet=False,
        )
    print(f"[OK] Kaggle dataset ready: {dataset_id}")


def build_kernel_script(username: str) -> str:
    import base64
    train_3d_code = (REPO_ROOT / "ml" / "scripts" / "train_3d.py").read_bytes()
    b64_code = base64.b64encode(train_3d_code).decode("ascii")

    return f'''"""Auto-generated Kaggle GPU training runner for 3D U-Net."""
import base64
import os
import subprocess
import sys
import zipfile
from pathlib import Path

print("=" * 60)
print("KAGGLE GPU 3D U-NET TRAINING RUNNER")
print("=" * 60)

# 1. Check dependencies (nibabel is pre-installed in Kaggle GPU)
try:
    import nibabel
    print("[OK] nibabel is available")
except ImportError:
    try:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "nibabel"], timeout=30)
    except Exception:
        pass

# 2. Extract dataset bundle to local SSD
input_dir = Path("/kaggle/input/{DATASET_SLUG}")
working_dir = Path("/kaggle/working")
project_dir = working_dir / "bme_project"
project_dir.mkdir(parents=True, exist_ok=True)

# Look for bundle zip in input
zip_candidates = list(input_dir.glob("*.zip"))
if zip_candidates:
    bundle_zip = zip_candidates[0]
    print(f"Unpacking {{bundle_zip.name}} to {{project_dir}}...")
    with zipfile.ZipFile(bundle_zip, 'r') as zf:
        zf.extractall(str(project_dir))
else:
    # If uncompressed
    print(f"Using uncompressed input at {{input_dir}}")
    project_dir = input_dir

print("Dataset unpacked. Files in project:")
for p in (project_dir / "data").iterdir():
    print(f"  {{p.name}}")

# 3. Output directory in /kaggle/working
out_dir = working_dir / "results3d"
out_dir.mkdir(parents=True, exist_ok=True)

# 4. Write self-contained train_3d.py directly into working dir using base64
train_script = working_dir / "train_3d.py"
raw_code = base64.b64decode("""{b64_code}""")
train_script.write_bytes(raw_code)
print(f"Self-contained train_3d.py restored ({{len(raw_code)}} bytes)")

cmd = [
    sys.executable, "-u", str(train_script), str(project_dir),
    "--device", "cuda",
    "--amp",
    "--resume",
    "--checkpoint-every-epoch",
    "--epochs", "40",
    "--folds", "5",
    "--out-dir", str(out_dir),
]
print("\\nStarting training command:")
print(" ".join(cmd))
print("=" * 60)

subprocess.run(cmd, check=True)

# 5. Bundle results into results3d.zip
zip_path = working_dir / "results3d.zip"
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
    for pt in out_dir.glob("fold_*.pt"):
        zf.write(pt, arcname=pt.name)
    metrics_f = out_dir / "metrics.json"
    if metrics_f.exists():
        zf.write(metrics_f, arcname="metrics.json")

print(f"\\n[OK] Training complete! Packaged results to: {{zip_path}}")
'''


def push_kernel_to_kaggle(api: KaggleApi, username: str):
    kernel_dir = STAGING_DIR / "kernel"
    kernel_dir.mkdir(parents=True, exist_ok=True)

    # Copy latest local scripts into kernel folder
    shutil.copy2(REPO_ROOT / "ml" / "scripts" / "train_3d.py", kernel_dir / "train_3d.py")
    shutil.copy2(REPO_ROOT / "ml" / "scripts" / "seg2nifti.py", kernel_dir / "seg2nifti.py")

    script_path = kernel_dir / "train_kaggle_kernel.py"
    script_path.write_text(build_kernel_script(username), encoding="utf-8")

    meta_path = kernel_dir / "kernel-metadata.json"
    meta = {
        "id": f"{username}/{KERNEL_SLUG}",
        "title": "BME 3D UNet Training",
        "code_file": "train_kaggle_kernel.py",
        "language": "python",
        "kernel_type": "script",
        "is_private": True,
        "enable_gpu": True,
        "enable_internet": True,
        "dataset_sources": [
            f"{username}/{DATASET_SLUG}"
        ],
    }
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    print(f"Pushing GPU training kernel to Kaggle: {username}/{KERNEL_SLUG}...")
    api.kernels_push(str(kernel_dir))
    print(f"[OK] Kernel pushed! Kaggle is now running training in the cloud on NVIDIA GPU.")
    print("  You can now close your laptop and turn it off anytime — it trains in Google's cloud!")


def check_status(api: KaggleApi, username: str, as_json: bool = False):
    kernel_ref = f"{username}/{KERNEL_SLUG}"
    try:
        status_res = api.kernels_status(kernel_ref)
        if hasattr(status_res, "status"):
            raw_s = status_res.status
            status = getattr(raw_s, "name", str(raw_s)).lower()
            if "kernelworkerstatus." in status:
                status = status.split("kernelworkerstatus.")[-1].lower()
            failure_msg = getattr(status_res, "failure_message", "") or getattr(status_res, "failureMessage", "") or ""
        elif isinstance(status_res, dict):
            status = str(status_res.get("status", "unknown")).lower()
            failure_msg = status_res.get("failureMessage", "") or ""
        else:
            status = str(status_res).lower()
            failure_msg = ""
    except Exception as e:
        err_str = str(e)
        if "Cannot access kernel" in err_str or "404" in err_str:
            status = "idle"
            failure_msg = "Kernel not yet started on Kaggle"
        else:
            status = "error"
            failure_msg = err_str

    if as_json:
        print(json.dumps({"status": status, "failureMessage": failure_msg, "kernel": kernel_ref}))
        return status

    print("=" * 60)
    print(f"Kaggle Job Status [{kernel_ref}]:")
    print(f"  Status   : {status.upper()}")
    if failure_msg:
        print(f"  Message  : {failure_msg}")
    print("=" * 60)
    return status


def download_results(api: KaggleApi, username: str, dest_dir: Path):
    kernel_ref = f"{username}/{KERNEL_SLUG}"
    print(f"Checking outputs for {kernel_ref}...")
    dest_dir.mkdir(parents=True, exist_ok=True)

    temp_dl = STAGING_DIR / "download"
    temp_dl.mkdir(parents=True, exist_ok=True)

    try:
        api.kernels_output(kernel_ref, path=str(temp_dl))
    except Exception as e:
        err_msg = str(e)
        if "Cannot access kernel" in err_msg or "Forbidden" in err_msg or "403" in err_msg or "404" in err_msg:
            print(f"[INFO] No outputs found on Kaggle yet for {kernel_ref}.")
            print("Please click 'Train on Kaggle GPU' first to run the cloud training.")
            return
        raise

    print("Output files downloaded from Kaggle:")

    # Look for results3d.zip or fold_*.pt
    zip_candidates = list(temp_dl.glob("*.zip"))
    if zip_candidates:
        with zipfile.ZipFile(zip_candidates[0], "r") as zf:
            zf.extractall(str(dest_dir))
            print(f"[OK] Extracted weights from {zip_candidates[0].name} to {dest_dir}")
    else:
        for f in temp_dl.rglob("*"):
            if f.is_file() and (f.suffix == ".pt" or f.suffix == ".json"):
                shutil.copy2(f, dest_dir / f.name)
                print(f"  [OK] Copied {f.name} -> {dest_dir / f.name}")

    print(f"\n[OK] Training results imported into {dest_dir}!")


def main():
    parser = argparse.ArgumentParser(description="Automated Kaggle GPU Training Pipeline")
    parser.add_argument("--start", "--push", dest="start", action="store_true", help="Package data and launch GPU training on Kaggle")
    parser.add_argument("--status", action="store_true", help="Check Kaggle GPU training status")
    parser.add_argument("--download", action="store_true", help="Download trained weights to data/results3d")
    parser.add_argument("--watch", action="store_true", help="Start and monitor until complete, then auto-download")
    parser.add_argument("--monitor", action="store_true", help="Monitor currently running job and auto-download on completion")
    parser.add_argument("--json", action="store_true", help="Output machine-readable JSON")
    args = parser.parse_args()

    api = KaggleApi()
    api.authenticate()
    username = get_kaggle_username(api)
    if not args.json:
        print(f"Authenticated Kaggle user: {username}")

    if args.start or (args.watch and not args.monitor):
        export_dataset(REPO_ROOT, STAGING_DIR)
        push_dataset_to_kaggle(api, STAGING_DIR, username)
        # Give Kaggle a brief moment to register dataset
        time.sleep(3)
        push_kernel_to_kaggle(api, username)

    if args.watch or args.monitor:
        print("\nMonitoring training progress in Kaggle cloud...")
        while True:
            time.sleep(30)
            status = check_status(api, username, as_json=False)
            if status in ("complete", "error", "failed"):
                break
        if status == "complete":
            download_results(api, username, REPO_ROOT / "data" / "results3d")
        else:
            print("Training finished with error. Inspect logs on Kaggle.")
        return

    if args.status:
        check_status(api, username, as_json=args.json)
        return

    if args.download:
        download_results(api, username, REPO_ROOT / "data" / "results3d")
        return

    if not (args.start or args.status or args.download or args.watch):
        parser.print_help()


if __name__ == "__main__":
    main()


