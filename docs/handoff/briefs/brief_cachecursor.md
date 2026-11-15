# Fix: coronal and sagittal do not open at the middle slice when a scan comes from the browser cache

File: `client/nextjs/src/app/(dashboard)/annotate/Viewer.tsx` (large file, make a local change only).

Bug: in the review-mode load effect, the IndexedDB cache branch (search for `const cached = await getCachedVolume(cacheKey);`) decompresses the cached scan, builds `dims`, `data`, `lo`, `hi`, `axes`, `orient`, then calls `setScanComplete(true)` and `setSlicesDone(dims[2])`. It never sets the cursor. So on a cached open the coronal and sagittal views keep the cursor left over from the previous case or the initial state, not the middle.

The streamed (non-cached) branch already does this correctly at completion (search for `// The other two planes open at their MIDDLE slice`). Do not change that branch.

Fix: inside the cache branch, immediately after `setSlicesDone(dims[2]);` add:

    setCursor({ i: Math.floor(dims[0] / 2), j: Math.floor(dims[1] / 2), k: 0 });

so a cached open matches the streamed open: coronal and sagittal at the middle, axial at its first slice (k = 0).

Rules:
- Edit only that one place in `Viewer.tsx`. Change nothing else.
- Use your own file tools. The only shell command allowed is `pnpm --filter nextjs exec tsc --noEmit`, run once at the end. No background tasks, no sub-agents.
- Do not read `.env` or anything under `data/`. No emoji. Do not stage or commit. Do not push.
- Report in 2 lines: the exact line changed, and the typecheck result.
