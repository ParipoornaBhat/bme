# ml — BME detection pipeline

Python side of the project. The model lives here; the Thunder Stack app in `client/` and
`server/` calls it over HTTP. See [../docs/PRD.md](../docs/PRD.md) for the full design.

## Why this is a separate service

PyTorch cannot run on Cloudflare Workers. The Hono API is a gateway — it owns auth, job
records, and result serving. This package owns the model and nothing else. They talk over
HTTP with a shared secret.

## Layout

| Path | Stage (PRD §4) | Purpose |
|---|---|---|
| `src/bme/preprocess/` | A | DICOM to NIfTI, N4 bias correction, intensity normalization, T1 to STIR registration |
| `src/bme/datasets/` | — | nnU-Net `dataset.json` builders, patient-level split logic |
| `src/bme/train/` | B, C, D | nnU-Net / MedNeXt configs, mask-inpainting normative model |
| `src/bme/infer/` | — | Cascade runner: bone mask, then BME inside it |
| `src/bme/quantify/` | E | Connected components, volumes, SI ratios, marching cubes to GLB |
| `src/bme/serve/` | — | FastAPI app the Hono gateway calls |
| `scripts/` | — | One-shot CLI tools: `deid.py`, `convert.py`, `seg2nifti.py`, `qc_report.py` |
| `notebooks/` | — | Exploration only. Nothing here is a dependency of the pipeline. |

## Setup

Python **3.14 is fine** — verified 2026-08-26 that torch 2.13.0, nnunetv2 2.8.1 and
monai 1.6.0 all publish `cp314` wheels, and the full nnU-Net dependency tree resolves.
An earlier version of this file wrongly claimed a 3.13 ceiling.

```bash
python -m venv ml/.venv
ml/.venv/Scripts/python.exe -m pip install numpy nibabel pydicom SimpleITK pynrrd scipy
```

That covers de-identification, conversion and dataset building. For training, install the
torch build matching your CUDA (see pytorch.org) and then:

```bash
ml/.venv/Scripts/python.exe -m pip install -e ".[train]"
```

`ml/.venv/` is gitignored.

## Pipeline order

```bash
python ml/scripts/inventory.py     <base>                  # what the archives contain
python ml/scripts/deid.py          <base>                  # -> data/raw/<CASE>/
python ml/scripts/convert.py       <base>                  # -> data/nifti/, worklist.csv
#   ... annotate in 3D Slicer -> data/annotations/<CASE>/<CASE>.seg.nrrd ...
python ml/scripts/seg2nifti.py     <base>                  # -> *_labels.nii.gz, validated
python ml/scripts/build_dataset.py <base> --stage bone     # -> nnU-Net layout + splits
python ml/scripts/train.py         <base> --stage bone
python ml/scripts/build_dataset.py <base> --stage bme
python ml/scripts/train.py         <base> --stage bme
```

Every script takes `--dry-run` or `--check-only` and refuses to overwrite without `--force`.

## Rules

These are enforced in [../CLAUDE.md](../CLAUDE.md); repeated here because they are easy to
violate by accident.

- `data/raw/` and `data/nifti/` are **immutable**. Derived output goes to a new directory.
- `.seg.nrrd` is the only human-edited annotation file. Every `.nii.gz` labelmap is generated
  and disposable.
- The label mapping is keyed by **segment name**, never segment order:
  `1=bone_marrow`, `2=bme`, `3=uncertain`. Hard-fail on an unknown name rather than guessing.
- Patient-level splits only. Never let slices or multi-scan cases from one patient straddle a fold boundary.
- The locked test set is evaluated once, at the end.
- No patient identifiers in code, logs, filenames, or commit messages. Pseudonymous IDs only.

## Cross-Validation Folds & Comparability

### Patient-Grouped Folds (Default)
By default, `ml/scripts/train_3d.py` assigns cross-validation folds grouped strictly by `patient_id` (read from the de-identified `worklist.csv`):
1. **Patient Grouping**: All scans of the same patient are grouped together. Paired scans never straddle train and validation splits.
2. **Deterministic Shuffling**: Sorted unique patient IDs are deterministically shuffled using `SEED=42`. Directory discovery order and case renaming do not alter fold assignment.
3. **Balanced Allocation**: Patient groups are assigned via greedy bin-packing to the currently smallest fold (ties broken by lowest fold index). Fold sizes remain balanced within ±1 case.
4. **Fail-Closed Privacy**: If `patient_id` is missing or blank for any case in `worklist.csv`, execution halts with a clear error unless `--allow-case-level-folds` is explicitly specified.

### Reproducing Legacy Runs (`--legacy-case-folds`)
Earlier versions assigned folds at the case level via round-robin (`groups[i % folds_n].append(case)` on sorted case IDs), which could allow multi-scan patients to straddle fold boundaries.
To reproduce those historical assignments bit-for-bit:
```bash
python ml/scripts/train_3d.py <base> --legacy-case-folds
```

### Why Old and New Runs Are NOT Comparable
1. **Holdout Independence**: Legacy runs used scan-level holdouts where paired scans of the same patient could appear in both train and validation sets. Patient-grouped runs enforce strict patient-level holdouts, preventing multi-scan leakage.
2. **Dataset Fingerprint Isolation**: Checkpoints and metrics embed a SHA-256 dataset fingerprint and `fold_mode` ("patient_grouped" vs "legacy_case_level"). Auto-resume (`--resume`) and completed fold skipping (`--skip-completed`) detect mismatches and refuse to merge or resume across different fold modes.
3. **Sampling Mix Isolation**: Patch sampling mix (`--sampling-mix lesion=A,bone=B,random=C`) is recorded in `data_config` and the fingerprint. Non-default sampling requires an isolated `--out-dir` outside `data/`.

