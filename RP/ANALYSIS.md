# What the literature says, and what we should change

Re-read 2026-09-04 from the **9 PDFs currently in this folder**. The previous
version of this file was written 2026-08-28 against a set of 11 PDFs, four of
which have since been replaced. Its paper numbering no longer maps to these
files and three of its claims were wrong — see "Corrections" at the end.

---

## The nine papers, as they actually read

| # | Study | Task / data | Headline result |
|---|---|---|---|
| 1 | Hwang 2022, *Comput Biol Med* | Lumbar bone marrow, sagittal T1. 44 healthy (836 img) + 56 diseased (1064 img) | 2D U-Net DSC **0.960 ± 0.049** healthy, **0.950 ± 0.022** diseased; semi-automatic 3D Grow-Cut 0.914 / 0.889 |
| 2 | Ronneberger 2015, MICCAI | The original U-Net architecture | Foundational method paper — **see note below** |
| 3 | Jamaludin 2024, *Rheumatology* | Spinal BMO in axSpA. 3,483 MRIs, 686 patients, two phase-3 trials | Binary per-vertebral-unit BMO classification; SpineNet; manual-segmentation step added little |
| 4 | Ribeiro 2023, *Appl Sci* | **BME detection**, children/adolescents. Transfer learning, ResNet-18 | CV balanced accuracy **0.792 ± 0.034**; best single test model **0.852 bal-acc, AUC 0.964** |
| 5 | Zheng 2022, *Front Physiol* | Hip BME + synovitis. 195 patients, 1,945 STIR/T2WI slices | U-Net beat UNet++, Attention-UNet, HRNet. Femoral head **88.48%**, inflammatory lesions **69.36%** |
| 6 | Lee 2021, *Diagnostics* | Sacroiliac joint BME. 815 images, 60 axSpA + 19 healthy | ROI extraction then CNN classification on Gd-enhanced FS T1 |
| 7 | Yu 2024, *Bioengineering* | **Knee BMEL** — closest paper to our task | Unsupervised conditional diffusion, **no training labels needed**; low DICE, and argues DICE is the wrong metric here |
| 8 | Bordner 2023 | Sacroiliitis per ASAS criteria. DESIR cohort, 256 patients | Mask-RCNN, AUC **0.98** internal; external cohort **MCC 0.62, sensitivity 56%, specificity 100%** |
| 9 | Song 2023, *BMC Med Imaging* | Lumbar BME **detection** (boxes, not masks) | DCNAS-Net: AP50 **90.6%**, recall 95.1%, F1 92.8%, 144 ms/image |

**Note on paper 2.** The PDF in this folder is the Freiburg *project webpage*, not
the paper. Cite `Ronneberger, Fischer, Brox — MICCAI 2015, LNCS 9351:234-241,
arXiv:1505.04597`. A literature survey slide that cites a webpage looks careless.

---

## 1. The 0.964 number needs its conditions attached

This is the most important correction, because our own HIM experiment appeared
to contradict it and does not.

Paper 4's abstract headline is **balanced accuracy 0.792 ± 0.034** — the
cross-validated figure. The **0.964 AUC is a different thing**: it is the single
best test-set model, and it requires two choices together:

> the best result corresponds to **freezing 6 of the 10 layers** of the Resnet-18.
> This model achieved a balanced accuracy of 0.852 and an AUC of 0.964

Its confusion matrix totals **52 samples** (8/2/4/38). One split, 52 slices.

Our HIM run reported AUC 0.604 vs 0.658 without HIM — but it was not run at
freeze 6. Their own table shows HIM is *worse* than a bone-region ROI when the
backbone is trained from scratch (0.550 vs 0.545) or used as a fixed feature
extractor (0.588 vs 0.583). **HIM only pays off in combination with partial
fine-tuning.**

**Action:** do not record "HIM does not work" as settled. Re-run HIM at
`--freeze 6`, which is the configuration the paper actually reports, and compare
against `--freeze 6` without HIM. That is a one-line change to an experiment we
have already built, and it is the difference between a negative result and an
untested one.

