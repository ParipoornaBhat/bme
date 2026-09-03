# HANDOFF — importing the outside 2D set

Written 2026-09-04. Read [STATUS.md](STATUS.md) first; this file covers one
thing only: the 2D image set that came from a teammate, and what is still open
on it.

---

## What arrived

`D:\Final yr Prj\Annotated\labled_data_bme` — **outside the repo, and it stays
outside.** Three folders, 381 image files, 120 MB:

| folder | files | what it is |
|---|---|---|
| `annotated/` | 156 png | BME slices, marked |
| `non-annotated/` | 156 png (2 jpeg) | BME slices, not marked |
| `non BME/` | 69 (50 png, 17 jpeg, 2 jpg) | healthy slices |

Strictly 2D. Nothing here feeds the 3D pipeline.

---

## The two questions you asked, answered

### 1. "The filenames can be different from mine"

They are, and it does not matter — nothing matches on filename. Matching is by
**pixel fingerprint**: a 64-bit gradient hash of the grayscale image, which
survives re-encoding, rescaling, and renaming.

### 2. "Not sure if I have the same images — it could duplicate, even in non BME"

**It would not have.** Measured against all 1,936 images already in
`data/slices2d`:

| | exact match | within 8 bits of 64 | median distance |
|---|---|---|---|
| incoming BME (156) | 0 | 0 | 14 / 64 |
| incoming non-BME (69) | 0 | 0 | 15 / 64 |

Zero overlap, and not marginally — the nearest existing image is ~14 bits away,
which is nowhere near a duplicate. There are also **no duplicates inside the
batch itself**. So the whole set is new material.

That is a useful answer but not a load-bearing one: the check runs on every
import regardless, so a future batch that *does* overlap gets caught the same
way.

---

## What I got wrong first, and the correction

My first pass looked for **red pen circles**, because that is how the earlier
`BME_ALL_IMAGES` set was marked. It reported 1 of 134 pairs as marked, which
did not match "some are annotated".

The reason: **every file in both folders has ~34,300 red pixels** — a near
constant. That is a burned-in overlay from the viewer these were exported from,
not an annotation. My detector was measuring the watermark.

The actual signal is **green**:

| | total green px | total red px |
|---|---|---|
| `annotated/` | 109,394 | 3,669,720 |
| `non-annotated/` | 217 | 3,566,716 |

Red is identical across both folders. Green is ~500x higher in `annotated/`.
**The marks are green, not red.**

**Confirmed on the real run.** Testing green selected **134 of 156** files as
marked — exactly the 134 that have a matching partner in `non-annotated/`, which
is an independent check falling out of a different code path. Red selected 1.

---

## The blocker you need to look at first

**These PNGs appear to have a burned-in coloured overlay from the source
viewer.** Roughly 34,300 coloured pixels in a fixed position in every file.

I did not get to check **what that overlay says.** Viewer exports commonly burn
in a patient name, MRN, date, and institution along an edge. If it does:

- storing them under `data/` is fine — `data/` is gitignored, nothing leaves the
  machine;
- **putting any of these images in a report, a slide, an Artifact, or a commit
  is a PHI disclosure.** The existing de-identification work covered DICOM
  headers and filenames. It did **not** touch pixels.

**Do this before any of these images appear in the presentation:** open three or
four of them and look at the edges. If there is text, they need a crop or mask
step, and the same question applies to whatever is already in
`data/slices2d/bme` from `BME_ALL_IMAGES`.

I am flagging this rather than deciding it. Where the crop boundary goes is a
call about patient data, and per the project rules that is not mine to make
alone.

---

## What was built

### `ml/scripts/import_2d.py`

```bash
python ml/scripts/import_2d.py "D:/Final yr Prj/Annotated/labled_data_bme"
```

**Dry run by default** — prints every copy it would make and writes nothing.
Add `--apply` to actually copy. The source folder is only ever read; nothing is
moved, renamed, or deleted there.

Three gates, each of which drops a file rather than guessing:

1. **Not already here** — pixel fingerprint, checked against `data/slices2d`
   *and* against files already accepted earlier in the same run.
2. **Has a patient** — grouping is by the leading number where the filename has
   one, and by the name itself where it does not. This matters: without a case
   id, slices from one patient would straddle a train/val split and every metric
   would be inflated. It also matters that the fallback exists — 51 of the 225
   files are named by person alone, and an earlier version that required a
   leading number silently dropped every one of them.
3. **Filename does not travel** — originals carry patient names, so copies are
   renamed to a pseudonymous id and the mapping goes to
   `data/import_map_2d.csv`. **That file is PHI.** Gitignored, never committed,
   never pasted, never off this machine.

Imported ids are prefixed `E` (external) — `EBME-###`, `ENBME-###` — so they
cannot collide with locally converted cases and a bad batch can be withdrawn by
prefix alone.

### Where things land

