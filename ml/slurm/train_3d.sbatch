#!/bin/bash
# 3D U-Net on the college H200 (Slurm). Run from ~/bme on the server:
#
#   sbatch ml/slurm/train_3d.sbatch          (or pnpm h200 -> Train 3D)
#   sbatch ml/slurm/train_3d.sbatch --resume (continue after maintenance or a kill)
#
# Expects ~/bme/env (CUDA torch, numpy, scipy, nibabel, pynrrd), ~/bme/ml/scripts/,
# ~/bme/data/annotations, ~/bme/data/nifti, ~/bme/data/worklist.csv and ~/bme/logs/.
# `pnpm h200` -> "Push data" puts all of these there.
#
# Why this setup (the 8 Oct laptop run scored bone 0.54, edema 0.18, ~2000 false
# blobs per scan, while 2D on the same scans reached bone 0.91):
#   --spacing 1.0       scans are ~0.35 mm in-plane, 3.6-5.8 mm between slices.
#                       At 1 mm a 160x160 patch covers the whole knee section;
#                       slices are never interpolated.
#   --aniso             first pooling in-plane only, so 16 slices are not
#                       halved before the network has seen them.
#   --aug-spatial       nnU-Net defaults, slice-wise: rotation +-30 deg and zoom
#                       0.7-1.4 (p=0.2 each), plus flips and gamma (--augment).
#                       Done live in RAM, every patch fresh; nothing is written
#                       to disk, so the 50 GB home limit is not touched.
#   --sampling-mix      a third of patches on edema, a third on bone, a third
#                       anywhere, so the model also sees normal tissue.
#
# H200 rules this job keeps: one 1g.18gb slice (the student default), under the
# 4 h job limit (training is fitted into 3.3 h, and the time guard stops cleanly
# at 3 h 45 with a resumable checkpoint), no compute on the login node, results
# only (weights + metrics, a few MB) written under ~/bme/data/.
# Results land in ~/bme/data/results3d-h200-v2/.
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
"$PY" ml/scripts/train_3d.py . --model unet --device cuda --out results3d-h200-v2 \
  --folds 5 --epochs 400 --hours 3.3 --max-runtime-minutes 225 --checkpoint-every-epoch \
  --spacing 1.0 --aniso --width 32 --patch 160,160,16 --patches-per-case 24 --batch 4 \
  --resample --augment --aug-spatial --sampling-mix lesion=0.33,bone=0.33,random=0.34 \
  --allow-case-level-folds --amp --cosine "$@"
