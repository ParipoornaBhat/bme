# Plan: data in one place, one data menu, one data document

Written 2026-11-11 for the session that executes it. Nothing in this plan is built yet.
Read `CLAUDE.md` first; its patient-data rules override everything here.

Work through the steps in order. Each step ends with a check; do not start the next step
until the check passes. If a check fails or something is unclear, stop and ask the user.

---

## 0. Rules for this work (do not skip)

- **Never run an erase command** (`pnpm data:3d:erase`, `pnpm data:nonbme:erase`, the
  "Erase" items of `pnpm data`). "From scratch" in the user's request means *a clean,
  ordered way to bring a laptop up to date*, not deleting data. The user has said
  "Don't erase anything".
- **Never print** the contents of `name.json`, `deid_map.csv`, `.env`, or the export
  mapping file. Counting lines or listing key names is fine.
- **Never `git add` data.** Stage nothing in this plan. **Do not commit. Do not push.**
  The user will ask for a commit separately.
- Stay on the current branch (`collaborative-radiologist-view`).
- The import scripts delete their *source* after a successful import. Do not change that
  logic. Change only *where they look*.
- Every Python script here has a dry run (no `--apply`). Always dry-run first and read
  the output before applying.
- Use `ml/.venv/Scripts/python.exe` (system `python` is not installed).
- No emoji in code, docs or messages.

## 1. Where things stand (facts, already verified)

- `git pull` is done: HEAD is `547f85c`. It brought the teammate's bundle import:
  `pnpm data:import:newcases` -> `scripts/import-newbme.js --bundle` ->
  `ml/scripts/import_newbme.py --bundle`.
- The bundle `bme_newcases_20261111.zip` (182 MB, 24 cases) is on this PC in the
  Downloads folder (`Downloads/Temp/New folder/Final Submission/`). A dry run on this
  laptop was clean: 24 to import, 0 skipped, IDs `BME-062 .. BME-085`, no ID mismatch.
  It has **not** been applied.
- This laptop: 76 annotated cases (`data/annotations/*/<ID>.seg.nrrd`), 121 scans in
  `data/nifti`. The hub laptop has more annotations (its Kaggle runs used 121).
- The new 24 cases carry the Slicer edema only; no bone is painted on them yet
  (STATUS, item 0a).
- A stash named `pre-pull edits` still exists as a safety net from the pull. Leave it;
  the user drops it.
- Uncommitted work from earlier sessions is in the tree (training menus, Kaggle
  pipeline, holdout split). Do not revert or reformat it.
- Shared helpers to reuse: `scripts/lib/ui.js` (title, section, choose, info, ok, warn,
  bad, next, stop, table), `scripts/lib/accounts.js` (root, python, requirePython, yes,
  runNode).

### Drop locations today (the problem)

| What you drop | Where it goes today | Read by |
|---|---|---|
| New BME case folders or zips | `data/newbme/` | `ml/scripts/import_newbme.py` (`--src` default) |
| New-cases bundle zip | repo root, `data/`, `data/exports/` | `import_newbme.py` `find_bundle()` |
| Non-BME DICOM zips | `Non BME/3d/` | `ml/scripts/nonbme_to_nrrd.py` (writes `Non BME/new/`) |
| Non-BME NRRD folders or zips | `Non BME/new/`, `data/newnonbme/` | `ml/scripts/import_newnonbme.py` (two roots, near line 69) |
| Teammate annotation zips | repo root, `data/exports/` | `ml/scripts/team_annotations.py` (search near line 231), `ml/scripts/export_nbme.py` (near line 229), `scripts/team-annotations.js` (zip lookup near line 31) |
| `fs_fix.zip` | repo root | `ml/scripts/swap_fs_series.py` |
| Zips made here to send | `data/exports/` | `team_annotations.py` (near lines 186, 336), `export_nbme.py` (near lines 147, 280) |

### Commands today

```
data:process  data:process:bme  data:import:newcases  data:3d:erase
data:3d:nonbme:process  data:nonbme:process  data:nonbme:erase
data:nonbme:fix-fs  data:nonbme:fix-fs:zip  data:nonbme:fix-fs:install
zipbme:<name>  zipnbme:<name>  zipnbme:combine
data:share  data:sync  data:import:team  data (alias of data:process)
```

---

## 2. Step 1: the inbox folder

Target layout, in the repo root:

```
inbox/
  bme/            new BME case folders or zips          (was data/newbme)
  bundles/        bme_newcases_*.zip                    (was repo root, data/, data/exports)
  nonbme-dicom/   non-BME DICOM zips                    (was Non BME/3d)
  nonbme/         non-BME NRRD folders or zips          (was Non BME/new, data/newnonbme)
  team/           teammate and hub zips you received    (was repo root, data/exports)
  fixes/          fs_fix.zip                            (was repo root)
  outgoing/       zips made here, to send               (was data/exports)
```

