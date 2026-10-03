# Audit of the Drive BME Slicer export

Checked 2026-09-30 against the three original Drive zips (`BME-20260929T081535Z-1-00{1,2,3}.zip`),
not against any copy. Every scan, marking, Slicer scene and DICOM header in them was read.
This is the dataset the medical student prepared: 108 patient folders, all labelled BME.

**How folders are named here.** By Drive folder number only; the folder names are patient
names and never appear in this repo. Six numbers are used by two folders each (7, 12, 15, 22,
34, 35), so those get `a`/`b` in alphabetical order of the full folder name, and the two
folders with no number are `X1` and `X2`. The label-to-folder key is
`~/Downloads/slicer-import/audit_key.csv` on Elvin's laptop (local only, it holds names).

---

## Verdict

The core of the dataset is sound: **every marking that exists is readable, non-empty, drawn
on an axial knee scan, and (except `X1`) sits exactly on that scan's voxel grid.** No
DICOM was found filed under the wrong patient.

What is wrong is the **packaging**: the same patient uploaded two or three times, markings
left off Drive, scans left off Drive, one folder holding two patients, stray copies of other
patients' scans, and lesions split across separate files or folders. None of that is visible
from the folder list, and several of these problems are already inside the 55 cases that
were imported.

| | Folders |
|---|---|
| Imported as BME-001 to BME-055 | 55 |
| Recoverable with no new data (scan rebuilt from DICOM, or a trivial choice) | 12 |
| Need a decision from the student (which file / which patient) | 4 |
| Marked in Slicer, but the marking was never uploaded | 24 |
| Never marked in Slicer | 8 |
| Marking with no scan anywhere | 1 |
| Excluded as duplicate uploads | 4 |
| **Total** | **108** |

Counting duplicates once, the export holds **at most about 100 distinct patients**, not 108.

---

## What is proper

| Check | Result |
|---|---|
| Body part | `KNEE` on every folder where the DICOM states it (69); blank on the rest, none different |
| Markings readable | 77 of 77 marking files open without error |
| Markings non-empty | 77 of 77 contain edema voxels |
| Marking fits its scan | 76 of 77 lie exactly on a scan's voxel grid in the same folder (the exception is `X1`) |
| Sequence marked on | All 76 are axial. 65 are on Slicer scans named as fat-suppressed PD (`pd_fse_tra_fs`, `pd_tse_fs_tra`), the right sequence for BME. The other 11 fit an axial DICOM series whose description is blank, so fat suppression is not confirmed by name |
| Segment naming | Consistent: every file uses `Segment_1` (plus an empty `Segment_2` in two files) |
| Wrong-patient DICOM | None found. Where the DICOM carries a real name, it matches the folder (one spelling variant, `143`). Eight DICOMs that seemed to disagree carry an anonymisation code, not a name |
| Slicer scan vs. DICOM | Where both exist, the Slicer scan is voxel-identical to a series in the same folder's DICOM, except the stray copies listed below and `126` |
| Marking size | 0.2 to 64 ml, median 7.0 ml; 2 to 13+ slices, most 4 to 10 |

---

## What is not proper

### 1. The same patient in more than one folder (affects training)

Identical scan voxels, and where the DICOM has a patient ID, the same ID.

| Folders | Evidence | Markings | Imported as | Action |
|---|---|---|---|---|
| 21 and 22a | Same scan, same DICOM patient ID | Both marked, **zero overlap** (different slices) | BME-032 and BME-033 | Merge into one case |
| 7a and 8 | Same scan, same DICOM patient ID | Both marked, **zero overlap** | BME-052 and BME-054 | Merge into one case |
| 11 and 12a | Same scan (12a has no DICOM) | Both marked, **zero overlap** | BME-003 (12a); 11 skipped | Merge into one case |
| 64 and 104 | Same scan | Only 64 marked | BME-049 (64) | 104 excluded |
| 146 and 107 | Same scan | Only 146 marked | BME-027 (146) | 107 excluded |
| 44 and X2 | Same scan | Only 44 marked | neither (44 had no scan file) | X2 excluded; 44 recoverable |
| 34b and 35b | Same scan | Neither marked | neither | 35b excluded |

**Two of these pairs are both inside the imported 55** (BME-032/033 and BME-052/054). With a
patient-level split they can land on opposite sides of train/validation, and the model is
then validated on a patient it trained on. They must be merged before any 3D training.

The zero-overlap markings are the pattern to ask the student about: each copy marks
different slices of the same scan. The likeliest explanation is that separate lesions were
saved in separate folders; the alternative is that one of them is wrong.

