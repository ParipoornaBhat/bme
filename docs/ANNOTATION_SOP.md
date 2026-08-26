# Annotation SOP — 3D Slicer for BME

**Read this before annotating a single case.** Re-annotating 70 cases because the export format was wrong is the most common way a project like this loses a month.

Companion doc: [PRD.md](PRD.md)

---

## 1. The format question, answered

You asked which of 3D Slicer's many save options is correct. Here is the full menu and the verdict on each.

| Option | What it is | Verdict |
|---|---|---|
| **`.seg.nrrd`** (Segmentation node) | Slicer's native segmentation. 3D labelmap + segment names, colors, DICOM terminology, and the link to the reference geometry. Handles overlapping segments (4D). | ✅ **MASTER FORMAT.** Save every case as this. Lossless, re-editable, one file. |
| **`.nii.gz` labelmap** | Plain integer labelmap volume. Loses names/colors, cannot overlap. | ✅ **DERIVED FORMAT.** Generate from the `.seg.nrrd` by script. This is what nnU-Net eats. Never hand-edit it. |
| **DICOM SEG** | The clinical interoperability standard. Round-trips into PACS. | 🟡 Optional. Add a one-line export at the end for the "clinical-grade / workflow integration" claim in your report. Fiddly; not worth it as your working format. |
| **`.mrb` scene bundle** | Whole Slicer scene zipped: volume + segmentation + view state. | 🟡 Good as a *backup / provenance* artifact. Useless as a training input — needs Slicer to open and bundles the image with the labels. |
| **`.nrrd` / `.nii` plain labelmap** | Same as the NIfTI row. | Same verdict — derived only. |
| **`.stl` / `.obj` / `.ply` model** | Surface mesh exported from a segment. | ❌ Not ground truth. A mesh is *derived* from voxels and cannot be converted back losslessly. Fine for a 3D render, never for training. |
| **PNG / JPEG screenshot** | What you did for the 69 non-BME cases. | ❌ **Never.** Discards spacing, orientation, bit depth, and 2 of the 3 dimensions. You cannot compute mm³ from it. |
| **Markups (ROI box, curve, fiducial)** | Point/box annotations. | ❌ Far too coarse for edema, which is an irregular blob with ill-defined margins. |

**The rule: `.seg.nrrd` is the master a human edits. Everything else is generated from it by a script and is disposable.**

### Why `.seg.nrrd` and not NIfTI as master

Slicer's docs recommend NRRD as the general-purpose format and note NIfTI mainly for neuroimaging convention. More concretely, `.seg.nrrd` stores segment names and terminology *in the file*. If you save plain NIfTI as your master, six months later you have a file full of the integers 1, 2, 3 and no in-file record of which is which — and the moment someone reorders segments in Slicer, your label values silently shift and you will not notice until your metrics are inexplicable.

### The derivation step

Script it, run it as a batch, never do it by hand:

```
data/annotations/BME-001/BME-001.seg.nrrd   # human edits this
        │  scripts/seg2nifti.py  (slicerio or SimpleITK)
        ▼
data/annotations/BME-001/BME-001_labels.nii.gz   # 0=bg 1=bone_marrow 2=bme 3=uncertain
```

The script must **enforce the label mapping by segment name**, not by segment order. Read the name from the `.seg.nrrd` metadata, look up its fixed integer, and hard-fail on an unknown name. This one defensive check prevents the most insidious bug in the entire project.

---

## 2. Why you already get 3 views + 3D from one annotation

You described this correctly, so just to confirm the mental model — it matters for the QC step below.

Slicer does not store "an annotation on slice 12 of the axial view". It stores a **3D binary voxel volume** aligned to the source image grid. When you paint in the axial view you are setting voxels in that 3D volume. The sagittal and coronal views are just different slicing planes through the same volume, so your paint appears there instantly. "Show 3D" runs marching cubes over it for the surface.

Two consequences:

1. **You do not need to annotate three times.** Annotate once, in whichever plane the lesion is clearest.
2. **A blob that looks right in axial can be a jagged staircase in coronal.** You painted slice-by-slice, so errors accumulate perpendicular to your working plane and are invisible from it. This is why §5 QC is mandatory, not optional.

---

## 3. Setup (once)

