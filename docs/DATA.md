# DATA — Datasets, Inbox, Team Sync, and Commands

This document describes the medical imaging data layout, the inbox staging system,
annotation exchange between team members, hub dataset operations, and data commands.

Read `CLAUDE.md` first: patient data rules override everything else. Real patient data
never enters git.

---

## 1. The picture

One laptop (the hub) collects annotations, merges contributions, and trains models.
Teammates paint bone and edema annotations on their own laptops. Because imaging files
are gitignored, all scans and segmentations travel between machines as zip archives.

```
+-------------------------------------------------------------+
|                      Teammate Laptops                       |
|  - Paint bone and edema in 3D Slicer or web viewer          |
|  - Export finished annotations to inbox/outgoing/           |
+------------------------------+------------------------------+
                               |
                   Zips travel via Drive / USB
                               |
+------------------------------v------------------------------+
|                         Hub Laptop                          |
|  - Merges teammate zips into data/annotations/              |
|  - Runs 2D and 3D training, validation, and testing         |
|  - Shares updated dataset packages back to teammates        |
|  - Pushes datasets to college H200 and private Kaggle       |
+-------------------------------------------------------------+
```

Git tracks code, configuration, and documentation only. The repository root `.gitignore`
blocks `data/`, `inbox/`, `BME/`, `Non BME/`, and all medical imaging file extensions.

---

## 2. Folders

### The inbox tree

All incoming archives, converted series, teammate contributions, and outgoing exports
live under the gitignored `inbox/` directory at the repository root:

- `inbox/bme/`: new BME case folders or zips (legacy fallback: `data/newbme`). Handled by `pnpm data:import:bme`.
- `inbox/bundles/`: new-cases bundle zips `bme_newcases_*.zip` (legacy fallbacks: repo root, `data/`, `data/exports`). Handled by `pnpm data:import:newcases`.
- `inbox/nonbme-dicom/`: non-BME DICOM zips (legacy fallback: `Non BME/3d`). Handled by `pnpm data:convert:nonbme`.
- `inbox/nonbme/`: converted non-BME NRRD folders or zips (legacy fallbacks: `Non BME/new`, `data/newnonbme`). Handled by `pnpm data:import:nonbme`.
- `inbox/team/`: teammate and hub annotation or scan zips received (legacy fallbacks: repo root, `data/exports`). Handled by `pnpm data:import:team`.
- `inbox/fixes/`: scan correction packages such as `fs_fix.zip` (legacy fallback: repo root). Handled by `pnpm data:fix:fs`.
- `inbox/outgoing/`: zips produced on this machine, ready to send to teammates or the hub (legacy fallback: `data/exports`).

Legacy drop locations remain supported by all scripts as secondary fallbacks so existing
directories and workflows continue to work.

### Working dataset (`data/`)

- `data/raw/` and `data/nifti/`: immutable inputs. Scan volumes are written during import and never modified or cleaned up in place.
- `data/annotations/<CASE>/<CASE>.seg.nrrd`: the only files a human edits.
- Generated artifacts: labelmaps (`<CASE>_labels.nii.gz`, `<CASE>_labels.json`), `data/nnunet/` preprocessed arrays, cross-validation split files, and training checkpoints under `data/results3d*` are disposable outputs produced by scripts.

---

## 3. Bring a laptop up to date, in order

To update a teammate laptop or a fresh workspace with the latest code, scans, and
annotations, execute these commands in sequence:

1. `git pull --ff-only`
   Pulls latest code and tracked documentation from git.
   Prints `Already up to date.` when already on HEAD.
2. `pnpm data:sync <hub_annotations.zip>` (or `pnpm data:sync <hub_mri.zip> <hub_annotations.zip>`)
   Applies hub MRI scans and annotations.
   Prints `exact match, kept` for scans that already match. When annotations match or are already applied, reports zero replacements.
3. `pnpm data:import:newcases`
   Discovers the newest `bme_newcases_*.zip` in `inbox/bundles/` and imports new cases without modifying existing case numbers.
   When already imported, prints `0 to import` and lists all cases as `skipped (already imported)`.
4. `pnpm data:status`
   Displays current dataset counts and lists any files waiting in `inbox/` folders.

The 24 cases BME-062 to BME-085 from `bme_newcases_20261111.zip` have edema only and no
bone painted yet; whether they are used for training is an open team decision.

---

## 4. Add new scans

### BME scans

1. Place raw BME case folders or zips into `inbox/bme/` (or `data/newbme/`).
2. Run `pnpm data:import:bme`.
3. The script assigns sequential `BME-nnn` IDs, extracts scan series into NIfTI volumes in `data/nifti/<CASE>/`, attaches Slicer edema annotations to `data/annotations/<CASE>/<CASE>.seg.nrrd`, and records de-identified metadata in `data/worklist.csv`.

### Non-BME scans (DICOM to NRRD to import)