### 2. Stray scans from other patients

| Folder | Contains | Its own marking |
|---|---|---|
| 10 | A copy of folder 2's scan, which is not in folder 10's DICOM | On folder 10's own scan (correct) |
| 5 | A copy of folder 10's scan, which is not in folder 5's DICOM | On folder 5's own scan (correct) |

The import picked the right scan for both (it matches the marking's grid), so BME-002 and
BME-041 are fine. The stray files should still be removed from Drive.

### 3. One folder holds two patients

**19**: two DICOM studies with two different patient IDs. The second patient sits in a
subfolder with its own scan and marking. The two markings do not overlap and are on
different scans. Needs splitting into two folders, and the second patient's identity
confirmed by the student.

### 4. Two marking files in one folder

| Folder | Files | Relationship | Action |
|---|---|---|---|
| 15a | `Segmentation` and `Segmentation preview` | Same mask exactly | Use either; delete the preview |
| 129 | `Segmentation` and `Segmentation 2` | Zero overlap | Ask: two lesions (merge) or a redo (pick one)? |
| 131 | Same two names | Zero overlap | Same question |
| 132 | Same two names, one with an empty segment | Zero overlap | Same question |

### 5. Files missing from Drive

- **Marking made but not uploaded: 24 folders** (27 before excluding duplicates). The Slicer
  scene in each folder contains a segmentation node, so the edema was marked, but the
  `.seg.nrrd` was not uploaded. These are the cheapest cases to recover: the files should
  still be on the student's computer. Listed per folder in `reupload_list.txt` (local).
- **Marking uploaded without its scan: 11 folders** (22b, 41, 44, 46, 85, 118, 119, 120, 130,
  131, X1). All except X1 have an axial DICOM series that the marking fits exactly, so the
  scan can be rebuilt from DICOM and these become usable without asking anyone (131 still
  needs its two-file question answered).
- **X1** has a marking and nothing else. It fits no scan anywhere in the export.
- **No DICOM at all**: 4, 12a, 15a, 112, 125, X1.
- Almost every Slicer scene refers to volumes that were not uploaded, so the scenes cannot be
  reopened in Slicer as they are. This does not matter for us; the `.nrrd` files are what
  count.

### 6. Never marked in Slicer

**8 folders**: 29, 30, 31, 40, 54, 101, 102, 103 (104 was a ninth, now excluded as a
duplicate). No Slicer scene, no marking; only DICOM and screenshots. Folder 54 has four
screenshots named like markings, which were probably drawn on 2D pictures and cannot be
turned into a 3D mask. These need marking from scratch.

### 7. Messy but harmless

- Duplicate copies of the same scan inside one folder: 15a (3 copies), 19, 23 (2 copies).
  The import skips a folder when two scans match, so 23 was skipped for nothing (15a was
  skipped for its duplicate preview marking).
- File names that were saved over and over: `...fs.nrrd1.nrrd11.nrrd`, `Segmentation.seg.nrrd 2.seg.nrrd`,
  `Unnamed Series.nrrd`.
- Two segments in one file where one is empty: 11, 132.
- Formats that need extra tools: 6 `.rar` archives (23, 24, 136, 137, 143, X2); 2 old `.doc` files.
- Folder naming: six Drive numbers used twice, two folders with no number, `--` prefixes,
  folders named only with a number, and misspellings.

### 8. Markings worth a second look

These are not errors, but a radiologist should look at them before they are trusted:

- **On two or fewer slices**: 46, 52, 121, 131, X1. BME usually spans more slices than that.
- **Smallest volumes** (under 0.75 ml): 46, 52, X1, 50, 18, 118.
- **Report says "no ... edema"**: 19 folders include a Word report. The reports in 5, 18 and 26
  contain a "no edema" type phrase while the folder is marked BME. This was a keyword search
  only; the phrase may refer to a different structure, so read those three reports.
- **126**: its Slicer scan is not voxel-identical to anything its DICOM rebuilds. It may be a
  different reconstruction of the same series; not confirmed.

### 9. Patient privacy

The export is **not de-identified**, and must never be shared outside the team:

- Folder names, DICOM zip names and some Word report names are patient names.
- The DICOM is inconsistent: 68 folders have the patient name blanked, but 21 still carry a
  real name, 28 a birth date, 29 a study date and 23 an institution name.
- None of the DICOM declares de-identification (`PatientIdentityRemoved` is empty everywhere).

Our pipeline converts to `.nrrd`/`.nii.gz` under pseudonymous IDs, which drops all of this,
but the raw zips stay under the rules in `CLAUDE.md` §1.

### 10. Things that limit the model regardless of cleanup

- **Two scanners**: United Imaging 3.0 T (54 folders) and Siemens 1.5 T (47). Different voxel
  sizes too (0.26 to 0.5 mm in-plane, 3.6 to 4.96 mm slices). Results should be reported per
  scanner as well as overall.
- **Every folder is BME-positive.** There are no negatives in this export.
- **Only edema is marked**, not bone marrow; the training pipeline needs both.
- **One plane**: every marking is axial.
- Sex is recorded for 34 folders (25 M, 9 F) and age for 34 (18 to 76 years); the rest is blank.

---

## Effect on the imported BME-001 to BME-055

| Case | Folder | Problem | Fix |
|---|---|---|---|
| BME-032, BME-033 | 21, 22a | Same patient twice | Merge markings into one case, drop the other ID |
| BME-052, BME-054 | 7a, 8 | Same patient twice | Same |
| BME-003 | 12a | Same patient as folder 11 (not imported), whose marking covers other slices | Merge 11's marking into it |
| BME-002, BME-041 | 10, 5 | Stray scan files in the folder; import picked the right scan | None |

The other 50 imported cases have no problem found by this audit.

---

## Questions for the medical student

1. **Folders 21/22a, 7a/8, 11/12a, and the second files in 129, 131, 132**: each pair marks
   different slices of the same scan. Are these separate lesions of one patient, or a redo?
2. **Folder 19**: which patient is in the subfolder, and should it be its own folder?
3. **The 24 folders with a Slicer scene but no marking**: please upload the `Segmentation.seg.nrrd`
   files from the computer they were made on (list in `reupload_list.txt`).
4. **X1**: which scan was this marking drawn on?
5. **Folders 5, 18, 26**: the report says "no edema" somewhere. Is BME definitely present?
6. **Folders 29, 30, 31, 40, 54, 101, 102, 103**: were these ever marked?
7. Please remove stray copies (folders 5 and 10), duplicate scan copies, and the
   `Segmentation preview` file in 15a.

---

## Per-folder table

`Slicer` = scans exported from Slicer; `DICOM` = distinct series in the DICOM; `Marks` =
number of marking files.

| Folder | Imported as | Slicer | DICOM | Marks | Status | Notes |
|---|---|---|---|---|---|---|
| 1 | BME-001 | 1 Slicer | 10 series | 1 | Imported |  |
| 2 | BME-031 | 1 Slicer | 11 series | 1 | Imported |  |
| 3 | BME-039 | 1 Slicer | 10 series | 1 | Imported |  |
| 4 | BME-040 | 1 Slicer | none | 1 | Imported |  |
| 5 | BME-041 | 3 Slicer | 9 series | 1 | Imported | holds a stray copy of folder 10's scan; report contains a "no ... edema" phrase |
| 6 | BME-045 | 1 Slicer | 19 series | 1 | Imported |  |
| 7a | BME-052 | 1 Slicer | 32 series | 1 | Imported | same patient and scan as 8; markings do not overlap |
| 7b | BME-053 | 1 Slicer | 1 series | 1 | Imported |  |
| 8 | BME-054 | 1 Slicer | 32 series | 1 | Imported | same patient and scan as 7a; markings do not overlap |
| 9 | BME-055 | 1 Slicer | 17 series | 1 | Imported |  |
| 10 | BME-002 | 2 Slicer | 16 series | 1 | Imported | holds a stray copy of folder 2's scan |
| 11 |  | 1 Slicer | 10 series | 1 | Recoverable (trivial) | import skipped: 2 segments; same patient and scan as 12a; markings do not overlap; second segment is empty |
| 12a | BME-003 | 1 Slicer | none | 1 | Imported | same patient and scan as 11; markings do not overlap |
| 12b | BME-004 | 1 Slicer | 1 series | 1 | Imported |  |
| 13 | BME-012 | 1 Slicer | 9 series | 1 | Imported |  |
| 14 | BME-020 | 1 Slicer | 10 series | 1 | Imported |  |
| 15a |  | 3 Slicer | none | 2 | Recoverable (trivial) | import skipped: 2 segmentation files; two marking files are the same mask (one is a "preview"); 3 identical scan copies |
| 15b | BME-028 | 1 Slicer | 1 series | 1 | Imported |  |
| 17 | BME-029 | 1 Slicer | 11 series | 1 | Imported |  |
| 18 | BME-030 | 1 Slicer | 16 series | 1 | Imported | report contains a "no ... edema" phrase |
| 19 |  | 3 Slicer | 22 series | 2 | Needs decision | import skipped: 2 scans match; two patients (two DICOM studies); second one sits in a subfolder |
| 21 | BME-032 | 1 Slicer | 13 series | 1 | Imported | same patient and scan as 22a; markings do not overlap |
| 22a | BME-033 | 1 Slicer | 13 series | 1 | Imported | same patient and scan as 21; markings do not overlap |
| 22b |  | - | 1 series | 1 | Recoverable (scan from DICOM) | import skipped: segmentation but no scan file |
| 23 |  | 3 Slicer | 10 series | 1 | Recoverable (trivial) | import skipped: 2 scans match; 2 identical scan copies |
| 24 | BME-034 | 2 Slicer | 10 series | 1 | Imported |  |
| 25 | BME-035 | 1 Slicer | 9 series | 1 | Imported |  |
| 26 | BME-036 | 1 Slicer | 8 series | 1 | Imported | report contains a "no ... edema" phrase |
| 27 | BME-037 | 1 Slicer | 18 series | 1 | Imported |  |
| 28 | BME-038 | 1 Slicer | 12 series | 1 | Imported |  |
| 29 |  | - | 1 series | - | Never marked in Slicer |  |
| 30 |  | - | 1 series | - | Never marked in Slicer |  |
| 31 |  | - | 1 series | - | Never marked in Slicer |  |
| 32 |  | - | 1 series | - | Marking not uploaded |  |
| 33 |  | - | 1 series | - | Marking not uploaded |  |
| 34a |  | 1 Slicer | 1 series | - | Marking not uploaded | import skipped: no segmentation |
| 34b |  | - | 1 series | - | Marking not uploaded | 35b is a duplicate of this folder |
| 35a |  | 1 Slicer | 1 series | - | Marking not uploaded | import skipped: no segmentation |
| 35b |  | - | 1 series | - | Excluded (duplicate) | duplicate of 34b, excluded |
| 36 |  | - | 1 series | - | Marking not uploaded |  |
| 37 |  | 1 Slicer | 1 series | - | Marking not uploaded | import skipped: no segmentation |
| 38 |  | 1 Slicer | 1 series | - | Marking not uploaded | import skipped: no segmentation |
| 40 |  | - | 1 series | - | Never marked in Slicer |  |
| 41 |  | - | 1 series | 1 | Recoverable (scan from DICOM) | import skipped: segmentation but no scan file |
| 42 |  | - | 1 series | - | Marking not uploaded |  |
| 43 |  | 1 Slicer | 1 series | - | Marking not uploaded | import skipped: no segmentation |
| 44 |  | - | 1 series | 1 | Recoverable (scan from DICOM) | import skipped: segmentation but no scan file; X2 is a duplicate of this folder |
| 45 |  | - | 1 series | - | Marking not uploaded |  |
| 46 |  | - | 1 series | 1 | Recoverable (scan from DICOM) | import skipped: segmentation but no scan file; marking on 2 or fewer slices |
| 47 |  | - | 1 series | - | Marking not uploaded |  |
| 48 |  | - | 1 series | - | Marking not uploaded |  |
| 49 |  | - | 1 series | - | Marking not uploaded |  |
| 50 | BME-042 | 1 Slicer | 1 series | 1 | Imported |  |
| 52 | BME-043 | 1 Slicer | 1 series | 1 | Imported | marking on 2 or fewer slices |
| 53 |  | 1 Slicer | 1 series | - | Marking not uploaded | import skipped: no segmentation |
| 54 |  | - | 1 series | - | Never marked in Slicer |  |
| 55 | BME-044 | 1 Slicer | 1 series | 1 | Imported |  |
| 60 | BME-046 | 1 Slicer | 1 series | 1 | Imported |  |
| 62 | BME-047 | 1 Slicer | 1 series | 1 | Imported |  |
| 63 | BME-048 | 1 Slicer | 1 series | 1 | Imported |  |
| 64 | BME-049 | 1 Slicer | 1 series | 1 | Imported | 104 is a duplicate of this folder |
| 65 | BME-050 | 1 Slicer | 1 series | 1 | Imported |  |
| 66 | BME-051 | 1 Slicer | 1 series | 1 | Imported |  |
| 85 |  | - | 1 series | 1 | Recoverable (scan from DICOM) | import skipped: segmentation but no scan file |
| 88 |  | - | 1 series | - | Marking not uploaded |  |
| 101 |  | - | 1 series | - | Never marked in Slicer |  |
| 102 |  | - | 1 series | - | Never marked in Slicer |  |
| 103 |  | - | 1 series | - | Never marked in Slicer |  |
| 104 |  | - | 1 series | - | Excluded (duplicate) | duplicate of 64, excluded |
| 106 |  | 1 Slicer | 1 series | - | Marking not uploaded | import skipped: no segmentation |
| 107 |  | - | 1 series | - | Excluded (duplicate) | duplicate of 146, excluded |
| 108 |  | - | 1 series | - | Marking not uploaded |  |
| 109 |  | - | 1 series | - | Marking not uploaded |  |
| 110 |  | - | 1 series | - | Marking not uploaded |  |
| 111 |  | - | 1 series | - | Marking not uploaded |  |
| 112 |  | - | none | - | Marking not uploaded |  |
| 113 |  | - | 1 series | - | Marking not uploaded |  |
| 114 |  | - | 1 series | - | Marking not uploaded |  |
| 118 |  | - | 14 series | 1 | Recoverable (scan from DICOM) | import skipped: segmentation but no scan file |
| 119 |  | - | 1 series | 1 | Recoverable (scan from DICOM) | import skipped: segmentation but no scan file |
| 120 |  | - | 1 series | 1 | Recoverable (scan from DICOM) | import skipped: segmentation but no scan file |
| 121 | BME-005 | 1 Slicer | 1 series | 1 | Imported | marking on 2 or fewer slices |
| 122 | BME-006 | 1 Slicer | 1 series | 1 | Imported |  |
| 124 | BME-007 | 1 Slicer | 1 series | 1 | Imported |  |
| 125 | BME-008 | 1 Slicer | none | 1 | Imported |  |
| 126 | BME-009 | 1 Slicer | 1 series | 1 | Imported | Slicer scan not reproduced by its DICOM |
| 127 | BME-010 | 1 Slicer | 1 series | 1 | Imported |  |
| 128 | BME-011 | 1 Slicer | 1 series | 1 | Imported |  |
| 129 |  | 1 Slicer | 1 series | 2 | Needs decision | import skipped: 2 segmentation files; two marking files that do not overlap |
| 130 |  | - | 1 series | 1 | Recoverable (scan from DICOM) | import skipped: segmentation but no scan file |
| 131 |  | - | 1 series | 2 | Needs decision | import skipped: 2 segmentation files; two marking files that do not overlap; marking on 2 or fewer slices |
| 132 |  | 1 Slicer | 1 series | 2 | Needs decision | import skipped: 2 segmentation files; two marking files that do not overlap; one file has an empty segment |
| 133 | BME-013 | 1 Slicer | 1 series | 1 | Imported |  |
| 134 | BME-014 | 1 Slicer | 1 series | 1 | Imported |  |
| 135 | BME-015 | 1 Slicer | 1 series | 1 | Imported |  |
| 136 | BME-016 | 1 Slicer | 10 series | 1 | Imported |  |
| 137 | BME-017 | 1 Slicer | 10 series | 1 | Imported |  |
| 138 | BME-018 | 1 Slicer | 1 series | 1 | Imported |  |
| 139 | BME-019 | 1 Slicer | 1 series | 1 | Imported |  |
| 140 | BME-021 | 1 Slicer | 1 series | 1 | Imported |  |
| 141 | BME-022 | 1 Slicer | 1 series | 1 | Imported |  |
| 142 | BME-023 | 1 Slicer | 1 series | 1 | Imported |  |
| 143 | BME-024 | 1 Slicer | 10 series | 1 | Imported |  |
| 144 | BME-025 | 1 Slicer | 1 series | 1 | Imported |  |
| 145 | BME-026 | 1 Slicer | 1 series | 1 | Imported |  |
| 146 | BME-027 | 1 Slicer | 1 series | 1 | Imported | 107 is a duplicate of this folder |
| X1 |  | - | none | 1 | Unusable (no scan) | import skipped: segmentation but no scan file; marking fits no scan anywhere in the export; marking on 2 or fewer slices |
| X2 |  | 1 Slicer | 10 series | - | Excluded (duplicate) | duplicate of 44, excluded |

---

## What this audit did not check

- **Whether the marked region is really BME.** That is a clinical judgement; only a
  radiologist can confirm it. Everything above is about files, geometry and identity.
- The "no edema" report check is a keyword search, not a reading of the report.
- Four same-name pairs (11/125, 128/25, 129/141, 55/7b) could not be compared by DICOM
  identity because those DICOMs have the identity fields blanked. Their scans differ (and
  129/141 come from different scanners), so they are treated as different patients.
