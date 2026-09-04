# BME Project — what exists, what is used, what is next

Last updated: 2026-09-04

---

## 1. Where the project stands in one line

**Three** models are built. The 2D *classifier* and the 2D *segmenter* both train, save
per-fold checkpoints, and run on an uploaded image from `/results`. The 3D segmenter is
written and smoke-tested but has never trained, because it needs 3D annotations that do not
exist yet.

## 1b. The three models, and why there are three

| Model | Question it answers | Needs drawing? | Output |
|---|---|---|---|
| **2D classifier** | "Does this scan have edema?" | No — the folder is the label | Yes/no + confidence |
| **2D segmenter** | "Where is the edema on this slice?" | Yes | A mask, per slice |
| **3D segmenter** | "Where is it in the volume, and how big?" | Yes | 3D mask, mm³, surface |

The classifier exists because it needed **zero annotation** and could produce a number
immediately. That is also its ceiling: it cannot mark anything, and a per-case label applied to
every slice is noisy by construction.

**The two segmenters share one annotation effort.** A 3D annotation is a stack of 2D ones, so
`make_2d_seg.py` slices the same `.seg.nrrd` files into image/mask pairs. Annotate once, train
both. There is deliberately no separate 2D annotation tool — it would be the same work done
twice.

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
| Web app | Next.js 15 | App Router, server routes read the pipeline output directly |
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
| `/annotate` | Slicer-style Four-Up: three planes plus a live 3D surface. Crosshair sync, brush **and pencil** (trace an outline, Enter fills it), eraser, three named segments, **"only inside bone"** masking, Ctrl+Z/Y, saves `.seg.nrrd` automatically |
| `/training` | Pick a model, set folds/epochs, Start/Stop, live log, progress bar + ETA, run history, AUC chart |
| `/results` | 2D and 3D tabs, case- and slice-level metrics, confusion matrix, per-fold table, **upload a slice** → YES/NO + per-fold spread + Grad-CAM + edema mask and overlay |
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
| `train_2d.py` | 2D classifier (yes/no), patient-level cross-validation |
| `make_2d_seg.py` | Slices the 3D annotations into 2D image/mask pairs |
| `make_seg2d_from_masks.py` | Painted 2D masks → `data/seg2d/` image/mask pairs |
| `train_2d_seg.py` | 2D U-Net that **marks** the edema — bone + lesion channels |
| `infer_2d.py` | One image → YES/NO, Grad-CAM and edema mask, as JSON. Loads checkpoints; never trains |
| `gradcam.py` | Grad-CAM heatmaps from the saved checkpoints, on held-out folds |
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

**2D classifier — ResNet-18, 5-fold, patient-level splits, 8 epochs, curated 2D dataset
(94 images, 87 patients, 18 BME):**

| Metric | Case level |
|---|---|
| Accuracy | 90.8% |
| F1 | 0.789 |
| **ROC AUC** | **0.961** (across folds **0.977 ± 0.032**) |
| Confusion | `[[64, 5], [3, 15]]` — TN, FP / FN, TP |

**Do not quote this.** It is measured, seeded and reproducible, and it is also almost
certainly inflated. Two pixel-level leaks were found on 2026-09-04:

- **A red ellipse drawn around the lesion** is burned into `BME-2D-005` and `BME-2D-008` —
  a human annotation, present in 2/25 BME images and 0/69 non-BME.
- **A burned-in yellow A/P orientation overlay** appears in 19/69 non-BME images (28%) but
  1/25 BME (4%), and the two folders are framed and cropped differently. They came from
  different exporters, and "which exporter" is trivially learnable.

Neither explains 0.96 on its own, but a classifier does not have to find edema when the
folder is written on the image. Retrain on a centre crop that excludes the borders, drop or
repair the two annotated images, and report whatever survives.

The number it replaced, on the old volume-derived 1,975-slice set, was **0.658** — and that
one was weak for two honest reasons that still apply here:

1. **Noisy labels.** The label is per *case*, applied to every slice. A BME patient's scan has many
   slices with no edema on them, all labelled BME. Part of the task is unlearnable.
2. **The task itself is hard.** Early edema is subtle and low-contrast; a single 2D slice viewed
   without anatomical context is thin evidence.

### Two controlled experiments, both negative — and both worth reporting

**High-intensity masking did not transfer.** Published as lifting AUC 0.55 → 0.96 on a
*paediatric* cohort. Under matched conditions (same architecture, folds, seed, epochs) it made
our results **worse**: 0.604 vs 0.658, losing on every individual fold. The technique was
compensating for growth-plate confounds, which adult knees do not have, while discarding
surrounding anatomy the model was using.

**More epochs did not help.** 6 epochs gave 0.665; 3 epochs gave 0.658 with a *better*
across-fold mean and lower variance. Training loss fell 0.51 → 0.03 while validation stayed
flat — the model stopped learning around epoch 3 and spent the rest memorising. Use 3.

Testing published methods properly and reporting that they did not transfer is a stronger
methodology section than a single unexplained number.

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

- **2D slice-level labels.** The 2D *classifier* needs no drawing — the folder is its label.
  But that is exactly why it is weak: a BME scan has ~25 slices and maybe 6 show edema, yet all
  25 are labelled BME. Ticking which slices actually show edema (no drawing, ~2 min/case) would
  attack that directly. 2D *segmentation* — outlining the region — is a separate, larger job and
  is probably not worth it when 3D gives volume and shape.
- 3D training controls (nothing to train yet)
- Review page is a standalone HTML file, not a page in the app

## 9. Known issues

| Issue | Impact |
|---|---|
| **The annotation tool has never been used by a human** | Save path is verified; the drawing experience is unknown |
| PyTorch is CPU-only | ~45 min per 5-fold run. A CUDA build **does** exist (`torch 2.13.0+cu126`) — I was wrong earlier that none was available. Installing it is a ~2.5 GB download, deferred by choice. Roughly 10x faster. |
| `BME/IMRAZ.zip` has no DICOM | −1 case |
| 9 non-BME patients have a screenshot but no scan | `Non BME/2d` holds 69 pictures, `Non BME/3d` holds 60 scans. A picture alone cannot be measured or reconstructed, so those 9 are excluded. Recovering their zips would take healthy cases 60 → 69. |
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
