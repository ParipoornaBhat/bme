# Dataset inventory

Generated 2026-08-26 by reading DICOM headers directly out of the case archives
(no extraction). Supersedes the provisional audit in [PRD.md](PRD.md) §2.

## Totals

| | Cases | Readable |
|---|---|---|
| BME | 48 | **47** (`IMRAZ.zip` contains no DICOM) |
| Non-BME | 60 | **60** |
| **Total** | **108** | **107** |

3.1 GB. 305 series. Class balance 47:60 — close enough to even that no resampling
is needed, which is unusually lucky for a pathology dataset.

## Body region

**Knee**, essentially throughout — `BodyPartExamined` reads `KNEE` on 92 cases and is
blank on 15. No mixed-joint problem, so PRD §2.2's "pick one joint and finish it" is
already satisfied. Build for the knee.

## Sequences — the finding that drives the model design

Classified by MR physics (TR/TE/TI + fat-suppression flags in `ScanOptions`), because
222 of 305 series have no `SeriesDescription` — the anonymised exports stripped it.

| Availability | Cases | % |
|---|---|---|
| **Edema-sensitive (fat-suppressed PD/T2/STIR)** | **107 / 107** | **100%** |
| T1 | 18 / 107 | 16% |
| Both | 18 / 107 | 16% |
| Neither | 0 | 0% |

Broken down by class, the T1 gap is worse where it matters:

| | n | edema-seq | both |
|---|---|---|---|
| BME | 47 | 47 | **5** |
| Non-BME | 60 | 60 | 13 |

**89 of 107 cases are single-series exports** — one fat-suppressed sequence and
nothing else.

### Consequence

The PRD originally specified T1 as input channel 1, to separate true edema from red
marrow and cysts. **That is not viable as a required input** — only 5 of 47 BME cases
have a T1. The primary model must be **single-channel on the fat-suppressed sequence**.

T1 moves to an optional auxiliary: an ablation on the 18-case subset, reported as
"what a second sequence would buy us", not part of the main pipeline. See PRD §4.3.

This raises the value of the two channels that need no second acquisition — the
contralateral mirror and the Stage D anomaly residual. They are now the main
specificity levers rather than nice-to-haves.

### Protocol observed

Where descriptions survive, it is a standard knee protocol:
`pd_fse_tra_fs`, `pd_fse_cor_fs`, `pd_fse_sag_fs` (fat-suppressed PD in three planes),
`pd_mx3d_sag_spair_uCS` (3D PD with SPAIR), `t1_fse_cor`, `t2_fse_sag`, `t2_tirm_cor`.

## Scanners

| Vendor / model | Cases |
|---|---|
| UIH uMR 780 | 74 |
| SIEMENS Avanto | 18 |
| SIEMENS Symphony | 15 |

Three scanners across two vendors. Good for a generalization claim, and it makes the
intensity normalization in PRD §4.1 mandatory rather than optional — raw intensities
are not comparable across these.

## Geometry

| Matrix / thickness | Series |
|---|---|
| 432×432, 3.5 mm | 48 |
| 320×320, 4 mm | 18 |
| 576×576, 3.5 mm | 17 |
| 408×408, 3 mm | 16 |
| 280×224, 1 mm | 9 |

Typical case is ~0.35 mm in-plane at 3–4 mm slice thickness — roughly **10:1
anisotropy**. Two implications:

- Lesion **volumes** stay reliable (voxel volume is known exactly).
- The **3D surface** will look stacked/terraced unless smoothed, because through-plane
  resolution is coarse. Taubin smoothing in Stage E is not cosmetic, it is required.
- The `280×224 @ 1 mm` series are true 3D isotropic acquisitions. Those are the best
  cases for the 3D deliverable and for demo figures — prefer them when picking a
  showcase case.

## PHI status

| | Cases |
|---|---|
| Headers already anonymised (0 PHI tags) | 84 |
| Headers carrying full PHI | 23 |

The 23 carry `PatientName`, `PatientID`, `PatientBirthDate`, `PatientAge`, `PatientSex`,
`ReferringPhysicianName`, `OperatorsName`, `StudyDate`, `StationName`, `InstitutionName`,
`InstitutionAddress`, `AccessionNumber`.

**Filenames remain the larger exposure — every case still carries a patient name there**
(`--MOHAMMED-FAIZ.zip`, `62 MAMTA J SHENOY PDFS.zip`, …), including the 84 whose headers
are clean. De-identification has to rename files, not just scrub tags.

Also unchecked: **burned-in pixel annotations**. Anonymisers do not touch pixel data, and
scanner-burned text is common. Spot-check before release.

## Known gaps

- `BME/IMRAZ.zip` — no DICOM inside. Re-export.
- 17 non-BME cases have a PNG slice in `Non BME/Slices/` but no volume in `Non BME/3d/`:
  **7, 17–25, 28, 29, 32, 33, 35, 36, 43**. Re-export as DICOM or drop them.
- `Non BME/Slices/` (69 PNGs) is now redundant — the same cases exist as volumes.
  Keep for figures; do not train on it.

## Reproducing this

```bash
python ml/scripts/inventory.py "D:/Final yr Prj/bme"
```

Requires `pydicom`. Reads headers from inside the zips; extracts nothing; prints no
patient identifiers.
