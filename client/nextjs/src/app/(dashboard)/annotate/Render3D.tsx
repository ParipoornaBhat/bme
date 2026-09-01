"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Loader2, Maximize2 } from "lucide-react";

/**
 * The 3D quadrant, matching how 3D Slicer presents a segmentation.
 *
 * ALL SEGMENTS, NOT THE SELECTED ONE
 * An earlier version rendered only whichever segment was active in the toolbar,
 * so painting bone marrow and then switching to edema made the view go empty —
 * it looked broken when it was merely showing an empty layer. Every segment is
 * built, each can be hidden, and Slicer does the same.
 *
 * SCALE IS THE POINT
 * The camera frames the whole VOLUME and draws a wireframe of its bounds with
 * orientation letters, so a small lesion looks small. Framing on the segment's
 * own bounding box (the first attempt here) zoomed everything to fill the
 * canvas, making a 200 mm^3 speck and a 20,000 mm^3 region indistinguishable.
 * "Fit" is a button for when you do want a close look.
 *
 * Geometry is in millimetres via the voxel spacing, so proportions stay true on
 * ~10:1 anisotropic data instead of stretching along the slice axis.
 */

type P3 = [number, number, number];
type Quad = { z: number; pts: [number, number][]; shade: number; color: string };
type SegDef = { value: number; label: string; color: string };

