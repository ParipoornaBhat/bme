#!/bin/bash
# 2D U-Net on the college H200 (Slurm). Run from ~/bme on the server:
#
#   sbatch ml/slurm/train_2d_seg.sbatch
#
# Expects ~/bme/env (CUDA torch from the cu121 wheel, numpy, pillow), ~/bme/ml/scripts/,
# ~/bme/data/seg2d3d/ copied up from the hub laptop, and ~/bme/logs/ created before
# submitting (Slurm does not create it). Weights and metrics land in
# ~/bme/data/results2dseg3d/; metrics.json is written only after the last fold.
# #SBATCH paths must be absolute or the job exits at once (H200 guide); Slurm expands
# %u only in #SBATCH lines, so the script body uses $HOME.
#SBATCH --job-name=bme_unet2d
#SBATCH --partition=h200
#SBATCH --gres=gpu:1g.18gb:1
#SBATCH --cpus-per-task=2
#SBATCH --mem=16G
#SBATCH --time=04:00:00
#SBATCH --output=/home/%u/bme/logs/unet2d_%j.out
#SBATCH --error=/home/%u/bme/logs/unet2d_%j.err

set -euo pipefail
source "$HOME/bme/env/bin/activate"
cd "$HOME/bme"
nvidia-smi -L
python3 ml/scripts/train_2d_seg.py . --data seg2d3d --out results2dseg3d --device cuda "$@"
