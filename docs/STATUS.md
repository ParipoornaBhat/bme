# STATUS — where the project is right now

**Living document. Update it at the end of every working session.**
If you are picking this project up cold (new chat, new teammate, new machine), read this
file first, then [SUMMARY.md](SUMMARY.md) for the full picture, then [PRD.md](PRD.md).

Last updated: **2026-09-04**

---

## One-paragraph state

Two pipelines run side by side. **2D** now trains, saves weights, and predicts on a new
image end to end: upload a slice on `/results` and it returns YES/NO, a Grad-CAM heatmap and
an edema mask, all from saved checkpoints. **3D** is the segmentation system from the PRD and
is still waiting on annotations.

The web app does the whole loop in the browser: annotate, train, test a slice, inspect
results, check storage. Every filename in the dataset is pseudonymous — no patient name
survives anywhere on disk. The critical path is unchanged: annotate more cases, measure
inter-rater Dice, then train the bone/lesion model properly.

**Read the numbers with the n in mind.** The 2D classifier's case-level AUC on the curated
dataset is **0.961** (per-fold **0.977 ± 0.032**) — but that is 18 BME patients against 69
non-BME, 3–4 positives per validation fold, and it is a different dataset from the one that
produced the old 0.658. It is not yet a defensible headline; see Known problems.

---

## Phase tracker

Phases are defined in [PRD.md](PRD.md) §8.

| Phase | What | State |
|---|---|---|
| — | Repo, docs, monorepo scaffold, `ml/` package | ✅ done |
| — | Dataset collection (107 cases) | ✅ done |
| — | Header inventory ([DATASET.md](DATASET.md)) | ✅ done |
| — | Local dev DB (Docker + seed) | ✅ **verified running**, port 5434 |
| — | Domain schema (+ pgvector 0.8.6) | ✅ **applied and verified** — 17 tables, HNSW indexes live |
| **0** | **De-identification** | ✅ **done** — 107 cases, 13,818 images, PHI verified clean |
| — | DICOM→NIfTI + primary-series picker | ✅ 107/107 converted, data/worklist.csv written |
| — | 2D baseline (extract, train, review, Grad-CAM) | ✅ trains, saves checkpoints, predicts on upload |
| — | 2D inference: upload → YES/NO + Grad-CAM + edema mask | ✅ `infer_2d.py`, `/api/predict`, `/results` |
| — | Annotation viewer: Four-Up, crosshair sync, pencil fill, 3D surface | ✅ save round-trip verified |
| — | Web app: annotate / training / results / storage | ✅ built and API-verified |
| — | Full pseudonymisation of every filename | ✅ 108 archives + 121 images renamed |
| **1** | **Annotation pipeline** | 🟡 **0 cases done. The critical path.** |
| — | nnU-Net dataset builder + training wrapper | ✅ **verified** against synthetic Slicer-format .seg.nrrd — geometry, splits, leak checks all pass |
| 2 | Stage B — bone/marrow segmentation | ⬜ blocked on Phase 1 |
| 3 | Stage C — BME segmentation | ⬜ |
| 4 | Stage D anomaly + Stage E quantification | ⬜ |
| 5 | Explainability + locked-test evaluation | ⬜ |
| 6 | Web platform + segment editor (PRD §7.5–7.6) | ⬜ |
| 7 | Report / paper / defence | ⬜ |

---

## Do this next

In order. Each step's output is the next step's input.

0. **2D track was rebuilt from scratch on 2026-09-04.** Read
   [HANDOFF.md](HANDOFF.md) before touching anything 2D. In short: 2D now uses
   only the curated `BME/2d` and `Non BME/2d` folders -- 94 images, 87 patients,
   18 BME vs 69 non-BME. Everything derived from the 3D volumes was removed from
   the 2D dataset. `data/slices2d` is build output: `python ml/scripts/build_2d.py
   "D:/Final yr Prj/bme" --apply` regenerates it.

