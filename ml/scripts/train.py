"""Run nnU-Net v2 planning, preprocessing and training for a cascade stage.

    python ml/scripts/train.py "D:/Final yr Prj/bme" --stage bone
    python ml/scripts/train.py "D:/Final yr Prj/bme" --stage bone --fold 0
    python ml/scripts/train.py "D:/Final yr Prj/bme" --stage bme --plan-only

Wraps `nnUNetv2_plan_and_preprocess` and `nnUNetv2_train` so the environment
variables and dataset ids are set consistently. nnU-Net does the real work; this
exists so nobody has to remember three env vars and a dataset number.

Notes
  * nnU-Net reads nnUNet_raw / nnUNet_preprocessed / nnUNet_results from the
    environment. They are set here to live under `data/nnunet/`, gitignored.
  * `splits_final.json` written by build_dataset.py is preserved — planning would
    otherwise generate random, patient-ignorant splits.
  * Trains all 5 folds by default. The 5 fold models are also the deep ensemble
    used for uncertainty maps (PRD §5), so this is not wasted work.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

STAGES = {
    "bone": {"id": 1, "name": "Dataset001_BMEBone"},
    "bme": {"id": 2, "name": "Dataset002_BMELesion"},
}
CONFIG = "3d_fullres"


def run(cmd: list[str], env: dict) -> int:
    print(f"\n$ {' '.join(cmd)}\n", flush=True)
    return subprocess.run(cmd, env=env).returncode


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--stage", choices=sorted(STAGES), required=True)
    ap.add_argument("--fold", help="single fold (0-4), or 'all' (default)", default="all")
    ap.add_argument("--config", default=CONFIG,
                    help="3d_fullres (default), 3d_lowres, 2d")
    ap.add_argument("--trainer", default=None,
                    help="e.g. nnUNetTrainer_250epochs for a quick first pass")
    ap.add_argument("--plan-only", action="store_true")
    ap.add_argument("--continue-training", action="store_true")
    args = ap.parse_args()

    base = Path(args.base).resolve()
    spec = STAGES[args.stage]
    nn = base / "data" / "nnunet"
    raw, prep, results = nn / "nnUNet_raw", nn / "nnUNet_preprocessed", nn / "nnUNet_results"

    dataset_dir = raw / spec["name"]
    if not (dataset_dir / "dataset.json").exists():
        sys.exit(
            f"missing {dataset_dir / 'dataset.json'}\n"
            f"Run first:  python ml/scripts/build_dataset.py \"{base}\" --stage {args.stage}"
        )

    n = json.loads((dataset_dir / "dataset.json").read_text(encoding="utf-8")).get("numTraining", 0)
    print(f"stage={args.stage}  dataset={spec['name']}  numTraining={n}  config={args.config}")
    if n < 5:
        print(f"  !! {n} training case(s). 5-fold CV needs at least 5; results below ~20 are noise.")

    if shutil.which("nnUNetv2_train") is None:
        sys.exit(
            "nnUNetv2_train not on PATH — nnU-Net is not installed in this interpreter.\n"
            "  cd ml && uv pip install -e \".[train]\"\n"
            "Install the torch build matching your CUDA first (see pytorch.org)."
        )

    for d in (raw, prep, results):
        d.mkdir(parents=True, exist_ok=True)

    env = dict(os.environ)
    env["nnUNet_raw"] = str(raw)
    env["nnUNet_preprocessed"] = str(prep)
    env["nnUNet_results"] = str(results)

    # Planning regenerates splits_final.json if absent. Ours is patient-level;
    # nnU-Net's fallback is random, which leaks a case across folds.
    splits = prep / spec["name"] / "splits_final.json"
    backup = splits.read_bytes() if splits.exists() else None

    rc = run(
        ["nnUNetv2_plan_and_preprocess", "-d", str(spec["id"]), "--verify_dataset_integrity",
         "-c", args.config],
        env,
    )
    if rc != 0:
        sys.exit(f"planning failed (exit {rc})")

    if backup is not None:
        splits.parent.mkdir(parents=True, exist_ok=True)
        if splits.read_bytes() != backup:
            splits.write_bytes(backup)
            print("\n  restored our patient-level splits_final.json (planning had replaced it)")

    if args.plan_only:
        print("\nplan-only — stopping before training")
        return

    folds = ["0", "1", "2", "3", "4"] if args.fold == "all" else [args.fold]
    for fold in folds:
        cmd = ["nnUNetv2_train", str(spec["id"]), args.config, fold]
        if args.trainer:
            cmd += ["-tr", args.trainer]
        if args.continue_training:
            cmd += ["--c"]
        rc = run(cmd, env)
        if rc != 0:
            sys.exit(f"training failed on fold {fold} (exit {rc})")

    print(f"\ndone — results under {results / spec['name']}")
    print("next:")
    if args.stage == "bone":
        print("  python ml/scripts/build_dataset.py <base> --stage bme")
    else:
        print("  evaluate, then run the locked test set exactly once")


if __name__ == "__main__":
    main()