```
data/slices2d/bme/EBME-###_s###.png       from non-annotated/
data/slices2d/non_bme/ENBME-###_s###.png  from non BME/
data/refmarks2d/EBME-###_mark.png         from annotated/
data/slices2d/index.csv                   appended
data/import_map_2d.csv                    id -> original name  [PHI]
```

**`data/refmarks2d/` is reference, not labels.** A circle drawn over a region is
not a voxel-accurate mask; training a segmenter on one teaches it to predict
circles. Those images are there so you can see what the marker saw while you
annotate properly in the annotate page, on the clean image. Nothing in the
pipeline reads that folder.

---

## Status of the import: DONE

Ran with `--apply`. Nothing was skipped and nothing was lost.

```
non-annotated -> bme       156 new, 132 cases
non BME       -> non_bme    69 new,  69 cases
annotated     -> refmarks  134 of 156 carry a mark

skipped: 0 already in repo, 0 duplicated inside the batch, 0 unreadable
copied 225 images and 134 reference marks
```

| | before | after |
|---|---|---|
| `data/slices2d/bme` | 864 | **1,020** |
| `data/slices2d/non_bme` | 1,111 | **1,180** |
| `data/refmarks2d` | — | **134** |
| `index.csv` rows | 1,975 | **2,200** |

The source folder was not modified. Re-running is safe: every imported image is
now fingerprinted on the next pass and skipped as a duplicate.

### One thing that was in the repo root

`labled_data_bme/` — a 120 MB, 381-file copy of the whole batch — was sitting
**untracked in the repo root**, not covered by any ignore rule. I did not create
it; the importer only ever writes under `data/`.

It is one `git add .` away from committing patient images. I have added
`/labled_data_bme/` and `/Annotated/` to `.gitignore` so that cannot happen, and
left the files alone. **Delete it yourself once you are satisfied it is a
duplicate of `D:\Final yr Prj\Annotated\labled_data_bme` — it is redundant now
that the import is done, but erasing data is your call, not mine.**

---

## The freeze-depth sweep

`train_2d.py` already supports both halves of this:

- `--freeze N` freezes the first N top-level backbone blocks
- `--patience N` early-stops after N epochs with no validation AUC gain, and
  restores the best weights rather than keeping the last ones

**The sweep has never completed.** It was relaunched and ran for about an hour on
CPU, then was stopped on 2026-09-04 before the first arm (`--freeze 0`) printed a
single fold. `data/results2d/` holds no sweep output, so there is no result to
report and nothing to quote in the write-up.

Stopping it lost nothing: it started at 04:01 and the import landed at 04:58, so
it was reading the pre-import file list. Any freeze depth it chose would have
been chosen on half the data.

Re-run it after the import, not before -- the batch roughly doubles the data and
adds genuinely independent patients, so any freeze depth chosen on the old set
would be chosen on the wrong distribution.

```bash
for f in 0 4 6 8; do python ml/scripts/train_2d.py --freeze $f --patience 5 --epochs 30; done
```

Early stopping is what makes this affordable on CPU: without it every arm pays
for 30 epochs whether or not it stopped improving at 8. Expect the shallow-freeze
arms to stop earliest.

Two things to hold on to when reading the result:

- Report **mean +/- std across the folds**, not the best fold. A sweep is exactly
  the situation where quoting the best number is most tempting and most wrong.
- Four arms on one validation set is four chances to get lucky. If the spread
  between arms is smaller than the std within an arm, the honest conclusion is
  that freeze depth did not matter -- which is a real finding, and cheaper to
  defend than a fragile one.

Previous negative results already recorded, for consistency of tone: HIM made
AUC worse (0.604 vs 0.658), and 6 epochs matched 3 epochs.

---

## After the import

Once the images are in, the counts roughly double: 864 -> ~1,020 BME and
1,111 -> ~1,180 non-BME. Then:

1. **Retrain the classifier** — Training page, "Detect (yes / no)" tab. More
   data, and this time genuinely independent patients rather than more slices
   from the same knees. If AUC does not move off ~0.66, the ceiling is the
   method, not the data volume, and that is worth knowing before the report.
2. **The segmenter still has 0 annotations.** This import does not change that.
   Reference marks are not labels. The "Mark the edema" tab stays blocked until
   you annotate real cases in the annotate page — that remains the single
   blocker on both project objectives.

---

## Reproducing the analysis

The two probe scripts lived in the session scratchpad and are gone. Neither is
needed to run the import — they only produced the numbers quoted above. If you
want to re-derive them, both are short: fingerprint every image with the
`fingerprint()` function in `import_2d.py`, then compare Hamming distances
across sets; and count green pixels per file with the mask above.

---

## Uncommitted at handoff

- `ml/scripts/import_2d.py` — new
- `docs/HANDOFF.md` — this file
- `docs/STATUS.md` — new step 0, two new known-problem rows
- `.gitignore` — `/labled_data_bme/` and `/Annotated/`

`git status` is clean of data: the only untracked things are the two docs and
the script.

Plus the ~12 commits from earlier sessions that have never been pushed. Nothing
was pushed, and nothing will be without you asking.