1. **First**, add `/inbox/` to `.gitignore`, in the patient-data block next to `/data/`.
   This adds an ignore rule; it is not an exception.
   Check: `git check-ignore -v inbox/bme/x` prints the new rule, and
   `git status --short` shows no `inbox` entry after the folders exist.
2. Create one Python helper, `ml/scripts/inbox.py`, with no side effects on import:
   - `INBOX = "inbox"` and a dict of the sub-folder names above.
   - `drop_dirs(base, kind) -> list[Path]`: the new folder first, then the old
     locations for that kind, in the order of the table in section 1. Only existing
     directories are returned, except the first, which is always returned.
   - `outgoing(base) -> Path`: `inbox/outgoing`, created on demand.
   - `ensure(base)`: create the empty tree; return the paths it created.
3. Change each reader to use it. New location first, old ones as a fallback, and print
   one line saying which folder was used. Files to edit, one at a time:
   - `ml/scripts/import_newbme.py`: `--src` default becomes the first of
     `drop_dirs(base, "bme")` that holds anything (fall back to `data/newbme`);
     `find_bundle()` also searches `inbox/bundles` first.
   - `ml/scripts/import_newnonbme.py`: the two roots become `drop_dirs(base, "nonbme")`.
   - `ml/scripts/nonbme_to_nrrd.py`: source = first non-empty of
     `drop_dirs(base, "nonbme-dicom")`; destination = `inbox/nonbme` **only if**
     `Non BME/new` holds no numbered folders, else keep `Non BME/new` (numbering must not
     restart). Read `next_number()` before touching this.
   - `ml/scripts/team_annotations.py` and `ml/scripts/export_nbme.py`: incoming search
     adds `inbox/team` first; outputs go to `outgoing(base)`.
   - `ml/scripts/swap_fs_series.py`: look for `fs_fix.zip` in `inbox/fixes` first, then
     the repo root. `zip` writes to `outgoing(base)`.
   - `scripts/team-annotations.js`: a bare zip name is looked up in `inbox/team`, then
     where it was typed, then `data/exports`.
   - Update the wording in `scripts/data-menu.js`, `scripts/erase-3d.js`,
     `scripts/erase-nonbme.js` and each script's docstring to name the new folders.
4. Do **not** move any existing file. Old locations keep working.
5. `Non BME/axial`, `Non BME/new/new`, `data/raw`, `data/nifti`, `data/annotations` are
   not drop locations. Leave them.

Check for step 1 (all must hold):
- `ml/.venv/Scripts/python.exe -m py_compile` on every edited `.py`; `node --check` on
  every edited `.js`.
- Dry runs still work and name a folder:
  `import_newbme.py .` (expect "missing ..." or 0 items, not a traceback),
  `import_newbme.py . --bundle <path to the zip in Downloads>` (expect the same
  24-case result as section 1),
  `import_newnonbme.py .`, `team_annotations.py import-all .`.
- `ml/tests/test_export_for_colab.py` and `ml/tests/test_check_deid_folder.py` still run
  with the same result as before the change (run them before and after).

## 3. Step 2: import the 24 new cases on this laptop

Ask the user "Apply the new-cases import now?" before the apply command. It adds 24
cases to `data/` and 24 rows to `data/worklist.csv` and `data/deid_map.csv`. It keeps
the bundle.

1. Record before-counts: annotation folders, `data/nifti` folders, worklist rows,
   deid_map line count (count only; never print the file).
2. Copy the bundle from Downloads into `inbox/bundles/` (copy, do not move).
3. Dry run: `pnpm data:import:newcases`. Expect 24 to import, `BME-062 .. BME-085`.
   If it reports an ID mismatch, stop: this laptop is out of sync with the hub and
   needs `pnpm data:sync` first.
4. On the user's yes: `node scripts/import-newbme.js --bundle --apply` (read
   `scripts/import-newbme.js` first to confirm how it passes `--apply`).
5. After-counts: each of the four numbers is +24. Re-run step 3: all 24 are skipped as
   already imported.
6. Tell the user plainly: these 24 have edema only, no bone. Check and report (do not
   decide) whether the trainers would load a case without `bone_marrow`:
   read `load_case()` in `ml/scripts/train_3d.py` (it treats "required segment"
   problems as non-fatal) and `neededFiles()` in `scripts/h200-menu.js` (it sends every
   case with a `.seg.nrrd`). If they would enter training with empty bone, say so and
   ask the user whether to exclude them until bone is painted. The fixed 80/20 split
   (`pnpm train:split`) should be made **after** this question is settled.

## 4. Step 3: one data menu

Rewrite `scripts/data-menu.js` with `scripts/lib/ui.js`. It must keep every current
behaviour (the confirm prompts, `--keep`, the zip-name question). Groups, in this order:

