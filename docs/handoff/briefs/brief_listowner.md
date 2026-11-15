# Show "Annotated by" on every row of the case list (3D annotate page)

File: `client/nextjs/src/app/(dashboard)/annotate/page.tsx` (only this file).

The case list (the left column, each case row with its ID and red/green dot) used to show who annotated each case. It now shows annotated-by only in the toolbar, which is not enough: the list must show it for every case too.

Data: each case object from `/api/cases` already carries the owner. Check the `Case` type in `page.tsx` and the `/api/cases` route (`client/nextjs/src/app/api/cases/route.ts`) for the field name (`assignedTo` and/or `annotatedBy`). Use the same value the toolbar shows, which is `annotatedBy` from `case_owner` (fall back to `assignedTo`). If the list's `Case` type lacks the field, add it to the type and read it; do not change the API.

Show it on each row, in the same muted small style as the row's other secondary text:
- the first name only, for example "Paripoorna" (if the stored name has an underscore, show the part before it, so "Aditi_H_Nayak" shows "Aditi"; keep the full name in the tooltip);
- when no owner is set, show nothing (not "not set");
- keep the row layout intact: the text is truncated with an ellipsis, the row height does not change, and the list stays usable at narrow widths;
- the tooltip (`title`) is "Annotated by <full name>".

Rules:
- Edit only `page.tsx`.
- Use your own file tools. The only shell command allowed is `pnpm --filter nextjs exec tsc --noEmit`, run once at the end. No background tasks, no sub-agents.
- Do not read `.env` or anything under `data/`. No emoji. Do not stage or commit. Do not push.
- Report in 2 lines: which field you used, and the typecheck result.
