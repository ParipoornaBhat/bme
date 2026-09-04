# HANDOFF — the 2D track

Rewritten 2026-09-04. The earlier version of this file described an import that
has since been undone; ignore anything you remember from it.

Read [STATUS.md](STATUS.md) first. This file covers the 2D track only. The plan
for the missing piece is [PLAN_2D_ANNOTATION.md](PLAN_2D_ANNOTATION.md).

---

## The decision that shapes everything here

**2D uses only the curated 2D images. Nothing derived from the 3D volumes.**

Slices cut from a DICOM series are a different distribution — one patient across
twenty near-identical slices, a different exporter, a different window. Mixing
them in inflated the training set with correlated copies while the case count
barely moved. They are out of the 2D dataset and do not come back.

The 3D track is untouched: `data/nifti/` (107 cases), `data/raw/`,
`data/annotations/`.

---

## What the 2D dataset is now

Source of truth is the hand-curated root folders:

```
BME/2d/                25 images, 18 patients
BME/2d_annotated/      EMPTY
Non BME/2d/            69 images, 69 patients
Non BME/2d_annotated/  EMPTY
```

[build_2d.py](../ml/scripts/build_2d.py) turns those into `data/slices2d/`.
`data/` is disposable — delete it and re-run:

```bash
python ml/scripts/build_2d.py "D:/Final yr Prj/bme" --apply
```

**94 images, 87 patients, 18 BME vs 69 non-BME (3.8:1).**

### Two things done to `BME/2d` on 2026-09-04

**Renamed.** The filenames were patient names, which is PHI exactly as much as
the pixels are. Now `BME-2D-<case>_s<k>`. The id -> name map went to
`Annotated/deid_map_2d.csv` — **outside the repo**, and it stays there.
`Non BME/2d` was already pseudonymous and was left alone.

**Deduplicated.** 52 files were 25 unique images; the rest were pixel-identical
copies, now in `BME/2d/_duplicates/`, moved rather than deleted. Left in, the
same image would have landed in both train and val.

A related bug is worth knowing because it is easy to reintroduce: `case_id()`
stripped `_001` but not `_s000`, so every file counted as its own patient — 25
instead of 18. Patient grouping quietly degrading into per-file grouping is the
single easiest way to publish a meaningless number.

---

## What was deleted, and why it is safe

| removed | was | why safe |
|---|---|---|
| `data/slices2d_him` | 1,976 files, HIM experiment | built from 3D slices; regenerable via `make_2d.py --him`; its result is already recorded — HIM made AUC **worse**, 0.604 vs 0.658 |
| `data/results2d` | metrics from the old 1,975-slice set | measured a dataset that no longer exists |
| `data/seg2d_ext`, old `data/slices2d` | intermediate imports | rebuilt by `build_2d.py` |

Kept: `nifti`, `raw`, `annotations`. All 3D.

---

## Sharing with the team — do NOT send the whole `data/` folder

`data/` contains three files that map pseudonymous ids back to patient names:

```
data/deid_map.csv          source_archive  = patient-named zip
data/rename_map.csv        old_name
data/image_rename_map.csv  old_name
```

Sending `data/` wholesale hands over the de-identification key. That defeats
every renaming step in this project in one action.

**Send `data/slices2d/` only** — images plus `index.csv`, all pseudonymous. That
is enough to train the classifier and is all a teammate needs for 2D. It is also
about 30 MB rather than the 1.1 GB `data/nifti/` adds.

Two further points:

- `data/` is build output, not source. A teammate who has the repo and the root
  `BME/` and `Non BME/` folders can regenerate `data/slices2d` themselves with
  `build_2d.py`, which is better than shipping images around.
- **It is still patient imaging.** Pseudonymous is not anonymous. It goes to
  teammates on this project, on local machines — not to a cloud drive, not to a
  chat app, not into the report without checking the images for burned-in text
  first. `data/deid_map.csv` records `burned_in=NO` for 74 of 107 3D cases and
  **blank for 34**, meaning nobody checked those. The 2D exports have not been
  checked at all.

---

## Where the two tracks stand

### Classifier — runs today

`/training` -> "Detection (BME Present / Absent)". Everything is wired:
`--arch`, `--freeze`, `--patience` reach `train_2d.py` correctly.

**But 18 BME patients is very few.** At 5 folds that is 3-4 positives per
validation fold. Run it to establish the pipeline; expect fold-to-fold spread
wider than any effect being measured, and report it with the n stated rather
than as a headline number.

The old figure, for reference and no longer comparable because the dataset
changed entirely: case-level AUC 0.658, F1 0.589.

### Segmenter — unblocked: 2D annotation tool built

The 2D annotation tool is now built and live:
- `/annotate` -> "2D slices" tab hosts an interactive canvas painter (`Painter2D.tsx`).
- Allows selecting any 2D slice from `data/slices2d`, painting Bone Marrow (`1`), BME Lesion (`2`), Uncertain (`3`), and Eraser (`0`).
- Saves masks to `data/annotations2d/<case_id>/<stem>.mask.png` as standard 8-bit grayscale PNGs.
- `ml/scripts/make_seg2d_from_masks.py` converts the masks into `data/seg2d/` (images, masks, index.csv).
- `ml/scripts/pipeline_seg.py` and `/api/training-seg` now automatically detect 2D annotations and chain directly into `train_2d_seg.py` (2D Dual-Channel U-Net).

---

## The freeze-depth sweep

Never completed. It was relaunched, ran about an hour on CPU, and was stopped on
2026-09-04 before the first arm printed a single fold. `data/results2d/` holds
no sweep output, so there is nothing to quote.

Stopping it cost nothing — it was reading a file list that has since been
replaced entirely.

When it is re-run, shrink it. Four arms x 5 folds x 12 epochs on CPU was going
to take most of a day:

```bash
for f in 0 4 6 8; do python ml/scripts/train_2d.py "D:/Final yr Prj/bme" --arch resnet18 --folds 3 --epochs 8 --patience 3 --freeze $f; done
```

Then re-run only the winning depth at `--folds 5` for the number that goes in
the report. Mean +/- std across folds, never the best fold. If the spread
between arms is smaller than the std within an arm, the honest conclusion is
that freeze depth did not matter — a real finding, and easier to defend than a
fragile one.

Negative results already on record, for consistency of tone: HIM made AUC worse
(0.604 vs 0.658), and 6 epochs matched 3.

---

## Uncommitted

- `ml/scripts/build_2d.py` — new
- `ml/scripts/import_2d.py` — modified, and **now unused**. It imports from a
  folder layout that no longer feeds anything; `build_2d.py` replaced it.
- `docs/PLAN_2D_ANNOTATION.md` — new
- `docs/HANDOFF.md` — this file
- `docs/STATUS.md`

`git status` is clean of data.
