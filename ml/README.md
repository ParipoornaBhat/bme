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
- **Patient-level splits only.** Never let slices from one case straddle a fold boundary.
- The locked test set is evaluated **once**, at the end.
- No patient identifiers in code, logs, filenames, or commit messages. Pseudonymous IDs only.
