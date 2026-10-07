#!/bin/bash
# 2D U-Net on the college H200 (Slurm). Run from ~/bme on the server:
#
#   sbatch ml/slurm/train_2d_seg.sbatch
#
# Expects ~/bme/env (CUDA torch, numpy, pillow), ~/bme/ml/scripts/ and
# ~/bme/data/seg2d3d/ copied up from the hub laptop. Weights and metrics land in
# ~/bme/data/results2dseg3d/. Paths use $HOME: Slurm expands %u only in #SBATCH lines.
#SBATCH --job-name=bme_unet2d
#SBATCH --partition=h200
#SBATCH --gres=gpu:1g.18gb:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --time=01:00:00
#SBATCH --output=logs/unet2d_%j.out
#SBATCH --error=logs/unet2d_%j.err

set -euo pipefail
source "$HOME/bme/env/bin/activate"
cd "$HOME/bme"
nvidia-smi -L
python3 ml/scripts/train_2d_seg.py . --data seg2d3d --out results2dseg3d --device cuda "$@"
