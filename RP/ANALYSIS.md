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
