# STATUS — where the project is right now

**Living document. Update it at the end of every working session.**
If you are picking this project up cold (new chat, new teammate, new machine), read this
file first, then [PRD.md](PRD.md).

Last updated: **2026-08-26**

---

## One-paragraph state

Repo scaffolded, 107 cases collected (knee MRI, 47 BME / 60 non-BME), **de-identification
run and verified** — `data/raw/` holds 13,818 scrubbed DICOM images under pseudonymous IDs.
Local dev Postgres now starts with one command. Annotation has **just begun** (1 case). All 107 cases are converted to NIfTI with a primary
series chosen — see `data/worklist.csv`.
The critical path is annotation: get to 10 cases, measure inter-rater Dice, then train
Stage B. Nothing is blocked on code.

---

## Phase tracker

Phases are defined in [PRD.md](PRD.md) §8.

| Phase | What | State |
|---|---|---|
| — | Repo, docs, Thunder Stack scaffold, `ml/` package | ✅ done |
| — | Dataset collection (107 cases) | ✅ done |
| — | Header inventory ([DATASET.md](DATASET.md)) | ✅ done |
| — | Local dev DB (Docker + seed) | ✅ **verified running**, port 5434 |
| — | Domain schema (+ pgvector 0.8.6) | ✅ **applied and verified** — 17 tables, HNSW indexes live |
| **0** | **De-identification** | ✅ **done** — 107 cases, 13,818 images, PHI verified clean |
| — | DICOM→NIfTI + primary-series picker | ✅ 107/107 converted, data/worklist.csv written |
| **1** | **Annotation pipeline** | 🟡 **in progress — 1 case. The critical path.** |
| 2 | Stage B — bone/marrow segmentation | ⬜ blocked on Phase 1 |
| 3 | Stage C — BME segmentation | ⬜ |
| 4 | Stage D anomaly + Stage E quantification | ⬜ |
| 5 | Explainability + locked-test evaluation | ⬜ |
| 6 | Web platform + segment editor (PRD §7.5–7.6) | ⬜ |
| 7 | Report / paper / defence | ⬜ |

---

## Do this next

In order. Each step's output is the next step's input.

1. **Switch annotation output from `.mrb` to `.seg.nrrd`.** `Annotated/1/2026-08-26-Scene.mrb`
   is a Slicer scene bundle — fine as a personal backup, but nothing downstream reads it and
   it bundles the images with the labels. Save the Segmentation node as `.seg.nrrd` as well.
   See [ANNOTATION_SOP.md](ANNOTATION_SOP.md) §1.

2. **Annotate against `data/raw/<CASE_ID>/`, not the named zips.** Otherwise every
   annotation is keyed to a patient name and has to be remapped later. `data/deid_map.csv`
   has the correspondence.

3. **Install MONAI Label in Slicer** — the single biggest annotation speed-up. It trains on
   the cases you have finished and pre-segments the next one, so each case you label makes
   the following one faster. See [ANNOTATION_SOP.md](ANNOTATION_SOP.md) §3.

4. **Set up TotalSegmentator-MRI in Slicer** ([ANNOTATION_SOP.md](ANNOTATION_SOP.md) §3) to
   bootstrap bone masks — correct rather than draw, and it shows you what is bone.

5. **Annotate to 10 cases, then stop.** Do not do 50 before checking convention drift.

6. **Measure inter-rater Dice** on 5 double-annotated cases. This is the project's
   performance ceiling and belongs in the report.

7. **Re-annotate those 10** with the conventions the comparison settled, then continue.

8. **Phase 2** — nnU-Net v2 on the bone labels. Should clear Dice 0.90 easily. If it does
   not, the data pipeline is broken, not the model.

---

## Local development

One command from a clean clone. No `.env` editing — the script writes it.

```
pnpm install
pnpm setup          # start Postgres, apply migrations, seed
pnpm dev
```

`pnpm setup` = `db:up` + `migrate:deploy` + `db:seed`. Or double-click `start_db.cmd`.

- Postgres runs in Docker (`bme-db`), published on **5433 by default (5434 on this machine — Sarvam holds 5433)**. A native Windows
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
| **nnU-Net v2** (`3d_fullres`, ResEnc-L) | Self-configures from the dataset; CNNs beat transformers at this scale. MedNeXt-L is the challenger, not the starting point. |
| **Two-stage cascade** — bone first, edema inside it | Makes muscle/effusion false positives structurally impossible. The single most important design choice. |
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
| **Every case filename carries a patient name** | PHI exposure | Fixed by step 1. Data is gitignored, so nothing has leaked. |
| 23 cases have full PHI in DICOM headers | PHI exposure | Fixed by step 1. |
| Burned-in pixel text unchecked | Anonymisers do not touch pixels | `deid.py` reports the `BurnedInAnnotation` flag; still spot-check visually. |
| `BME/IMRAZ.zip` has no DICOM (PNG only) | −1 case | Re-export or drop. |
| 17 non-BME cases have a PNG but no volume | −17 potential cases | Numbers 7, 17–25, 28, 29, 32, 33, 35, 36, 43. Re-export or drop. |
| ~10:1 voxel anisotropy | 3D surfaces look terraced | Taubin smoothing in Stage E is required, not cosmetic. |
| ~~Python 3.14 cannot run PyTorch~~ | **Wrong — retracted 2026-08-26** | torch 2.13.0, nnunetv2 2.8.1, monai 1.6.0 all ship cp314 wheels. 3.14 is fine; the `<3.13` pin was removed. |
| 3 scanners, 2 vendors | Raw intensities not comparable | Normalization in PRD §4.1 is mandatory. |

---

## Repo map

```
docs/STATUS.md          <- you are here; read first
docs/PRD.md             the plan: architecture, evaluation, phases
docs/DATASET.md         what the 107 cases actually contain
docs/ANNOTATION_SOP.md  how to annotate; read before touching Slicer
CLAUDE.md               working rules, git conventions, PHI handling
ml/scripts/inventory.py re-run the dataset inventory
ml/scripts/deid.py      de-identification
ml/scripts/convert.py   DICOM -> NIfTI + picks each case's primary series
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