1. **3D Slicer 5.6+** (stable).
2. Extension Manager, install:
   - **SlicerRT** (segment comparison, Dice — you need this for inter-rater agreement)
   - **SegmentEditorExtraEffects** (adds *Split Volume*, *Surface Cut*, and a better *Grow from seeds*)
   - **TotalSegmentator** (bone mask bootstrap — see below)
   - Optionally **SegmentWithSAM** (SAM/SAM2 click-to-segment) or **MONAI Label** (learns from your corrections as you go — worth setting up once you have ~10 cases done, it compounds)
3. Settings → set default scene save format to NRRD.

### Bootstrap the bone mask — do this before you touch a case

Run **TotalSegmentator-MRI** on the volume first. It segments 56 anatomical structures on MRI, sequence-independently. Load its output as a segment named `bone_marrow` and **correct** it rather than drawing from scratch.

This is a two-for-one: it makes bone labelling 5–10x faster, *and* it puts a coloured outline on screen showing you exactly what is bone. Which directly answers the problem you raised — "it is hard for a non-medical person to tell muscle from bone marrow". After a dozen cases you will not need the overlay, but early on it is the difference between confident labels and guesses.

---

## 4. Per-case workflow

1. **Load the DICOM series** (de-identified). Not the PNG.
2. Set layout to **Four-Up** (axial + sagittal + coronal + 3D). Never annotate in a single-view layout.
3. **Window/level**: `Ctrl` + right-drag. Find a setting where marrow contrast is clear and *keep it consistent across cases* — note it in the annotation JSON. Windowing does not change the saved data, but it heavily changes what you *perceive*, so inconsistent windowing means inconsistent labels.
4. **Load T1 as a second volume** if available. Use the fade slider to flip STIR ↔ T1 on the same slice. This is the single most reliable way to confirm a suspicious region is real edema — see §6.
5. Segment Editor → create three segments, named **exactly**:
   - `bone_marrow`
   - `bme`
   - `uncertain`

   Exact names matter — the derivation script keys off them.
6. **`bone_marrow` first.** Correct the TotalSegmentator output. Include the *whole* marrow cavity of each bone in view, including the edematous part. Exclude cortex (the black rim) and everything outside it.
   - Best tools: *Grow from seeds*, *Threshold* + *Islands*, then *Scissors* to trim.
7. **`bme` second**, working **inside** `bone_marrow`.
   - Set **Masking → Editable area: Inside `bone_marrow`**. Slicer will then physically refuse to let you paint outside bone. Turn this on. It converts your hardest judgement call into an impossibility.
   - Tools: *Paint* with a small sphere brush, or *Level tracing*, or *Threshold* previewed inside the mask and then trimmed.
   - Edema has **hazy, ill-defined margins**. Do not draw a crisp outline where the image does not have one. Include the hazy transition zone or mark it `uncertain` — but be consistent, and write down which convention you chose.
8. **`uncertain`** for anything you genuinely cannot call. Use it freely. It is excluded from the loss, so it costs you nothing and prevents you from teaching the model that ambiguous edema is normal.
9. **QC in all three planes** (§5) — mandatory.
10. **Save**: Segmentation node → `data/annotations/<CASE_ID>/<CASE_ID>.seg.nrrd`.
11. **Log** to `<CASE_ID>_annot.json`: annotator initials, date, minutes spent, sequence used, self-rated confidence 1–5, and any notes. The confidence field is worth more than it looks — it lets you later check whether the model fails specifically on cases the human also found hard, which is a genuinely interesting result for the report.

---

## 5. QC — the step everyone skips

Before saving, for every case:

- [ ] Scroll the **sagittal** view through the whole lesion. Does it look like a coherent 3D shape, or a staircase?
- [ ] Same in **coronal**.
- [ ] Look at the **3D view**. A correct lesion is a smooth-ish blob. Jagged fins or disconnected specks mean slice-to-slice inconsistency.
- [ ] `bme` is entirely inside `bone_marrow` — zero voxels outside. (Segment Statistics will tell you.)
- [ ] No segment leaks past the cortical rim into muscle or joint space.
- [ ] Turn off the overlay and look at the raw image again. Do you still believe the lesion is there? A surprising number of annotations do not survive this.

Use **Segment Statistics** to sanity-check volumes. A `bme` volume of 2 mm³ is almost certainly a stray click. A `bme` volume larger than 40% of `bone_marrow` is almost certainly a leak.

---

## 6. Anatomy primer — telling bone marrow from muscle, and edema from its mimics

You said this is hard for a non-medical annotator. It is, but it reduces to a small number of reliable rules.

### Finding bone at all

