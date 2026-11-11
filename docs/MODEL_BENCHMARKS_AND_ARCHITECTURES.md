# BME MRI Segmentation & Detection — Model Architectures & Benchmark Report

> **Generated:** 2026-11-11 07:06 UTC | **Dataset Cohort:** De-identified knee MRI (`up to 121 volumes: 61 BME+, 60 Control`) | **PHI Status:** Zero patient identifiers or file paths stored.

---

## 1. Executive Summary

This repository evaluates **6 architectures across 3 task pipelines** (`2D Classification`, `2D Segmentation`, `3D Volumetric Segmentation`) using patient-grouped cross-validation:

- **Active Production Weights (`data/results3d/`, Version #37):** `C-Net + Dual-Channel 3D U-Net` (`121` scans, `50` epochs, `128x128x16`) — **Bone Dice `0.817`**, **Positives-Only BME Dice `0.229`**, **Control Specificity `96.7%`**, **Presence Accuracy `107/121 (88.4%)`**, `0.1` FP/case.
- **Diagnosed Collapse Run (`Version #41`):** Raised epochs to `65` with `BatchNorm3d` at `batch=4` and hard binary C-Net gating; **Fold 0 reached `0.324` Pos BME Dice (`11/12 TP`)** while **Folds 1–4 collapsed (`TP=0`)** due to `BatchNorm3d` batch-size shift, unclipped AMP gradient spikes (`6–9` skipped steps/fold), and binary gatekeeper cliffs.
- **New Flagship Architecture Currently Training (`OrthoGate-MedNeXt3D`, Live Kaggle Run `run_20261111_062858`):** Directly addresses every failure mode of `Version #41` (`5x5x3` MedNeXt + `3D ASPP` + `Bone-Guided Spatial Attention` + `Deep Supervision` + `GroupNorm` + `GradClip 1.0` + `Tversky beta=0.7` + `Soft C-Net Ramp` + `3D Gaussian Stitching` + `3x3x1 Closing & Hysteresis`) while compressing weights to **`0.809 MB / fold`** (`3.55 MB` 5-fold zip).

---

## 2. Detailed Model Architectures

### OrthoGate-MedNeXt3D (`orthogate_mednext`)

| Component | Specification |
| :--- | :--- |
| **Pipeline** | `3d_seg` |
| **Backbone** | 3-stage anisotropic Encoder-Decoder (20 -> 40 -> 80) + 3D ASPP bottleneck + Bone-Guided Attention + Deep Supervision + CNetHead3D |
| **Core Blocks** | 2x _OrthoMedNeXtBlock3D per stage (5x5x3 depthwise Conv3d, GroupNorm, 2x GELU inverted bottleneck, learnable 0.5 res_scale) + aniso (2,2,1) early downsampling + _ASPP3D + _BoneGuidedAttention3D + ds2 aux head |
| **Input Spec** | 128x128x16 patches at 0.5x0.5x3.0 mm + N4 + spatial rot/scale + MRI gamma/contrast/3D coil shading |
| **Outputs** | Bone logit, Bone-Gated BME logit, bottleneck C-Net logit, and Stage-2 Deep Supervision aux logits |
| **Normalization** | GroupNorm (gcd(channels, 8)) — batch-size invariant |
| **Loss Function** | Asymmetric Tversky (alpha=0.3, beta=0.7 on edema) + AMP-safe FP32 Focal + 0.3 * Deep Supervision loss + 0.5 * C-Net BCE + clip_grad_norm_(1.0) |
| **Gatekeeper** | Soft C-Net Ramp Gatekeeper across [max(0.05, t_high-0.20), t_high] with train-only calibration (<=0.58, >=92% train sensitivity) |
| **Post-Processing** | 3D Gaussian center-weighted stitching + 5-fold continuous prob ensemble + intra-osseous 3x3x1 morphological closing + peak-confidence hysteresis (>=25 voxels if peak>=0.65, else >=50) |
| **Model Size / Params** | 202,294 params (0.809 MB / fold at bc=20; 3.547 MB 5-fold zip) |
| **Known Limitations** | Still constrained by 121-scan single-cohort size (61 BME+), 128x128x16 patch locality, single-modality fat-suppressed MRI without paired T1, 25-voxel floor, and pending real Kaggle 5-fold clinical validation scores. |

### C-Net + Dual-Channel 3D U-Net (`cnet_dual_unet`)

| Component | Specification |
| :--- | :--- |
| **Pipeline** | `3d_seg` |
| **Backbone** | 3-stage double-conv 3D U-Net (base_channels=20: 20 -> 40 -> 80) + CNetHead3D bottleneck classifier |
| **Core Blocks** | Dual Conv3d(3x3x3) + BatchNorm3d (aniso=True: (2,2,1) first pool) + CNetHead3D (AdaptiveMaxPool3d(1) -> FC(64) -> FC(1)) |
| **Input Spec** | 128x128x16 patches at 0.5x0.5x3.0 mm physical spacing + N4 bias correction + spatial rot/zoom |
| **Outputs** | 2 segmentation channels (Bone, BME) + patch C-Net edema presence logit |
| **Normalization** | BatchNorm3d |
| **Loss Function** | Symmetric Dice + Focal (bme_weight=2.5) + 0.5 * BCEWithLogits(C-Net) |
| **Gatekeeper** | Hard binary cutoff on top-3 patch mean C-Net probability (wiped scans < threshold straight to 0) |
| **Post-Processing** | Uniform sliding-window average + flip TTA + hard min_bme_voxels removal |
| **Model Size / Params** | ~520k (~2.05 MB / fold) |
| **Known Limitations** | BatchNorm3d drifted between train batch=4 and val_batch=8 without gradient clipping, causing Folds 1-4 collapse in Version #41; hard binary C-Net cliff wiped borderline positive scans (12/61 in Version #37) to 0. |

### MedNeXt 3D (MICCAI 2023) (`mednext`)

| Component | Specification |
| :--- | :--- |
| **Pipeline** | `3d_seg` |
| **Backbone** | 3-stage 3D ConvNeXt Encoder-Decoder (16 -> 32 -> 64) |
| **Core Blocks** | 5x5x5 depthwise Conv3d + InstanceNorm3d + 1x1 inverted bottleneck (exp_ratio=2, GELU) + residual projection |
| **Input Spec** | 96x96x12 single-channel MRI patch |
| **Outputs** | 2 channels: Bone + BME |
| **Normalization** | InstanceNorm3d |
| **Loss Function** | Dice + Focal |
| **Gatekeeper** | None |
| **Post-Processing** | min_bme_voxels filtering |
| **Model Size / Params** | ~210k (bc=16) |
| **Known Limitations** | Tested only in 2-epoch quick smoke test (run_20261031_095628); symmetric 5x5x5 kernel does not model 3.0mm thick-slice anisotropy and lacks C-Net / Bone-Guided Attention. |

### Standard 3D U-Net (`3d-unet`)

| Component | Specification |
| :--- | :--- |
| **Pipeline** | `3d_seg` |
| **Backbone** | 3-stage 3D U-Net (16 -> 32 -> 64) or 20->40->80 with double_conv |
| **Core Blocks** | Single or double Conv3d(3x3x3) + InstanceNorm3d + ReLU + MaxPool3d + ConvTranspose3d |
| **Input Spec** | 96x96x12 (or 128x128x16 with spacing) single-channel MRI patch |
| **Outputs** | 2 channels: Channel 0 = Bone, Channel 1 = Edema (BME); clipped to bone |
| **Normalization** | InstanceNorm3d (earlier runs) |
| **Loss Function** | Dice + Focal (symmetric Dice on bone and edema) |
| **Gatekeeper** | None in early runs -> noisy false-positive clusters on negative controls |
| **Post-Processing** | Connected-component size filter (min_bme_voxels=50) |
| **Model Size / Params** | ~159k (bc=16 single) to ~400k |
| **Known Limitations** | Small 96x96x12 field of view (~3-4 cm) lacks pelvic context; without a presence gatekeeper or negative controls in early training, produced high false positives per case. |

### 2D Dual-Channel U-Net (`unet2d`)

| Component | Specification |
| :--- | :--- |
| **Pipeline** | `2d_seg` |
| **Backbone** | 4-stage 2D U-Net (32 -> 64 -> 128 -> 256 -> 512 bottleneck) |
| **Core Blocks** | Double 3x3 Conv2d + BatchNorm2d + ReLU with MaxPool2d(2) and ConvTranspose2d(2) |
| **Input Spec** | 256 x 256 single-slice fat-suppressed / STIR MRI |
| **Outputs** | 2 channels: Channel 0 = Bone marrow, Channel 1 = BME lesion (clipped inside bone at inference) |
| **Normalization** | BatchNorm2d |
| **Loss Function** | Dice + Focal (bme upweighted for <1% lesion prevalence) |
| **Gatekeeper** | None (inference clips lesion inside predicted bone mask) |
| **Post-Processing** | Bone-mask clipping per slice |
| **Model Size / Params** | ~7.76M |
| **Known Limitations** | 2D slice-by-slice context ignores 3D Z-axis continuity; trained on 18 early annotated cases only. |

### 2D Slice-to-Case Classifiers (ResNet / ConvNeXt / DenseNet / EfficientNet / MobileNetV3) (`2d_classifier`)

| Component | Specification |
| :--- | :--- |
| **Pipeline** | `2d_cls` |
| **Backbone** | torchvision 2D CNN backbones (ResNet-18/34/50, EfficientNet-B0, DenseNet-121, ConvNeXt-Tiny, MobileNetV3) |
| **Core Blocks** | Pretrained ImageNet stem/blocks fine-tuned with patient-grouped 5-fold CV |
| **Input Spec** | Extracted 2D MRI slice images resized to 224/256 with optional high-intensity mask & TTA |
| **Outputs** | Binary edema presence probability aggregated from slices to patient case score + Grad-CAM heatmap |
| **Normalization** | Backbone default (BatchNorm2d / LayerNorm) |
| **Loss Function** | Binary Cross-Entropy with logits |
| **Gatekeeper** | N/A (classification only — no localization mask) |
| **Post-Processing** | Case-level probability averaging across slices |
| **Model Size / Params** | 2.5M – 25M depending on torchvision backbone |
| **Known Limitations** | Per-case labels applied to all slices create noisy negative slices inside BME cases; cannot segment or measure lesion volume in mm3; documented shortcut risk on older uncropped JPEGs (docs/STATUS.md). |

---

## 3. Complete Training Run History (All Verified Runs)

> Note on cohort growth: Early runs (`Oct 10–26`) evaluated **61 positive cases only** (`neg=0`). Mid-October/early-Nov runs (`Oct 29–Nov 8`) had **76 cases** (`61 pos / 15 neg`). Full balanced runs (`Nov 8 onward`) cover all **121 cases** (`61 pos / 60 neg`). After Nov 9, metrics split **Positives-Only BME Dice** from **Overall Cohort Dice** so negative controls (`TNR`) cannot mask missed lesions.

| Run Key | Status | Arch | Cases (`Pos/Neg`) | Patch / Norm | Ep | Bone Dice | Pos BME Dice | All BME Dice | Pos Sens | Control TNR | FP/Case | Presence |
| :--- | :--- | :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `3d-run_20261111_062858` (Version #42 (Training Live on Kaggle T4 x2)) | **RUNNING** | `orthogate_mednext` | 121 (61/60) | `128x128x16 / group` | 65 | — | — | — | — | — | — | — |
| `3d-run_20261110_181938` (Version #41 (Folds 1-4 BatchNorm Collapse)) | completed | `cnet_dual_unet` | 121 (61/60) | `128x128x16 / batch` | 65 | 0.833 | 0.065 | 0.512 | 8.0% | 96.7% | 0.0 | 69/121 |
| `3d-run_20261110_135412` (Version #37 (Active Production)) | **ACTIVE** | `cnet_dual_unet` | 121 (61/60) | `128x128x16 / batch` | 50 | 0.817 | 0.229 | 0.595 | 41.0% | 96.7% | 0.1 | 107/121 |
| `3d-run_20261110_075814` | completed | `3d-unet` | 121 (61/60) | `96x96x12 / instance` | 50 | 0.720 | 0.390 | 0.237 | 65.9% | 8.3% | 8.2 | 66/121 |
| `3d-run_20261109_170539` | completed | `3d-unet` | 121 (61/60) | `96x96x12 / instance` | 40 | 0.542 | 0.034 | 0.393 | 15.8% | 80.0% | 33.8 | 56/121 |
| `3d-run_20261109_062316` | completed | `3d-unet` | 121 (61/60) | `96x96x12 / instance` | 40 | 0.396 | — | 0.496 | — | — | 0.0 | 60/121 |
| `3d-run_20261108_204806` | completed | `3d-unet` | 121 (61/60) | `96x96x12 / instance` | 40 | 0.384 | — | 0.231 | — | — | 13.1 | 62/121 |
| `3d-run_20261108_182154` | completed | `3d-unet` | 76 (61/15) | `96x96x12 / instance` | 40 | 0.427 | — | 0.210 | — | — | 85.4 | 61/76 |
| `3d-run_20261031_114743` | completed | `3d-unet` | 76 (61/15) | `96x96x12 / instance` | 40 | 0.444 | — | 0.213 | — | — | 83.9 | 61/76 |
| `3d-run_20261031_103914` | completed | `3d-unet` | 76 (61/15) | `96x96x12 / instance` | 40 | 0.248 | — | 0.105 | — | — | 170.0 | 61/76 |
| `3d-results3d_backup_20261031_170031` | completed | `mednext` | — (?/?) | `— / instance` | 2 | 0.189 | — | 0.031 | — | — | 195.1 | 23/31 |
| `3d-run_20261030_170825` | completed | `3d-unet` | 76 (61/15) | `96x96x12 / instance` | 40 | 0.431 | — | 0.217 | — | — | 63.2 | 61/76 |
| `3d-run_1793370309` | completed | `3d-unet` | 76 (61/15) | `96x96x12 / instance` | 40 | 0.261 | — | 0.116 | — | — | 368.1 | 61/76 |
| `3d-run_20261030_024143` | completed | `3d-unet` | 76 (61/15) | `96x96x12 / instance` | 40 | 0.407 | — | 0.168 | — | — | 217.4 | 61/76 |
| `3d-run_20261029_162014` | completed | `3d-unet` | 76 (61/15) | `96x96x12 / instance` | 40 | 0.346 | — | 0.120 | — | — | 311.9 | 61/76 |
| `3d-run_20261029_121929` | completed | `3d-unet` | 76 (61/15) | `96x96x12 / instance` | 40 | 0.346 | — | 0.116 | — | — | 3794.6 | 61/76 |
| `3d-run_20261026_144449` | completed | `3d-unet` | 61 (61/?) | `96x96x12 / instance` | 40 | 0.358 | — | 0.160 | — | — | 3399.1 | 61/61 |
| `3d-run_20261014_061557` | completed | `3d-unet` | 61 (61/?) | `96x96x12 / instance` | 40 | 0.370 | — | 0.160 | — | — | 3530.6 | 61/61 |
| `3d-run_20261013_130538` | completed | `3d-unet` | 61 (61/?) | `96x96x12 / instance` | 40 | 0.568 | — | 0.210 | — | — | 1049.6 | 61/61 |
| `3d-run_20261013_103213` | completed | `3d-unet` | 61 (61/?) | `96x96x12 / instance` | 2 | 0.174 | — | 0.037 | — | — | 3585.5 | 61/61 |
| `3d-results3d_backup_20261014_172953` | completed | `3d-unet` | 61 (61/?) | `96x96x12 / instance` | 40 | 0.563 | — | 0.202 | — | — | 1050.8 | 61/61 |
| `2dseg-unet2d-baseline` (2D Seg v1) | completed | `unet2d` | 18 (?/?) | `256x256 / batch` | 30 | 0.828 | — | 0.409 | — | — | — | — |

---

## 4. Detailed Per-Fold Breakdowns (Key Milestones)

### Version #37 — Active Production (`cnet_dual_unet`, 121 cases)

- **Note:** Best 121-case clinical balance served in app (Version #37): 107/121 presence accuracy, 96.7% control specificity, Pos BME Dice 0.229; missed 12/61 borderline positives due to hard C-Net gate.

| Fold | Epochs | Final Loss | Bone Dice | Pos BME Dice | Overall BME Dice | Sens (Pos) | Control TNR | FP / Case | AMP Skip |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Fold 0 | 50 | 0.6845 | 0.790 | 0.263 | 0.631 | 38.8% | 100.0% | 0.08 | 7 |
| Fold 1 | 50 | 0.7233 | 0.857 | 0.207 | 0.588 | 46.1% | 100.0% | 0.00 | 7 |
| Fold 2 | 50 | 0.7129 | 0.794 | 0.223 | 0.611 | 48.6% | 100.0% | 0.08 | 7 |
| Fold 3 | 50 | 0.7341 | 0.826 | 0.178 | 0.548 | 46.5% | 91.7% | 0.29 | 7 |
| Fold 4 | 50 | 0.7638 | 0.817 | 0.276 | 0.596 | 24.9% | 91.7% | 0.04 | 7 |

### Version #41 — Diagnosed Fold Collapse (`cnet_dual_unet`, 65 epochs, BatchNorm)

- **Note:** Fold 0 hit 0.324 Pos BME Dice (11/12 TP), but Folds 1-4 collapsed to zero edema under BatchNorm3d drift + AMP spikes without gradient clipping + hard C-Net gating.

| Fold | Epochs | Final Loss | Bone Dice | Pos BME Dice | Overall BME Dice | Sens (Pos) | Control TNR | FP / Case | AMP Skip |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Fold 0 | 65 | 1.2061 | 0.793 | 0.324 | 0.579 | 40.0% | 83.3% | 0.21 | 9 |
| Fold 1 | 65 | 1.7154 | 0.860 | 0.000 | 0.480 | 0.0% | 100.0% | 0.00 | 6 |
| Fold 2 | 65 | 1.8069 | 0.823 | 0.000 | 0.500 | 0.0% | 100.0% | 0.00 | 6 |
| Fold 3 | 65 | 1.7817 | 0.852 | 0.000 | 0.500 | 0.0% | 100.0% | 0.00 | 6 |
| Fold 4 | 65 | 1.7268 | 0.837 | 0.000 | 0.500 | 0.0% | 100.0% | 0.00 | 6 |

### UNet3D High-Recall Pre-Gate (`3d-unet`, 121 cases — 65.9% Pos Sens, 8.3% Spec)

- **Note:** 121 volumes (61 with edema, 60 without), 5 patient_grouped_stratified folds, patch 96x96x12. Bone and edema are trained together. Edema outside the predicted bone is removed. Dice, lesion sensitivity, and false positives per case are mean ± std across folds.

| Fold | Epochs | Final Loss | Bone Dice | Pos BME Dice | Overall BME Dice | Sens (Pos) | Control TNR | FP / Case | AMP Skip |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Fold 0 | 50 | 1.6683 | 0.646 | 0.359 | 0.180 | 50.1% | 0.0% | 11.42 | 5 |
| Fold 1 | 50 | 1.7039 | 0.778 | 0.397 | 0.287 | 68.2% | 16.7% | 5.84 | 5 |
| Fold 2 | 50 | 1.6936 | 0.733 | 0.422 | 0.211 | 79.0% | 0.0% | 7.42 | 7 |
| Fold 3 | 50 | 1.6823 | 0.749 | 0.376 | 0.271 | 77.1% | 16.7% | 10.58 | 4 |
| Fold 4 | 50 | 1.6717 | 0.694 | 0.394 | 0.239 | 55.0% | 8.3% | 5.75 | 5 |

### 2D Dual-Channel U-Net Baseline (`unet2d`, 18 early cases)

- **Note:** Lesion Dice is averaged over slices that actually contain a lesion; including empty slices would inflate it towards 1. False positives are counted on slices with no reference lesion.

| Fold | Epochs | Final Loss | Bone Dice | Pos BME Dice | Overall BME Dice | Sens (Pos) | Control TNR | FP / Case | AMP Skip |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Fold ? | 30 | — | 0.860 | — | — | 100.0% | — | — | — |
| Fold ? | 30 | — | 0.817 | — | — | 100.0% | — | — | — |
| Fold ? | 30 | — | 0.702 | — | — | 100.0% | — | — | — |
| Fold ? | 30 | — | 0.894 | — | — | 100.0% | — | — | — |
| Fold ? | 30 | — | 0.867 | — | — | 100.0% | — | — | — |

---

## 5. Active Training Run (`OrthoGate-MedNeXt3D`)

- **Run Key:** `3d-run_20261111_062858`
- **Status:** `RUNNING` on `Kaggle T4 x2` (`121` scans: `61` BME+ / `60` Control, `5` folds × `65` epochs)
- **Model Spec:** `base_channels=20`, `double_conv=True`, `aniso=True`, `norm_type=group`, `patch=128x128x16`, `spacing=0.5,0.5,3.0 mm`
- **Loss & Stability:** `Tversky(alpha=0.3, beta=0.7)` + `Focal` + `0.3 * Deep Supervision` + `0.5 * C-Net BCE` + `clip_grad_norm_(1.0)`
- **Inference & Gating:** `Soft C-Net Ramp`, `Gaussian Patch Stitching`, `3x3x1 Intra-Osseous Closing`, `Confidence Hysteresis (>=25 vox @ peak>=0.65)`, `Flip TTA`, `5-Fold Prob Ensemble`

*Once this Kaggle job finishes and imports results, re-run `pnpm --filter @bme/db db:seed-benchmarks` and refresh this report before pushing final metrics to GitHub.*