## Kaggle Cloud GPU Training (3D U-Net)

For fast training on free cloud GPUs (NVIDIA T4) without local hardware bottlenecks.

### Safeguarded CLI Pipeline (`ml/scripts/kaggle_pipeline.py`)

Every step requires explicit subcommands and confirmations. No data is ever transmitted automatically.

#### 1. Diagnostics (`doctor`)
Runs 12-point system, environment, network, and security diagnostics without exposing credentials:
```bash
pnpm kaggle:doctor
# Or check remote dataset visibility:
pnpm kaggle:doctor --remote
```

#### 2. One-Time Setup Flow (Approve & Upload Once)
1. **Export & Verify Locally**:
   ```bash
   python ml/scripts/export_for_colab.py --src . --dst ../bme_colab_export --mapping-file ../bme_recovery/export_mapping.json
   ```
2. **Approve Dataset**:
   Runs preflight and `check_deid_folder.py` to record a tamper-proof approval hash:
   ```bash
   pnpm kaggle:approve --confirm-approve
   ```
3. **Upload Once (Fast Network Recommended)**:
   Compares local hash to approval record and queries Kaggle remotely. If the remote dataset already carries the approved hash, nothing is uploaded:
   ```bash
   pnpm kaggle:upload --confirm-upload
   ```

#### 3. Per-Run Training Flow (`run`)
Launches the notebook kernel with your desired mode, tracks execution status, downloads filtered outputs (`fold_*.pt`, `metrics*.json`, `run_status.json`), and executes verified import:
```bash
# Smoke test (quick_test: 2 folds x 2 epochs)
pnpm kaggle:run --mode quick --confirm-launch

# Speed benchmark (bench: 1 fold x 1 epoch)
pnpm kaggle:run --mode bench --confirm-launch

# Single fold (fold0: fold 0 x 40 epochs)
pnpm kaggle:run --mode fold0 --confirm-launch

# Production training (full: 5 folds x 40 epochs)
pnpm kaggle:run --mode full --confirm-launch

# Evaluation suite & post-processing diagnostics
pnpm kaggle:run --mode eval_suite --confirm-launch
```

If the training process or your laptop restarts, resume tracking and download without re-launching:
```bash
pnpm kaggle:run --resume
# Or fetch latest results directly:
pnpm kaggle:fetch
```

### Import Safety Policy
- **Production Weights (`data/results3d/`)**: Only runs whose `run_status.json` verifies `mode == "full"`, `complete == true`, and dataset fingerprint matches are imported into `data/results3d/` through `verify_and_import_weights.py` (with automatic backup of previous weights).
- **Experimental Runs**: Outputs from `quick`, `bench`, `fold0`, incomplete runs, or fingerprint mismatches are safely archived to `data/results3d_experiments/<run_id>/` and are never permitted to overwrite production results.

### Stale-Build Warning
If you pull new changes or edit frontend/backend code, ensure you rebuild and restart the production server:
```bash
pnpm build
next start -H 127.0.0.1
```
The Train3D UI automatically displays a build-stamp alert if the server build is out-of-sync with current source code.

### Manual Fallback (Zero API Dependencies)
If you prefer not to use the Kaggle API or CLI:
1. Export and verify locally using `export_for_colab.py`.
2. Go to [kaggle.com/datasets](https://www.kaggle.com/datasets) -> New Dataset. Upload `../bme_colab_export` directly as a **Private Dataset**.
3. Upload `ml/notebooks/train_3d_colab.ipynb` to [kaggle.com/code](https://www.kaggle.com/code).
4. Attach your private dataset, enable GPU T4 and Internet, select `CONFIG_MODE`, and click **Save & Run All (Commit)**.
5. Download `results3d.zip` from outputs and verify locally:
   ```bash
   python ml/scripts/verify_and_import_weights.py path/to/results3d.zip data/results3d
   ```

## Evaluation Suite & Post-Processing (`ml/scripts/eval_suite.py`)

### 1. Leakage Rule & Multi-Fold Ensembling
- **Cross-Validation Patients**: Any case that was part of the cross-validation training pool must **never** be evaluated with a multi-fold ensemble. For CV cases, out-of-fold (OOF) inference is strictly enforced: only the fold model whose recorded `val_cases` contain the case may evaluate it.
- **Ensemble Policy**: Multi-fold ensembling (averaging soft probabilities across all 5 folds) is mathematically valid **only** on an external test set or a locked test cohort (`--test-patients-file`). Running multi-fold ensembles on cross-validation data causes in-sample information leakage because every case was in 4 out of 5 fold models' training sets.

### 2. Honest Nested Cross-Validation for Post-Processing
- Post-processing thresholds (edema probability threshold $\theta \in [0.3, 0.8]$ and 3D connected-component minimum size in $\text{mm}^3$) are selected through **nested cross-validation**:
  - For each held-out fold $k$, parameter optimization is performed strictly on the remaining 4 folds ($folds \ne k$).
  - The chosen parameters are then applied without modification to evaluate the held-out fold $k$.
  - This prevents post-processing hyperparameter overfitting and yields an honest generalization estimate.
  - An optimistic "tuned on everything" baseline is also computed for comparison and clearly flagged as optimistic.

### 3. Patient-Level Bootstrap Confidence Intervals
- Because several patients have bilateral knee scans or repeat sessions, confidence intervals are computed using **patient-level bootstrap resampling** (2,000 iterations).
- All scans belonging to the same patient move together into each resample, preserving intra-subject correlations and preventing overconfident confidence intervals.
- Paired bootstrap resampling is used to evaluate significance differences between competing configurations.