0b. **2D slice annotation tool built.** `/annotate` -> "2D slices" tab now has an
   interactive canvas painter (`Painter2D.tsx`) with brush, eraser, labels, undo, and save.
   Masks save to `data/annotations2d/<case>/<stem>.mask.png` as exact uint8 PNGs (0=bg,
   1=bone, 2=bme, 3=uncertain). `ml/scripts/make_seg2d_from_masks.py` converts them into
   `data/seg2d/` for `train_2d_seg.py`.

0c. **The 2D loop is closed as of 2026-09-04.** Both trainers now save one checkpoint per
   fold (`data/results2d/checkpoints/`, `data/results2dseg/checkpoints/`) with a manifest
   recording the preprocessing and the class order. `/results` has an upload panel that runs
   those checkpoints on a new image; Grad-CAM loads them instead of training a throwaway
   model. **Both trainers were broken before this** — the dataset rebuild left images at 77
   different sizes with no `Resize` in the transform, so `DataLoader` could not collate a
   batch and training died on the first step.

0d. **Do not quote the 0.961 AUC.** Two pixel-level leaks are already confirmed — a red
   lesion ellipse burned into two BME images, and a yellow orientation overlay that is 7x
   commoner in the non-BME folder. See Known problems. Retrain on a centre crop and drop
   the annotated images first; whatever survives that is the number.

1. **Annotate in the browser: `/annotate` → 3D volume tab.** Pick a case, paint, save.
   No file dragging, no folder picking, and the segments are named correctly for you.
   3D Slicer still works if you prefer it — use `ml/scripts/slicer_setup.py` to start.

2. **If using Slicer instead, save `.seg.nrrd`, not `.mrb`.** A scene bundle is fine as a
   personal backup, but nothing downstream reads it. See [ANNOTATION_SOP.md](ANNOTATION_SOP.md) §1.

3. **Optional: install MONAI Label in Slicer** — the single biggest annotation speed-up. It trains on
   the cases you have finished and pre-segments the next one, so each case you label makes
   the following one faster. See [ANNOTATION_SOP.md](ANNOTATION_SOP.md) §3.

4. **Optional: TotalSegmentator-MRI in Slicer** ([ANNOTATION_SOP.md](ANNOTATION_SOP.md) §3) to
   bootstrap bone masks — correct rather than draw, and it shows you what is bone.

5. **Annotate to 10 cases, then stop.** Do not do 50 before checking convention drift.

6. **Measure inter-rater Dice** on 5 double-annotated cases. This is the project's
   performance ceiling and belongs in the report.

7. **Re-annotate those 10** with the conventions the comparison settled, then continue.

8. **Phase 2** — nnU-Net v2 on the bone labels. Should clear Dice 0.90 easily. If it does
   not, the data pipeline is broken, not the model.

---

## How the four of you share work

The dataset moves by hand over a private channel — it is patient imaging and is never
pushed anywhere automatically. What the **shared database** holds is the ledger: who
annotated which case, when, and the segment sizes.

That split is what makes it work. Everyone pointed at the same database sees the same
completion status, so a case marked done with no local file tells you who to ask for it.
The `/annotate` page shows that as an amber download icon with the annotator's name.

