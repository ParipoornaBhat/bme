# Shared contract: reviewer site + annotation dropdown (read fully; all workers code against this)

Repo: pnpm workspace. `client/nextjs` (Next.js app, package `nextjs`, path alias `~/` = `client/nextjs/src/`), `server/db` (package `@bme/db`, Drizzle + Postgres, exports everything from `server/db/src/index.ts`), `ml/` Python (venv `ml/.venv`). The online Postgres is reached by `DATABASE_URL`. Annotations already sync to table `case_annotation` (see `server/db/src/schema/bme.ts`, `client/nextjs/src/lib/annotation-sync.ts`). Annotation files: `data/annotations/<CASE>/<CASE>.seg.nrrd` (main) and `<CASE>__<annotator>.seg.nrrd` (one person's copy). Case IDs match `^(BME|NBME)-\d{3}$`; annotator names match `^[A-Za-z0-9_-]{1,40}$`; the main file's annotator key in the DB is `_main`.

## Two modes of the same Next.js app
- `local` (default, today's app, runs on each teammate's laptop with the data folder and Python).
- `review` (hosted on Vercel, no `data/` folder, no Python, no Hono API). Selected by env `APP_MODE=review` (server) and `NEXT_PUBLIC_APP_MODE=review` (client). Helper `client/nextjs/src/lib/app-mode.ts` exports `isReviewMode(): boolean` (server: `process.env.APP_MODE === "review"`; client: `process.env.NEXT_PUBLIC_APP_MODE === "review"`).
- Review mode exposes ONLY: `/login`, `/annotate` (3D viewer), `/api/review/*`, `/api/volume/[caseId]`, `/api/annotation/[caseId]` (GET, POST), `/api/annotation/[caseId]/labels` (GET), `/api/cases` (GET, list only), Next static assets. Everything else returns 404 in review mode (middleware).

## Database additions (migration `0004_review_site.sql`)
1. `case_annotation` gets column `labels_gz_b64 text` (nullable): the labelmap resampled onto the case's primary scan grid, one uint8 per voxel in the SAME order the web editor uses today (exactly the raw buffer `ml/scripts/read_seg.py` writes), gzip-compressed, then base64. Filled by the local sync on every push, and by a backfill for rows where it is null.
2. `review_scan`: `case_id varchar(32) pk`, `drive_file_id varchar(128) not null`, `updated_at timestamp default now not null`.
3. `review_account`: `id uuid pk default random`, `username varchar(40) not null unique` (stored lower-case), `display_name varchar(64) not null`, `password_hash text not null` (format `scrypt$<saltHex>$<hashHex>`, Node `crypto.scryptSync(password, salt, 64)`, 16-byte random salt), `created_at timestamp default now not null`.
4. `review_edit`: `id uuid pk default random`, `case_id varchar(32) not null`, `reviewer varchar(40) not null` (display name made safe with the annotator rule), `base_annotator varchar(64)` (which annotation they started from), `labels_gz_b64 text not null` (same encoding as above), `note text`, `status varchar(16) not null default 'open'` (`open` | `applied` | `dismissed`), `created_at timestamp default now not null`, `updated_at timestamp default now not null`, `applied_at timestamp`. Unique index on (`case_id`, `reviewer`) where `status = 'open'` (a reviewer has at most one open edit per case; saving again updates it).
Drizzle names: `caseAnnotation.labelsGzB64`, `reviewScan`, `reviewAccount`, `reviewEdit`.

## Roles on the hosted site
- `review_account` also has `role varchar(16) not null default 'reviewer'` (`reviewer` | `team`). `REVIEW_ACCOUNTS` entries are `Name:Password:role` (role optional, default `reviewer`).
- `review_edit` also has `kind varchar(16) not null default 'review'` (`review` for reviewers, `team` for team members).
- Both roles use the same 3D annotate page and the same save route. The difference:
  - `reviewer`: the save is a review suggestion, shown to the owner by `pnpm review:inbox`; the button reads "Submit review".
  - `team`: the save is that person's own annotation; the button reads "Save". It is stored as a `review_edit` with `kind = 'team'` and `reviewer` = their safe name. The local sync on that person's own laptop applies it automatically (see below), so it becomes `<CASE>__<name>.seg.nrrd` there and then syncs to everyone. Until then the hosted site shows it as theirs: `GET labels?by=_mine` returns the current user's open edit, and the dropdown lists it as "<name> (online, not yet synced)".
- `GET /api/review/me` also returns `role`.
- Local sync addition (in `client/nextjs/src/lib/annotation-sync.ts`): after the pulls, fetch open `review_edit` rows with `kind = 'team'` and `reviewer = me` (me = the laptop user's safe annotator name). For each: skip if the case scan is not on this laptop; otherwise decode, write `<CASE>__<me>.seg.nrrd` through `ml/scripts/write_seg.py` (normal save rule, so the main file follows the first-annotation rule), mark the edit `applied`, and let the normal push send it. Report count as `appliedOnline`. Never apply another person's team edit.

## Review-mode HTTP contract
- `POST /api/review/login` body `{ username, password }` -> 200 `{ ok: true, user: { username, displayName } }` + cookie `bme_review` (HttpOnly, Secure in production, SameSite=Lax, 12 h), or 401 `{ error: "Wrong username or password" }`. Username compared case-insensitively. Constant-time hash compare. 5 failed tries per IP per 10 minutes -> 429.
- `POST /api/review/logout` -> clears cookie.
- `GET /api/review/me` -> `{ user: { username, displayName } }` or 401.
- Cookie value: `<username>.<expiresMs>.<hmacHex>` signed with HMAC-SHA256 key `REVIEW_SESSION_SECRET` (env, required in review mode; refuse to start login without it). Helper `client/nextjs/src/lib/review-auth.ts` exports `getReviewUser(req): Promise<{ username, displayName } | null>` usable in route handlers and a light `verifyReviewCookie(value): { username } | null` usable in middleware (Edge-safe: Web Crypto only).
- `GET /api/cases` (review) -> same JSON shape as today's local route, built from `review_scan` + `case_annotation` (only the fields the 3D annotate page reads).
- `GET /api/volume/[caseId]?list=1` (review) -> only the primary series in the same shape as local. `GET /api/volume/[caseId]` (review) -> streams `https://drive.usercontent.google.com/download?id=<drive_file_id>&export=download&confirm=t` (follow redirects) as `application/gzip` with the same headers the local route sends; body streamed, never buffered; the Drive URL and file ID are never sent to the browser. Cache-Control private, max-age 3600.
- `GET /api/annotation/[caseId]` (review) -> `{ exists, savedAt, bytes, annotators: [{ name, savedAt, isMain }], review: { status, updatedAt } | null }` from `case_annotation` (+ the current reviewer's open `review_edit`). `annotators` sorted by `created_at` ascending, `_main` not listed as a person; `isMain` true for the person whose `sha256` equals `_main`'s.
- `GET /api/annotation/[caseId]/labels?by=<annotator>` (review) -> raw uint8 labelmap (gunzipped `labels_gz_b64`): `by=_review` gives the current reviewer's open edit; `by=<name>` that person; no `by` gives `_main`. 404 if missing or `labels_gz_b64` null.
- `POST /api/annotation/[caseId]` (review) -> body raw uint8 labelmap (like local), optional `?note=` and `?base=<annotator>`; gzip+base64 and upsert the reviewer's open `review_edit`. Response `{ ok: true, review: { status: "open", updatedAt } }`. Max body 40 MB. Never touches `case_annotation`.
- Local mode keeps every current behaviour of these routes.

## Local-mode additions
- `GET /api/annotation/[caseId]` (local) already returns `annotators` (from local files). The 3D page shows a dropdown "Annotation: <name> (first)" listing them; default is the main file (first annotation). Choosing another loads `/api/annotation/[caseId]/labels?by=<name>` read-only-by-default (painting then saving saves as the current user, as today).
- Auto sync in local mode: when the annotate page opens, then every 60 s while visible, and right after each save, the page calls `POST /api/annotation-sync?by=<me>` (fire and forget, at most one in flight). If the report's `changedCases` contains the open case and there are no unsaved edits, reload that case's annotation list and labels; if there ARE unsaved edits, show a small notice "New annotations from the team for this case. Save, then reload." Show a tiny status text: "Synced hh:mm", "Sync off (database unreachable)", or "Syncing...". The sync must never block painting or saving.
- Review inbox (local only): `pnpm review:inbox` lists open review edits (case, reviewer, date, note) from the online DB; `pnpm review:inbox apply <id> [--main]` downloads it, writes `<CASE>__<reviewer>.seg.nrrd` via `ml/scripts/write_seg.py` (with `--main` it also replaces the main file, after backing up to `data/annotations_backup/<stamp>-review/`), then marks the edit `applied`; `pnpm review:inbox dismiss <id>` marks it `dismissed`. Default is a dry listing; nothing changes without `apply`/`dismiss`.
- Setup (local, run once by the owner): `pnpm review:setup` reads `REVIEW_ACCOUNTS` from `.env` (format `Name:Password,Name2:Password2`), upserts `review_account` rows (never prints passwords), and loads `data/review_scan_ids.json` (`{ "<CASE>": "<driveFileId>" }`) into `review_scan` (upsert). Prints counts only.

## Commands (root package.json)
- `build:prod`: `cross-env APP_MODE=review NEXT_PUBLIC_APP_MODE=review pnpm --filter nextjs build` — if `cross-env` is not installed, implement with a tiny `scripts/run-review.js` that sets the env and spawns `pnpm --filter nextjs build|start` (no new dependency).
- `start:prod`: the same for `start`.
- `review:setup`: `pnpm --filter @bme/db review:setup`.
- `review:inbox`: `node scripts/review-inbox.js`.
- `data:cloud:backfill`: fills `labels_gz_b64` for this laptop's rows that lack it (via the running app or a direct script, see worker brief).

## Rules for every worker
- Patient data: never open, print or quote `.env`, `data/deid_map.csv`, any `name.json`, or files under `data/` except reading `data/review_scan_ids.json` keys/values is allowed only inside code (do not open it yourself). Never write a patient name. Case IDs are fine.
- Do NOT connect to any database and do NOT run migrations, setup, sync, build or dev servers. The reviewer applies and runs them.
- Do not stage, commit, push, stash or change branches. If you commit, use a single-line Conventional Commits message `type(scope): summary` with type one of feat, fix, refactor, perf, docs, style, test, build, ci, chore. No body and no trailers. Never add a Co-Authored-By line or any AI or Antigravity attribution. Do not push.
- No new npm or pip dependencies. No emoji. Short plain messages. Do not reformat unrelated code.
- Use your own file tools to read/write. Never use the shell to list or read. Only the shell commands in your brief are allowed; anything else ends your run. No background tasks, no sub-agents.
- Work fast: read only what you need, write your files early, then check, then a 10-line report (files changed, checks, anything you could not do).