export default function Render3D({
  labels, dims, spacing, segments,
}: {
  labels: Uint8Array | null;
  dims: [number, number, number];
  spacing: [number, number, number];
  segments: ReadonlyArray<SegDef>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [built, setBuilt] = useState<Array<{ value: number; quads: P3[][] }> | null>(null);
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [building, setBuilding] = useState(false);
  const [yaw, setYaw] = useState(0.7);
  const [pitch, setPitch] = useState(-0.32);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(false);
  const drag = useRef<{ x: number; y: number } | null>(null);

  const mm: P3 = [dims[0] * spacing[0], dims[1] * spacing[1], dims[2] * spacing[2]];

  const build = useCallback(() => {
    if (!labels) return;
    setBuilding(true);
    // Yield first so the button shows its loading state before the main thread
    // is occupied by the extraction loop.
    setTimeout(() => {
      const [nx, ny, nz] = dims;
      const [sx, sy, sz] = spacing;
      const step = Math.max(1, Math.round(Math.cbrt((nx * ny * nz) / 180_000)));
      const at = (i: number, j: number, k: number) =>
        i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz
          ? 0 : labels[i + nx * (j + ny * k)];

      const out: Array<{ value: number; quads: P3[][] }> = [];
      const voxels: Record<number, number> = {};

      for (const seg of segments) {
        const v = seg.value;
        const quads: P3[][] = [];
        let count = 0;
        for (let k = 0; k < nz; k += step) {
          for (let j = 0; j < ny; j += step) {
            for (let i = 0; i < nx; i += step) {
              if (at(i, j, k) !== v) continue;
              count++;
              const x = i * sx, y = j * sy, z = k * sz;
              const dx = step * sx, dy = step * sy, dz = step * sz;
              // Boundary faces only; interior ones are never visible.
              if (at(i, j, k - step) !== v)
                quads.push([[x, y, z], [x + dx, y, z], [x + dx, y + dy, z], [x, y + dy, z]]);
              if (at(i, j, k + step) !== v)
                quads.push([[x, y, z + dz], [x + dx, y, z + dz], [x + dx, y + dy, z + dz], [x, y + dy, z + dz]]);
              if (at(i - step, j, k) !== v)
                quads.push([[x, y, z], [x, y + dy, z], [x, y + dy, z + dz], [x, y, z + dz]]);
              if (at(i + step, j, k) !== v)
                quads.push([[x + dx, y, z], [x + dx, y + dy, z], [x + dx, y + dy, z + dz], [x + dx, y, z + dz]]);
              if (at(i, j - step, k) !== v)
                quads.push([[x, y, z], [x + dx, y, z], [x + dx, y, z + dz], [x, y, z + dz]]);
              if (at(i, j + step, k) !== v)
                quads.push([[x, y + dy, z], [x + dx, y + dy, z], [x + dx, y + dy, z + dz], [x, y + dy, z + dz]]);
            }
          }
        }
        voxels[v] = count * step * step * step;
        if (quads.length) out.push({ value: v, quads });
      }

      setCounts(voxels);
      setBuilt(out);
      setBuilding(false);
    }, 20);
  }, [labels, dims, spacing, segments]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const W = cv.width, H = cv.height;
    ctx.fillStyle = "#05080b";
    ctx.fillRect(0, 0, W, H);

    const visible = (built ?? []).filter((b) => !hidden.has(b.value));

    let cx = mm[0] / 2, cy = mm[1] / 2, cz = mm[2] / 2;
    let extent = Math.max(mm[0], mm[1], mm[2]);
    if (fit && visible.length) {
      let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
      let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
      for (const g of visible) for (const q of g.quads) for (const [x, y, z] of q) {
        if (x < mnX) mnX = x; if (x > mxX) mxX = x;
        if (y < mnY) mnY = y; if (y > mxY) mxY = y;
        if (z < mnZ) mnZ = z; if (z > mxZ) mxZ = z;
      }
      cx = (mnX + mxX) / 2; cy = (mnY + mxY) / 2; cz = (mnZ + mxZ) / 2;
      extent = Math.max(mxX - mnX, mxY - mnY, mxZ - mnZ, 1) * 1.7;
    }

    const scale = ((Math.min(W, H) * 0.78) / extent) * zoom;
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
    const project = ([x, y, z]: P3) => {
      const dx = x - cx, dy = y - cy, dz = z - cz;
      const rx = dx * cosY - dz * sinY;
      const rz = dx * sinY + dz * cosY;
      const ry = dy * cosP - rz * sinP;
      return { sx: W / 2 + rx * scale, sy: H / 2 + ry * scale, depth: dy * sinP + rz * cosP };
    };

    // volume bounds
    const corners = [
      [0, 0, 0], [mm[0], 0, 0], [mm[0], mm[1], 0], [0, mm[1], 0],
      [0, 0, mm[2]], [mm[0], 0, mm[2]], [mm[0], mm[1], mm[2]], [0, mm[1], mm[2]],
    ].map((p) => project(p as P3));
    ctx.save();
    ctx.strokeStyle = "#b455c8";
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4],
                          [0, 4], [1, 5], [2, 6], [3, 7]] as [number, number][]) {
      ctx.moveTo(corners[a].sx, corners[a].sy);
      ctx.lineTo(corners[b].sx, corners[b].sy);
    }
    ctx.stroke();
    ctx.restore();

    // orientation letters, as Slicer labels its 3D view
    ctx.save();
    ctx.fillStyle = "#c07dd4";
    ctx.globalAlpha = 0.85;
    ctx.font = "600 12px ui-sans-serif, system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const [pt, letter] of [
      [[mm[0] / 2, mm[1] / 2, mm[2]], "S"], [[mm[0] / 2, mm[1] / 2, 0], "I"],
      [[mm[0] / 2, 0, mm[2] / 2], "A"], [[mm[0] / 2, mm[1], mm[2] / 2], "P"],
      [[0, mm[1] / 2, mm[2] / 2], "R"], [[mm[0], mm[1] / 2, mm[2] / 2], "L"],
    ] as Array<[P3, string]>) {
      const q = project(pt);
      ctx.fillText(letter, q.sx, q.sy);
    }
    ctx.restore();

    if (!visible.length) return;

    // One depth-sorted pass across all segments, so a lesion inside bone is
    // occluded correctly rather than always drawn on top.
    const drawn: Quad[] = [];
    for (const group of visible) {
      const col = segments.find((s) => s.value === group.value)?.color ?? "#ffffff";
      for (const quad of group.quads) {
        const pr = quad.map(project);
        const ux = pr[1].sx - pr[0].sx, uy = pr[1].sy - pr[0].sy;
        const vx = pr[2].sx - pr[0].sx, vy = pr[2].sy - pr[0].sy;
        drawn.push({
          z: pr.reduce((s, p) => s + p.depth, 0) / pr.length,
          pts: pr.map((p) => [p.sx, p.sy] as [number, number]),
          shade: Math.min(1, 0.45 + Math.abs(ux * vy - uy * vx) / 700),
          color: col,
        });
      }
    }
    drawn.sort((a, b) => b.z - a.z);

    for (const t of drawn) {
      const r = parseInt(t.color.slice(1, 3), 16),
        g = parseInt(t.color.slice(3, 5), 16),
        b = parseInt(t.color.slice(5, 7), 16);
      ctx.beginPath();
      ctx.moveTo(t.pts[0][0], t.pts[0][1]);
      for (let i = 1; i < t.pts.length; i++) ctx.lineTo(t.pts[i][0], t.pts[i][1]);
      ctx.closePath();
      ctx.fillStyle = `rgb(${Math.round(r * t.shade)},${Math.round(g * t.shade)},${Math.round(b * t.shade)})`;
      ctx.fill();
    }
  }, [built, hidden, yaw, pitch, zoom, fit, mm, segments]);

  const voxel = spacing[0] * spacing[1] * spacing[2];
  const totalFaces = (built ?? []).reduce((n, g) => n + g.quads.length, 0);

  return (
    <div className="flex flex-col rounded-lg border-2 border-neutral-700 bg-black p-1.5"
      style={{ aspectRatio: "1 / 1" }}>
      <div className="mb-1 flex shrink-0 items-center justify-between gap-1 px-1 text-[10px] uppercase tracking-wider text-neutral-400">
        <span className="inline-flex items-center gap-1"><Box className="h-3 w-3" /> 3D</span>
        <span className="flex items-center gap-1">
          <button onClick={() => setFit((v) => !v)} disabled={!built}
            title={fit ? "Show at true size in the volume" : "Zoom to what is painted"}
            className={`inline-flex items-center gap-0.5 rounded border px-1 py-0.5 normal-case tracking-normal disabled:opacity-40 ${
              fit ? "border-primary text-primary" : "border-neutral-600 text-neutral-300 hover:bg-neutral-800"}`}>
            <Maximize2 className="h-2.5 w-2.5" /> Fit
          </button>
          <button onClick={build} disabled={building}
            className="rounded border border-neutral-600 px-1.5 py-0.5 normal-case tracking-normal text-neutral-300 hover:bg-neutral-800 disabled:opacity-40">
            {building ? "Building…" : built ? "Rebuild" : "Build"}
          </button>
        </span>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        <canvas ref={canvasRef} width={460} height={460}
          className="cursor-grab rounded active:cursor-grabbing"
          style={{ aspectRatio: "1 / 1", maxWidth: "100%", maxHeight: "100%" }}
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
        {!built && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-5 text-center text-[11px] text-neutral-500">
            {building
              ? <span className="inline-flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> building surface…</span>
              : "Press Build to see everything painted, in 3D."}
          </div>
        )}
      </div>

      <div className="mt-1 shrink-0 space-y-0.5 px-1 text-[9px] text-neutral-500">
        {built && built.length > 0 ? (
          <div className="flex flex-wrap gap-x-2.5 gap-y-0.5">
            {built.map((g) => {
              const def = segments.find((s) => s.value === g.value)!;
              const off = hidden.has(g.value);
              return (
                <button key={g.value}
                  onClick={() => setHidden((h) => {
                    const n = new Set(h);
                    if (n.has(g.value)) n.delete(g.value); else n.add(g.value);
                    return n;
                  })}
                  title={off ? "Show" : "Hide"}
                  className={`inline-flex items-center gap-1 ${off ? "opacity-35" : ""}`}>
                  <span className="h-2 w-2 rounded-sm" style={{ background: def.color }} />
                  <span className="tabular-nums">
                    {def.label}: {((counts[g.value] ?? 0) * voxel).toFixed(0)} mm&sup3;
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div>volume {mm.map((v) => v.toFixed(0)).join(" x ")} mm</div>
        )}
        <div className="flex justify-between">
          <span>{totalFaces ? `${totalFaces.toLocaleString()} faces` : ""}</span>
          <span>{fit ? "zoomed" : "true size"} &middot; drag / scroll</span>
        </div>
      </div>
    </div>
  );
}
