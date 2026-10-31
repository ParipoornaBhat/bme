#!/bin/bash
# Long 3D U-Net on the college H200 (Slurm). Run from ~/bme on the server:
#
#   sbatch ml/slurm/train_3d.sbatch
#
# Expects ~/bme/env (CUDA torch, numpy, scipy, nibabel, pynrrd), ~/bme/ml/scripts/,
# ~/bme/data/annotations, ~/bme/data/nifti, ~/bme/data/worklist.csv and ~/bme/logs/.
# `pnpm h200` -> "Push data" puts all of these there.
#
# The laptop run was 5 folds x 40 epochs, 96x96x12 patches, width 16, 8 fixed
# patches per case: about 45 min. This one is wider, sees larger patches cut
# fresh every epoch with flips and intensity jitter, and fits as many epochs as
# 3.3 hours allow, leaving room inside the 4 hour student limit for loading and
# scoring. metrics.json is written only after the last fold; fold_<k>.pt after each.
# Results land in ~/bme/data/results3d-h200/.
#SBATCH --job-name=bme_unet3d
#SBATCH --partition=h200
#SBATCH --gres=gpu:1g.18gb:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=24G
#SBATCH --time=04:00:00
#SBATCH --output=/home/%u/bme/logs/unet3d_%j.out
#SBATCH --error=/home/%u/bme/logs/unet3d_%j.err

set -euo pipefail
source "$HOME/bme/env/bin/activate"
# The login profile exports a python3() shell function that runs /usr/bin/python3
# (no torch). Call the env interpreter by path so the function cannot win.
unset -f python python3 2>/dev/null || true
PY="$HOME/bme/env/bin/python3"
cd "$HOME/bme"
nvidia-smi -L
export BME_GPU_FRACTION=0.95
"$PY" ml/scripts/train_3d.py . --model unet --device cuda --out results3d-h200 \
  --folds 5 --epochs 400 --hours 3.3 \
  --width 32 --patch 128,128,16 --patches-per-case 24 --batch 4 \
  --resample --augment --amp --cosine "$@"
