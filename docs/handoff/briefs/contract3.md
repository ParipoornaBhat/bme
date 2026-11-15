# Contract 3: per-case review status, lock, and "annotated by" with multiple annotators

Repo: pnpm workspace. `client/nextjs` (Next.js, alias `~/` = `client/nextjs/src/`, `isReviewMode()` from `~/lib/app-mode`, reviewer identity via `getReviewUser(req)` in `~/lib/review-auth` returning `{ username, displayName, role }` with role `radiologist` | `reviewer` | `team`), `server/db` (`@bme/db`, Drizzle; schema in `server/db/src/schema/bme.ts`; tables already include `case_annotation`, `review_edit`, `review_edit_version`, `case_owner`, `annotation_event`). Event logging helper: `logEvents(rows)` in `~/lib/annotation-events`.

## Status is PER CASE, one row per (case, reviewer). Multiple reviewers per case are normal.
New table `case_review` (migration `0006_case_review.sql`, ADD only): `id uuid pk default random`, `case_id varchar(32) not null`, `reviewer varchar(40) not null` (the reviewer's safe display name, same rule as annotator names), `role varchar(16) not null`, `status varchar(24) not null` (`reviewed` | `reviewed_with_edits`), `locked boolean not null default true`, `marked_at timestamp default now not null`, `updated_at timestamp default now not null`. Unique index on (`case_id`, `reviewer`). Unmarking sets `locked = false` and keeps the row (history stays in `annotation_event`); the status shown for an unlocked row is "In review".

Status text (short, exactly these):
- `reviewed` + locked -> "Reviewed by <name>"
- `reviewed_with_edits` + locked -> "Reviewed with edits by <name>"
- unlocked row, or no row but the reviewer has an open or applied `review_edit` on the case -> "In review by <name>"

"With edits" rule (ONLY when real changes exist): when a reviewer marks a case, take that reviewer's latest saved labels for the case (latest `review_edit` row of any status, gunzip `labels_gz_b64`) and the labels of the annotation they started from (`base_annotator`, default `_main`: the `case_annotation` row's `labels_gz_b64`, gunzipped, even if that row is now tombstoned). If the reviewer has no saved edit, or the two label arrays are byte-identical, status is `reviewed`; otherwise `reviewed_with_edits`. So unmarking and re-marking without changing anything never turns "Reviewed" into "with edits", and an edit that was later undone back to the original also counts as no change.
Saving with no change: on the hosted save, if the submitted labels are byte-identical to the base annotation's labels and the reviewer has no earlier edit for the case, do not create a `review_edit` (respond `{ ok: true, unchanged: true }`); the UI shows "No changes to save." In the UI, the Save / Submit button is disabled until something was actually painted or erased.

## Routes
- `POST /api/review/mark` (review mode; roles `radiologist` and `reviewer` only; `team` gets 403) body `{ caseId, action: "mark" | "unmark" }`:
  - mark: upsert the row with the computed status, `locked = true`; event `review-mark` with details `{ status }`.
  - unmark: set `locked = false`; event `review-unmark`. A reviewer can only mark/unmark their own row.
  - Response: `{ ok: true, review: { reviewer, status, locked, markedAt } }`.
- Hosted save (`POST /api/annotation/[caseId]` in review mode): if the current reviewer's row for this case is locked, refuse with 423 `{ error: "You marked this case as reviewed. Unmark it to edit." }`.
- `GET /api/annotation/[caseId]` (both modes) adds `reviews: [{ reviewer, role, status, locked, markedAt }]` (all reviewers of the case, sorted by `marked_at`), plus `myReview` (review mode only: the current user's row or null), plus `annotatedByAll: string[]` = the owner first (`case_owner.annotated_by`), then every other person with a non-tombstoned annotation copy, ordered by that copy's `created_at`, without duplicates and without `_main`.
- `GET /api/cases` (both modes) adds per case `reviewedBy: [{ reviewer, status, locked }]` (only rows that are locked, i.e. marked) so the case list can show badges. One query for all cases, not one per case.
- The local Activities routes are unchanged; `review-mark` / `review-unmark` events appear in its Log tab automatically.

## UI
- Toolbar on the 3D page, review mode, roles `radiologist` and `reviewer`: a "Mark as reviewed" button when not marked; when marked, a pressed "Reviewed" (or "Reviewed with edits") button with a small "Unmark" action. Confirmation is not needed for mark; unmark asks "Unmark this case so you can edit it?".
- Lock: when `myReview.locked` is true, painting tools (brush/pencil, eraser, fill, any tool that changes labels, and keyboard shortcuts for them) are disabled and show the tooltip "Marked as reviewed. Unmark to edit." Everything else keeps working: scrolling slices, zoom, pan, window/level, opacity, outline view, switching annotations in the dropdown, torch, 3D view.
- Annotator picker header: "Annotated by <first>" and, if more, "(also: A, B)"; under it one line per reviewer with the status text above.
- Case list (`page.tsx`): next to each case a small badge per marked reviewer: "R" with tooltip of the status text (or the reviewer's initial), green for `reviewed`, amber for `reviewed_with_edits`. Add a filter chip "reviewed" / "not reviewed" next to the existing filter chips.
- Local mode shows the same badges and picker lines (read-only, no mark button).

## Rules for every worker
- Patient data: never open, print or quote `.env`, `data/deid_map.csv`, any `name.json`, or files under `data/`, `inbox/`, `BME/`, `Non BME/`. Case IDs and team/reviewer names are fine.
- Do NOT connect to any database, run migrations, setup, sync, build or dev servers.
- Do not stage, commit, push, stash or change branches. If you commit, use a single-line Conventional Commits message `type(scope): summary` with type one of feat, fix, refactor, perf, docs, style, test, build, ci, chore. No body and no trailers. Never add a Co-Authored-By line or any AI or Antigravity attribution. Do not push.
- No new dependencies. No emoji. Do not reformat unrelated code. Do not restructure `Viewer.tsx`; small wired-in edits only.
- Use your own file tools for ALL reading, listing and writing. The only shell commands allowed are the ones in your brief; anything else ends your run. No background tasks, no sub-agents.
- Write your files within the first few minutes, then run your checks once, then a short report.