**Cortical bone is black on every MRI sequence.** It is the one thing that never changes. Look for a thin, continuous, jet-black rim — that outline *is* the boundary of the bone. Everything inside it is marrow. Everything outside it is not.

This is the rule that solves your problem. You do not need to recognise a femur. You need to find the black rim and stay inside it.

### The signal table

| Tissue | T1 | STIR / T2-FS | Position |
|---|---|---|---|
| **Cortical bone** | black | black | thin rim, the boundary |
| **Normal fatty (yellow) marrow** | **bright** | **dark** (fat is suppressed) | inside the rim |
| **Muscle** | mid-grey | mid-grey | outside the rim, striated, symmetric bundles |
| **Joint fluid / effusion** | dark | **very bright**, sharply defined | in the joint space, outside bone |
| **BME** | **darker than normal marrow** | **bright, hazy** | **inside the rim** |

### The two-sequence test — your most reliable tool

A region is BME if **both** hold:
1. **Bright on STIR / T2-FS**, and
2. **Low signal on T1** — darker than the surrounding normal marrow.

Bright on STIR *alone* is not enough; that is exactly where most false positives come from. Loading T1 alongside and flipping between them (step 4 above) is worth more than any amount of squinting at STIR.

### Common mimics and how to reject them

| Looks like BME | Tell |
|---|---|
| **Muscle edema** | It is *outside* the black cortical rim. If you turned on "Editable area: inside `bone_marrow`", you literally cannot make this mistake. |
| **Joint effusion** | In the joint space, not marrow. Very bright and *sharply* bounded, whereas edema is hazy. |
| **Subchondral cyst** | Round, sharply defined, near-fluid brightness, sits right at the joint surface. BME is ill-defined. A cyst often has a rim of BME around it — label the BME, not the cyst. |
| **Red marrow reconversion** (normal variant, common in young/anaemic/smoking patients) | **Symmetric and bilateral**, follows normal marrow distribution, and on T1 stays *brighter than or equal to* muscle. True BME on T1 drops *below* muscle signal. This one catches people out — use the T1-vs-muscle comparison. |
| **Fat-suppression failure artifact** | Broad regions bright on STIR that follow the coil or a field inhomogeneity, not anatomy. Crosses tissue boundaries and ignores the cortical rim. |
| **Partial volume at the cortex** | A bright fringe hugging the rim on one slice only. Check the neighbouring slices — real lesions persist across several. |

### Practical heuristics

- **Compare to the other side.** Left and right marrow should look broadly similar. An asymmetry is the strongest early-BME cue there is, and it is why the model gets a mirrored input channel (PRD §4.3).
- **Compare to marrow elsewhere in the same bone.** You are looking for a region brighter than *its own neighbourhood*, not brighter than some absolute value.
- **If it exists on only one slice, be suspicious.** Real edema is a volume.
- **When genuinely unsure, mark `uncertain`.** That is what the label is for. It is a correct answer, not a failure.

---

## 7. Quality control across annotators

- **Double-annotate 15 cases** independently, no consultation. Compute **inter-rater Dice** (SlicerRT → Segment Comparison). Report it. That number is your project's practical performance ceiling and it makes every model number afterwards interpretable.
- **Get a radiologist to review a subset** — even 20 cases. This is the difference between "expert-validated ground truth" and "labelled by four CS students", and reviewers will ask.
- **Annotate in rounds, not one marathon.** After the first 10 cases, all four of you sit down, look at disagreements together, and update this SOP with the conventions you settled on. Then redo those 10. Labels made before the conventions were fixed are worth less than labels made after.
- **Never annotate knowing the label.** If you know a case is from the BME folder, you will find edema. Shuffle and blind the case IDs before annotating — this is cheap and it is a real methodological point you can put in the report.

---

## 8. Checklist per case

- [ ] De-identified DICOM series loaded (not PNG)
- [ ] Four-Up layout
- [ ] Consistent window/level, recorded
- [ ] T1 loaded alongside STIR
- [ ] Segments named exactly `bone_marrow`, `bme`, `uncertain`
- [ ] `bone_marrow` bootstrapped from TotalSegmentator and corrected
- [ ] Masking set to "Editable area: inside `bone_marrow`" before painting `bme`
- [ ] QC in axial, sagittal, coronal, and 3D
- [ ] Segment Statistics volumes look plausible
- [ ] Saved as `<CASE_ID>.seg.nrrd`
- [ ] `<CASE_ID>_annot.json` written