1. Drop raw DICOM zips into `inbox/nonbme-dicom/` (or `Non BME/3d/`).
2. Run `pnpm data:convert:nonbme`. DICOM series are converted to compressed `.nrrd` volumes in `inbox/nonbme/<n>/` (or `Non BME/new/<n>/`).
3. Run `pnpm data:import:nonbme`. Converts NRRD folders into `NBME-001` onward in `data/nifti/` and `data/annotations/`.

### Source removal and the `--keep` option

Successful imports remove their source file or folder by default to prevent duplicate
processing. To preserve the original files, pass `--keep` on the command line or answer
`n` to the confirmation question `Remove the source? [y/N]`.

---

## 5. Export annotations

### Commands

- `pnpm data:export:bme [name]` (or `pnpm zipbme:<name>`): exports owned BME cases where bone is painted.
- `pnpm data:export:nonbme [name]` (or `pnpm zipnbme:<name>`): exports owned non-BME cases patient-wise.
- `pnpm data:export [name]`: exports both BME and non-BME annotations in sequence.

If `name` is omitted, an interactive menu asks `Whose annotations?` listing all four
teammates from the `TEAM` definition in `ml/scripts/team_annotations.py`.

### Contents and destination

- BME exports contain `data/annotations/<CASE>/*.seg.nrrd` for owned cases whose canonical `<CASE>.seg.nrrd` contains `bone_marrow`, plus `manifest.json` with scan fingerprints. Cases that carry only the initial Slicer edema without bone painted are excluded so unfinished work cannot overwrite completed annotations.
- Non-BME exports contain `NBME-xxx/` folders with segmentations, label maps, voxel counts in JSON format, and `manifest.json`.
- All output zips are written to `inbox/outgoing/`. Send these archives to the hub laptop.

### Team ownership ranges

Agreed case ranges from `ml/scripts/team_annotations.py` and `export_nbme.py`:

- `paripoorna`: cases 1 to 15 (BME-001..015, NBME-001..015)
- `elvin`: cases 16 to 30 (BME-016..030, NBME-016..030)
- `aditi`: cases 31 to 45 (BME-031..045, NBME-031..045)
- `reegan`: cases 46 to 61 for BME (NBME 46 to 60)

---

## 6. Hub: merge and share

### Merging teammate annotations (`pnpm data:import:team`)

On the hub laptop, place received archives in `inbox/team/` and run `pnpm data:import:team`.
Per-file decision logic:

1. No local file exists, or local file lacks bone: take the incoming file.
2. Byte-identical: do nothing; file already matches.
3. Both files have bone painted and differ: flags a `CONFLICT`. Left unchanged unless `--prefer-incoming` is passed.
4. Refused on scan mismatch: refused if the scan fingerprint in `manifest.json` does not match the local primary scan, or if the zip owner does not match the case owner (unless `--any-owner` is passed).

Replaced files are automatically copied to `data/annotations_backup/<stamp>/` before
writing, allowing an import to be reversed if necessary. Full sync/restore operations
back up replaced files to `data/sync_backup/<stamp>/`.

### Sharing the complete dataset (`pnpm data:share`)

Running `pnpm data:share` on the hub produces two archives in `inbox/outgoing/`:

- `hub_mri_<stamp>.zip`: `data/worklist.csv` and all primary and secondary NIfTI scans under `data/nifti/`.
- `hub_annotations_<stamp>.zip`: all annotations under `data/annotations/`.

---

## Reviewer site scans

Run `pnpm review:scans` after importing new cases to keep the hosted reviewer site in step with this laptop.
The process splits into two steps around a manual drag-and-drop upload to the public Google Drive folder:
1. `pnpm review:scans` stages missing scans at `drive-upload/<CASE>_primary.nii.gz` using hard links that cost no disk space.
2. Upload `drive-upload/` contents to the Drive folder manually (the folder is view-only for the application).
3. `pnpm review:scans --finish` updates `data/review_scan_ids.json`, runs `pnpm review:setup`, and unlinks the hard links.
The `drive-upload/` folder is deleted once empty. Scans on Google Drive are never deleted by this command.

---

## 7. From data to training

After importing or merging new data on the hub:

1. `pnpm train:split`
   Regenerates the fixed 80/20 train/validation split (`data/train_split_80_20.json`) and 5-fold cross-validation folds. Patient cases are kept together so slices from one patient never cross split boundaries.
2. `pnpm train`
   Opens the interactive training menu for local 2D and 3D U-Net and Attention U-Net architectures.
3. Remote training
   - H200: `pnpm h200` packages scans and annotations and dispatches jobs to the H200 cluster.
   - Kaggle: `pnpm kaggle:upload` automatically gathers scans and annotations into the private staging dataset.

See [docs/COMMANDS.md](COMMANDS.md) for full training and execution details.

---

## 8. Fixes: the light-marrow swap

Cases NBME-005 and NBME-058 were originally provided with non fat-suppressed (light marrow)
scans. Edema is visible only on fat-suppressed scans (dark marrow).

