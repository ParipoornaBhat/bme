# Owner's instructions and requests (complete log, 2026-11-15)

This is the full record of what the project owner asked for, in order, and the rules they set. It is for whoever picks up the work next (an agent or a teammate). No passwords or patient details are recorded here. Read this with `HANDOFF.md`.

## 1. Standing rules (apply to all work)
- **Keep the laptop safe:** do not do anything that stresses the CPU, GPU or disk without need. Do not download large files (anything in gigabytes) without asking.
- **Never erase anything.** Deletions must be soft: move files to `data/annotations_backup/` and mark the database row deleted. Nothing is removed for good.
- **Never overclock or change GPU settings.**
- **Stay inside the repo** unless the owner gives permission.
- **Augmentation** (H200 training) must not break any H200 rule. Check before running.
- **Commits:** only when asked. One-line Conventional Commits (`type(scope): summary`), no body, no `Co-Authored-By` or AI attribution.
- **Pushes:** only when asked. Pushing to `main` starts a Vercel production deploy, so only push to `main` when the owner asks for it.
- **Staging:** name the files; never `git add -A` or `git add .`. Check `git status` first.
- **Patient data:** never commit imaging files (`.nii`, `.nrrd`, `.dcm`, zips of scans). Never print or read `.env` values, `data/deid_map.csv` or any `name.json`. Refer to cases by ID only (BME-001, NBME-014).
- **Delegation:** the owner's global rule is that Claude plans and reviews, and an agent (now Antigravity 2.0) does the implementation. Briefs must be self-contained, name the exact files, and say what to report.
- **Docs:** update `docs/STATUS.md` at the end of any session where something changed.
- **Answers:** keep them short and plain. Explain before acting on anything risky.
- **Teammates:** their folders, commands and structure must not change. They should not have to ask anyone to change anything.
- **Decisions stay with the owner:** clinical or labelling calls, and whether data can leave the network, go to the owner or the guide. Do not decide them silently.

## 2. Requests, in order

### Training and data (earlier sessions)
- Explain the custom model architecture (nnU-Net ResEnc M baseline, planned three-stage cascade).
- Plan and build a menu-driven training system: several Kaggle accounts and H200 accounts, data upload and update checks, a warning before any internet-heavy copy, eight training methods, live status and logs, one inbox folder, jump-host setup steps.
- Add a ninth method: one fixed 80/20 patient-level split, with the split shown to the user.
- Resume training after the H200 (4 h) and Kaggle (12 h) limits.
- Local training on CUDA, Apple MPS or CPU, chosen by what is available. Warn before a slow CPU run.
- One starting point: `pnpm menu`.
- A guide for setting up a fresh Kaggle account and API key.
- Share one private Kaggle dataset with selected teammate accounts only (not public).
- Keep `.env.example` current. Account keys are by USN (roll number).
- Make everything work on a teammate's PC, including PCs with no CUDA.
- Data: one document for all data operations and annotation exports, a single data menu (`pnpm data`), and an inbox folder tree.
- Import the new non-BME cases, fix the repeating artifact notice, and do a `git pull` before work (but do not push then).

### Annotation sync and review (this session)
- Annotations must save online as well as locally, with a separate copy per person. The first annotator is shown by default; a dropdown shows the others.
- Automatic sync in the background, so teammates' annotations appear without anyone doing anything. Make it safe: no duplicates, no lost work.
- Pull teammates' existing annotations into the online database; they must not be lost.
- Non-BME annotations: merge all teammates' zips automatically, and stop needing zips every time.
- Reviewer accounts: a radiologist reviewer (Kanupriya) and a second reviewer account (Review). The radiologist's fix replaces the annotation automatically; the replaced one is marked deleted but kept in the database. The second reviewer's changes are only flagged for the owner to decide.
- Team accounts (the four teammates) can open the normal annotate page and save as themselves.
- Reviewers can mark a case as reviewed, which locks their pencil and eraser for that case; they can unmark and change it. "Reviewed with edits" only if the annotation really changed.
- Every save, sync, review and delete is logged. Activities page (local only): log, reviews, deleted (open, compare, restore), owners. Deleted annotations can be opened and compared with a reviewer's.
- Several annotators per case: show the first person to annotate, then "also" the others. Annotation owners: BME 1-15 Paripoorna, 16-30 Elvin, 31-45 Aditi, 46-61 Reegan; BME-062 Elvin; BME-063 and 064 Aditi; BME-065 to 075 Paripoorna; BME-076 to 081 Aditi; BME-082 to 085 Reegan. NBME 1-15 Paripoorna, 16-30 Elvin, 31-45 Aditi, 46-60 Reegan.
- The annotation for NBME-058 came from a different scan on another laptop; fix it and import it (done).

