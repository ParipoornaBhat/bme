# BME Project — what exists, what is used, what is next

Last updated: 2026-08-28 · 20 commits

---

## 1. Where the project stands in one line

Two independent pipelines. **2D works and has real numbers.** **3D is fully built but has never
trained, because it needs annotations that do not exist yet.**

---

## 2. The dataset

| | |
|---|---|
| Cases | **107 usable** (47 BME, 60 non-BME) + 1 unreadable archive |
| Body region | Knee, throughout |
| Scanners | 3 (UIH uMR 780, Siemens Avanto, Siemens Symphony) |
| Sequence | Fat-suppressed PD/T2/STIR — present on **107/107** |
| T1 | Only 18/107, and 5/47 BME cases |
| Size | 3.0 GB source, 5.7 GB generated |

**Every filename is pseudonymous.** 108 archives and 121 images renamed to `BME-001.zip`,
`BME-2D-004.jpeg`. DICOM headers scrubbed on 13,818 images. No patient name exists anywhere on
disk except three mapping CSVs, which are gitignored and local-only.

**The finding that changed the design:** only 16% of cases have a T1 sequence. The original plan
used T1 as a second input channel to separate real edema from lookalikes. Not possible — so the
model is single-channel, and the specificity has to come from elsewhere (see §5).

---

## 3. What is used

| Layer | Tool | Why |
|---|---|---|
| Web app | Next.js 15 | Thunder Stack |
| API | Hono, on **Node** | Was Cloudflare `workerd`; it cannot connect to managed Postgres |
| Database | **Supabase** Postgres 17 + pgvector 0.8.2 | Shared by all four teammates |
| Auth | Better Auth, credential login | Four `@nmamit.in` accounts seeded |
| ML | PyTorch 2.13 + torchvision (CPU) | No CUDA build for Python 3.14 yet |
| 2D models | ResNet 18/34/50, EfficientNet-B0, DenseNet-121, ConvNeXt-Tiny, MobileNetV3 | All ship with torchvision — switching needs no install |
| 3D model | **nnU-Net v2** (a self-configuring U-Net) | Standard for medical segmentation; CNNs beat transformers at this data scale |
| Imaging | SimpleITK, nibabel, pydicom, pynrrd | DICOM → NIfTI → NRRD |
| Viewer | `nifti-reader-js` + Canvas | Three-plane painting in the browser |

Everything is a CNN. ResNet/MobileNet are **classifiers** ("is there edema?"); U-Net is a
**segmenter** ("where exactly?"). Different jobs, hence different models.

---

## 4. Features implemented

### Web app — everything runs in the browser

| Page | What it does |
|---|---|
| `/annotate` | Case list, three-plane MPR viewer, brush + eraser, three named segments, **"only inside bone"** masking, undo, saves `.seg.nrrd` automatically |
| `/training` | Pick a model, set folds/epochs, Start/Stop, live log, progress bar + ETA, run history, AUC chart |
| `/results` | 2D and 3D tabs, case- and slice-level metrics, confusion matrix, per-fold table |
| `/storage` | Size breakdown by category, disk usage |

### Team collaboration

The imaging never moves through the app — it is patient data, shared by hand. The **database holds
the ledger**: who annotated which case, when, and the segment sizes.

- Saving records you as the annotator
- A case done by someone else, with no local file, shows an amber **"your local copy is behind"**
  banner naming who to ask
- Multiple people can annotate the same case. Saves write `<CASE>.seg.nrrd` (canonical, what
  training reads) *and* `<CASE>__<annotator>.seg.nrrd` (kept forever). Without the second, the
  last person to save would erase everyone before them — and inter-rater Dice would be impossible.
- Work is assigned: ~26 cases each, isotropic cases spread evenly, 5 cases shared by all four.

### Pipeline scripts (`ml/scripts/`)

| Script | Job |
|---|---|
| `inventory.py` | Reads DICOM headers straight from the zips |
| `deid.py` | Strips PHI, assigns pseudonymous IDs |
| `case_registry.py` | Ties each ID to a content hash so IDs match on every machine |
| `rename_archives.py` / `rename_images.py` | Renames files to case IDs, keeps an undo map |
| `convert.py` | DICOM → NIfTI, picks each case's primary sequence |
| `make_2d.py` | Cuts volumes into 1,975 training images |
| `train_2d.py` | 2D classifier, patient-level cross-validation |
| `seg2nifti.py` | Slicer `.seg.nrrd` → training labels, **with validation** |
| `build_dataset.py` | nnU-Net layout + patient-level splits |
| `train.py` | nnU-Net wrapper |
| `write_seg.py` | Web editor → Slicer-compatible `.seg.nrrd` |
| `slicer_setup.py` | Sets up a 3D Slicer session correctly |

