# Plan — importing `Non BME/new`, without drowning the dataset

Written 2026-10-23. Scope: the new non-BME volumes only.

Short answer to the question asked: **yes, slices can be skipped, and the
mechanism already exists.** But slice depth is not what makes this set large —
series count per case is. Capping slices alone would not fix it.

---

## What arrived

`Non BME/new/new/` — 60 case folders, 212 NRRD volumes, 60 `name.json`.

```
Non BME/new/new/<n>/<series>.nrrd
Non BME/new/new/<n>/name.json      <- holds a patient name: PHI
```

| | |
|---|---|
| cases | 60 |
| volumes (series) | 212 |
| total axial slices if everything is kept | **10,223** |
| slices per volume | mostly 16-53; a tail at 92, 149, 150, 160, 180, 264, 320 |

Series per case is the problem:

| series in a case | cases |
|---|---|
| 1 | 47 |
| 7-16 | 11 |
| **21** | **2** |

---

## Why a slice cap alone is not enough

`make_2d.py` already caps slices and already spreads them evenly rather than
taking the first N:

```
--keep-fraction 0.6     central fraction of slices to keep
--max-per-case 24       cap so big volumes do not dominate
```

The flag is named `--max-per-case` but it is applied **per volume**. With 21
series in a case that is 21 x 24 = **504 slices from one patient**, all of them
near-duplicates of each other, and all landing in the same cross-validation fold.

That is worse than having too many slices. It means one patient contributes 500
training examples that are not independent, and the model learns that patient.

**So the cap has to move from per-volume to per-case.**

---

## The four decisions

### 1. One series per case, not all of them

A knee study contains several sequences and planes. Only the axial
fat-suppressed series is comparable to what the BME side contributes.

Pick **one** series per case, by this order:
1. axial plane (from the NRRD `space directions`, the through-plane axis)
2. slice count in the 16-60 range (the tail at 92-320 is almost certainly a
   different, isotropic sequence, not the axial stack)
3. if several still qualify, the one with the most in-plane resolution

Record which series was chosen per case, so the choice is auditable and
reproducible rather than "whatever sorted first".

### 2. Cap per case at 30-40, matching the BME side

After choosing the series, keep the central 60% and cap at **35 slices**.
Expected output: 60 cases x ~35 = **~2,100 slices**, down from 10,223.

The existing even-spread logic in `make_2d.py:123` is correct and should be
reused unchanged, not reimplemented.

### 3. Do not delete anything from `Non BME/`

CLAUDE.md section 3: raw inputs are immutable. The skipping happens **at
conversion time**, writing fewer slices into `data/`, not by removing NRRD files.

This matters beyond tidiness: `data/` is build output and must be regenerable.
If the source is pruned, a later decision to keep 50 slices instead of 35 is
unrecoverable.

### 4. Deduplicate by pixel fingerprint, not by name

It is not established whether these 60 cases overlap the 60 non-BME cases
already in `worklist.csv`. A name-based check was attempted and was not
reliable enough to act on.

Use the 64-bit gradient hash already in `build_2d.py` / `import_2d.py`. It is
the same machinery that caught 27 duplicate copies in `BME/2d`, it does not
depend on filenames, and it does not require reading the PHI in `name.json`.

---

## Class balance — check before, not after

The 2D classifier currently trains on 94 slices from 87 patients, 18 BME
against 69 non-BME: already 3.8:1 the wrong way.

Adding ~2,100 non-BME slices without adding BME would take that past 100:1. A
model would score 99% accuracy by answering "no BME" every time.

**Decide the target ratio first.** Either:
- subsample to roughly match the BME slice count, or
- bring in the BME volumes the same way in the same pass.

Importing all 2,100 and "fixing it with class weights later" does not work at
this ratio.

---

## Build order

1. **Read the NRRD headers and write the series-selection table** — case, chosen
   series, plane, slice count, why. No images written. Inspect it before going on.
2. Fingerprint-check the chosen series against `data/slices2d` and `data/nifti`.
3. Convert with a per-case cap, into `data/slices2d/non_bme/`.
4. Rebuild and retrain; compare against the current numbers rather than
   assuming more data is better.

Step 1 is deliberately read-only. Picking the wrong series for 60 patients is
cheap to fix before conversion and expensive afterwards.

---

## PHI note

`name.json` holds a patient name per case, 60 distinct values. It must not be
copied into `data/`, into any filename, into a log, or into the repo. Case ids
for these follow the existing scheme (`NBME-###`), and the id-to-name mapping
stays outside the repo alongside `Annotated/deid_map_2d.csv`.
