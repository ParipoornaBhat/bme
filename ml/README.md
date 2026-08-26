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

```bash
uv venv --python 3.11
uv pip install -e ".[dev]"
```

Install PyTorch separately — the wheel depends on your CUDA version, so it is deliberately
not in the default dependency set. Pick the right command from pytorch.org, then:

```bash
uv pip install -e ".[train]"
```

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
