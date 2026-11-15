# Rebuild the 3D view of the annotation: correct, anatomically oriented, smooth to rotate

File today: `client/nextjs/src/app/(dashboard)/annotate/Render3D.tsx` (374 lines, a 2D-canvas painter's-algorithm renderer). Keep its exported default component and its props EXACTLY as they are (`labels, dims, spacing, orient, segments, hidden, expanded, onToggleExpand, fill`, plus any others it has), so `Viewer.tsx` does not need to change. Labels: `labels[i + nx*(j + ny*k)]`, values 1 bone marrow, 2 edema (bme), 3 uncertain; `segments` gives each value's label and colour. `spacing` is mm per voxel along i, j, k. `orient` gives, for array axes i, j, k, the anatomical letter at index 0 and at the max end (`{ atZero, atMax }`, letters R L A P S I), derived from the scan affine.

## What is wrong today (all must be fixed)
1. It samples every `step`-th voxel with the SAME step on all three axes (step 4 on a 624 x 768 x 22 scan), so 16 of 22 slices are skipped, each used slice becomes a 4-slice slab, and a small edema lesion on 2 or 3 slices can vanish. 
2. It puts array axis j "up", so axial scans lie on their side (posterior up). The view must be anatomical: superior up.
3. Shading comes from projected face area, not lighting.
4. Depth sorting by quad average gives wrong occlusion (edema inside bone).
5. Voxel counts are sampled estimates (count * step^3).
6. Rotation redraws thousands of 2D paths on every mouse move, so it is not smooth.

## Build this instead (NO new npm dependencies; WebGL is built into the browser)
1. Mesh extraction in a Web Worker: `client/nextjs/src/app/(dashboard)/annotate/mesh3d.worker.ts`, created with `new Worker(new URL("./mesh3d.worker.ts", import.meta.url))` (works with Next.js webpack). Post `{ labels (transfer a copy), dims, spacing, values, inPlaneStep }`; get back per value `{ positions: Float32Array, normals: Float32Array, indices: Uint32Array, voxelCount }` (transferables). Cancel or ignore stale results when a new build starts.
   - Use every slice along the slice axis (the axis with the largest spacing). Downsample only the two in-plane axes, with `inPlaneStep = max(1, ceil(sqrt((ni*nj) / 160000)))`; a coarse cell counts as inside if ANY of its voxels has the value (so small lesions never vanish).
   - Surface: Surface Nets (or marching cubes) on the binary mask of each value, vertices in millimetres (`index * spacing`, voxel centres), then 0 to N iterations of Laplacian / Taubin smoothing (N from a "Smooth" setting: Off = 0, On = 6; default On), then per-vertex normals.
   - `voxelCount` is the EXACT count at full resolution (count over the original labels, not the downsampled grid).
2. Rendering with raw WebGL (WebGL2 if available, else WebGL1 with `OES_element_index_uint`), in `client/nextjs/src/app/(dashboard)/annotate/gl3d.ts` (small helpers: shader compile, buffers, mat4 math; write the mat4 helpers yourself, no library):
   - Depth test on. Lambert + a little specular, one key light that follows the camera plus ambient, so shape reads clearly.
   - Draw opaque segments first (edema, uncertain) then bone marrow as semi-transparent (alpha 0.35, depth write off, back faces culled), so edema inside bone is always visible and occlusion is correct.
   - The volume bounding box as thin lines, and orientation letters (R L A P S I) at the six face centres, drawn as an HTML overlay positioned by projecting the points each frame.
   - Anatomical orientation: world space is RAS+ (+x toward the patient's Right, +y toward Anterior, +z toward Superior). Build a 4x4 matrix that maps each array axis to a world axis using `orient`: an axis whose `atMax` is R/L maps to x, A/P to y, S/I to z; the sign is + if `atMax` is R, A or S and - if it is L, P or I. Scale by spacing. Camera up vector = +z (superior). Default view: from the front (camera on +y looking toward -y), which shows the patient's right on the screen's left, as in 3D Slicer. Verify with the letters: S must appear at the top in the default view.
3. Interaction (smooth):
   - Left-drag orbits (trackball/orbit around the model centre) with damping/inertia, rendered with `requestAnimationFrame` only while moving (no continuous render loop when idle).
   - Wheel or pinch zooms toward the centre (clamped), right-drag or Shift+drag pans, double-click resets the view.
   - Buttons: view presets A, P, L, R, S, I (animate to the preset over about 250 ms), Fit (frame the visible segments), Reset (whole volume framed, as now: framing the whole volume keeps a small lesion looking small), Smooth on/off, per-segment show/hide (keep the existing toggles and the `hidden` prop behaviour).
   - Keep the existing Build button and its behaviour (build on demand; show "Building..." while the worker runs). Keep `expanded` / `onToggleExpand` / `fill` behaviour.
4. Numbers under the view, per segment: exact voxel count and volume, formatted like `Bone marrow: 494,787 voxels, 12.43 ml (12.43 cm3)` (volume = voxelCount * spacing[0]*spacing[1]*spacing[2] / 1000 ml; 1 ml = 1 cm3; write "cm3" as `cm³`). Two decimals; below 0.1 ml show three.
5. Resize correctly with the panel (ResizeObserver, devicePixelRatio-aware canvas size). Release GL resources and terminate the worker on unmount. If WebGL is unavailable, show "3D view needs WebGL" and keep the numbers.

## Rules
- Edit only `Render3D.tsx` and the two new files `mesh3d.worker.ts` and `gl3d.ts` in the same folder. Do not edit `Viewer.tsx`.
- No new npm dependencies (three.js etc. are not allowed). No emoji.
- Use your own file tools for all reading and writing. The only shell command allowed is `pnpm --filter nextjs exec tsc --noEmit`, once at the end; fix errors in your files. No background tasks, no sub-agents.
- Do not read `.env` or anything under `data/`. Do not stage or commit. If you commit, use a single-line Conventional Commits message `type(scope): summary` with type one of feat, fix, refactor, perf, docs, style, test, build, ci, chore. No body and no trailers. Never add a Co-Authored-By line or any AI or Antigravity attribution. Do not push.
- Write the worker first, then gl3d.ts, then Render3D.tsx. Report in 8 lines: files, mesh method and step rule, orientation rule used, interaction, typecheck result.
