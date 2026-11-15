# Show "marked slices" per person in the annotation dropdown (local mode)

Read `brief_slices.md` in this same folder first and do exactly what it says. The ONLY differences for this run:
- You MUST create `ml/scripts/annotation_slices.py` (it does not exist yet; the last attempt wrote nothing).
- Your ONLY shell commands are `ml\.venv\Scripts\python.exe -m py_compile ml/scripts/annotation_slices.py` (once, after you write the helper) and `pnpm --filter nextjs exec tsc --noEmit` (once, at the end). Do NOT run the helper, do NOT run python on any data, do NOT run any other command. Any other command ends your run and nothing gets written, which is what happened last time.
- Write `ml/scripts/annotation_slices.py` FIRST, then the route change, then `AnnotatorPicker.tsx`, then the two checks.
