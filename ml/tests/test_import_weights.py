"""Automated security and validation tests for 3D weights import.

Tests:
1. Zip-slip path traversal rejection (e.g. ../../escape.txt)
2. Disallowed filenames rejection (e.g. hack.py, evil.sh)
3. Oversized payload rejection (> 10 MB total)
4. High-ratio compression bomb rejection (> 20x ratio)
5. Excessive file count rejection (> 10 files)
6. Corrupt / mismatched checkpoint rejection (invalid architecture keys)
7. Real-format checkpoint verification (exact payload saved by train_3d.py)
8. Valid results3d.zip import with automatic backup of existing weights
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

repo_root = Path(__file__).resolve().parent.parent.parent
python_exe = repo_root / "ml" / ".venv" / "Scripts" / "python.exe"
verifier_script = repo_root / "ml" / "scripts" / "verify_and_import_weights.py"

sys.path.insert(0, str(repo_root / "ml" / "scripts"))
import torch
from train_3d import UNet3D, PATCH, SEED


def run_verifier(src_path: Path, dest_dir: Path) -> tuple[int, dict]:
    res = subprocess.run(
        [str(python_exe), str(verifier_script), str(src_path), str(dest_dir)],
        capture_output=True,
        text=True,
    )
    try:
        data = json.loads(res.stdout)
    except Exception:
        data = {"stdout": res.stdout, "stderr": res.stderr}
    return res.returncode, data


def test_zip_slip_rejected():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        zip_path = tmp / "slip.zip"
        dest = tmp / "results3d"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("../../evil.txt", "malicious payload")
        code, out = run_verifier(zip_path, dest)
        assert code != 0, "Zip-slip attack should fail"
        assert out.get("success") is False
        assert "Path traversal" in out.get("error", "") or "Disallowed" in out.get("error", "")
        print("[PASS] Zip-slip attack rejected")


def test_wrong_filenames_rejected():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        zip_path = tmp / "bad_names.zip"
        dest = tmp / "results3d"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("hack.py", "print('attack')")
            zf.writestr("fold_0.pt", "dummy")
        code, out = run_verifier(zip_path, dest)
        assert code != 0, "Disallowed filename should fail"
        assert out.get("success") is False
        assert "Disallowed file" in out.get("error", "")
        print("[PASS] Wrong filenames rejected")


def test_oversize_payload_rejected():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        dest = tmp / "results3d"
        zip_path = tmp / "oversize.zip"
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("fold_0.pt", b"\x00" * (11 * 1024 * 1024))
        code, out = run_verifier(zip_path, dest)
        assert code != 0, "Oversize uncompressed payload should fail"
        assert out.get("success") is False
        assert "exceeds" in out.get("error", "").lower()
        print("[PASS] Oversize payload rejected")


def test_high_ratio_zip_bomb_rejected():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        dest = tmp / "results3d"
        zip_path = tmp / "zipbomb.zip"
        # Highly compressible repeating stream: 1.5 MB uncompressed, compressed to < 10 KB (ratio > 100x)
        repeated_data = b"0" * (1500 * 1024)
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("fold_0.pt", repeated_data)
        code, out = run_verifier(zip_path, dest)
        assert code != 0, "High ratio zip bomb should fail"
        assert out.get("success") is False
        assert "compression ratio" in out.get("error", "").lower()
        print("[PASS] High-ratio zip bomb rejected before extraction")


def test_too_many_files_rejected():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        dest = tmp / "results3d"
        zip_path = tmp / "too_many.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            for i in range(15):
                zf.writestr(f"fold_{i}.pt", "small")
        code, out = run_verifier(zip_path, dest)
        assert code != 0, "Excessive file count should fail"
        assert out.get("success") is False
        assert "Too many files" in out.get("error", "")
        print("[PASS] Excessive file count rejected before extraction")


def test_bad_checkpoint_rejected():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        dest = tmp / "results3d"
        fake_pt = tmp / "fold_0.pt"
        torch.save({"state": {"unexpected_conv.weight": torch.randn(2, 2, 3)}}, fake_pt)
        zip_path = tmp / "bad_ckpt.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.write(fake_pt, "fold_0.pt")
        code, out = run_verifier(zip_path, dest)
        assert code != 0, "Mismatched architecture checkpoint should fail"
        assert out.get("success") is False
        assert any("mismatch" in f.get("message", "").lower() for f in out.get("files", []))
        print("[PASS] Bad checkpoint rejected")


def test_real_format_checkpoint_verified():
    """Step 1 & 3 test: produce real checkpoint as train_3d.py writes, verify with weights_only=True."""
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        dest = tmp / "results3d"
        m = UNet3D()
        real_payload = {"state": m.state_dict(), "patch": PATCH, "seed": SEED}
        real_pt = tmp / "fold_0.pt"
        torch.save(real_payload, real_pt)

        # Check real size
        size = real_pt.stat().st_size
        assert size < 1024 * 1024, f"Real checkpoint size {size} unexpectedly large"

        metrics_file = tmp / "metrics.json"
        metrics_file.write_text(json.dumps({
            "model": "3d-unet",
            "summary": {"bone_dice": {"mean": 0.85, "std": 0.02}},
            "per_fold": []
        }))

        zip_path = tmp / "real_results3d.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.write(real_pt, "fold_0.pt")
            zf.write(metrics_file, "metrics.json")

        code, out = run_verifier(zip_path, dest)
        assert code == 0, f"Real format verification failed: {out}"
        assert out.get("success") is True
        assert (dest / "fold_0.pt").exists()
        print(f"[PASS] Real-format checkpoint verified ({size/1024:.1f} KB, weights_only=True)")


def test_valid_import_and_backup():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        dest = tmp / "results3d"
        dest.mkdir()
        (dest / "fold_0.pt").write_text("prior_checkpoint_contents")
        (dest / "metrics.json").write_text('{"summary": {}}')

        # Build valid checkpoint
        m = UNet3D()
        valid_pt = tmp / "fold_1.pt"
        torch.save({"state": m.state_dict(), "patch": PATCH, "seed": SEED}, valid_pt)
        valid_metrics = tmp / "metrics.json"
        valid_metrics.write_text(json.dumps({"model": "3d-unet", "summary": {}, "per_fold": []}))

        valid_zip = tmp / "results3d.zip"
        with zipfile.ZipFile(valid_zip, "w") as zf:
            zf.write(valid_pt, "fold_1.pt")
            zf.write(valid_metrics, "metrics.json")

        code, out = run_verifier(valid_zip, dest)
        assert code == 0, f"Valid import failed: {out}"
        assert out.get("success") is True
        assert (dest / "fold_1.pt").exists()

        # Check backup created
        backups = list(tmp.glob("results3d_backup_*"))
        assert len(backups) == 1, "Backup directory not created"
        assert (backups[0] / "fold_0.pt").read_text() == "prior_checkpoint_contents"
        print("[PASS] Valid import and backup verified")


if __name__ == "__main__":
    print("Running weights import security test suite...\n")
    test_zip_slip_rejected()
    test_wrong_filenames_rejected()
    test_oversize_payload_rejected()
    test_high_ratio_zip_bomb_rejected()
    test_too_many_files_rejected()
    test_bad_checkpoint_rejected()
    test_real_format_checkpoint_verified()
    test_valid_import_and_backup()
    print("\n[SUCCESS] ALL 8 IMPORT SECURITY & REAL-FORMAT TESTS PASSED SUCCESSFULLY!")
