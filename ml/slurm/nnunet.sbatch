#!/bin/bash
# nnU-Net v2 (ResEnc M) on the college H200. Run from ~/bme on the server:
#
#   sbatch ml/slurm/nnunet.sbatch 3d_fullres      (or pnpm h200 nnunet3d --as <roll>)
#   sbatch ml/slurm/nnunet.sbatch 2d              (or pnpm h200 nnunet2d --as <roll>)
#
# Submit the same command again after it stops: finished folds are skipped and
# an unfinished fold continues from its last checkpoint (--c). Five folds of
# 100 epochs may need more than one 4 h job; each job stops itself at 3 h 45.
#
# Needs nnunetv2==2.5.1 in ~/bme/env (pnpm h200 setup). Converting, planning
# and preprocessing happen here, inside the job, never on the login node.
# Everything nnU-Net writes stays under ~/bme/data/nnunet/; the comparable
# scores go to ~/bme/data/results-nnunet-<config>/metrics.json.
#SBATCH --job-name=bme_nnunet
#SBATCH --partition=h200
#SBATCH --gres=gpu:1g.18gb:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=24G
#SBATCH --time=04:00:00
#SBATCH --output=/home/%u/bme/logs/nnunet_%j.out
#SBATCH --error=/home/%u/bme/logs/nnunet_%j.err

set -euo pipefail
CONFIG="${1:-3d_fullres}"
case "$CONFIG" in 2d|3d_fullres) ;; *) echo "config must be 2d or 3d_fullres"; exit 1 ;; esac
unset -f python python3 2>/dev/null || true
ENV="$HOME/bme/env/bin"
cd "$HOME/bme"
nvidia-smi -L

export nnUNet_raw="$HOME/bme/data/nnunet/raw"
export nnUNet_preprocessed="$HOME/bme/data/nnunet/preprocessed"
export nnUNet_results="$HOME/bme/data/nnunet/results"
export nnUNet_n_proc_DA=3
export nnUNet_compile=f
DS=501
PLANS=nnUNetResEncUNetMPlans
TRAINER=nnUNetTrainer_100epochs
RUN="$nnUNet_results/Dataset501_BMEKnee/${TRAINER}__${PLANS}__${CONFIG}"
STOP_AT=$(( $(date +%s) + 225 * 60 ))

echo "== convert"
"$ENV/python3" ml/scripts/nnunet_prep.py convert .
if [ ! -f "$nnUNet_preprocessed/Dataset501_BMEKnee/${PLANS}.json" ] || \
   [ ! -d "$nnUNet_preprocessed/Dataset501_BMEKnee/${PLANS}_${CONFIG}" ]; then
  echo "== plan and preprocess ($CONFIG)"
  "$ENV/nnUNetv2_plan_and_preprocess" -d $DS -pl nnUNetPlannerResEncM -c "$CONFIG" -np 3 --verify_dataset_integrity
fi
"$ENV/python3" ml/scripts/nnunet_prep.py splits .

for FOLD in 0 1 2 3 4; do
  if [ -f "$RUN/fold_$FOLD/checkpoint_final.pth" ]; then
    echo "== fold $FOLD already finished"
    continue
  fi
  LEFT=$(( STOP_AT - $(date +%s) ))
  if [ "$LEFT" -lt 600 ]; then
    echo "== stopping before the 4 h limit. Submit the same job again to continue."
    exit 0
  fi
  echo "== fold $FOLD ($(( LEFT / 60 )) min left in this job)"
  set +e
  timeout "$LEFT" "$ENV/nnUNetv2_train" $DS "$CONFIG" $FOLD -p $PLANS -tr $TRAINER --c
  CODE=$?
  set -e
  if [ "$CODE" -eq 124 ]; then
    echo "== time guard stopped fold $FOLD; its checkpoint is kept. Submit again to continue."
    exit 0
  fi
  [ "$CODE" -eq 0 ] || exit "$CODE"
done

echo "== all folds finished, scoring"
"$ENV/python3" ml/scripts/nnunet_prep.py metrics . --config "$CONFIG" --out "results-nnunet-$CONFIG"
