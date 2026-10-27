"""Validate, verify, and safely import 3D U-Net model weights and metrics.

Usage:
    python ml/scripts/verify_and_import_weights.py <src_zip_or_dir> <dest_results3d_dir>

Security & Validation:
- Restricts files strictly to fold_<k>.pt and metrics.json.
- Rejects path traversal (zip-slip) and absolute paths.
- Enforces max total payload size (50 MB).
- Backs up existing destination directory prior to writing.
- Validates every .pt file with torch.load(weights_only=True, map_location="cpu")
  and confirms all keys and tensor shapes match UNet3D.state_dict().
- Validates metrics.json structure.
- Outputs machine-readable JSON status to stdout.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_3d import UNet3D  # noqa: E402

MAX_ZIP_BYTES = 10 * 1024 * 1024          # 10 MB compressed zip
MAX_UNCOMPRESSED_BYTES = 10 * 1024 * 1024 # 10 MB total uncompressed
MAX_FILES = 10                            # Max 10 files (headroom for 5-8 folds + metrics)
MAX_PT_BYTES = 2 * 1024 * 1024           # 2 MB per checkpoint (measured real: ~627 KB)
MAX_METRICS_BYTES = 200 * 1024           # 200 KB for metrics.json (measured real: ~3-10 KB)
MAX_RATIO = 20.0                         # Max compression ratio to block decompression bombs
ALLOWED_FILE_PATTERN = re.compile(r"^(fold_\d+\.pt|metrics\.json)$")


def verify_pt_file(path: Path) -> tuple[bool, str]:
    try:
        blob = torch.load(str(path), map_location="cpu", weights_only=True)
        if not isinstance(blob, dict) or "state" not in blob:
            return False, "Checkpoint missing 'state' dict"
        state = blob["state"]
        expected_state = UNet3D().state_dict()
        
        # Check keys match exactly
        if set(state.keys()) != set(expected_state.keys()):
            missing = set(expected_state.keys()) - set(state.keys())
            unexpected = set(state.keys()) - set(expected_state.keys())
            err = []
            if missing:
                err.append(f"missing {len(missing)} keys")
            if unexpected:
                err.append(f"unexpected {len(unexpected)} keys")
            return False, f"Key mismatch: {'; '.join(err)}"
        
        # Check shapes match
        for k, v in expected_state.items():
            if state[k].shape != v.shape:
                return False, f"Tensor shape mismatch for {k}: got {state[k].shape}, expected {v.shape}"
        return True, "valid"
    except Exception as e:
        return False, f"Torch load error: {type(e).__name__}: {e}"


def verify_metrics_file(path: Path) -> tuple[bool, str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return False, "metrics.json must be a JSON object"
        if "summary" not in data and "per_fold" not in data:
            return False, "metrics.json missing required 'summary' or 'per_fold' fields"
        return True, "valid"
    except Exception as e:
        return False, f"JSON parse error: {e}"


def process_import(src_path: Path, dest_dir: Path) -> dict:
    if not src_path.exists():
        return {"success": False, "error": f"Source file does not exist: {src_path}", "files": []}

    file_results: list[dict] = []
    
    with tempfile.TemporaryDirectory() as staging_dir_str:
        staging_dir = Path(staging_dir_str)
        staged_files: list[Path] = []

        if src_path.is_file() and src_path.suffix.lower() == ".zip":
            # 1. Inspect zip file for size & path traversal (zip-slip)
            if src_path.stat().st_size > MAX_ZIP_BYTES:
                return {"success": False, "error": f"Zip file exceeds maximum size of {MAX_ZIP_BYTES // (1024*1024)} MB", "files": []}

            try:
                with zipfile.ZipFile(src_path, "r") as zf:
                    members = [m for m in zf.infolist() if not m.is_dir()]

                    if len(members) > MAX_FILES:
                        return {"success": False, "error": f"Too many files in archive ({len(members)} > {MAX_FILES})", "files": []}

                    total_uncompressed = sum(info.file_size for info in members)
                    if total_uncompressed > MAX_UNCOMPRESSED_BYTES:
                        return {"success": False, "error": f"Total uncompressed size exceeds {MAX_UNCOMPRESSED_BYTES // (1024*1024)} MB limit", "files": []}

                    for member in members:
                        # Security check: zip-slip and path traversal
                        norm_name = member.filename.replace("\\", "/")
                        parts = norm_name.split("/")
                        if ".." in parts or os.path.isabs(norm_name) or norm_name.startswith("/"):
                            return {"success": False, "error": f"Path traversal detected in zip member: {member.filename}", "files": []}

                        base_name = parts[-1]
                        if not ALLOWED_FILE_PATTERN.match(base_name):
                            return {"success": False, "error": f"Disallowed file inside zip: {member.filename}. Allowed: fold_<k>.pt and metrics.json", "files": []}

                        # Per-file size check
                        if base_name.endswith(".pt") and member.file_size > MAX_PT_BYTES:
                            return {"success": False, "error": f"Checkpoint {base_name} ({member.file_size} bytes) exceeds {MAX_PT_BYTES // (1024*1024)} MB limit", "files": []}
                        if base_name == "metrics.json" and member.file_size > MAX_METRICS_BYTES:
                            return {"success": False, "error": f"Metrics file exceeds {MAX_METRICS_BYTES // 1024} KB limit", "files": []}

                        # Compression ratio check (zip bomb defense)
                        if member.compress_size > 0:
                            ratio = member.file_size / member.compress_size
                            if ratio > MAX_RATIO:
                                return {"success": False, "error": f"High compression ratio ({ratio:.1f}x > {MAX_RATIO}x) on {member.filename}", "files": []}

                        # Safe extraction to staging
                        target_staged = staging_dir / base_name
                        with zf.open(member) as source_f, open(target_staged, "wb") as target_f:
                            shutil.copyfileobj(source_f, target_f)
                        staged_files.append(target_staged)
            except zipfile.BadZipFile:
                return {"success": False, "error": "Invalid or corrupt zip file", "files": []}
        elif src_path.is_dir():
            for p in src_path.iterdir():
                if p.is_file():
                    if not ALLOWED_FILE_PATTERN.match(p.name):
                        return {"success": False, "error": f"Disallowed file in upload: {p.name}", "files": []}
                    target_staged = staging_dir / p.name
                    shutil.copy2(p, target_staged)
                    staged_files.append(target_staged)
        elif src_path.is_file():
            # Single file upload (.pt or .json)
            if not ALLOWED_FILE_PATTERN.match(src_path.name):
                return {"success": False, "error": f"Disallowed file: {src_path.name}", "files": []}
            target_staged = staging_dir / src_path.name
            shutil.copy2(src_path, target_staged)
            staged_files.append(target_staged)

        if not staged_files:
            return {"success": False, "error": "No valid model files found in upload", "files": []}

        # 2. Verify all staged files
        all_ok = True
        for f in sorted(staged_files, key=lambda x: x.name):
            if f.name.endswith(".pt"):
                ok, msg = verify_pt_file(f)
            else:
                ok, msg = verify_metrics_file(f)
            
            file_results.append({
                "name": f.name,
                "status": "ok" if ok else "failed",
                "message": msg
            })
            if not ok:
                all_ok = False

        if not all_ok:
            return {
                "success": False,
                "error": "One or more files failed verification",
                "files": file_results
            }

        # 3. Create backup of destination if existing weights are present
        dest_dir.mkdir(parents=True, exist_ok=True)
        existing_weights = list(dest_dir.glob("fold_*.pt")) + list(dest_dir.glob("metrics.json"))
        if existing_weights:
            ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_dir = dest_dir.parent / f"results3d_backup_{ts}"
            backup_dir.mkdir(parents=True, exist_ok=True)
            for ew in existing_weights:
                shutil.copy2(ew, backup_dir / ew.name)

        # 4. Copy staged files to destination
        for f in staged_files:
            shutil.copy2(f, dest_dir / f.name)

        return {
            "success": True,
            "count": len(staged_files),
            "files": file_results
        }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="Path to zip file, directory, or individual file")
    ap.add_argument("dest", help="Destination results3d directory")
    args = ap.parse_args()

    src_path = Path(args.src).resolve()
    dest_path = Path(args.dest).resolve()

    res = process_import(src_path, dest_path)
    print(json.dumps(res, indent=2))
    sys.exit(0 if res.get("success") else 1)


if __name__ == "__main__":
    main()