Several people annotating the same case is expected, not a conflict — the overlap set
exists precisely so inter-rater Dice can be measured. Saves write two files:
`<CASE>.seg.nrrd` (canonical, what training reads) and `<CASE>__<annotator>.seg.nrrd`
(that person's own copy, kept forever). Without the second, the last person to save would
erase everyone before them and the agreement number would be impossible to compute.

## Local development

One command from a clean clone. No `.env` editing — the script writes it.

```
pnpm install
pnpm setup          # start Postgres, apply migrations, seed
pnpm dev
```

`pnpm setup` = `db:up` + `migrate:deploy` + `db:seed`. Or double-click `start_db.cmd`.

**Using the shared Supabase database instead of local Docker?** Put the connection string in
`.env` and skip `db:up` entirely. Use the **session pooler** host
(`aws-0-ap-northeast-2.pooler.supabase.com`), not the `db.*.supabase.co` one — the direct host
has no IPv4 address, so it is unreachable from any network without working IPv6. That is not a
misconfiguration on your side; it is how Supabase provisions direct endpoints.

`pnpm dev` no longer runs the seed first. Seeding is a one-time job and a database hiccup should
not stop you working on the app — use `pnpm dev:seed` when you actually want both.

- Postgres runs in Docker (`bme-db`). Port is picked automatically — 5433 by default,
  5434 on this machine because another project holds 5433. A native Windows
  Postgres owns 5432 on at least one team machine. If 5433 is also busy the script probes
  upward to 5460, then remembers the choice as `BME_DB_PORT` in `.env`.
- `pnpm db:down` stops it; **the volume survives**, so data comes back.
- Team sign-in — credential login, all four share one password:
  `nnm23cs071@nmamit.in`, `nnm23cs124@nmamit.in`, `nnm23cs149@nmamit.in`,
  `nnm23cs293@nmamit.in` / `BmeDev@2026`
- Requires Docker Desktop **running** — the script says so plainly if it is not.

---

## Decisions already made — do not relitigate

| Decision | Why |
|---|---|
| **Knee**, single joint | 92/107 cases read `BodyPartExamined = KNEE`. Settled by the data. |
| **nnU-Net v2**, with 2D U-Net as a measured challenger | Self-configures; CNNs beat transformers at this scale. But our voxels are ~10:1 anisotropic and 3D models are sensitive to patient positioning — so 2D vs 3D is decided by measurement, not assumption. See PRD §4.3d. |
| **Multi-task network** — bone and edema predicted together | Revised. A hard cascade gates: if the bone mask trims the boundary, the lesion voxels outside are unrecoverable. Sharing an encoder lets bone inform the lesion task instead. Constraint applied at inference. See PRD §4.3b. |
| **Single-channel** on fat-suppressed sequence | Only 18/107 have T1, and 5/47 BME. T1 is an ablation, not an input. See [DATASET.md](DATASET.md). |
| **`.seg.nrrd`** master → `.nii.gz` derived | Preserves segment names in-file; label values cannot silently shift. |
| Labels `1=bone_marrow 2=bme 3=uncertain` | Keyed by **name**, never order. `uncertain` is excluded from the loss. |
| **Python service separate from Hono** | PyTorch cannot run on Cloudflare Workers. |
| Commit style: one line, conventional prefix, **no `Co-Authored-By`** | Matches the user's other repos. See [../CLAUDE.md](../CLAUDE.md). |

---

## Open questions — need the guide or a radiologist

Carried from [PRD.md](PRD.md) §10, updated with what the data answered.

| # | Question | State |
|---|---|---|
| 1 | Which joint? | ✅ **Answered by data — knee.** |
| 2 | Is T1 available? | ✅ **Answered — only 16%.** Model redesigned around it. |
| 3 | Can a radiologist review ~20 annotated cases? | ❓ **Open. Ask early** — it decides whether you claim expert-validated ground truth or student-labelled. |
| 4 | Can this data leave the hospital network? | ❓ **Open.** Decides whether "cloud-enabled" in the synopsis survives or becomes "on-premise". |
| 5 | Are the `.docx` files in some archives radiology reports? | ❓ **Open.** If yes they are PHI *and* free weak labels — worth asking for them properly. |

---

## Known problems

| Problem | Impact | Action |
|---|---|---|
| **2D case-level AUC jumped 0.658 → 0.961 when the dataset was rebuilt** | A number that good on this task, from 18 positive patients, is more likely a dataset shortcut than a modelling win | Two leaks measured on 2026-09-04. **(a)** `BME-2D-005` and `BME-2D-008` carry a **red ellipse drawn around the lesion**, burned into the pixels — 2/25 BME files, 0/69 non-BME. **(b)** A burned-in yellow A/P orientation overlay appears in **19/69 non-BME (28%)** but **1/25 BME (4%)**, and the two folders are framed and cropped differently — different exporters. Neither alone explains 0.96, but together they make it indefensible. **Before quoting anything: retrain on a centre crop excluding the borders, and drop or repair the two ellipse images.** |
| 18 BME patients is the whole 2D positive pool | 3–4 positives per validation fold; the per-fold spread is wider than most effects | Always report mean ± std with n stated. Never quote one fold. |
| **Every case filename carries a patient name** | PHI exposure | Fixed by step 1. Data is gitignored, so nothing has leaked. |
| 23 cases have full PHI in DICOM headers | PHI exposure | Fixed by step 1. |
| Burned-in pixel text unchecked | Anonymisers do not touch pixels | `deid.py` reports the `BurnedInAnnotation` flag; still spot-check visually. |
| **The teammate 2D exports carry a burned-in viewer overlay** | ~34,300 coloured pixels in a fixed position in every file, in both the marked and unmarked folders. If it contains a name or MRN, these images cannot go in the report. | Open three or four and look at the edges. See [HANDOFF.md](HANDOFF.md). Storing them under gitignored `data/` is safe either way. |
| The marks in that batch are **green**, not red | The earlier `BME_ALL_IMAGES` set used red pen, so red-based detection finds nothing here | `import_2d.py` tests green. Confirm the per-file distribution before trusting the count. |
| `BME/IMRAZ.zip` has no DICOM (PNG only) | −1 case | Re-export or drop. |
| 17 non-BME cases have a PNG but no volume | −17 potential cases | Numbers 7, 17–25, 28, 29, 32, 33, 35, 36, 43. Re-export or drop. |
| ~10:1 voxel anisotropy | 3D surfaces look terraced | Taubin smoothing in Stage E is required, not cosmetic. |
| ~~Python 3.14 cannot run PyTorch~~ | **Wrong — retracted 2026-08-26** | torch 2.13.0, nnunetv2 2.8.1, monai 1.6.0 all ship cp314 wheels. 3.14 is fine; the `<3.13` pin was removed. |
| 3 scanners, 2 vendors | Raw intensities not comparable | Normalization in PRD §4.1 is mandatory. |

---

- **`BME/2d` filenames were patient names until 2026-09-04.** Renamed to
  `BME-2D-<case>_s<k>`; the map is at `Annotated/deid_map_2d.csv`, outside the
  repo. Anything derived from those files before that date carries the old names.
- **Never share the whole `data/` folder with teammates.** It contains
  `deid_map.csv`, `rename_map.csv` and `image_rename_map.csv` -- the id-to-name
  keys. Share `data/slices2d/` only, or let them rebuild it with `build_2d.py`.
- **18 BME patients is the entire 2D positive pool.** At 5 folds that is 3-4 per
  validation fold. Any 2D classifier number must be reported as mean +/- std with
  the n stated, never as a single headline figure.
- **Burned-in pixel text has not been checked on the 2D exports.**
  `deid_map.csv` records `burned_in=NO` for 74 of 107 3D cases and blank for 34.
  De-identification covered DICOM headers and filenames, never pixels. Check
  before any image goes in a slide or report.

## Repo map

```
docs/STATUS.md          <- you are here; read first
docs/PRD.md             the plan: architecture, evaluation, phases
docs/DATASET.md         what the 107 cases actually contain
docs/ANNOTATION_SOP.md  how to annotate; read before touching Slicer
CLAUDE.md               working rules, git conventions, PHI handling
ml/scripts/train_2d.py  2D classifier; writes data/results2d/checkpoints/
ml/scripts/train_2d_seg.py 2D U-Net; writes data/results2dseg/checkpoints/
ml/scripts/infer_2d.py  one image -> YES/NO + Grad-CAM + mask, as JSON
ml/scripts/gradcam.py   heatmaps from the saved checkpoints; never trains
ml/scripts/inventory.py re-run the dataset inventory
ml/scripts/deid.py      de-identification
ml/scripts/convert.py   DICOM -> NIfTI + picks each case's primary series
ml/scripts/seg2nifti.py .seg.nrrd -> validated training labelmap
ml/scripts/build_dataset.py  nnU-Net layout + patient-level splits
ml/scripts/train.py     nnU-Net plan/preprocess/train wrapper
ml/scripts/slicer_setup.py    run INSIDE Slicer to start a case correctly
ml/scripts/rename_segments.py fix .seg.nrrd saved with default segment names
BME/, Non BME/, data/   gitignored, never committed
```

## Commit log

```
git log --oneline
```

---

## How to update this file

At the end of a session, change: the date, the phase tracker, "Do this next", and anything
in Known problems that got fixed. Keep it short — if it grows past two screens it stops
getting read, which defeats the point.