Every script that writes has a dry-run and refuses to overwrite without `--force`.

---

## 5. The model design

```
Scan → Stage B: find the bone → Stage C: find edema INSIDE the bone → volume + 3D shape
```

Stage C only ever sees voxels inside Stage B's mask. This makes muscle and joint-fluid false
positives **structurally impossible** rather than something the network must learn — and it is
also what lets a non-radiologist annotate, since the computer outlines the bone for you.

With T1 unavailable, specificity comes from two channels that need no second scan:
a **left-right mirrored copy** (asymmetry is the earliest sign) and an **anomaly residual** from a
model trained only on healthy marrow.

---

## 6. Results so far

**2D classifier, 5-fold, split by patient:**

| Metric | Case level |
|---|---|
| Accuracy | 64.5% |
| F1 | 0.587 |
| **ROC AUC** | **0.665** |

This is **weak** — 0.5 is random guessing. Two honest reasons:

1. **Noisy labels.** The label is per *case*, applied to every slice. A BME patient's scan has many
   slices with no edema on them, all labelled BME. Part of the task is unlearnable.
2. **Overfitting.** Training loss fell 0.51 → 0.03 over 6 epochs while validation stayed near 60%.
   It stopped learning by epoch 3 and started memorising.

**3D: no results.** Zero annotations, so it has never trained.

---

## 7. What to do next

**In order. Each step feeds the next.**

1. **Re-run ResNet-18 properly** — 5 folds, **3–4 epochs** (not 6). The current app shows a
   throwaway MobileNet smoke test, not a real result.
2. **Annotate 10 cases** at `/annotate`. This is the critical path; everything else waits on it.
3. **Measure inter-rater Dice** on the 5 shared cases. That number is the model's realistic
   ceiling and makes every later result interpretable.
4. **Train Stage B** (bone). Should clear Dice 0.90 easily — if not, the data pipeline is broken.
5. **Train Stage C** (edema), then add the mirror and anomaly channels as an ablation table.
6. **Quantification** — lesion volume in mm³, 3D surface export.
7. **Explainability** — uncertainty maps, per-lesion evidence table.

**Ask the guide now, in parallel — these have lead time:**

- Can a radiologist review ~20 annotations? Decides whether you claim expert-validated or
  student-labelled ground truth.
- Can the data leave the hospital network? Decides whether "cloud-enabled" survives.
- Are the `.docx` files in 5 archives radiology reports? If so they are PHI *and* free weak labels.

---

## 8. Not built yet

- 2D mask drawing (the 2D model needs no drawing — its label is the folder)
- Reset/delete training runs from the UI
- 3D training controls (nothing to train yet)
- Grad-CAM / heatmaps in the UI
- Review page is a standalone HTML file, not a page in the app

## 9. Known issues

| Issue | Impact |
|---|---|
| **The annotation tool has never been used by a human** | Save path is verified; the drawing experience is unknown |
| PyTorch is CPU-only | 5 folds × 6 epochs took ~45 min. RTX 4050 unused — no CUDA wheel for Python 3.14 |
| `BME/IMRAZ.zip` has no DICOM | −1 case |
| 17 non-BME cases have a PNG but no volume | Re-export or drop |
| ~10:1 voxel anisotropy | 3D surfaces need smoothing or they look terraced |
| 2 demo accounts with published passwords | `admin@thunder.com` — harmless locally, remove before any deploy |

---

## 10. Realistic targets

| Metric | Target |
|---|---|
| Bone segmentation Dice | 0.92 |
| **BME lesion Dice** | **0.60–0.72** |
| Lesion sensitivity | 0.80 at ≤1.5 false positives/case |
| Case-level AUC | 0.90 |

Published fully-automated BME work reports sensitivity 0.58–0.83 on **larger** datasets. Dice 0.62
with sensitivity 0.80 is a publishable result. Do not chase 0.90 on lesions — at this data scale it
would mean a leak, not a good model.
