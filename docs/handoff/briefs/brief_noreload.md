# Switching annotation must not reload or blank the viewer

File: `client/nextjs/src/app/(dashboard)/annotate/Viewer.tsx` only (large file; small local change).

Bug: `handleAnnotatorChange` (search for `const handleAnnotatorChange`) calls `setBusy(true)` at its start and `setBusy(false)` in its `finally`. The render code (search for `if (busy) {`) returns a full-page spinner whenever `busy` is true, so the whole viewer, including all three slice canvases and the 3D panel, is unmounted and re-mounted for every annotation switch. The scan is already loaded; only the labels change.

Fix:
1. In `handleAnnotatorChange`, remove `setBusy(true)` and `setBusy(false)`. Instead use a new state `const [switching, setSwitching] = useState(false);`: set it true at the start and false in `finally`.
2. Show `switching` only as a small inline text in the existing status line (for example "Switching annotation..."), never as the full-page spinner. The status line already exists; use the same element that shows `status`.
3. While `switching` is true, disable the annotator dropdown and the painting tools (the same `disabled` pattern already used with `busy` on those buttons, but using `busy || switching`), so no edit lands on the old labels during the switch.
4. `reloadCaseAnnotation` (the auto-sync reload) must not set `busy` at all; check it does not, and if anything there does, switch it to the same `switching` state.
5. Do not change the scan loading path (`setBusy(true)` near the top of the case load effect and `setBusy(false)` after the scan is ready). The full-page spinner must still show while a NEW case's scan loads, and only then.
6. The canvases must stay mounted during a switch; make sure nothing else keys the viewer on the annotator.

Rules:
- Edit only `Viewer.tsx`.
- Use your own file tools for all reading and writing. The ONLY shell command allowed is `pnpm --filter nextjs exec tsc --noEmit`, run once at the end. Any other shell command ends your run. No background tasks, no sub-agents.
- Do not read `.env` or anything under `data/`. No emoji. Do not stage or commit. Do not push.
- Report in 3 lines: what changed (line numbers), and the typecheck result.