```
Data
  Get this laptop up to date
    1. Show what is here            counts: scans, annotated, with bone, inbox contents
    2. Sync from the hub            data:sync   (hub_mri zip + hub_annotations zip)
    3. Import new cases (bundle)    data:import:newcases
  Bring in new scans
    4. Import BME folders           data:import:bme
    5. Convert non-BME DICOM        data:convert:nonbme
    6. Import non-BME               data:import:nonbme
  Share annotations
    7. Export my BME annotations    data:export:bme <name>
    8. Export my non-BME annotations data:export:nonbme <name>
    9. Export both                  data:export <name>      (new: runs 7 then 8)
   10. Hub: merge teammate zips     data:import:team
   11. Hub: combine all non-BME     data:export:nonbme:all
   12. Hub: share the whole dataset data:share
  Fixes
   13. Install the light-marrow fix data:fix:fs
  Danger (asks twice, never part of any flow)
   14. Erase the 3D dataset
   15. Erase imported non-BME
```

- Item 1 is new and read-only: counts only, never names. For each inbox folder, show how
  many items wait there and the command that handles them.
- Items 7 to 9 ask "whose?" with the four names from `TEAM` in
  `ml/scripts/team_annotations.py` when no name is given.
- Each item ends with a `next(...)` line saying what to do with the result (for an
  export: where the zip is and who to send it to).
- The two erase items keep their existing confirmation and add a second, typed one
  (the user must type `erase`).

New names in `package.json`, old names kept as aliases (teammates use them):

| New | Old alias kept |
|---|---|
| `data` | `data:process` |
| `data:status` | new |
| `data:import:bme` | `data:process:bme` |
| `data:import:newcases` | unchanged |
| `data:convert:nonbme` | `data:3d:nonbme:process` |
| `data:import:nonbme` | `data:nonbme:process` |
| `data:export:bme` | `zipbme:<name>` (all four) |
| `data:export:nonbme` | `zipnbme:<name>` (all four) |
| `data:export` | new (both) |
| `data:export:nonbme:all` | `zipnbme:combine` |
| `data:import:team`, `data:share`, `data:sync` | unchanged |
| `data:fix:fs` | `data:nonbme:fix-fs:install` |
| `data:erase:3d` | `data:3d:erase` |
| `data:erase:nonbme` | `data:nonbme:erase` |

Check for step 3: `node --check`; run `node scripts/data-menu.js` and press Enter (back)
to see the menu prints; run item 1; run items 7 and 8 as dry runs if the underlying
script has one, otherwise only confirm the command line it would run.

## 5. Step 4: one document, `docs/DATA.md`

Write it from the scripts' docstrings and the behaviour verified above, not from memory.
Outline:

1. **The picture**: hub laptop collects and trains; teammates paint; data travels as
   zips; nothing imaging goes into git. One diagram in text.
2. **Folders**: the inbox tree; `data/raw`, `data/nifti` (immutable), `data/annotations`
   (the only thing a human edits), everything else is generated.
3. **Bring a laptop up to date, in order**: pull -> `data:sync` (if behind the hub) ->
   `data:import:newcases` -> `data:status`. What each prints when it is already done.
4. **Add new scans**: BME folders; non-BME DICOM -> NRRD -> import. What is deleted
   after a successful import and how `--keep` avoids it.
5. **Export annotations**: BME (`data:export:bme`), non-BME (`data:export:nonbme`),
   both (`data:export`). What a zip contains, where it lands (`inbox/outgoing`), who
   owns which case range (from `TEAM`), and that a case without bone is left out.
6. **Hub: merge and share**: `data:import:team` and how it decides per file (take,
   identical, conflict, refused on scan mismatch), where backups go
   (`data/annotations_backup/<stamp>/`, `data/sync_backup/<stamp>/`), `data:share`.
7. **From data to training**: `pnpm train:split`, then `pnpm train`; the H200 push and
   the Kaggle dataset pick up new cases by themselves (link `docs/COMMANDS.md`).
8. **Fixes**: the light-marrow swap.
9. **Danger**: the two erase commands, what each removes, that no flow needs them.
10. **Command table**: new name, old alias, what it does, whether it changes data.
11. **When something stops**: ID mismatch, scan fingerprint mismatch, conflict, empty
    inbox folder; each with the next command.

Then: link `docs/DATA.md` from `CLAUDE.md` ("Read this first" list), from
`docs/COMMANDS.md` section 6 (replace the "planned but not moved" sentence), and from
`docs/STATUS.md`. Fix any doc that names a renamed command
(`grep -rn "data:process:bme\|data:3d:nonbme\|data:nonbme:process\|zipbme\|zipnbme" docs`).

## 6. Step 5: close out

- Update `docs/STATUS.md`: what was built, what was imported, known problems.
- Final report to the user, plainly: what was done, what was verified and how, what was
  not done, and anything that failed. List the counts before and after the import.
- Remind the user of the open items that need their decision:
  the `pre-pull edits` stash, installing `kaggle` and `psutil` in `ml/.venv`, the
  bone question from step 2.6, and that nothing is committed.

## 7. Not in this plan

- No change to the trainers, the Kaggle pipeline or the H200 menus.
- No annotation edits. No relabelling. No clinical judgement calls: flag them.
- No upload of anything, anywhere.
