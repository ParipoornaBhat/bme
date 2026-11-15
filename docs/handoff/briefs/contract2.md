# Contract 2: review supersede, soft delete, owners, activity log (all workers code against this)

Repo: pnpm workspace. `client/nextjs` (Next.js, alias `~/` = `client/nextjs/src/`), `server/db` (package `@bme/db`, Drizzle + Postgres, everything exported from `server/db/src/index.ts`), `ml/` Python (`ml/.venv`). Two app modes: `local` (each teammate's laptop, has `data/` and Python) and `review` (hosted, `isReviewMode()` from `~/lib/app-mode`). Read these first for the current state: `server/db/src/schema/bme.ts` (tables `case_annotation`, `review_scan`, `review_account`, `review_edit`), `server/db/src/services/annotation-sync-plan.ts` (`decide()`), `client/nextjs/src/lib/annotation-sync.ts` (sync engine), `client/nextjs/src/app/api/annotation/[caseId]/route.ts`, `.../labels/route.ts`, `client/nextjs/src/app/api/cases/route.ts`, `client/nextjs/src/app/api/review-inbox/route.ts`, `server/db/src/scripts/review-setup.ts`, `server/db/src/services/review-accounts.ts`.

Files: `data/annotations/<CASE>/<CASE>.seg.nrrd` is the MAIN file (training reads only this). `<CASE>__<annotator>.seg.nrrd` is one person's copy. DB key for the main file is annotator `_main`. Case IDs `^(BME|NBME)-\d{3}$`, annotator names `^[A-Za-z0-9_-]{1,40}$`.

## The one rule above all: no annotation is ever lost
- Never DELETE a row from `case_annotation`, `review_edit` or any version/log table. "Delete" always means a soft delete (tombstone) in the DB.
- On a laptop, "remove" always means MOVE the file to `data/annotations_backup/<YYYYMMDD-HHMMSS>-<reason>/<CASE>/<file>`, never `unlink`. Print what moves where.
- Every change below is logged in `annotation_event`.

## Database additions (migration `0005_supersede_owner_log.sql`, ADD only)
1. `case_annotation` new nullable columns: `deleted_at timestamp`, `deleted_by varchar(64)`, `deleted_reason varchar(32)` (`superseded` | `manual`), `superseded_by varchar(64)` (the annotator whose work replaced it).
2. `review_account` new column `role` values become `radiologist` | `reviewer` | `team` (column exists; no type change, only new allowed value). `REVIEW_ACCOUNTS` entries `Name:Password:role` accept `radiologist`.
   - `radiologist`: a submitted edit automatically replaces the case's annotation (see Supersede).
   - `reviewer`: a submitted edit is only flagged; the owner decides in the Activities page.
   - `team`: unchanged (their own annotation).
3. `review_edit_version`: `id uuid pk default random`, `review_edit_id uuid not null` (references review_edit.id), `labels_gz_b64 text not null`, `note text`, `saved_at timestamp default now not null`. Every reviewer/team save on the hosted site appends one row here, so no intermediate save is lost (the `review_edit` row keeps the latest).
4. `review_edit` new columns: `applied_by varchar(64)`, `claim_token varchar(64)` (for the atomic claim below).
5. `case_owner`: `case_id varchar(32) pk`, `annotated_by varchar(64)` (null = not set), `source varchar(16) not null` (`team-ranges` | `manual`), `set_by varchar(64)`, `set_at timestamp default now not null`. This is the ONLY source of "Annotated by" shown anywhere. Sync and saves never write it.
   Seed (in `pnpm review:setup`, insert-if-missing only, never overwrite an existing row): case number n (from BME-n and NBME-n) -> 1-15 `Paripoorna`, 16-30 `Elvin`, 31-45 `Aditi`, 46-61 `Reegan` (NBME has only up to 60). Every other existing case (BME-062 to BME-085 today) gets a row with `annotated_by = null`. Keep the ranges in one TS constant `server/db/src/services/case-owner.ts` with a comment that they mirror `TEAM` in `ml/scripts/team_annotations.py` and `NBME_TEAM` in `ml/scripts/export_nbme.py`.
6. `annotation_event` (append-only log): `id uuid pk default random`, `at timestamp default now not null`, `case_id varchar(32) not null`, `annotator varchar(64)`, `actor varchar(64)` (who did it: laptop user, reviewer, or `sync`), `action varchar(32) not null`, `sha256 varchar(64)`, `details jsonb`. Index on (`case_id`, `at`) and on `at`.
   Actions: `save` (local editor save), `push`, `pull`, `review-submit`, `team-submit`, `supersede`, `review-apply`, `review-dismiss`, `retire-local` (a laptop moved a tombstoned file to backup), `delete` (manual soft delete), `restore`, `set-main`, `owner-set`.

## Supersede (radiologist edits replace the annotation, automatically, nothing lost)
Hosted save by a `radiologist` on case C, starting from annotation B (`?base=`, default `_main`):
1. Upsert the open `review_edit` (kind `review`) + append `review_edit_version` + event `review-submit`.
2. In the same DB transaction, tombstone the base: set `deleted_at=now, deleted_by=<radiologist safe name>, deleted_reason='superseded', superseded_by=<radiologist safe name>` on `case_annotation` rows (C, B) and (C, `_main`) when they are not already tombstoned. Event `supersede` with details `{ base: B }`. Content stays in the rows.
A `reviewer` save does steps 1 only (no tombstone). A `team` save is unchanged (kind `team`).

## Local sync additions (`client/nextjs/src/lib/annotation-sync.ts` + `decide()`)
- Remote index now includes `deleted_at`, `deleted_reason`, `superseded_by`.
- `decide()` new first rule when the remote row is tombstoned:
  - local file exists and its sha equals the remote sha, or state.sha equals local sha -> `retire-local` (move the local file to backup with reason `superseded` or `deleted`, update state, event `retire-local`).
  - local file exists, differs, and was changed after the last sync (state.sha != local sha) -> `conflict` (never auto-move fresh work; reported).
  - no local file -> `none`. Tombstoned rows are never pulled and never pushed.
- Apply open review edits (any laptop, safely once): for each `review_edit` with `status='open'` and `kind='review'` whose author account is `radiologist`: atomically claim it (`UPDATE ... SET status='applying', claim_token=<random>, applied_by=me WHERE id=? AND status='open' RETURNING`); only the winner continues. Write `<CASE>__<radiologist>.seg.nrrd` through `ml/scripts/write_seg.py <base> <CASE> <raw> <radiologist> --main` (it backs up the old main), push both rows (`<radiologist>` and `_main`, clearing any tombstone on `_main` because it is new content), set `status='applied'`, `applied_at`, event `review-apply`. On any failure set `status` back to `open` and report it. `reviewer`-role edits are NOT auto-applied.
- Main-file fallback (step E) must not recreate a main file whose `_main` row is tombstoned unless a new non-tombstoned annotation replaced it; when it picks a copy, prefer the `case_owner.annotated_by` person's copy, then earliest `created_at`.
- Log events `push`, `pull`, `retire-local` for every applied action (batch insert at the end of the sync).

## Local routes (404 in review mode)
- `GET /api/activities/events?case=&person=&action=&limit=200&before=<iso>` -> `{ events: [...] }` newest first.
- `GET /api/activities/reviews` -> review edits with versions count, status, role of the author, base annotator (no labels).
- `GET /api/activities/deleted` -> tombstoned `case_annotation` rows (no content): case, annotator, deleted_at, deleted_by, reason, superseded_by.
- `POST /api/activities/delete` `{ caseId, annotator }` -> soft delete (tombstone, reason `manual`, actor = laptop user) + move the local file to backup + event `delete`. Refuses `_main` unless `{ force: true }`.
- `POST /api/activities/restore` `{ caseId, annotator }` -> clear the tombstone, write the DB content back to the local file (backing up anything in the way), event `restore`.
- `POST /api/activities/review` `{ id, action: "apply" | "dismiss", main?: boolean }` -> like the existing review-inbox route (keep that route working, it may call the same code).
- `POST /api/activities/owner` `{ caseId, annotatedBy }` -> set `case_owner` (source `manual`, set_by = laptop user), event `owner-set`. This is the only way to change "Annotated by".
- `GET /api/annotation/[caseId]/labels?by=<annotator>&deleted=1` (local) -> serves a tombstoned row's labels from the DB `labels_gz_b64` (gunzip, raw uint8) so a deleted annotation can be opened and compared. Without `deleted=1`, unchanged.
- `GET /api/annotation/[caseId]` (both modes) also returns `annotatedBy` (from `case_owner`, null if not set) and `deleted: [{ name, deletedAt, reason, supersededBy }]`; `annotators` excludes tombstoned names.
- `GET /api/cases` (both modes): each case's "annotated by" field comes from `case_owner` only (local mode reads the DB; if the DB is unreachable fall back to the ranges constant, never to file copies).

## Activities page (local only, `client/nextjs/src/app/(dashboard)/activities/`)
Sub-tabs at the top: Log | Reviews | Deleted | Owners.
- Log: table of `annotation_event` (time, case, person, action, actor), filters by case/person/action, "Load more".
- Reviews: open and past review edits; for open `reviewer`-role edits: Apply as main / Keep alongside / Dismiss buttons; shows versions count.
- Deleted: tombstoned annotations; per row: Open (navigates to `/annotate?case=<C>&by=<annotator>&deleted=1`), Compare (opens `/annotate?case=<C>&by=<annotator>&deleted=1&compare=<supersededBy>`), Restore (with confirm).
- Owners: list of cases with "Annotated by" and an edit control (writes via `/api/activities/owner`), highlighting cases with no owner.
- The dashboard nav shows "Activities" in local mode only. Review mode: the page and its routes return 404.

## Rules for every worker
- Patient data: never open, print or quote `.env`, `data/deid_map.csv`, any `name.json`, or files under `data/`, `inbox/`, `BME/`, `Non BME/`. Never write a patient name. Case IDs and team member names are fine.
- Do NOT connect to any database, run migrations, setup, sync, build or dev servers. The reviewer does that.
- Do not stage, commit, push, stash or change branches. If you commit, use a single-line Conventional Commits message `type(scope): summary` with type one of feat, fix, refactor, perf, docs, style, test, build, ci, chore. No body and no trailers. Never add a Co-Authored-By line or any AI or Antigravity attribution. Do not push.
- No new npm or pip dependencies. No emoji. Short plain UI text. Do not reformat unrelated code.
- Use your own file tools; never the shell to list or read. Only the shell commands in your brief are allowed; anything else ends your run. No background tasks, no sub-agents.
- Work fast: read only what you need, write early, check, then a short report (files, checks, anything you could not do).