The light-marrow swap replaces the underlying scan with the case's own fat-suppressed
series while preserving all painted annotations:

1. Hub laptop: generates `fs_fix.zip` containing the dark axial scans via `pnpm data:nonbme:fix-fs:zip`.
2. Teammate laptops: place `fs_fix.zip` into `inbox/fixes/` (or the repo root) and run `pnpm data:fix:fs` (`node scripts/swap-fs.js install --apply`).
3. The script rewrites volumes in `data/nifti/`, resamples `.seg.nrrd` segmentations onto the new grid by world coordinates (nearest-neighbour), updates `data/worklist.csv`, backs up replaced files to `data/_backup_fs_<stamp>/`, and deletes the zip upon completion.

---

## 9. Danger: erase commands

Two commands exist to wipe data for full resets. Neither command is part of any normal
workflow:

- `pnpm data:erase:3d` (`pnpm data:3d:erase`):
  Wipes `data/raw`, `data/nifti`, `data/annotations`, `data/nnunet`, and 3D rows in `data/worklist.csv`, `data/deid_map.csv`, and the database. Preserves `inbox/bme` and `data/newbme`.
- `pnpm data:erase:nonbme` (`pnpm data:nonbme:erase`):
  Wipes imported NBME cases only (`data/nifti/NBME-*`, `data/annotations/NBME-*`, and NBME rows in database and worklist). Preserves `inbox/nonbme`, `Non BME/new`, `data/newnonbme`, and all BME cases.

Both commands require two confirmations:
1. An initial `[y/N]` prompt.
2. Typing the literal word `erase`.
Any other response cancels with `Cancelled. Nothing was deleted.`

---

## 10. Command table

| New command | Old alias | What it does | Changes data |
|---|---|---|---|
| `pnpm data` | `pnpm data:process` | Interactive data menu | No |
| `pnpm data:status` | (new) | Count scans, annotations, and inbox items | No |
| `pnpm data:sync` | (unchanged) | Sync scans and annotations from hub zips | Yes |
| `pnpm data:import:newcases` | (unchanged) | Import bundled BME cases (bme_newcases_*.zip) | Yes |
| `pnpm data:import:bme` | `pnpm data:process:bme` | Import raw BME folders or zips | Yes |
| `pnpm data:convert:nonbme` | `pnpm data:3d:nonbme:process` | Convert non-BME DICOM zips to NRRD | Yes |
| `pnpm data:import:nonbme` | `pnpm data:nonbme:process` | Import non-BME NRRD cases | Yes |
| `pnpm data:export:bme` | `pnpm zipbme:<name>` | Export owned BME annotations with bone | No |
| `pnpm data:export:nonbme` | `pnpm zipnbme:<name>` | Export owned non-BME annotations | No |
| `pnpm data:export` | (new) | Export both BME and non-BME annotations | No |
| `pnpm data:import:team` | (unchanged) | Hub: merge teammate annotation zips | Yes |
| `pnpm data:export:nonbme:all` | `pnpm zipnbme:combine` | Hub: combine all 60 non-BME cases for training | No |
| `pnpm data:share` | (unchanged) | Hub: export full MRI and annotation zips | No |
| `pnpm data:fix:fs` | `pnpm data:nonbme:fix-fs:install` | Install fat-suppressed series swap fix | Yes |
| `pnpm data:erase:3d` | `pnpm data:3d:erase` | Danger: wipe 3D dataset to restart at BME-001 | Yes |
| `pnpm data:erase:nonbme` | `pnpm data:nonbme:erase` | Danger: wipe imported NBME cases | Yes |

---

## 11. When something stops

### ID mismatch

- Symptom: `pnpm data:import:newcases` stops and reports that this laptop would assign different IDs than the manifest.
- Cause: This laptop is missing earlier cases present on the hub.
- Next command: `pnpm data:sync <hub_annotations.zip>` to bring case IDs and annotations up to date, then rerun `pnpm data:import:newcases`.

### Scan fingerprint mismatch

- Symptom: `pnpm data:import:team` or `data:sync` skips a case because the incoming scan fingerprint in `manifest.json` does not match the local scan.
- Cause: The two machines have different MRI scans assigned to the same case ID.
- Next command: Run `pnpm data:sync <hub_mri.zip> <hub_annotations.zip>` to align local scans with the hub.

### Conflict

- Symptom: `pnpm data:import:team` reports `CONFLICT` on an annotation file where both local and incoming files have bone painted and their contents differ.
- Cause: Annotations for that case were edited independently on two laptops.
- Next command: Review both versions in the web viewer (`/annotate`). To override local with incoming, run `pnpm data:import:team --prefer-incoming`. Replaced files remain available in `data/annotations_backup/<stamp>/`.

### Empty inbox folder

- Symptom: An import or conversion command reports 0 items found.
- Cause: Files were placed in an unmigrated folder or not yet downloaded.
- Next command: Run `pnpm data:status` to inspect item counts across all inbox folders, and move the relevant archive into the correct `inbox/` subfolder.
