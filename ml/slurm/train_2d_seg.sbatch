#!/bin/bash
# 2D U-Net on the college H200 (Slurm). Run from ~/bme on the server:
#
#   sbatch ml/slurm/train_2d_seg.sbatch
#
# Expects ~/bme/env (CUDA torch, numpy, pillow, nibabel), ~/bme/ml/scripts/,
# ~/bme/data/annotations and ~/bme/data/nifti, and ~/bme/logs/ created before
# submitting (Slurm does not create it). If data/seg2d3d is missing, this job
# builds those axial slices on the server, then trains. Weights and metrics land in
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
if [ ! -f data/seg2d3d/index.csv ]; then
  echo "Building axial slices on this server from the saved annotations."
  python3 ml/scripts/seg2nifti.py . --force
  python3 ml/scripts/make_2d_seg.py . --force
fi
python3 ml/scripts/train_2d_seg.py . --data seg2d3d --out results2dseg3d --model unet --device cuda "$@"
