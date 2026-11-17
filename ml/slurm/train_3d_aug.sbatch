#!/bin/bash
# The 3D U-Net of ml/slurm/train_3d.sbatch at one of three augmentation levels,
# so the levels can be compared on the same folds, grid, patches and time budget:
#
#   sbatch ml/slurm/train_3d_aug.sbatch low            (or pnpm h200 aug low --as <roll>)
#   sbatch ml/slurm/train_3d_aug.sbatch med
#   sbatch ml/slurm/train_3d_aug.sbatch max
#   sbatch ml/slurm/train_3d_aug.sbatch max --resume   (continue after the 4 h limit)
#
# The levels are AUG_LEVELS in ml/scripts/train_3d.py. Augmentation is done live
# in RAM; nothing is stored. Each level writes its own folder:
# ~/bme/data/results3d-aug-low, -med, -max. The no-augmentation control is
# ml/slurm/train_3d_plain.sbatch. Same H200 limits as train_3d.sbatch.
#SBATCH --job-name=bme_aug
#SBATCH --partition=h200
#SBATCH --gres=gpu:1g.18gb:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=24G
#SBATCH --time=04:00:00
#SBATCH --output=/home/%u/bme/logs/aug_%j.out
#SBATCH --error=/home/%u/bme/logs/aug_%j.err

set -euo pipefail
LEVEL="${1:-}"
case "$LEVEL" in low|med|max) shift ;; *) echo "first argument must be low, med or max"; exit 1 ;; esac
unset -f python python3 2>/dev/null || true
PY="$HOME/bme/env/bin/python3"
cd "$HOME/bme"
nvidia-smi -L
export BME_GPU_FRACTION=0.95
# BME_EPOCHS set (the dashboard sets it): every fold trains to that many epochs, over as many
# 3 h 45 m parts as it takes, continued with --resume. Not set: the older 3.3 h budget shared by
# all folds, which a run started that way must keep using.
if [ -n "${BME_EPOCHS:-}" ]; then BUDGET=(--epochs "$BME_EPOCHS"); else BUDGET=(--epochs 400 --hours 3.3); fi
"$PY" ml/scripts/train_3d.py . --model unet --model-arch unet3d --device cuda --out "results3d-aug-$LEVEL" \
  --folds 5 "${BUDGET[@]}" --max-runtime-minutes 225 --checkpoint-every-epoch \
  --spacing 1.0,1.0,3.0 --aniso --width 32 --patch 160,160,16 --patches-per-case 24 --batch 4 \
  --resample --aug-level "$LEVEL" --sampling-mix lesion=0.33,bone=0.33,random=0.34 \
  --allow-case-level-folds --amp --cosine "$@"
