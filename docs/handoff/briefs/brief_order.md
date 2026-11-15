# Fix: the case list is not in order (BME-001 should be first)

File: `client/nextjs/src/app/api/cases/route.ts` (only this file).

Cause: both branches of the route build `const cases = ...map(...)` from unordered database rows (`scans` from `reviewScan` in the first branch, `worklist` in the second) and return them as they come. The database returns no guaranteed order, so the list appears random (for example NBME-059, NBME-060, BME-001, BME-007, BME-028).

Fix: right after each `const cases = ...` is built, and before the `NextResponse.json({ cases, ...})` return, sort `cases` in place with this order:
1. BME cases before NBME cases (use the case's class; the ID prefix "BME-" or "NBME-" works as the fallback);
2. within each group, by the numeric part of the ID ascending (BME-001 < BME-002 < ... < BME-085; NBME-001 < ... < NBME-060).

Write one small helper `compareCaseIds(a, b)` at the top of the file and use it in both places. Do not change any other field of the response.

Rules:
- Edit only `client/nextjs/src/app/api/cases/route.ts`.
- Use your own file tools. The only shell command allowed is `pnpm --filter nextjs exec tsc --noEmit`, run once at the end. No background tasks, no sub-agents.
- Do not read `.env` or anything under `data/`. No emoji. Do not stage or commit. Do not push.
- Report in 2 lines: where the sort was added, and the typecheck result.
