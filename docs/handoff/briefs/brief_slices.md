# Show "marked slices" per person in the annotation dropdown (local mode)

Goal: in the Annotation dropdown on the 3D annotate page, each person's entry shows how many slices of the axial plane they marked, as "marked/total", for example "Aditi 30/39". The entry for the main file is labelled with the person it duplicates when they are identical.

## 1. New helper `ml/scripts/annotation_slices.py`
Usage: `python ml/scripts/annotation_slices.py <base> <CASE>`. Prints ONE JSON object on stdout and nothing else:
`{ "<file name>": { "marked": int, "total": int, "identical_to": "<file name or null>" } }` for every `<CASE>*.seg.nrrd` in `data/annotations/<CASE>/`.
- Read with `nrrd.read` (the `nrrd` package is already used by `ml/scripts/write_seg.py`; import the same way).
- Slice axis = the axis of the header's `space directions` with the largest length. `marked` = number of slices along that axis with any non-zero label; `total` = size along that axis.
- `identical_to`: name of another file in the same case with an identical array (same shape and `np.array_equal`), if any; choose the person's copy over the main file when both match; null otherwise.
- Cache in `data/.cache/slices.json`, keyed by file name with `size` and `mtime` (write atomically with a temp file and rename). Unreadable file: `{ "marked": null, "total": null, "error": "<short reason>" }`, never crash the whole call.
- Exit 0 always; print the JSON only.

## 2. Route `client/nextjs/src/app/api/annotation/[caseId]/route.ts` (GET, local mode only; review mode unchanged)
Run the helper with `execFile` (python from the repo's `ml/.venv` on Windows, same pattern as the existing calls in this route; timeout 15 s). Add to each entry of `annotators` a field `slices: { marked, total } | null` (null if the helper failed or the file is missing), and add `identicalTo: string | null` (the annotator name the file is identical to, from the helper). If the helper fails, return the annotators without these fields; never fail the request.

## 3. Dropdown: `client/nextjs/src/app/(dashboard)/annotate/AnnotatorPicker.tsx`
- Each option shows a second, muted column on the right: `marked/total` (for example `30/39`), with the tooltip "Axial slices with paint". If `slices` is null, show nothing.
- For the main-file entry (`isMain`): if `identicalTo` is set, label it "<name> (main)" and show a muted "same as <name>'s copy" line under the dropdown. Do not hide anything.
- If a person's `marked` is less than `total`, show the column in amber (partly annotated) instead of the normal muted text, so partial annotations stand out. Full (equal) shows normal.

## Rules
- Edit only: `ml/scripts/annotation_slices.py` (new), `client/nextjs/src/app/api/annotation/[caseId]/route.ts`, `client/nextjs/src/app/(dashboard)/annotate/AnnotatorPicker.tsx`.
- Do not change `Viewer.tsx`, the deletion behaviour, or any sync code.
- Do not read `.env` or anything under `data/` except through the helper (do not open files there yourself). No patient data in code or output. No emoji.
- Use your own file tools. Shell commands allowed: `ml\.venv\Scripts\python.exe -m py_compile ml/scripts/annotation_slices.py`, `pnpm --filter nextjs exec tsc --noEmit` (once at the end). Any other shell command ends your run. No background tasks, no sub-agents.
- Do not stage or commit. Do not push.
- Report in 4 lines: files, helper output shape, typecheck result, and anything you could not do.