---

## 2. What a realistic lesion Dice looks like

Paper 5 is the useful calibration point: the same U-Net scores **88.48%** on the
femoral head and **69.36%** on the inflammatory lesions. Bone is easy; the lesion
is hard, and the gap is about twenty points.

Paper 7 goes further and argues the metric itself misleads for small lesions:

> lesion segmentation in MRI is heavily impacted by the size of the lesion
> relative to the volume as a whole, and DICE is a flawed metric in such cases

**Action:** expect a lesion Dice in the 0.6-0.7 range at best, and report lesion
sensitivity and false positives per case alongside it. Do not present a bone
Dice as if it were the result — it is the easy half of the problem.

---

## 3. Detection and segmentation are different tasks, and the papers split evenly

Papers 3, 4, 6, 8 and 9 all do **detection or classification** — is there BME,
and roughly where. Only 1, 5 and 7 produce **masks**.

That split supports our two-model design: a detector answering yes/no and a
segmenter outlining the lesion. It is not an unusual architecture; it is what
most of this literature does, with the two halves published separately.

Paper 8 is the cautionary one. AUC 0.98 internally, then on an external cohort
**sensitivity 56%** — it missed nearly half the positive patients while keeping
specificity at 100%. A model tuned on one cohort degraded sharply on another.

**Action:** whatever we report, report it on patient-level held-out data and say
the n. Our 18 BME patients make this risk larger for us, not smaller.

---

## 4. Unsupervised segmentation is a real fallback

Paper 7 segments knee BMEL with **no training labels at all**, using conditional
diffusion models. Its accuracy is low and it says so plainly.

This matters to us because annotation is our bottleneck. It is worth one
sentence in the report as an alternative we considered — not worth building.

---

## Corrections to the 2026-08-28 version of this file

| Old claim | What the papers say |
|---|---|
| "2D U-Net **beat 3D U-Net**, 89-90% vs 86-88% F1" | **No paper here compares 2D U-Net to 3D U-Net.** Paper 1 compares 2D U-Net (DSC 0.96) to *3D Grow-Cut*, a semi-automatic classical algorithm (0.91). The 88% figure is Paper 5's femoral-head Dice, a different study and a different task. **Do not put this claim on a slide.** |
| "HIM reached AUC 0.964 — biggest single win available" | True number, but it is one 52-sample test split and requires freeze=6. The cross-validated headline is 0.792. |
| "Read from the 11 PDFs" / cites Paper 10, Paper 11 | There are 9 PDFs. Those two no longer exist; the numbering above is the current folder order. |

The dual-channel / multi-task recommendation from the old file is **not** in
these nine papers — it came from one of the replaced PDFs. It may still be a
good idea, but it is currently uncited. Do not attribute it to this reading list.

---

# Research gaps, aligned to our objectives

The gaps below are the five bullets on slide 10 of the presentation. Each is
matched to the paper that actually evidences it, to the objective it feeds, and
to what we can honestly claim. Objectives are numbered as in PRD §1.

**O1** BME mask &#183; **O2** mask constrained inside bone &#183; **O3** quantification
(volume, %, count, diameter, SI) &#183; **O4** 3D surface in the browser &#183;
**O5** case-level call with calibrated confidence &#183; **O6** explanation a
clinician can audit in under 30 seconds.

