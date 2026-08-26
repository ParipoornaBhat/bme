# PRD — Explainable Unified Deep Learning for Bone Marrow Edema (BME) Detection in MRI

**Team:** Elvin Edwin Rodrigues (NNM23CS071), Paripoorna B (NNM23CS124), Reegan Sujal Pinto (NNM23CS149), Aditi H Nayak (NNM23CS293)
**Dept:** Computer Science and Engineering
**Doc status:** v1 — planning. Data collection in progress.
**Companion doc:** [ANNOTATION_SOP.md](ANNOTATION_SOP.md) — read this before you annotate a single case.

---

## 0. TL;DR — what this document decides

| Question | Decision |
|---|---|
| Best model for the segmentation task | **nnU-Net v2, `3d_fullres` with the ResEnc-L planner.** MedNeXt-L as the challenger. Not a transformer, not Mamba. |
| One model or several? | **Two-stage cascade.** Stage B finds bone/marrow. Stage C finds edema *inside* Stage B's mask. This is the single most important design choice in the doc. |
| How do we handle "early BME is subtle"? | A third, **normative/anomaly branch** trained only on your Non-BME cases. Residual from "expected normal marrow" = candidate lesion. Uses your negatives, which you have more of. |
| How do we annotate? | 3D Slicer, on the **source volume**, saved as **`.seg.nrrd`** (master) then derived `.nii.gz` labelmap (training). Never PNG screenshots. |
| How do we get 3 views + 3D from one annotation? | You already do. Slicer stores a 3D voxel labelmap; painting in axial automatically populates sagittal/coronal/3D. The discipline is to *verify* in the other two planes. |
| Explainability | The mask itself + per-lesion SI ratios + uncertainty maps. Grad-CAM only on the case-level head. |
| Web platform | Thunder Stack (Next.js + Hono + Drizzle/Postgres) as the app, **plus a separate Python FastAPI+PyTorch inference service.** ML cannot run on Cloudflare Workers. |
| Realistic target | Bone Dice ≥ 0.92. **BME lesion Dice 0.60–0.72.** Case-level AUC ≥ 0.90. Anything claiming BME Dice > 0.85 is on a much larger dataset than yours. |

---

## 1. The problem, restated in engineering terms

The synopsis states the clinical problem well. Restated as what we actually have to build:

Given a 3D MRI volume of a joint (knee / hip / sacroiliac), produce:

1. A **binary 3D voxel mask** of bone marrow edema.
2. That mask **constrained to lie inside bone marrow** — never in muscle, fluid, or soft tissue.
3. **Quantification**: per-bone lesion volume (mm³), % of that bone's marrow volume, lesion count, max diameter, mean/max normalized signal intensity.
4. A **3D surface** of the lesion, renderable in a browser.
5. A **case-level call** (BME present / absent) with a calibrated confidence.
6. An **explanation** a clinician can audit in under 30 seconds.

Two things make this hard, and they are different problems needing different solutions:

- **Early BME is subtle.** Low contrast, ill-defined margins, small volume. Solved by the anomaly branch (§4.4) and by signal normalization (§4.1).
- **BME is easy to confuse with things outside bone.** Muscle edema, joint effusion, and cysts are all bright on STIR. Solved by the anatomy-first cascade (§4.2), which makes the confusion *structurally impossible* rather than something the model has to learn.

---

## 2. Current state audit

**Superseded by [DATASET.md](DATASET.md)** — full header-level inventory, generated
2026-08-26 after collection completed. Summary:

| Path | Contents | Verdict |
|---|---|---|
| `BME/` | 48 case archives, 47 readable | Collection complete |
| `Non BME/3d/` | 60 case archives, all readable | Collection complete |
| `BME/Annotated/` | **empty** | **The remaining blocker** |
| `Non BME/Slices/` | 69 PNG screenshots | Redundant — same cases now exist as volumes. Keep for figures. |

107 usable cases, knee, 47 BME : 60 non-BME, three scanners. Every case has a
fat-suppressed (edema-sensitive) sequence; only 16% have T1 — see §4.3.

Blockers 2 and 3 below are **resolved**: volumes replaced the PNGs, and both classes are
now the same modality. Blocker 1 (PHI) stands, and has a new dimension — 84 of 107 cases
have clean headers, but *every* case still carries a patient name in its filename.

### 2.1 Blocking issues, in priority order

**BLOCKER 1 — PHI in filenames and headers.**
Filenames carry patient names (`24 mamatha.png`, `44 abdularrahman png.png`, `62 MAMTA J SHENOY PNG.jpg`, `abdul pdfs.zip`). DICOM headers almost certainly carry `PatientName`, `PatientID`, `PatientBirthDate`, `InstitutionName`, and often burned-in text on the pixel data itself.

