# Fix: slice images are stretched when the panel is short

File: `client/nextjs/src/app/(dashboard)/annotate/Viewer.tsx` (large; make a small, local change). In the three slice panels each `<canvas>` (search for `aspectRatio: \`${g.mmW} / ${g.mmH}\``) is styled with `width: ${g.w}px`, `aspectRatio: mmW / mmH`, `maxWidth: "100%"`, `maxHeight: "100%"`. When the panel is shorter than the image needs, the browser clamps the height with max-height but keeps the width, so the aspect ratio is lost and the image is drawn flattened (for example a 624 x 768 axial slice shown about 3 times wider than tall). The same happens in the other direction for wide-short panels.

## Required behaviour
The image must ALWAYS fit entirely inside its panel and keep its true physical proportions (`g.mmW : g.mmH`), whatever the panel's width and height, at zoom 1.0. It should be as large as fits (contain), centred. Zoom and pan (the wrapper's CSS transform) keep working on top of that exactly as now.

## How
- Measure each plane's available tile box (the element that is the canvas's positioning parent: the `div` with `relative flex h-full w-full items-center justify-center`, or its parent if that one is transformed) with a `ResizeObserver` (one observer, three targets, stored in state as `{ w, h }` per plane; clean up on unmount; guard for zero sizes).
- Compute `scale = Math.min(boxW / g.mmW, boxH / g.mmH)` and set explicit `width` and `height` in px on the canvas style (`g.mmW * scale`, `g.mmH * scale`), rounded down. Remove `aspectRatio`, `maxWidth`, `maxHeight` from that style. Until the first measurement arrives, fall back to the current style so nothing flashes at zero size.
- Do not change the canvas bitmap size (`canvas.width/height`), the drawing code, or any pointer-to-voxel mapping: those already use the element's bounding rect, so they must keep working with the new CSS size. After the change, check every place that converts pointer coordinates to voxels (search `getBoundingClientRect`) still divides by the rect's width/height and not by `g.w`; if any uses `g.w` or assumes one CSS pixel per voxel, fix it to use the rect.
- The same fix applies to any overlay canvas or SVG stacked on the slice canvas (selection box, cursors): they must share the fitted size.
- If the 2D painter (`Painter2D.tsx`) has the same styling bug, do NOT touch it; report it.

## Rules
- Edit only `client/nextjs/src/app/(dashboard)/annotate/Viewer.tsx`.
- Use your own file tools for all reading and writing. The only shell command allowed is `pnpm --filter nextjs exec tsc --noEmit`, once at the end. No background tasks, no sub-agents.
- Do not read `.env` or anything under `data/`. No emoji. Do not stage or commit. If you commit, use a single-line Conventional Commits message `type(scope): summary` with type one of feat, fix, refactor, perf, docs, style, test, build, ci, chore. No body and no trailers. Never add a Co-Authored-By line or any AI or Antigravity attribution. Do not push.
- Report in 5 lines: what you measure, the size formula, pointer-mapping check result, typecheck result.