### Hosted reviewer site (Vercel)
- A review-only site with its own login: username and password, no Google or other login buttons, no sign-up.
- Reviewer side: only the 3D annotate page and review tools. Team side: the normal annotate page.
- Separate commands: `pnpm build:prod` and `pnpm start:prod` for the review-only build. Everything else stays local.
- Domain: `bme.paripoorna.me` (the Vercel project is bme-kappa.vercel.app for now).
- Secrets to Vercel by command (`pnpm vercel:secrets`), never the passwords. Passwords stay in the local `.env` and the database as a hash.
- Scans come from one Google Drive folder set to "Anyone with the link". The owner accepts that the folder is public-by-link; the guide's approval for real patient scans is still pending.
- Keep the first upload folder only until the upload is confirmed; then remove the links (`pnpm review:scans:finish`).
- For new cases later: `pnpm review:scans`, upload the new files, then `pnpm review:scans --finish`.

### Viewer and 3D
- Stop the stretched images: each slice must always fit its panel at its true proportions.
- Load the axial view from its first slice while the scan downloads; the other two views open at the middle slice. Cache scans in the browser; prefetch the next case.
- Opacity slider directly in the toolbar; an outline-only option for seeing borders (bone and edema) easily.
- 3D view: correct anatomical orientation (superior up), smooth surface, every slice used so nothing vanishes, rotation and zoom smooth, view buttons (A, P, L, R, S, I), exact voxel counts and volume in ml and cm³.
- Move/resize tool: select one region or several (Ctrl/Shift+click, box select), move or resize them together.
- Copy and paste of a region: copy only, never cut. Paste on another slice of the same scan at the same size and position, into the current user's own annotation only.
- Switching annotation must not reload or blank the viewer: no full-page loading screen. (Open.)
- The Move/resize button is not responding. (Open.)
- Show in the annotator dropdown how many axial slices each person marked (for example "2/22"). (Open.)
- In the case list, show "annotated by" on every row. (Done; not yet click-tested live.)
- The case list must be in order: BME-001 first, then BME-002, and so on; BME before NBME. (Done.)

### Duplicates (open decision)
- The owner believed BME-003's annotations by Reegan and Paripoorna were identical. They are not: Reegan's copy has 10,756 extra voxels on 2 more slices. Aditi marked only 30 of 39 slices.
- Across all 145 cases, the main annotation is identical to one person's copy. The owner asked to delete the duplicates and offered a custom dropdown to do it. Nothing has been deleted. The owner must decide which entry to keep or hide.

### Deploy and push history
- Pushes and merges to `main` have been done when the owner asked. The last one is `ec0420c`.
- The owner asked for: "push and put to main, because Vercel is on main".
- A mistake happened in one commit: its message does not describe its contents, and one commit is empty. Recorded in `HANDOFF.md`. Do not rewrite pushed history.

### Working style with agents
- Run independent tasks in parallel only when they edit different files. Run tasks that share a file one after another.
- Keep each brief short and self-contained. A long brief times out.
- The owner asked for speed: "run them all in parallel and finish fast" when work was independent.

## 3. What is pending (see HANDOFF.md for detail)
1. Stop the full reload on annotation switch.
2. Slice counts in the annotator dropdown.
3. Fix the Move/resize button.
4. Copy and paste of regions (copy only).
5. The owner's decision on duplicate main annotations.
6. Confirm Vercel's production settings; decide on the console 404 leftover.
7. Live-site checks of the reviewer flow and the Activities page.
8. Commit the handoff and the status pointer only when the owner asks.