| Gap on the slide | Evidence in these nine papers | Objective | What we can claim |
|---|---|---|---|
| **1. No fully reliable automated BME detection** | Paper 8: AUC 0.98 internally, then **sensitivity 56%** on an external cohort. Paper 4: cross-validated balanced accuracy **0.792 ± 0.034**. Paper 7 states its own performance is low. | O5 | Reliability is not solved; published headline numbers do not survive a cohort change. We address it by patient-level splits and reporting mean ± std, not by claiming a better number. |
| **2. Limited localization and severity analysis** | Papers 3, 4, 6, 8, 9 stop at detection or classification — **no lesion mask at all**. Paper 9 outputs bounding boxes. Paper 5 gives lesion Dice **69.36%** against **88.48%** for bone. | O1, O2, O3 | **This is our strongest gap.** Most of the field answers "is there edema"; few answer "how much, and where". Quantification is where our contribution sits. |
| **3. Radiologist workload and fatigue** | Paper 9: lumbago affects 500M+ people and manual MRI review is the bottleneck. Paper 7: manual and semi-automatic segmentation is labour-intensive with poor intra- and inter-rater reliability. | motivation for O1-O6 | Treat as **motivation, not a measured outcome.** We have not run a reader study, so we cannot claim we reduce fatigue or improve radiologist accuracy. Say the workload is the reason for automating, then stop. |
| **4. Missing early-stage BME in large-volume scans** | Paper 8's 56% external sensitivity is exactly this failure. Paper 7: BMELs have diffuse signal, irregular shapes and varying sizes, which is why raters disagree. | O5, and the anomaly branch (PRD §4.4) | **Our distinctive answer.** None of these nine papers train a normative model on healthy marrow and flag deviation. Learning "expected normal" from our 69 non-BME cases is genuinely uncommon in this literature. |
| **5. Limited clinical validation and real-world applicability** | Paper 3 states it directly — clinical-trial data, standardised protocols, may not generalise to routine imaging. Paper 8 demonstrates the drop. Paper 7 has **no external test set** at all. | O4, O6 | **Do not claim we close this.** 87 patients from one source, no external validation — we share the limitation. What we can claim is a deployable, auditable workflow rather than a notebook: that is applicability, not validation. |

---

# Additions — gaps these papers support that the slide does not list

Four of these are stronger than some of the five above, because they are gaps
the papers state about *themselves*.

**A. Knee BME is barely covered.** Of the nine, only Paper 7 studies the knee.
The rest are spine (1, 3, 9), sacroiliac joint (6, 8) or hip (5). BME behaves
differently by joint, so results from the sacroiliac literature do not transfer
to us for free. **This is our anatomy and the literature on it is thin** — a
defensible novelty claim, and a cheap one to make honestly.

**B. Healthy controls are usually missing.** Most of these train only on
diseased subjects. Paper 1 is the exception and shows it matters: a model
trained on healthy marrow alone scored DSC 0.830 on diseased subjects, while
one trained on diseased scored 0.950. **Our 69 non-BME cases are a design
choice, not padding** — they are what makes a false-positive rate measurable.

**C. The evaluation metric is itself a gap.** Paper 7 argues Dice is misleading
when the lesion is small relative to the image, and reports low Dice while
noting the model is still useful. Reporting **lesion sensitivity and false
positives per case** alongside Dice is a methodological contribution, not just
bookkeeping.

**D. Annotation cost and inter-rater disagreement are unsolved.** Paper 7 gives
this as its motivation for going unsupervised, and names annotator bias
explicitly. Our in-browser annotation tool and written SOP address it directly.

---

# One claim to soften

**Explainability is not an untouched gap.** Paper 6 already uses **ResNet-18
with Grad-CAM** for BME classification — the same architecture as our detection
track:

> Grad-CAM was used to determine the area of the input image that primarily
> affected the final results so as to intuitively confirm the validity of the
> classification results

So "no one explains their predictions" would be false, and an examiner who has
read Paper 6 will know it. Two things are still fair to say:

1. Paper 6 uses Grad-CAM to **validate its own classifier**, not to give a
   clinician something to audit. There is no quantification and no mask.
2. Our contribution is the **combination** — detection, segmentation,
   quantification and explanation in one workflow, on the knee — rather than
   explainability by itself.

Paper 6 is also a **citation in our favour**: it is independent evidence that
ResNet-18 plus Grad-CAM is an accepted approach for exactly this task, which is
worth more on a methodology slide than an overstated novelty claim.
