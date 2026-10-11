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

For fast training on free cloud GPUs (NVIDIA T4, 30 free hours/week) without local hardware bottlenecks.

### Safeguarded CLI Pipeline (`ml/scripts/kaggle_pipeline.py`)

Every step requires explicit subcommands and confirmations. No data is ever transmitted automatically:

1. **Preflight**: Verify de-identification, leak guards, and volume integrity:
   ```bash
   python ml/scripts/kaggle_pipeline.py preflight --export-dir ../bme_colab_export --mapping-file ../bme_recovery/export_mapping.json
   ```
2. **Upload**: Upload strictly the verified de-identified export to a private Kaggle dataset:
   ```bash
   python ml/scripts/kaggle_pipeline.py upload --confirm-upload --export-dir ../bme_colab_export --mapping-file ../bme_recovery/export_mapping.json
   ```
3. **Launch**: Push and execute the notebook kernel on Kaggle GPU (`--mode quick` smoke test by default; `--mode bench` for 1 fold x 1 epoch speedup benchmark; `--mode fold0` for fold 0 x 40 epochs; `--mode full` for all 5 folds x 40 epochs, with optional `--folds`):
   ```bash
   python ml/scripts/kaggle_pipeline.py launch --confirm-launch [--mode {bench,quick,fold0,full}] [--folds 0 1 ...]
   ```
4. **Status**: Monitor cloud execution:
   ```bash
   python ml/scripts/kaggle_pipeline.py status
   ```
5. **Download**: Download outputs into an isolated staging directory outside the repo:
   ```bash
   python ml/scripts/kaggle_pipeline.py download --staging-dir ../bme_kaggle_staging
   ```
6. **Import**: Validate weights (weights_only=True, tensor shapes, allowlist) into `data/results3d`:
   ```bash
   python ml/scripts/kaggle_pipeline.py import --staging-dir ../bme_kaggle_staging
   ```

### Manual Fallback (Zero API Dependencies)

If you prefer not to use the Kaggle API or CLI:
1. **Export & Verify Dataset Locally**:
   ```bash
   python ml/scripts/export_for_colab.py --src . --dst ../bme_colab_export --mapping-file ../bme_recovery/export_mapping.json
   python ml/scripts/export_for_colab.py --verify --src . --dst ../bme_colab_export --mapping-file ../bme_recovery/export_mapping.json
   ```
2. **Upload to Kaggle as Private Dataset**:
   - Go to [kaggle.com/datasets](https://www.kaggle.com/datasets) -> **New Dataset**.
   - Upload the folder `../bme_colab_export` (upload the folder directly, not a zip, never both).
   - Title: `BME 3D Dataset` (slug `bme-3d-dataset`).
   - **Crucial**: Set visibility to **Private Dataset** and click Create.
3. **Upload & Run Notebook**:
   - Go to [kaggle.com/code](https://www.kaggle.com/code) -> **New Notebook** -> **File > Upload Notebook**.
   - Select `ml/notebooks/train_3d_colab.ipynb`.
   - Under **Input** (right sidebar), click **+ Add Input** and add your private `bme-3d-dataset`.
   - Under **Settings**, select **Accelerator > GPU T4** and enable **Internet**.
   - Set `CONFIG_MODE = "quick_test"` (for smoke test), `"bench"` (for speedup benchmark), `"fold0"` (for single fold), or `"full"` (for production) in the config cell.
   - Click **Save Version > Save & Run All (Commit)**.
4. **Import Downloaded Weights**:
   - When training finishes, download `results3d.zip` from the notebook's **Output** tab.
   - Verify and import locally:
     ```bash
     python ml/scripts/verify_and_import_weights.py path/to/results3d.zip data/results3d
     ```