This must be fixed **before** the data goes into git, into cloud storage, or onto any shared drive. `.gitignore` now blocks the data folders, and the repo has zero commits — so nothing has entered git history. You are in the clean position. Keep it that way.

Required: a one-way pseudonymisation pass producing `BME-001`, `BME-002`, `NBME-001` and so on, with the name-to-ID mapping kept in a single `deid_map.csv` that lives **offline, never in the repo** (already gitignored). Use `pydicom` with a tag deletion list, or `gdcmanon`. Also check the *pixel data* for burned-in annotations — anonymisers do not touch those.

**BLOCKER 2 — the 69 PNGs are not training data.**
They are lossy 8-bit screenshots of a single slice, with window/level baked in, spatial geometry (voxel spacing, slice thickness, orientation) discarded, and possibly Slicer's orientation letters and scale bar burned in. You cannot compute a volume in mm³ from a PNG. You cannot build a 3D structure from one slice. And a model trained on baked-in windowing learns the windowing, not the pathology.

Re-export those 69 cases as **full DICOM series** (or NIfTI). The PNGs are still useful as a visual index and as presentation figures — keep them, just do not train on them.

**BLOCKER 3 — the two classes are not comparable.**
Right now BME = a DICOM volume, Non-BME = PNGs. If that asymmetry persists into the dataset, the model will learn "is it a screenshot?" instead of "is there edema?". This is the classic shortcut-learning trap and it produces a beautiful, meaningless 99% accuracy.

**Rule: positives and negatives must be identical in modality, sequence type, body region, and preprocessing.** The only thing that differs is the pathology.

### 2.2 What to ask the radiology contact for

For every case, BME and non-BME alike:

- The **full DICOM series**, not exported images. Ideally the whole study, all sequences.
- Minimum sequences: **STIR or T2-FS/PD-FS** (edema is bright here — the primary channel) **and T1** (edema is dark here — this is what separates true edema from red marrow and from a cyst).
- Consistent body region. **Pick one joint and finish it.** Mixing knee + SIJ + hip across ~70 cases gives you three tiny datasets, not one usable one. Recommend whichever joint you have most of.
- The radiology report text if obtainable — free weak labels and a sanity check on your own annotation.

---

## 3. Data strategy

### 3.1 Canonical dataset layout

Adopt this now; it maps 1:1 onto nnU-Net's expected input and saves a painful migration later.

```
data/                                   # gitignored
├── raw/                                # untouched, post-deid only
│   └── BME-001/
│       └── dicom/…
├── nifti/                              # converted, still full-fidelity
│   └── BME-001/
│       ├── BME-001_stir.nii.gz
│       ├── BME-001_t1.nii.gz
│       └── BME-001_meta.json           # sequence, spacing, scanner, field strength, joint, side
├── annotations/
│   └── BME-001/
│       ├── BME-001.seg.nrrd            # MASTER — editable, from Slicer
│       ├── BME-001_labels.nii.gz       # DERIVED — for training
│       └── BME-001_annot.json          # annotator, date, minutes spent, confidence, sequence used
└── nnunet/                             # generated by scripts, fully disposable
    ├── nnUNet_raw/
    ├── nnUNet_preprocessed/
    └── nnUNet_results/
```

`raw/` and `nifti/` are inputs you never edit. `annotations/*.seg.nrrd` is the only file a human ever touches. Everything under `nnunet/` is regenerable from a script — treat it as build output.

### 3.2 Label schema

Three labels, painted in Slicer as three segments:

| Value | Name | Who uses it |
|---|---|---|
| 0 | background | — |
| 1 | `bone_marrow` | Stage B target, and Stage C's spatial constraint |
| 2 | `bme` | Stage C target |
| 3 | `uncertain` | **excluded from the loss.** Not background, not lesion. |

The `uncertain` label is not optional and it is not a cop-out. Without it, every voxel you were unsure about gets silently labelled "background", and the model is actively trained to call ambiguous edema normal — which is exactly the early-stage case you care most about. Masking those voxels out of the loss is standard practice and it will measurably help.

Label 1 (`bone_marrow`) is the whole marrow cavity of each bone in view, *including* the region that is edematous. So `bme` is a strict subset of `bone_marrow` by construction. Painting bone is fast (large, high-contrast, well-defined region) and it buys you Stage B for free.

### 3.3 Splits

