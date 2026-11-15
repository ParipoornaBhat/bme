# Handoff: where the project stands (2026-11-15)

Read this first, then `docs/STATUS.md`. Everything here is uncommitted unless marked as pushed.

- Owner's rules and full request log: `docs/handoff/USER_REQUESTS.md`.

## Repo and branch state
- Branch `collaborative-radiologist-view` and `main` are both at `ec0420c` on GitHub (pushed and merged). Vercel production deploys from `main`.
- Local working tree: clean except this handoff folder (`docs/handoff/`), which is not committed.
- Commit `95873db` has the wrong message: it contains the middle-slice fix, the case-list sort and the "annotated by" name. Commit `ec0420c` is empty. Do not rewrite pushed history; it is recorded here so nobody is surprised.

## Done and pushed
- Review site (hosted, bme-kappa.vercel.app; target domain bme.paripoorna.me): login by username, roles (radiologist, reviewer, team), lock/mark per case, reviewer saves, Drive scans streamed.
- Database (Supabase): migrations 0000 to 0006 applied. `case_owner` seeded for all 145 cases. Kanupriya is `radiologist`, `Review` is `reviewer`, the four team members are `team`.
- Sync: radiologist edits replace the annotation automatically; the replaced one is soft-deleted online and moved to backup on the next sync.
- Viewer: opacity slider, outline toggle (O), multi-select and box select in the Move tool, first-slice streaming for axial with a browser cache, prefetch of the next case.
- Stretched-image fix (fit to panel). 3D view rebuilt with WebGL (orientation, smooth surface, volumes in ml and cm3).
- Cached open puts coronal and sagittal at the middle slice.
- Case list sorted BME before NBME, then by number; "annotated by" shown in each row.

## Open, in order (none of these are done)
1. **Stop the full reload when switching annotation.** Cause: `handleAnnotatorChange` in `Viewer.tsx` calls `setBusy(true)`, and `if (busy)` replaces the whole viewer with a spinner. Fix: use a separate `switching` state shown in the status line. Brief: `docs/handoff/briefs/brief_noreload.md`. An agy run for it was started but wrote nothing.
2. **Slice counts in the annotator dropdown** ("Aditi 30/39"). Needs a helper `ml/scripts/annotation_slices.py` (does not exist yet), a change to `GET /api/annotation/[caseId]`, and `AnnotatorPicker.tsx`. Brief: `brief_slices.md` plus `brief_slices2.md` (the second one restricts the tools). Two agy runs failed: headless mode denied a file-read permission and nothing was written. A third run was started but had produced nothing when this was written.
3. **Move/resize button does not respond.** Not reproduced yet. Read-only findings: the button is wired to the tool; the canvas pointer handlers are around `Viewer.tsx` line 4210 onwards; `startMove` is around line 2083; `canAnnotate` is true for team accounts, so permissions are not the cause. Next step: build, open BME-001 on the hosted build, try click, drag and resize, then fix what fails.
4. **Copy and paste of regions** (copy only, never cut). Copy the selected region or group from the current slice; paste onto any slice of the same scan with the same size and position; paste only into the current user's own annotation (greyed out while viewing another person's). Not started.
5. **Duplicate annotations.** Finding: in all 145 cases the main file is byte-identical to exactly one person's copy; no two person copies are identical to each other. BME-003: Paripoorna's copy equals main, Reegan's has 10,756 extra voxels on 2 more slices, Aditi marked 30 of 39 slices. Decision pending from the owner: keep the main entry and label it "Paripoorna (main)", or remove it from the dropdown. Nothing has been deleted.
6. Remaining hosted checks: reviewer save and auto-replace, Activities page, outline and multi-select on the live site.

## Also pending (easy to miss)
- **No brief exists yet** for item 3 (Move button) or item 4 (copy/paste). Write one before starting either, using the same format as `brief_noreload.md`.
- **Vercel environment settings:** not confirmed. Run `pnpm vercel:secrets` (or check the Vercel dashboard) that `DATABASE_URL`, `REVIEW_SESSION_SECRET`, `APP_MODE=review` and `NEXT_PUBLIC_APP_MODE=review` are set for production. Without them the live site cannot log anyone in.
- **Console 404 on the review site:** the page still calls `/api/auth/get-session`, which does not exist in review mode. Harmless, but it shows as errors in the browser console. Fix: skip that call when `isReviewMode()` is true.
- **Minor:** `pnpm review:scans:finish` prints a Node `DeprecationWarning` about `shell: true`. Harmless; fix when convenient.
- **Not click-tested live:** reviewer save and auto-replace, the Activities page (log, compare, restore), outline view, multi-select, first-slice streaming on a cold cache.

## Continuing in Antigravity 2.0 (not the agy CLI)
- The owner will continue in Antigravity 2.0. The CLI notes below describe the old `agy` setup; use them only as background.
- The task briefs in `docs/handoff/briefs/` are plain text. Each one is self-contained: goal, files it may edit, forbidden actions, checks, and what to report. Any agent can run them.
- The "allowed shell commands" lists in the briefs are guard rails for the old CLI. In Antigravity 2.0, keep the same limits by hand: edit only the named files, no reading `.env` or `data/`, no commits or pushes unless the owner asks.
- Before starting, check `git status` and `git log -1`. Nothing from the earlier background runs is pending: all `agy` workers were stopped, and the working tree holds no unfinished edits.
- Open items 1 to 6 below are still the work to do, in that order. Item 1 (reload on switch) and item 4 (copy/paste) both touch `Viewer.tsx`, so do them one at a time.

## agy (Antigravity CLI) workflow
- Binary: `agy` on PATH, account `paripoornabhat@gmail.com`, model `gemini-3.8-flash-high` (also `-medium`, `-low`).
- Run a brief: `agy -p "$(cat <brief>)" --mode accept-edits --model gemini-3.8-flash-high --add-dir . --settings <settings.json> --output-format text --print-timeout 20m`
- Settings file: `docs/handoff/briefs/settings_sync.json` (allows only typecheck, `git status/diff`, `py_compile` and the `@bme/db` test command).
- Known failure: in headless mode the agent sometimes asks for a file-read or shell permission it can't get, stops, and writes nothing. Fixes that worked: keep briefs short; say "use only your file tools"; put the one allowed shell command at the end; use `--print-timeout 20m` or more. Long briefs with several files time out.
- Parallel work: only run workers in parallel when they own different files. `Viewer.tsx` is shared by most open items, so run those one at a time.
- Rules every brief follows: no `.env` or `data/` reads, no patient names, one-line conventional commits with no attribution, no push unless asked.

## Rules that still apply
- Never `git add -A`; name files. Commit and push only when the owner asks. Pushing to `main` deploys production.
- Never commit anything under `data/`, `inbox/`, `drive-upload/` or any `.env`.
- Patient data: case IDs only in chat and logs.
- Soft delete only: a "delete" moves files to `data/annotations_backup/` and marks the DB row deleted; nothing is removed for good.

## Where things are
- Briefs and contracts: `docs/handoff/briefs/`.
- Viewer: `client/nextjs/src/app/(dashboard)/annotate/Viewer.tsx` (large).
- Sync engine: `client/nextjs/src/lib/annotation-sync.ts`; decision rules: `server/db/src/services/annotation-sync-plan.ts`.
- Case list: `client/nextjs/src/app/(dashboard)/annotate/page.tsx`; API: `client/nextjs/src/app/api/cases/route.ts`.
- Owners: `server/db/src/services/case-owner.ts`.
- Deploy: `pnpm build:prod`, `pnpm start:prod`, `pnpm vercel:secrets`, `pnpm vercel:deploy`.
