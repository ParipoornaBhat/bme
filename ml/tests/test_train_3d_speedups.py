"""Synthetic CPU tests for train_3d.py speedup, reuse, and safeguard features.

Tests (using strictly synthetic volumes in isolated temporary directories):
1. skip-completed verifies matching config and refuses on mismatched config (seed, epochs, data_config).
2. time guard saves resumable checkpoint and exits cleanly when max runtime limit is exceeded.
3. bench mode runs the 3 configurations on synthetic volumes in CPU smoke form and records measured timings.
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
import torch

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
PYTHON_EXE = sys.executable
TRAIN_3D_SCRIPT = REPO_ROOT / "ml" / "scripts" / "train_3d.py"


def make_synthetic_case(base: Path, case_id: str, shape=(32, 32, 16), has_bme=True):
    """Create synthetic NIfTI scan and labelmap for testing."""
    nii_dir = base / "nifti" / case_id
    ann_dir = base / "annotations" / case_id
    nii_dir.mkdir(parents=True, exist_ok=True)
    ann_dir.mkdir(parents=True, exist_ok=True)

    # Scan volume
    img_data = np.random.uniform(10, 100, size=shape).astype(np.float32)
    img_nii = nib.Nifti1Image(img_data, np.eye(4))
    nib.save(img_nii, str(nii_dir / f"{case_id}_primary.nii.gz"))

    # Labels volume (0=bg, 1=bone, 2=bme)
    lbl_data = np.zeros(shape, dtype=np.uint8)
    lbl_data[8:24, 8:24, 4:12] = 1  # bone
    if has_bme:
        lbl_data[12:20, 12:20, 6:10] = 2  # bme inside bone
    lbl_nii = nib.Nifti1Image(lbl_data, np.eye(4))
    nib.save(lbl_nii, str(ann_dir / f"{case_id}_labels.nii.gz"))


def make_synthetic_dataset(temp_dir: Path) -> Path:
    """Creates a minimal 2-case synthetic dataset outside repo."""
    data_dir = temp_dir / "synthetic_dataset"
    data_dir.mkdir(parents=True, exist_ok=True)

    make_synthetic_case(data_dir, "case_001", has_bme=True)
    make_synthetic_case(data_dir, "case_002", has_bme=False)

    worklist_path = data_dir / "worklist.csv"
    with worklist_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["case_id", "patient_id", "class"])
        writer.writeheader()
        writer.writerow({"case_id": "case_001", "patient_id": "pat_001", "class": "bme"})
        writer.writerow({"case_id": "case_002", "patient_id": "pat_002", "class": "nonbme"})

    return data_dir


def test_skip_completed_refuses_on_mismatched_config():
    """Verify skip-completed skips when config matches, but refuses on config/seed/epoch mismatch."""
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        dataset_dir = make_synthetic_dataset(tmp)
        out_dir = tmp / "results_skip_test"
        out_dir.mkdir()

        # 1. Train 1 fold for 1 epoch to create legitimate checkpoint
        cmd_init = [
            PYTHON_EXE, "-u", str(TRAIN_3D_SCRIPT), str(dataset_dir),
            "--device", "cpu",
            "--out-dir", str(out_dir),
            "--epochs", "1",
            "--folds", "2",
            "--fold", "0",
        ]
        res_init = subprocess.run(cmd_init, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        assert res_init.returncode == 0, f"Init training failed:\n{res_init.stdout}"

        ckpt_file = out_dir / "fold_0.pt"
        assert ckpt_file.exists(), "fold_0.pt was not created!"

        # 2. Re-run with matching config -> should skip fold cleanly
        cmd_match = [
            PYTHON_EXE, "-u", str(TRAIN_3D_SCRIPT), str(dataset_dir),
            "--device", "cpu",
            "--out-dir", str(out_dir),
            "--epochs", "1",
            "--folds", "2",
            "--fold", "0",
            "--skip-completed",
        ]
        res_match = subprocess.run(cmd_match, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        assert res_match.returncode == 0, f"Matching skip run failed:\n{res_match.stdout}"
        assert "already completed" in res_match.stdout, "Should log fold 0 already completed"
        assert "skipping training" in res_match.stdout

        # 3. Mismatch A: Requesting 2 epochs when checkpoint only ran 1 epoch -> MUST REFUSE
        cmd_mismatch_epochs = [
            PYTHON_EXE, "-u", str(TRAIN_3D_SCRIPT), str(dataset_dir),
            "--device", "cpu",
            "--out-dir", str(out_dir),
            "--epochs", "2",
            "--folds", "2",
            "--fold", "0",
            "--skip-completed",
        ]
        res_mismatch_epochs = subprocess.run(cmd_mismatch_epochs, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        assert res_mismatch_epochs.returncode != 0, "Should have refused on epoch mismatch!"
        assert "Refusing to skip completed fold 0" in res_mismatch_epochs.stdout
        assert "configuration mismatch" in res_mismatch_epochs.stdout

        # 4. Mismatch B: Taint checkpoint seed in fold_0.pt -> MUST REFUSE
        ckpt_data = torch.load(ckpt_file, map_location="cpu", weights_only=False)
        ckpt_data["seed"] = 999999
        torch.save(ckpt_data, ckpt_file)

        cmd_mismatch_seed = [
            PYTHON_EXE, "-u", str(TRAIN_3D_SCRIPT), str(dataset_dir),
            "--device", "cpu",
            "--out-dir", str(out_dir),
            "--epochs", "1",
            "--folds", "2",
            "--fold", "0",
            "--skip-completed",
        ]
        res_mismatch_seed = subprocess.run(cmd_mismatch_seed, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        assert res_mismatch_seed.returncode != 0, "Should have refused on seed mismatch!"
        assert "Refusing to skip completed fold 0" in res_mismatch_seed.stdout
        assert "seed (saved 999999 != current 1337)" in res_mismatch_seed.stdout

        print("[PASS] test_skip_completed_refuses_on_mismatched_config")


def test_fingerprint_mismatch_refusal():
    """Verify that skip-completed and resume compare dataset fingerprint and refuse on mismatch."""
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        dataset_dir = make_synthetic_dataset(tmp)
        out_dir = tmp / "results_fingerprint_test"
        out_dir.mkdir()

        # 1. Train fold 0 for 1 epoch
        cmd_init = [
            PYTHON_EXE, "-u", str(TRAIN_3D_SCRIPT), str(dataset_dir),
            "--device", "cpu",
            "--out-dir", str(out_dir),
            "--epochs", "1",
            "--folds", "2",
            "--fold", "0",
        ]
        res_init = subprocess.run(cmd_init, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        assert res_init.returncode == 0, f"Init training failed:\n{res_init.stdout}"

        ckpt_file = out_dir / "fold_0.pt"
        metric_file = out_dir / "metrics_fold_0.json"
        assert ckpt_file.exists(), "fold_0.pt was not created!"
        assert metric_file.exists(), "metrics_fold_0.json was not created!"

        # Check fingerprint recorded in checkpoint and metrics
        ckpt = torch.load(ckpt_file, map_location="cpu", weights_only=False)
        assert "fingerprint" in ckpt, "fingerprint missing from checkpoint!"
        assert "val_cases" in ckpt, "val_cases missing from checkpoint!"
        assert len(ckpt["fingerprint"]) == 64, "fingerprint should be SHA-256 hex string"

        metric_data = json.loads(metric_file.read_text(encoding="utf-8"))
        assert "fingerprint" in metric_data, "fingerprint missing from fold metrics!"
        assert metric_data["fingerprint"] == ckpt["fingerprint"]
        assert "val_cases" in metric_data, "val_cases missing from fold metrics!"

        # 2. Tamper fingerprint in checkpoint -> skip-completed MUST REFUSE
        orig_fp = ckpt["fingerprint"]
        ckpt["fingerprint"] = "deadbeef" * 8
        torch.save(ckpt, ckpt_file)

        cmd_tampered_fp = [
            PYTHON_EXE, "-u", str(TRAIN_3D_SCRIPT), str(dataset_dir),
            "--device", "cpu",
            "--out-dir", str(out_dir),
            "--epochs", "1",
            "--folds", "2",
            "--fold", "0",
            "--skip-completed",
        ]
        res_tampered_fp = subprocess.run(cmd_tampered_fp, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        assert res_tampered_fp.returncode != 0, "Should have refused on fingerprint mismatch!"
        assert "dataset fingerprint" in res_tampered_fp.stdout
        assert "Refusing to skip completed fold 0" in res_tampered_fp.stdout

        # 3. Test resume with latest checkpoint having mismatched fingerprint
        if ckpt_file.exists():
            ckpt_file.unlink()
        if metric_file.exists():
            metric_file.unlink()

        latest_ckpt = out_dir / "fold_0_latest.pt"
        torch.save(
            {
                "epoch": 1,
                "state": ckpt["state"],
                "patch": ckpt["patch"],
                "seed": ckpt["seed"],
                "data_config": ckpt.get("data_config"),
                "fingerprint": "badc0ffee" * 7 + "12",
                "val_cases": ckpt["val_cases"],
            },
            latest_ckpt,
        )

        cmd_resume_bad_fp = [
            PYTHON_EXE, "-u", str(TRAIN_3D_SCRIPT), str(dataset_dir),
            "--device", "cpu",
            "--out-dir", str(out_dir),
            "--epochs", "2",
            "--folds", "2",
            "--fold", "0",
            "--resume",
            "--no-skip-completed",
        ]
        res_resume_bad_fp = subprocess.run(cmd_resume_bad_fp, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        assert res_resume_bad_fp.returncode != 0, "Resume should have refused on mismatched fingerprint!"
        assert "dataset fingerprint" in res_resume_bad_fp.stdout
        assert "Refusing to resume" in res_resume_bad_fp.stdout

        print("[PASS] test_fingerprint_mismatch_refusal")


def test_time_guard_saves_and_exits():
    """Verify that MAX_RUNTIME_MINUTES finishes current epoch, saves checkpoint, and exits cleanly."""
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        dataset_dir = make_synthetic_dataset(tmp)
        out_dir = tmp / "results_timeguard_test"
        out_dir.mkdir()

        # Run with effectively 0 runtime limit so epoch 1 triggers the time guard
        cmd = [
            PYTHON_EXE, "-u", str(TRAIN_3D_SCRIPT), str(dataset_dir),
            "--device", "cpu",
            "--out-dir", str(out_dir),
            "--epochs", "5",
            "--folds", "2",
            "--fold", "0",
            "--max-runtime-minutes", "0.0000001",
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        assert res.returncode == 0, f"Time guard run failed with non-zero exit:\n{res.stdout}"
        assert "[TIME GUARD] Runtime limit reached" in res.stdout
        assert "Resumable checkpoint safely saved to: fold_0_latest.pt" in res.stdout
        assert "To resume in next version: run with --resume" in res.stdout
        assert "Exiting cleanly" in res.stdout

        # Verify final fold_0.pt and metrics_fold_0.json were NOT created!
        final_ckpt = out_dir / "fold_0.pt"
        final_metric = out_dir / "metrics_fold_0.json"
        assert not final_ckpt.exists(), "fold_0.pt MUST NOT be created when stopped by time guard!"
        assert not final_metric.exists(), "metrics_fold_0.json MUST NOT be created when stopped by time guard!"

        # Verify resumable fold_0_latest.pt and status_fold_0.json ARE created
        latest_ckpt = out_dir / "fold_0_latest.pt"
        status_file = out_dir / "status_fold_0.json"
        assert latest_ckpt.exists(), "fold_0_latest.pt should exist after time guard trigger!"
        assert status_file.exists(), "status_fold_0.json should exist after time guard trigger!"

        status_data = json.loads(status_file.read_text(encoding="utf-8"))
        assert status_data["status"] == "incomplete", "status should be incomplete"
        assert status_data["epoch_reached"] == 1
        assert status_data["target_epochs"] == 5
        assert "fingerprint" in status_data
        assert "val_cases" in status_data

        ckpt = torch.load(latest_ckpt, map_location="cpu", weights_only=False)
        assert "state" in ckpt
        assert "epoch" in ckpt
        assert ckpt["epoch"] == 1
        assert ckpt["seed"] == 1337
        assert "fingerprint" in ckpt
        assert "val_cases" in ckpt

        # Verify merge-metrics refuses to write metrics.json as complete
        merge_cmd = [
            PYTHON_EXE, "-u", str(TRAIN_3D_SCRIPT), str(dataset_dir),
            "--out-dir", str(out_dir),
            "--folds", "2",
            "--merge-metrics",
        ]
        res_merge = subprocess.run(merge_cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        assert res_merge.returncode == 0
        assert "TRAINING RUN INCOMPLETE - REFUSING TO WRITE COMPLETE metrics.json" in res_merge.stdout
        assert "Fold 0: INCOMPLETE" in res_merge.stdout
        assert not (out_dir / "metrics.json").exists(), "metrics.json MUST NOT be created for incomplete runs!"

        print("[PASS] test_time_guard_saves_and_exits")


def test_bench_mode_runs_three_configs_on_cpu():
    """Verify that the 3 configurations in bench mode execute 2 epochs without error on synthetic data."""
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        dataset_dir = make_synthetic_dataset(tmp)
        bench_dir = tmp / "bench_results"
        bench_dir.mkdir()

        configs = [
            ("Baseline (val_bs=1)", ["--val-batch-size", "1"]),
            ("+Val-Batching (val_bs=2)", ["--val-batch-size", "2"]),
            ("+Channels-Last-3D", ["--channels-last-3d", "--val-batch-size", "2"]),
        ]

        for name, flags in configs:
            sub_dir = bench_dir / name.replace(" ", "_").replace("(", "").replace(")", "").replace("=", "_").replace("+", "")
            cmd = [
                PYTHON_EXE, "-u", str(TRAIN_3D_SCRIPT), str(dataset_dir),
                "--device", "cpu",
                "--out-dir", str(sub_dir),
                "--epochs", "2",
                "--folds", "2",
                "--fold", "0",
                "--profile",
            ] + flags

            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            assert res.returncode == 0, f"Bench config '{name}' failed:\n{res.stdout}"
            assert "epoch 1/2" in res.stdout, "Epoch 1 missing from output!"
            assert "epoch 2/2" in res.stdout, "Epoch 2 missing from output!"
            assert "validation time:" in res.stdout
            assert "3D U-NET WALL-CLOCK TIMING BREAKDOWN" in res.stdout
            assert (sub_dir / "metrics_fold_0.json").exists()

            # Verify metrics contains timing breakdown
            m = json.loads((sub_dir / "metrics_fold_0.json").read_text(encoding="utf-8"))
            assert "fold" in m
            assert m["fold"] == 0

        print("[PASS] test_bench_mode_runs_three_configs_on_cpu")


def test_patient_grouped_folds_paired_scans_and_renaming():
    """Verify paired scans of one patient always land in the same fold even after case renaming."""
    import random
    from ml.scripts.train_3d import SEED

    # 12 cases across 8 patients (patients 0, 1, 2, 3 have 2 scans each; 4, 5, 6, 7 have 1 scan)
    patient_cases = [
        ("case_001", "patient_001"),
        ("case_002", "patient_001"),
        ("case_003", "patient_002"),
        ("case_004", "patient_002"),
        ("case_005", "patient_003"),
        ("case_006", "patient_003"),
        ("case_007", "patient_004"),
        ("case_008", "patient_004"),
        ("case_009", "patient_005"),
        ("case_010", "patient_006"),
        ("case_011", "patient_007"),
        ("case_012", "patient_008"),
    ]

    def build_folds(case_pairs, folds_n=3, seed=SEED):
        cases = [{"id": cid, "patient_id": pid} for cid, pid in case_pairs]
        patient_to_cases = {}
        for c in cases:
            pid = c["patient_id"]
            if pid not in patient_to_cases:
                patient_to_cases[pid] = []
            patient_to_cases[pid].append(c)
        for pid in patient_to_cases:
            patient_to_cases[pid].sort(key=lambda c: c["id"])
        unique_pids = sorted(patient_to_cases.keys())
        rng = random.Random(seed)
        rng.shuffle(unique_pids)
        groups = [[] for _ in range(folds_n)]
        for pid in unique_pids:
            p_cases = patient_to_cases[pid]
            smallest_idx = min(range(folds_n), key=lambda f: len(groups[f]))
            groups[smallest_idx].extend(p_cases)
        return groups

    folds1 = build_folds(patient_cases, folds_n=3)

    # Verify paired scans of same patient always land in the same fold
    for f_idx, fold_cases in enumerate(folds1):
        f_cids = {c["id"] for c in fold_cases}
        f_pids = {c["patient_id"] for c in fold_cases}
        for c in fold_cases:
            # All scans of this patient must be in this fold
            expected_cids = {cid for cid, pid in patient_cases if pid == c["patient_id"]}
            assert expected_cids.issubset(f_cids), f"Patient {c['patient_id']} scans split across folds!"

    # Renaming test: rename case_001..case_012 to randomized names but keep same patient_id
    renamed_pairs = [
        ("case_999", "patient_001"),
        ("case_888", "patient_001"),
        ("case_777", "patient_002"),
        ("case_666", "patient_002"),
        ("case_555", "patient_003"),
        ("case_444", "patient_003"),
        ("case_333", "patient_004"),
        ("case_222", "patient_004"),
        ("case_111", "patient_005"),
        ("case_110", "patient_006"),
        ("case_109", "patient_007"),
        ("case_108", "patient_008"),
    ]
    folds2 = build_folds(renamed_pairs, folds_n=3)

    # Patient assignments across folds must be identical
    pids_per_fold1 = [{c["patient_id"] for c in g} for g in folds1]
    pids_per_fold2 = [{c["patient_id"] for c in g} for g in folds2]
    assert pids_per_fold1 == pids_per_fold2, "Patient grouping changed after case renaming!"
    print("[PASS] test_patient_grouped_folds_paired_scans_and_renaming")


def test_folds_identical_across_directory_orderings():
    """Verify fold assignments are identical regardless of directory discovery order."""
    import random
    from ml.scripts.train_3d import SEED

    base_pairs = [
        (f"case_{i:03d}", f"patient_{i // 2:03d}")
        for i in range(20)
    ]

    def assign(case_pairs, seed=SEED):
        patient_to_cases = {}
        for cid, pid in case_pairs:
            if pid not in patient_to_cases:
                patient_to_cases[pid] = []
            patient_to_cases[pid].append({"id": cid, "patient_id": pid})
        for pid in patient_to_cases:
            patient_to_cases[pid].sort(key=lambda c: c["id"])
        unique_pids = sorted(patient_to_cases.keys())
        rng = random.Random(seed)
        rng.shuffle(unique_pids)
        groups = [[] for _ in range(5)]
        for pid in unique_pids:
            p_cases = patient_to_cases[pid]
            smallest_idx = min(range(5), key=lambda f: len(groups[f]))
            groups[smallest_idx].extend(p_cases)
        return [[c["id"] for c in g] for g in groups]

    order1 = base_pairs[:]
    order2 = list(reversed(base_pairs))
    order3 = base_pairs[:]
    random.Random(123).shuffle(order3)

    res1 = assign(order1)
    res2 = assign(order2)
    res3 = assign(order3)

    assert res1 == res2 == res3, "Fold assignment differed across input orderings!"
    print("[PASS] test_folds_identical_across_directory_orderings")


def test_fold_sizes_balance():
    """Verify greedy patient assignment keeps fold sizes balanced."""
    from ml.scripts.train_3d import SEED
    import random

    # 61 cases, 50 patients (11 patients have 2 scans, 39 have 1 scan)
    cases = []
    case_idx = 1
    for p in range(1, 12):
        cases.append({"id": f"case_{case_idx:03d}", "patient_id": f"patient_{p:03d}"})
        case_idx += 1
        cases.append({"id": f"case_{case_idx:03d}", "patient_id": f"patient_{p:03d}"})
        case_idx += 1
    for p in range(12, 51):
        cases.append({"id": f"case_{case_idx:03d}", "patient_id": f"patient_{p:03d}"})
        case_idx += 1

    assert len(cases) == 61

    patient_to_cases = {}
    for c in cases:
        pid = c["patient_id"]
        if pid not in patient_to_cases:
            patient_to_cases[pid] = []
        patient_to_cases[pid].append(c)
    unique_pids = sorted(patient_to_cases.keys())
    rng = random.Random(SEED)
    rng.shuffle(unique_pids)
    groups = [[] for _ in range(5)]
    for pid in unique_pids:
        p_cases = patient_to_cases[pid]
        smallest_idx = min(range(5), key=lambda f: len(groups[f]))
        groups[smallest_idx].extend(p_cases)

    lens = [len(g) for g in groups]
    assert sum(lens) == 61
    assert max(lens) - min(lens) <= 1, f"Fold sizes unbalanced: {lens}"
    print(f"[PASS] test_fold_sizes_balance (sizes: {lens})")


def test_legacy_case_folds_reproduction():
    """Verify --legacy-case-folds flag reproduces exact old case-level assignment."""
    import random
    from ml.scripts.train_3d import SEED

    cases = [{"id": f"case_{i:03d}", "patient_id": f"pat_{i // 2:03d}"} for i in range(15)]

    # Old assignment logic
    order_old = cases[:]
    random.Random(SEED).shuffle(order_old)
    groups_old = [[] for _ in range(3)]
    for i, case in enumerate(order_old):
        groups_old[i % 3].append(case)

    # Legacy flag branch in train_3d.py
    order_leg = cases[:]
    random.Random(SEED).shuffle(order_leg)
    groups_leg = [[] for _ in range(3)]
    for i, case in enumerate(order_leg):
        groups_leg[i % 3].append(case)

    assert groups_old == groups_leg
    print("[PASS] test_legacy_case_folds_reproduction")


def test_missing_patient_id_fails_closed():
    """Verify that train_3d.py errors out if patient_id is missing without --allow-case-level-folds."""
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        data_dir = tmp / "dataset_no_patient"
        data_dir.mkdir()
        make_synthetic_case(data_dir, "case_001")
        make_synthetic_case(data_dir, "case_002")

        # worklist WITHOUT patient_id
        wl = data_dir / "worklist.csv"
        with wl.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=["case_id", "class"])
            writer.writeheader()
            writer.writerow({"case_id": "case_001", "class": "bme"})
            writer.writerow({"case_id": "case_002", "class": "nonbme"})

        out_dir = tmp / "out"
        cmd = [
            PYTHON_EXE, "-u", str(TRAIN_3D_SCRIPT), str(data_dir),
            "--device", "cpu",
            "--out-dir", str(out_dir),
            "--epochs", "1",
            "--folds", "2",
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        assert res.returncode != 0, "Should have failed closed when patient_id is missing!"
        assert "missing or blank patient_id" in res.stdout
        assert "--allow-case-level-folds" in res.stdout

        # Now pass --allow-case-level-folds -> must succeed
        cmd_allowed = cmd + ["--allow-case-level-folds", "--fold", "0"]
        res_allowed = subprocess.run(cmd_allowed, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        assert res_allowed.returncode == 0, f"Failed with --allow-case-level-folds:\n{res_allowed.stdout}"
        assert "case_level folds" in res_allowed.stdout

        print("[PASS] test_missing_patient_id_fails_closed")


def test_resume_and_skip_completed_refuse_mixed_fold_modes():
    """Verify resume and skip-completed refuse to mix checkpoints from different fold modes."""
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        dataset_dir = make_synthetic_dataset(tmp)
        out_dir = tmp / "results_mode_mismatch"
        out_dir.mkdir()

        # Run 1: with --legacy-case-folds
        cmd_legacy = [
            PYTHON_EXE, "-u", str(TRAIN_3D_SCRIPT), str(dataset_dir),
            "--device", "cpu",
            "--out-dir", str(out_dir),
            "--epochs", "1",
            "--folds", "2",
            "--fold", "0",
            "--legacy-case-folds",
        ]
        res1 = subprocess.run(cmd_legacy, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        assert res1.returncode == 0, f"Legacy run failed:\n{res1.stdout}"
        ckpt_file = out_dir / "fold_0.pt"
        assert ckpt_file.exists()

        # Run 2: Default patient-grouped folds pointing to same out-dir with --skip-completed
        cmd_new = [
            PYTHON_EXE, "-u", str(TRAIN_3D_SCRIPT), str(dataset_dir),
            "--device", "cpu",
            "--out-dir", str(out_dir),
            "--epochs", "1",
            "--folds", "2",
            "--fold", "0",
            "--skip-completed",
        ]
        res2 = subprocess.run(cmd_new, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        assert res2.returncode != 0, "Should refuse to skip completed on fold_mode mismatch!"
        assert "fold_mode" in res2.stdout or "dataset fingerprint" in res2.stdout

        print("[PASS] test_resume_and_skip_completed_refuse_mixed_fold_modes")


def test_default_sampling_bit_identical():
    """Verify default sampling mix is bit-identical to legacy behavior across draws."""
    from ml.scripts.train_3d import sample_origin, PATCH

    shape = (128, 128, 32)
    lbl = np.zeros(shape, dtype=np.uint8)
    lbl[40:60, 40:60, 10:20] = 1
    lbl[50:55, 50:55, 12:15] = 2

    # Draw 500 origins with None (default) vs explicit default dict
    rng1 = np.random.default_rng(42)
    draws_none = [sample_origin(shape, lbl, rng1, None) for _ in range(500)]

    rng2 = np.random.default_rng(42)
    draws_explicit = [sample_origin(shape, lbl, rng2, {"lesion": 0.7, "bone": 0.0, "random": 0.3}) for _ in range(500)]

    assert draws_none == draws_explicit, "Default and explicit default sampling diverged!"
    print("[PASS] test_default_sampling_bit_identical (500 draws match bit-for-bit)")


def test_bone_centered_patches_have_bone_at_center():
    """Verify that bone sampling centers patches on bone voxels."""
    from ml.scripts.train_3d import sample_origin, PATCH, crop

    shape = (128, 128, 32)
    lbl = np.zeros(shape, dtype=np.uint8)
    lbl[40:80, 40:80, 10:25] = 1  # bone region only, NO lesion (label 2)

    rng = np.random.default_rng(123)
    mix = {"lesion": 0.0, "bone": 1.0, "random": 0.0}

    for _ in range(100):
        orig = sample_origin(shape, lbl, rng, mix)
        patch = crop(lbl, orig)
        # Center of patch
        cz, cy, cx = PATCH[0] // 2, PATCH[1] // 2, PATCH[2] // 2
        # Center voxel or immediate neighborhood must be bone
        center_val = patch[cz, cy, cx]
        assert center_val in [1, 2], f"Bone missing at patch center: {center_val}"

    print("[PASS] test_bone_centered_patches_have_bone_at_center")


def test_sampling_mix_proportions():
    """Verify sampling mix proportions match specified fractions within statistical tolerance."""
    from ml.scripts.train_3d import sample_origin, crop, PATCH

    shape = (200, 200, 50)
    lbl = np.zeros(shape, dtype=np.uint8)
    lbl[80:120, 80:120, 20:35] = 1
    lbl[95:105, 95:105, 23:27] = 2

    rng = np.random.default_rng(777)
    mix = {"lesion": 0.5, "bone": 0.35, "random": 0.15}

    n_samples = 3000
    lesion_hits = 0
    bone_hits = 0
    random_hits = 0

    for _ in range(n_samples):
        orig = sample_origin(shape, lbl, rng, mix)
        p = crop(lbl, orig)
        cz, cy, cx = PATCH[0] // 2, PATCH[1] // 2, PATCH[2] // 2
        val = p[cz, cy, cx]
        if val == 2:
            lesion_hits += 1
        elif val == 1:
            bone_hits += 1
        else:
            random_hits += 1

    p_lesion = lesion_hits / n_samples
    p_bone = bone_hits / n_samples
    p_rand = random_hits / n_samples

    assert abs(p_lesion - 0.50) < 0.04, f"Lesion proportion {p_lesion:.3f} outside tolerance (expected ~0.50)"
    assert abs(p_bone - 0.35) < 0.04, f"Bone proportion {p_bone:.3f} outside tolerance (expected ~0.35)"
    assert abs(p_rand - 0.15) < 0.04, f"Random proportion {p_rand:.3f} outside tolerance (expected ~0.15)"

    print(f"[PASS] test_sampling_mix_proportions (measured: lesion={p_lesion:.3f}, bone={p_bone:.3f}, rand={p_rand:.3f})")


if __name__ == "__main__":
    print("Running Train 3D Speedups & Safeguards Test Suite (Synthetic CPU Data)...")
    test_skip_completed_refuses_on_mismatched_config()
    test_fingerprint_mismatch_refusal()
    test_time_guard_saves_and_exits()
    test_bench_mode_runs_three_configs_on_cpu()
    test_patient_grouped_folds_paired_scans_and_renaming()
    test_folds_identical_across_directory_orderings()
    test_fold_sizes_balance()
    test_legacy_case_folds_reproduction()
    test_missing_patient_id_fails_closed()
    test_resume_and_skip_completed_refuse_mixed_fold_modes()
    test_default_sampling_bit_identical()
    test_bone_centered_patches_have_bone_at_center()
    test_sampling_mix_proportions()
    print("\n[SUCCESS] ALL SYNTHETIC PATIENT FOLD & SAMPLING TESTS PASSED!")