- **Patient-level splits, always.** Two slices from the same patient in different folds is leakage and inflates every number you report.
- **5-fold cross-validation**, not a single train/test split. At n≈70–150, one split's test set is ~15 cases and the variance is enormous. Report mean ± std across folds.
- Hold out a **final locked test set of ~15–20 cases** touched exactly once, at the end. Do not tune on it. Do not look at it. Its only purpose is the number that goes in the report.
- Stratify folds by class, and by joint/scanner if those vary.

---

## 4. The model — a four-stage pipeline

The synopsis says "unified deep learning framework". Unified means *one system, one API, one output* — not one monolithic network. A cascade is the right engineering answer and is what every high-performing paper in this area actually does.

```
DICOM ─▶ [A] Preprocess ─▶ [B] Bone/marrow seg ─▶ [C] BME seg (inside B) ─▶ [E] Quantify + 3D ─▶ [F] Case call
                                    │                     ▲
                                    └────────▶ [D] Normative/anomaly branch (early BME)
```

### 4.1 Stage A — Preprocessing

Order matters here.

1. **DICOM to NIfTI** (`dcm2niix`). Preserves spacing, orientation, and header metadata.
2. **Sequence identification** from headers (`ScanningSequence`, `ScanOptions`, `SeriesDescription`, TI/TE/TR). You need to know which volume is STIR and which is T1 — do not trust the folder name.
3. **N4 bias field correction** (SimpleITK). MRI has smooth intensity drift across the field of view; without correction, "bright" is partly a function of position in the coil, and the model will learn that.
4. **Resample to a common spacing.** nnU-Net picks this automatically from the dataset fingerprint — let it. Do not hand-tune.
5. **Intensity normalization — the single highest-leverage preprocessing step.** MRI intensity has no absolute units; a value of 400 means nothing across two scanners. Two options:
   - Baseline: z-score within the body mask (nnU-Net's default for MRI).
   - **Better for this problem: reference-tissue normalization.** Divide by the mean intensity of a reference region — skeletal muscle is the standard choice, since muscle signal is stable across patients and sequences. This turns raw intensity into a *ratio*, which is what a radiologist actually uses ("brighter than muscle on STIR"). It makes the signal comparable across scanners and gives you a physically meaningful feature for the explainability layer.
6. **Co-register T1 to STIR** (rigid, SimpleITK) so they can be stacked as input channels. If they came from the same session with the same geometry this may be a no-op — check, do not assume.

### 4.2 Stage B — Bone / marrow segmentation

**Target:** the marrow cavity of each bone in view (femur, tibia, patella / sacrum, ilium).
**Model:** nnU-Net v2 `3d_fullres`.
**Expected performance:** Dice 0.92–0.97. Bone is large, high-contrast, and consistently shaped — this is the easy stage, and published results on knee bone segmentation reach ~0.98.

**Bootstrap it — do not label from scratch.** Run **TotalSegmentator-MRI** (56 anatomical structures, sequence-independent, works on MRI not just CT) over your volumes to get an initial bone mask, then have the annotator *correct* it in Slicer rather than draw it. Correcting a mask takes a fraction of the time drawing one does.

**Why this stage carries most of the value:**

- It makes muscle and fluid false positives *structurally impossible*, not merely unlikely. Stage C never sees a voxel outside bone.
- It gives you the denominator for "% of bone volume affected" — a far more clinically meaningful number than raw mm³.
- It tells you *which bone* each lesion is in, which is a large part of the explanation.
- **It solves your annotator problem.** Load the auto bone mask into Slicer as a visible overlay before you start. Now "which of this is bone and which is muscle" is answered on screen, and you are left with the much easier judgement of "is this bit of marrow brighter than it should be".

### 4.3 Stage C — BME segmentation (the primary model)

**Model: nnU-Net v2, `3d_fullres`, ResEnc-L planner.**

Why nnU-Net and not something newer:

- It self-configures patch size, spacing, batch size, normalization, and augmentation from a fingerprint of *your* dataset. At n≈100 with no hyperparameter budget and no GPU cluster, this is worth more than any architectural novelty.
- Controlled benchmarks consistently show CNN-based nnU-Net variants (vanilla, ResEnc, MedNeXt) **outperforming Transformer- and Mamba-based networks** when all experimental factors are held equal. Transformers need data you do not have. Do not pick an architecture because it sounds current.
- It is the standard baseline. A reviewer or examiner asking "why this model" gets a one-line, citable answer.

**Challenger:** MedNeXt-L. Surpasses nnU-Net on several public benchmarks and is a legitimate second entry. Run it *after* nnU-Net works, as a comparison-table row — not as your starting point.

**Input channels.** Revised 2026-08-26 after the header inventory ([DATASET.md](DATASET.md)).

The original design put T1 in channel 1, to separate true edema from red marrow and cysts. **The data does not support it: only 18 of 107 cases have a T1, and only 5 of 47 BME cases.** 89 cases are single-series exports. T1 cannot be a required input.

What every case does have is a fat-suppressed sequence — 107/107. So:

| Ch | Content | Why |
|---|---|---|
| 0 | Fat-suppressed PD/T2/STIR, normalized | Edema is bright. **The only channel present in every case.** |
| 1 | **Left-right mirrored copy of ch 0** | Contralateral symmetry prior. Needs no second acquisition. |
| 2 | Stage B bone mask | Hard anatomical prior. |
| 3 | Stage D anomaly residual (§4.4) | Normative deviation. Needs no second acquisition. |

**T1 is now an auxiliary, not a channel.** Run it as an ablation on the 18-case subset and report it as "what a second sequence would buy" — a legitimate finding, and an argument for changing the acquisition protocol in future work. Do not build the main pipeline around it.

**This raises the stakes on channels 1 and 3.** They were framed as enhancements when T1 was carrying the specificity load. With T1 gone they *are* the specificity mechanism, and both are things you generate from the single acquisition you already have.

**On the contralateral prior:** marrow signal is broadly symmetric left-to-right in a healthy patient. Feed the mirrored volume as an extra channel and the network can learn "this side is brighter than its mirror" — asymmetry is exactly the cue radiologists use, and it is strongest precisely in the *early*, subtle cases where absolute intensity is nearly normal. One line of preprocessing. A clean, defensible novelty claim.

Caveat to check: these are **single-knee** studies, so the mirror is the same knee flipped, not the opposite knee. That still works as a left/right-within-the-joint asymmetry prior (medial vs lateral compartment), which is clinically meaningful in knee OA — but it is a different claim from true contralateral comparison. Validate it in the §4.3 ablation before writing it up, and describe it accurately.

**Loss:** Dice + Focal (or Dice + Tversky with β > α to favour recall). BME is well under 1% of voxels; plain cross-entropy will converge to predicting all-background and report 99% accuracy. Deep supervision on, per nnU-Net default. Exclude `uncertain` voxels from the loss.

**Sampling:** oversample foreground patches (nnU-Net does this by default — verify it is on).

### 4.4 Stage D — Normative / anomaly branch (your answer to "early stage")

This is the part of the plan that specifically targets the hardest requirement in your synopsis, and it exploits an asset you actually have: **you have more confirmed normal cases than abnormal ones.**

Train a model of *normal marrow appearance* using only the Non-BME volumes:

- A **3D mask-inpainting network**: mask out random marrow patches, train it to reconstruct them from surrounding context. It only ever sees healthy marrow, so it can only ever reconstruct healthy marrow.
- At inference, inpaint across the whole marrow cavity and take the **residual** (`|actual − predicted|`). Normal marrow reconstructs well, so small residual. Edema does not, so large residual. The residual map is a lesion heatmap that never needed a single lesion label.

This is a published, working approach for exactly this problem (semi-supervised BML detection in knee MRI via mask inpainting) and it fits your data shape.

Use it two ways:
1. **As an extra input channel to Stage C** — the residual map becomes channel 4.
2. **As a standalone recall-oriented detector** — for flagging suspicious regions where the supervised model is unconfident.

Practical benefit: it turns your ~70 negative cases from "the boring half of the dataset" into the training set for a second model.

### 4.5 Stage E — Quantification and 3D output

Pure post-processing, no learning. This is what turns a mask into a *result*.

1. Threshold the probability map (tune the threshold on validation for the sensitivity/precision balance you want — not fixed at 0.5).
2. 3D connected components; **discard components below a minimum volume** (e.g. < 30 mm³) to kill speckle false positives. Tune this on validation; it is often the single biggest precision win.
3. Per lesion: volume (mm³), max 3D diameter, centroid, **which bone** (intersect with Stage B labels), mean and max normalized SI, SI ratio vs muscle.
4. Per bone: total lesion volume, % of marrow volume affected.
5. Per case: lesion count, total volume, a SPARCC-style ordinal score if you are doing SIJ.
6. **3D surface**: marching cubes on the lesion mask (`scikit-image`), Taubin smoothing, decimate, export **`.glb`**. GLB is the right choice — single binary file, loads natively in `three.js` / `react-three-fiber`, no conversion in the browser.
7. Also export the bone surface as a separate, semi-transparent GLB so the lesion is seen *in anatomical context* rather than floating in space.

### 4.6 Stage F — Case-level decision

**Derive it from Stage C; do not train a separate black-box classifier.** A case is BME-positive if total lesion volume exceeds a threshold calibrated on the validation folds.

Why this way: the case-level answer and the pixel-level explanation can never contradict each other. A separate classifier can say "BME present" while the segmentation shows nothing — and then your explainability story collapses in the viva.

Optionally add a small 3D classification head on the shared encoder as an ensemble member and a Grad-CAM host (§5). Report both, and report their agreement.

---

## 5. Explainability plan

Your synopsis promises "explainable" twice. Be concrete about what that means, because "we added Grad-CAM" is a weak answer for a segmentation model — the mask is already a far better spatial explanation than a blurry heatmap.

Four layers, strongest first:

1. **The mask itself.** Voxel-precise localization overlaid on all three planes plus 3D. This *is* the explanation, and it is inherently faithful.
2. **A quantitative evidence table** per lesion: bone of origin, volume, SI ratio vs muscle on STIR, SI ratio vs muscle on T1, % of bone affected. This mirrors how a radiologist justifies a call in a report, and every number is traceable to voxels.
3. **Uncertainty maps.** Deep ensemble (your 5 CV folds already are an ensemble — free) or MC-dropout. Voxel-wise predictive variance gives a "the model is unsure here" overlay, and a case-level confidence that can trigger "refer for human review". For a clinical tool, *knowing when it does not know* is worth more than a marginal Dice gain, and it is a strong report section.
4. **Grad-CAM / Score-CAM** on the case-level classification head only. Include it because it is expected and it is one function call — but frame it as supporting evidence, not the primary mechanism. Say so explicitly in the report; examiners respect the distinction.

---

## 6. Evaluation plan and honest targets

Report all of these. Segmentation-only metrics hide the failure modes that matter clinically.

**Segmentation (voxel level)**
Dice, IoU, 95th-percentile Hausdorff distance, per fold, mean ± std.

**Detection (lesion level — the clinically relevant one)**
Lesion-wise sensitivity at a matching IoU ≥ 0.1, and **false positives per case**. A model with Dice 0.62 that finds 9/10 lesions with 1 FP is more useful than one with Dice 0.70 that misses the small ones. Report the FROC curve.

**Case level**
ROC-AUC, sensitivity, specificity, PPV/NPV at the chosen operating point, confusion matrix. Report the operating point you would actually ship, and why.

**Quantification agreement**
Predicted vs manual lesion volume: ICC and a Bland–Altman plot. This is what validates the "gives volume and size" claim.

**Human ceiling — do this, it is cheap and it is the most credible thing in the report**
Have two annotators independently label ~15 cases. Compute **inter-rater Dice**. That number is the practical ceiling. If humans agree at 0.72, then a model at 0.68 is performing at human level, and you can say so with evidence instead of apologising for a number that sounds low.

**Realistic targets — calibrate expectations now**

| Metric | Baseline | Target | Stretch |
|---|---|---|---|
| Bone/marrow Dice | 0.88 | **0.92** | 0.96 |
| BME lesion Dice | 0.45 | **0.62** | 0.72 |
| Lesion sensitivity | 0.65 | **0.80** @ ≤1.5 FP/case | 0.88 |
| Case-level AUC | 0.82 | **0.90** | 0.95 |
| Volume ICC | 0.70 | **0.85** | 0.92 |

Published fully-automated BME work in the sacroiliac joints reports lesion sensitivity in the **0.58–0.83** range with specificity ~0.97, on datasets larger than yours; knee BML segmentation reports 2D Dice around **0.70**. If you hit Dice 0.62 with sensitivity 0.80, you are in the published range. **Do not chase Dice 0.90 on lesions — it is not achievable at this data scale, and a number that high would mean you have a leak.**

---

## 7. Product architecture (Thunder Stack + Python)

### 7.1 The one hard constraint

**PyTorch cannot run on Cloudflare Workers.** The Hono API in Thunder Stack is the gateway, not the model host. The architecture must be:

```
Next.js (web)  ──▶  Hono API  ──▶  Postgres (Drizzle)   metadata, jobs, results
     │                  │
     │                  ├──▶  Object store (R2/S3)      volumes, masks, GLB
     │                  │
     │                  └──▶  Python FastAPI + PyTorch  ← the model, on a GPU
     │                             (Modal / RunPod / HF Spaces / lab GPU box)
     └──▶ Cornerstone3D viewer + three.js 3D panel
```

Hono owns auth, upload orchestration, job records, and result serving. The Python service owns the model and nothing else. They talk over HTTP with a shared secret. This keeps the Thunder Stack monorepo intact and idiomatic while putting the ML where ML can actually run.

### 7.2 Repo layout

```
bme/
├── client/
│   ├── nextjs/                 # web app: upload, viewer, report
│   └── expo/                   # optional; a mobile MRI viewer is low value — deprioritise
├── server/
│   ├── hono/                   # @thunder/api — gateway, auth, jobs
│   └── db/                     # @thunder/db — Drizzle schema + migrations
├── packages/
│   └── shared/                 # shared TS types — the API contract lives here
├── ml/                         # NEW — Python, uv-managed
│   ├── pyproject.toml
│   ├── src/bme/
│   │   ├── preprocess/         # dcm2niix, N4, normalization, registration
│   │   ├── datasets/           # nnU-Net dataset.json builders, split logic
│   │   ├── train/              # nnU-Net + MedNeXt + inpainting configs
│   │   ├── infer/              # cascade runner
│   │   ├── quantify/           # components, volumes, SI ratios, marching cubes to GLB
│   │   └── serve/              # FastAPI app
│   ├── notebooks/
│   └── scripts/                # deid.py, convert.py, seg2nifti.py, qc_report.py
└── docs/
    ├── PRD.md
    └── ANNOTATION_SOP.md
```

### 7.3 Data model (Drizzle sketch)

`patients` (pseudonymous_id only — **no names, ever**) → `studies` → `series` → `jobs` → `predictions` → `lesions`. Plus `annotations` (ground truth) and `users`/`sessions` from Better Auth.

`lesions` is the table that powers the results UI: `id, prediction_id, bone_label, volume_mm3, max_diameter_mm, centroid_xyz, mean_si_ratio, confidence`.

### 7.4 API contract

```
POST /api/studies                  -> { studyId, uploadUrl }   presigned PUT
POST /api/studies/:id/analyze      -> { jobId }                 enqueue
GET  /api/jobs/:id                 -> { status, progress }      poll or SSE
GET  /api/studies/:id/results      -> { lesions[], metrics, maskUrl, meshUrl }
GET  /api/studies/:id/mask.nii.gz  -> signed URL
```

Inference takes minutes, not milliseconds — **async job model, not request/response.** Get this right early; retrofitting it is painful.

### 7.5 Viewer and segment editor — "Slicer-lite in the browser"

**Requirement (2026-08-26):** the web app must not be a read-only result viewer. It has to
let you *edit* — correct the model's output, annotate from scratch, reopen and revise an
earlier annotation, and adjust ML results later. The reference UI is 3D Slicer's Segment
Editor: four panels (axial / 3D / coronal / sagittal) with a left rail holding the
segmentation selector, source volume, segment list with per-segment visibility, a tool
grid, and undo/redo.

**Deliberately not** all of Slicer. The subset below covers the correction workflow, which
is where the value is.

#### Build on Cornerstone3D — do not write a viewer

`@cornerstonejs/core` + `@cornerstonejs/tools` already provide: volume viewports with MPR,
window/level, synchronised crosshairs, labelmap segmentation representation, and the editing
tools — `BrushTool` (circular and sphere), `RectangleScissors`, `CircleScissors`,
`SphereScissors`, `PaintFill`, threshold-in-brush, plus segmentation undo/redo. OHIF Viewer
v3 is built on exactly this stack and is the proof it works.

| Panel | Library |
|---|---|
| Axial / coronal / sagittal MPR + overlay | Cornerstone3D volume viewports |
| 3D lesion + translucent bone | react-three-fiber, GLB from Stage E |
| Segment list, tool rail, undo/redo | Your own React — thin UI over Cornerstone's tool API |

#### Tool subset for v1

Brush (adjustable radius, 2D and sphere), eraser, threshold-constrained brush, scissors,
fill-between-slices, undo/redo, per-segment visibility and opacity. **Masking: "editable
area = inside `bone_marrow`"** — carry this over from the Slicer SOP; it is the single
feature that stops non-radiologist annotators painting into muscle.

Not in v1: Grow-from-seeds, Level tracing, Logical operators, Islands, Margin/Hollow,
Smoothing. Add only if a real workflow needs them.

#### Honest scoping

- **Correcting an AI mask in the browser: very feasible.** Brush + eraser + threshold +
  undo covers it, and this is the common case.
- **Bulk from-scratch annotation in the browser: slower than Slicer.** Slicer's
  Grow-from-seeds and Level tracing are genuinely faster for virgin cases.

So: **Phase 1 ground truth is annotated in 3D Slicer.** The web editor is for correction,
review, and post-ML adjustment. Do not put the web editor on the critical path for training
data — that is how the model never gets trained.

### 7.6 Storage format — round-tripping between Slicer and the web

**Requirement:** saved annotations should come back in a format that matches the input, so a
case can move between Slicer, the web app, and the model without lossy conversion.

**Use DICOM SEG as the interchange format.** This is precisely what it exists for: a DICOM
object that stores a segmentation, references the source series by UID, and lives in the
same study as the images. It round-trips into 3D Slicer natively, and `dcmjs` reads and
writes it in the browser. A case can be handed back as a zip that looks like the zip that
went in — images plus a SEG object.

Three formats, each with one job:

| Format | Role | Who writes it |
|---|---|---|
| **`.seg.nrrd`** | Slicer working file during Phase 1 | Annotator in Slicer |
| **DICOM SEG** | Interchange + what the platform stores and returns | Server (`dcmqi`), browser (`dcmjs`) |
| **`.nii.gz`** | Training input | Script, derived |

Converters: **`dcmqi`** (`itkimage2segimage` / `segimage2itkimage`) is purpose-built for
NRRD/NIfTI ↔ DICOM SEG on the server. `dcmjs` handles the browser side.

This supersedes the "DICOM SEG optional" note in [ANNOTATION_SOP.md](ANNOTATION_SOP.md) §1 —
it was optional when the plan was Slicer-only. With a web editor in scope it becomes the
backbone, because it is the one format both ends read natively.

**Note on `.mrb`:** a Slicer scene bundle is a fine personal backup but must not be the
saved artifact of record — it bundles the images with the labels, needs Slicer to open, and
nothing else in the pipeline reads it. Export `.seg.nrrd` alongside it.

#### Sync flow

```
Slicer  ──.seg.nrrd──▶ dcmqi ──▶ DICOM SEG ──▶ object store + Postgres row
                                      │
                                      ├──▶ dcmjs ──▶ browser editor ──▶ edited SEG ──▶ new version
                                      └──▶ segimage2itkimage ──▶ .nii.gz ──▶ nnU-Net
```

Version annotations rather than overwriting: an `annotations` row per save, with
`parent_id`, `author_id`, `source` (`human` | `model` | `model_corrected`). You need this
anyway to measure how much a human changed the model's output — which is a genuinely
interesting number for the report, and free once versioning exists.

---

## 8. Phase plan

**Phase 0 — Unblock data (this week, in parallel with everything else)**
De-identification script. Re-export the 69 non-BME cases as DICOM series. Confirm sequence availability (STIR + T1). Pick one joint.
*Exit: 20 de-identified, converted volumes on disk.*

**Phase 1 — Annotation pipeline**
Slicer setup, TotalSegmentator-MRI bootstrap for bone masks, annotate 10 cases, measure inter-rater Dice on 5 of them, freeze the SOP.
*Exit: 10 cases with `.seg.nrrd` + derived NIfTI, and a measured human ceiling.*

**Phase 2 — Stage B (bone)**
nnU-Net v2 on bone labels. 5-fold CV.
*Exit: Dice ≥ 0.90. This should work; if it does not, the data pipeline is broken, not the model.*

**Phase 3 — Stage C (BME) — the long one**
Baseline single-channel nnU-Net, then add T1, then bone mask, then mirror channel. Ablate each addition; **the ablation table is a core report deliverable.**
*Exit: lesion Dice ≥ 0.55 and an ablation table.*

**Phase 4 — Stage D (anomaly) + Stage E (quantification)**
Inpainting model on negatives. Residual as channel 4. Connected components, volumes, GLB export.
*Exit: end-to-end DICOM to metrics + mesh, from one CLI command.*

**Phase 5 — Explainability + full evaluation**
Ensemble uncertainty, evidence tables, Grad-CAM head. Lock the test set and run it **once**.
*Exit: final results table.*

**Phase 6 — Web platform**
Thunder Stack scaffold, Hono to FastAPI wiring, Cornerstone3D viewer, 3D panel, report export.
*Exit: upload a zip in a browser, get a 3D result.*

**Phase 7 — Writing and defence**
Paper, report, demo video, ablation and comparison tables.

**Sequencing note:** Phases 2–5 are the project. Phase 6 is packaging. If time runs short, a rigorous model with a thin UI defends far better than a polished UI over a weak model. Start Phase 6 only once Phase 3 has a number you are willing to put in the report.

---

## 9. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **PHI leak** | Project-ending, institutionally serious | De-identify before anything leaves the acquisition machine. `.gitignore` in place. Never commit `deid_map.csv`. |
| **Dataset too small** | Poor generalization | 5-fold CV not a single split; heavy 3D augmentation; anomaly branch to exploit negatives; pretrain on public knee/SIJ data if licensing allows. |
| **Annotation quality** (non-medical annotators) | Bad labels cap the achievable ceiling | Bone-mask overlay to disambiguate anatomy; `uncertain` label; radiologist review of a subset; measure and report inter-rater Dice. |
| **Shortcut learning** from mismatched classes | Fake 99% accuracy | Identical acquisition + preprocessing for both classes (§2.1). Sanity-check with a shuffled-label run — it should fail. |
| **No GPU** | Cannot train 3D | Kaggle (30 GPU-h/week free) or Colab Pro. nnU-Net `3d_fullres` at this data size is feasible on a single T4/P100 overnight. Budget for this early. |
| **Class imbalance** | Model predicts all-background | Dice+Focal loss, foreground oversampling, lesion-level metrics rather than accuracy. |
| **ML on Workers** | Architecture dead-end | Separate Python service from day one (§7.1). |
| **Scope creep** (Expo app, cloud, multi-joint) | Nothing finishes | Web only. One joint. Mobile explicitly out of scope for v1. |

---

## 10. Open questions — take these to your guide / radiology contact

1. Which joint has the most cases? The answer determines the entire dataset.
2. Are T1 sequences available alongside STIR for every case? Determines whether channel 1 exists.
3. Can a radiologist review ~20 annotated cases? Determines whether you have a gold standard or a silver one — and this materially changes what you can claim.
4. What is the institutional policy on this data leaving the hospital network? Determines whether "cloud-enabled" in the synopsis is achievable or must become "deployable on-premise".
5. How many BME-positive cases are realistically obtainable? If under ~30, the anomaly branch (§4.4) moves from "nice enhancement" to "the primary method", and the framing of the whole project shifts.

---

## 11. References

- [Performance of Fully Automated Algorithm Detecting Bone Marrow Edema in Sacroiliac Joints (PMC10381124)](https://pmc.ncbi.nlm.nih.gov/articles/PMC10381124/) — bone Dice 0.982, BME sensitivity 0.58–0.83, specificity 0.97. The closest published analogue to this pipeline.
- [Automatic Segmentation of Bone Marrow Lesions on MRI Using a Deep Learning Method (PMC11048083)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11048083/) — knee BML, ~0.70 2D Dice.
- [Semi-Supervised Bone Marrow Lesion Detection from Knee MRI Segmentation Using Mask Inpainting Models (arXiv 2409.19185)](https://arxiv.org/pdf/2409.19185) — the basis for Stage D.
- [Deep-learning quantification of hip BME and synovitis in spondyloarthritis (PubMed 36935744)](https://pubmed.ncbi.nlm.nih.gov/36935744/) — U-Net vs UNet++ vs Attention-UNet vs HRNet; 88.5% femoral head, 69.4% lesions.
- [Advanced Automated Model for Robust Bone Marrow Segmentation in Whole-body MRI](https://www.sciencedirect.com/science/article/pii/S1076633224010481) — nnU-Net, multi-vendor/multi-centre; evidence for Stage B robustness.
- [MedNeXt: Transformer-driven Scaling of ConvNets for Medical Image Segmentation (arXiv 2303.09975)](https://arxiv.org/pdf/2303.09975) — the Stage C challenger.
- [Multi-encoder nnU-Net outperforms transformer models (arXiv 2504.03474)](https://arxiv.org/pdf/2504.03474) — evidence for choosing CNN over transformer at this data scale.
- [TotalSegmentator MRI: Robust Sequence-independent Segmentation](https://www.researchgate.net/publication/389096356_TotalSegmentator_MRI_Robust_Sequence-independent_Segmentation_of_Multiple_Anatomic_Structures_in_MRI) — Stage B bootstrap.
- [Bone Segmentation in Low-Field Knee MRI Using a 3D CNN (MDPI)](https://www.mdpi.com/2504-2289/9/6/146) — femur/tibia/patella Dice 0.984; upper bound for Stage B.
- [MONAI Label: AI-assisted interactive labeling of 3D medical images (arXiv 2203.12362)](https://arxiv.org/pdf/2203.12362) and [SegmentWithSAM for 3D Slicer (arXiv 2408.15224)](https://arxiv.org/pdf/2408.15224) — annotation acceleration.
- [A quantitative method to assess muscle edema using STIR MRI (Sci Rep)](https://www.nature.com/articles/s41598-020-64287-8) — reference-tissue normalization rationale.
- [3D Slicer Segmentations module documentation](https://slicer.readthedocs.io/en/latest/user_guide/modules/segmentations.html) — format semantics behind the SOP.
