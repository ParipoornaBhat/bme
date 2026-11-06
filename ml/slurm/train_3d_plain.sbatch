#!/bin/bash
# Control for ml/slurm/train_3d.sbatch: the same 3D U-Net, grid, patches,
# sampling and time budget, with no augmentation (no flips, gamma, rotation or
# zoom). The difference between the two runs is what augmentation adds.
#
#   sbatch ml/slurm/train_3d_plain.sbatch           (or pnpm h200 train3dplain --as <roll>)
#   sbatch ml/slurm/train_3d_plain.sbatch --resume
#
# Same H200 limits as train_3d.sbatch. Results: ~/bme/data/results3d-h200-plain/.
#SBATCH --job-name=bme_unet3d_plain
#SBATCH --partition=h200
#SBATCH --gres=gpu:1g.18gb:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=24G
#SBATCH --time=04:00:00
#SBATCH --output=/home/%u/bme/logs/unet3dplain_%j.out
#SBATCH --error=/home/%u/bme/logs/unet3dplain_%j.err

set -euo pipefail
unset -f python python3 2>/dev/null || true
PY="$HOME/bme/env/bin/python3"
cd "$HOME/bme"
nvidia-smi -L
export BME_GPU_FRACTION=0.95
"$PY" ml/scripts/train_3d.py . --model unet --device cuda --out results3d-h200-plain \
  --folds 5 --epochs 400 --hours 3.3 --max-runtime-minutes 225 --checkpoint-every-epoch \
  --spacing 1.0 --aniso --width 32 --patch 160,160,16 --patches-per-case 24 --batch 4 \
  --resample --sampling-mix lesion=0.33,bone=0.33,random=0.34 \
  --allow-case-level-folds --amp --cosine "$@"
