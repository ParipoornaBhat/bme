"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Loader2, Maximize2 } from "lucide-react";

/**
 * The 3D quadrant, matching how 3D Slicer presents a segmentation.
 *
 * SCALE IS THE POINT
 * The camera frames the whole VOLUME, not the painted region, and a wireframe
 * of the volume bounds is drawn around it with orientation letters. A small
 * lesion therefore looks small — which is the honest picture and the reason
 * this view is worth having. Framing on the segment's own bounding box (the
 * first attempt here) zoomed every lesion to fill the canvas, so a 200 mm^3
 * speck and a 20,000 mm^3 region looked identical.
 *
 * Everything is computed in millimetres using the volume's voxel spacing, so
 * proportions are anatomically true on our ~10:1 anisotropic data rather than
 * stretched along the slice axis.
 *
 * "Fit to segment" is available as a button, the way Slicer offers a zoom —
 * a deliberate action rather than the silent default.
 */

type Quad = { z: number; pts: [number, number][]; shade: number };
type P3 = [number, number, number];

export default function Render3D({
  labels, dims, spacing, segValue, color,
}: {
  labels: Uint8Array | null;
  dims: [number, number, number];
  spacing: [number, number, number];
  segValue: number;
  color: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [faces, setFaces] = useState<P3[][] | null>(null);
  const [building, setBuilding] = useState(false);
  const [yaw, setYaw] = useState(0.7);
  const [pitch, setPitch] = useState(-0.32);
  const [zoom, setZoom] = useState(1);
  const [fitSegment, setFitSegment] = useState(false);
  const [voxelCount, setVoxelCount] = useState(0);
  const drag = useRef<{ x: number; y: number } | null>(null);

  // Physical extent of the whole volume, in mm.
  const mm: P3 = [dims[0] * spacing[0], dims[1] * spacing[1], dims[2] * spacing[2]];

  const build = useCallback(() => {
    if (!labels) return;
    setBuilding(true);
    setTimeout(() => {
      const [nx, ny, nz] = dims;
      const [sx, sy, sz] = spacing;
      const step = Math.max(1, Math.round(Math.cbrt((nx * ny * nz) / 200_000)));
      const at = (i: number, j: number, k: number) =>
        i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz
          ? 0 : labels[i + nx * (j + ny * k)];

      let count = 0;
      const out: P3[][] = [];
      for (let k = 0; k < nz; k += step) {
        for (let j = 0; j < ny; j += step) {
          for (let i = 0; i < nx; i += step) {
            if (at(i, j, k) !== segValue) continue;
            count++;
            const x = i * sx, y = j * sy, z = k * sz;
            const dx = step * sx, dy = step * sy, dz = step * sz;
            // Only faces on the boundary — interior faces are never visible and
            // would multiply the triangle count for nothing.
            if (at(i, j, k - step) !== segValue)
              out.push([[x, y, z], [x + dx, y, z], [x + dx, y + dy, z], [x, y + dy, z]]);
            if (at(i, j, k + step) !== segValue)
              out.push([[x, y, z + dz], [x + dx, y, z + dz], [x + dx, y + dy, z + dz], [x, y + dy, z + dz]]);
            if (at(i - step, j, k) !== segValue)
              out.push([[x, y, z], [x, y + dy, z], [x, y + dy, z + dz], [x, y, z + dz]]);
            if (at(i + step, j, k) !== segValue)
              out.push([[x + dx, y, z], [x + dx, y + dy, z], [x + dx, y + dy, z + dz], [x + dx, y, z + dz]]);
            if (at(i, j - step, k) !== segValue)
              out.push([[x, y, z], [x + dx, y, z], [x + dx, y, z + dz], [x, y, z + dz]]);
            if (at(i, j + step, k) !== segValue)
              out.push([[x, y + dy, z], [x + dx, y + dy, z], [x + dx, y + dy, z + dz], [x, y + dy, z + dz]]);
          }
        }
      }
      setVoxelCount(count * step * step * step);
      setFaces(out);
      setBuilding(false);
    }, 10);
  }, [labels, dims, spacing, segValue]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const W = cv.width, H = cv.height;
    ctx.fillStyle = "#05080b";
    ctx.fillRect(0, 0, W, H);

    // Frame on the volume by default. Only zoom to the segment on request.
    let cx = mm[0] / 2, cy = mm[1] / 2, cz = mm[2] / 2;
    let extent = Math.max(mm[0], mm[1], mm[2]);
    if (fitSegment && faces && faces.length) {
      let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
      let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
      for (const q of faces) for (const [x, y, z] of q) {
        if (x < mnX) mnX = x; if (x > mxX) mxX = x;
        if (y < mnY) mnY = y; if (y > mxY) mxY = y;
        if (z < mnZ) mnZ = z; if (z > mxZ) mxZ = z;
      }
      cx = (mnX + mxX) / 2; cy = (mnY + mxY) / 2; cz = (mnZ + mxZ) / 2;
      extent = Math.max(mxX - mnX, mxY - mnY, mxZ - mnZ, 1) * 1.6;
    }

    const scale = ((Math.min(W, H) * 0.78) / extent) * zoom;
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch), sinP = Math.sin(pitch);

    const project = ([x, y, z]: P3) => {
      const dx = x - cx, dy = y - cy, dz = z - cz;
      const rx = dx * cosY - dz * sinY;
      const rz = dx * sinY + dz * cosY;
      const ry = dy * cosP - rz * sinP;
      const depth = dy * sinP + rz * cosP;
      return { sx: W / 2 + rx * scale, sy: H / 2 + ry * scale, depth };
    };

    // ---- volume bounding box, drawn first so the surface sits inside it ----
    const c = [
      [0, 0, 0], [mm[0], 0, 0], [mm[0], mm[1], 0], [0, mm[1], 0],
      [0, 0, mm[2]], [mm[0], 0, mm[2]], [mm[0], mm[1], mm[2]], [0, mm[1], mm[2]],
    ].map((p) => project(p as P3));
    const edges: [number, number][] = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    ctx.save();
    ctx.strokeStyle = "#b455c8";
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [a, b] of edges) { ctx.moveTo(c[a].sx, c[a].sy); ctx.lineTo(c[b].sx, c[b].sy); }
    ctx.stroke();
    ctx.restore();

    // Orientation letters at the face centres, as Slicer labels its 3D view.
    const marks: Array<[P3, string]> = [
      [[mm[0] / 2, mm[1] / 2, mm[2]], "S"],
      [[mm[0] / 2, mm[1] / 2, 0], "I"],
      [[mm[0] / 2, 0, mm[2] / 2], "A"],
      [[mm[0] / 2, mm[1], mm[2] / 2], "P"],
      [[0, mm[1] / 2, mm[2] / 2], "R"],
      [[mm[0], mm[1] / 2, mm[2] / 2], "L"],
    ];
    ctx.save();
    ctx.fillStyle = "#c07dd4";
    ctx.font = "600 13px ui-sans-serif, system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const [p, letter] of marks) {
      const q = project(p);
      ctx.globalAlpha = 0.85;
      ctx.fillText(letter, q.sx, q.sy);
    }
    ctx.restore();

    if (!faces || faces.length === 0) return;

    // ---- the painted surface ----
    const drawn: Quad[] = [];
    for (const quad of faces) {
      const pr = quad.map(project);
      const depth = pr.reduce((s, p) => s + p.depth, 0) / pr.length;
      const ux = pr[1].sx - pr[0].sx, uy = pr[1].sy - pr[0].sy;
      const vx = pr[2].sx - pr[0].sx, vy = pr[2].sy - pr[0].sy;
      const area = Math.abs(ux * vy - uy * vx);
      drawn.push({
        z: depth,
        pts: pr.map((p) => [p.sx, p.sy] as [number, number]),
        // Faces turned towards the camera project to a larger area, so area is
        // a serviceable stand-in for a lighting term.
        shade: Math.min(1, 0.45 + area / 700),
      });
    }
    drawn.sort((a, b) => b.z - a.z);

    const r = parseInt(color.slice(1, 3), 16),
      g = parseInt(color.slice(3, 5), 16),
      b = parseInt(color.slice(5, 7), 16);
    for (const t of drawn) {
      ctx.beginPath();
      ctx.moveTo(t.pts[0][0], t.pts[0][1]);
      for (let i = 1; i < t.pts.length; i++) ctx.lineTo(t.pts[i][0], t.pts[i][1]);
      ctx.closePath();
      ctx.fillStyle = `rgb(${Math.round(r * t.shade)},${Math.round(g * t.shade)},${Math.round(b * t.shade)})`;
      ctx.fill();
    }
  }, [faces, yaw, pitch, zoom, fitSegment, color, mm]);

  const painted = labels ? labels.some((v) => v === segValue) : false;
  const volMm3 = voxelCount * spacing[0] * spacing[1] * spacing[2];

  return (
    <div className="rounded-lg border-2 border-neutral-700 bg-black p-2">
      <div className="mb-1.5 flex items-center justify-between gap-2 px-1 text-[11px] uppercase tracking-wider text-neutral-400">
        <span className="inline-flex items-center gap-1.5"><Box className="h-3 w-3" /> 3D</span>
        <div className="flex items-center gap-1">
          <button onClick={() => setFitSegment((v) => !v)} disabled={!faces}
            title={fitSegment ? "Show at true size within the volume" : "Zoom to the segment"}
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] normal-case tracking-normal disabled:opacity-40 ${
              fitSegment ? "border-primary text-primary" : "border-neutral-600 text-neutral-300 hover:bg-neutral-800"
            }`}>
            <Maximize2 className="h-3 w-3" /> Fit
          </button>
          <button onClick={build} disabled={building || !painted}
            className="rounded border border-neutral-600 px-2 py-0.5 text-[10px] normal-case tracking-normal text-neutral-300 hover:bg-neutral-800 disabled:opacity-40">
            {building ? "Building…" : faces ? "Rebuild" : "Build"}
          </button>
        </div>
      </div>

      <div className="relative">
        <canvas ref={canvasRef} width={460} height={460}
          className="w-full cursor-grab rounded active:cursor-grabbing"
          style={{ aspectRatio: "1 / 1" }}
          onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY }; }}
          onMouseMove={(e) => {
            if (!drag.current) return;
            setYaw((v) => v + (e.clientX - drag.current!.x) * 0.01);
            setPitch((v) => Math.max(-1.45, Math.min(1.45, v + (e.clientY - drag.current!.y) * 0.01)));
            drag.current = { x: e.clientX, y: e.clientY };
          }}
          onMouseUp={() => { drag.current = null; }}
          onMouseLeave={() => { drag.current = null; }}
          onWheel={(e) => setZoom((z) => Math.max(0.4, Math.min(8, z * (e.deltaY > 0 ? 0.9 : 1.1))))}
        />
        {!faces && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-neutral-500">
            {building ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> building surface…
              </span>
            ) : painted ? "Press Build to see the painted region in 3D."
              : "Paint something first, then press Build."}
          </div>
        )}
      </div>

      <div className="mt-2 flex items-baseline justify-between gap-2 px-1 text-[10px] text-neutral-500">
        <span>
          {faces
            ? <>~{volMm3.toFixed(0)} mm&sup3; &middot; {faces.length.toLocaleString()} faces</>
            : <>volume {mm.map((v) => v.toFixed(0)).join(" x ")} mm</>}
        </span>
        <span>{fitSegment ? "zoomed to segment" : "true size in volume"} &middot; drag / scroll</span>
      </div>
    </div>
  );
}
