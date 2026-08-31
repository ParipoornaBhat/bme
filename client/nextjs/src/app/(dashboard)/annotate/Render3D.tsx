"use client";

import { useEffect, useRef, useState } from "react";
import { Box, Loader2 } from "lucide-react";

/**
 * The 3D quadrant of the Four-Up layout: a live surface of what has been
 * painted, rebuilt on demand from the shared label volume.
 *
 * WHY IT IS BUILT ON REQUEST RATHER THAN LIVE
 * Marching cubes over a 432x432x33 volume is not something to run on every
 * brush stroke — it would make painting stutter for a view you glance at
 * occasionally. Slicer makes the same call: "Show 3D" is a button, not a
 * default. Paint freely, press Build when you want to check the shape.
 *
 * WHY IT MATTERS FOR THE WORK ITSELF
 * A lesion painted slice by slice can look right in every axial view and still
 * be a jagged staircase in 3D, because errors accumulate perpendicular to the
 * plane you are working in and are invisible from it. Seeing the surface is how
 * you catch that before saving.
 *
 * No three.js: a few thousand triangles painter-sorted onto a 2D canvas is
 * enough here, and it keeps the bundle small.
 */

type Tri = { z: number; pts: [number, number][]; shade: number };

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
  const [tris, setTris] = useState<[number, number, number][][] | null>(null);
  const [building, setBuilding] = useState(false);
  const [yaw, setYaw] = useState(0.6);
  const [pitch, setPitch] = useState(-0.35);
  const drag = useRef<{ x: number; y: number } | null>(null);

  /**
   * Surface extraction, deliberately simple: emit a quad for every face where a
   * labelled voxel meets an unlabelled one. That is a blocky isosurface rather
   * than marching cubes, but it is exact about *where* the boundary is, which
   * is what matters when you are checking for staircase artefacts — a smoothed
   * surface would hide the very thing you are looking for.
   *
   * Downsampled so a big volume stays interactive.
   */
  const build = () => {
    if (!labels) return;
    setBuilding(true);
    setTimeout(() => {
      const [nx, ny, nz] = dims;
      const step = Math.max(1, Math.round(Math.cbrt((nx * ny * nz) / 220_000)));
      const at = (i: number, j: number, k: number) =>
        i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz
          ? 0 : labels[i + nx * (j + ny * k)];

      const out: [number, number, number][][] = [];
      const [sx, sy, sz] = spacing;
      for (let k = 0; k < nz; k += step) {
        for (let j = 0; j < ny; j += step) {
          for (let i = 0; i < nx; i += step) {
            if (at(i, j, k) !== segValue) continue;
            const x = i * sx, y = j * sy, z = k * sz;
            const dx = step * sx, dy = step * sy, dz = step * sz;
            const faces: Array<[[number, number, number][], boolean]> = [
              [[[x, y, z], [x + dx, y, z], [x + dx, y + dy, z], [x, y + dy, z]], at(i, j, k - step) !== segValue],
              [[[x, y, z + dz], [x + dx, y, z + dz], [x + dx, y + dy, z + dz], [x, y + dy, z + dz]], at(i, j, k + step) !== segValue],
              [[[x, y, z], [x, y + dy, z], [x, y + dy, z + dz], [x, y, z + dz]], at(i - step, j, k) !== segValue],
              [[[x + dx, y, z], [x + dx, y + dy, z], [x + dx, y + dy, z + dz], [x + dx, y, z + dz]], at(i + step, j, k) !== segValue],
              [[[x, y, z], [x + dx, y, z], [x + dx, y, z + dz], [x, y, z + dz]], at(i, j - step, k) !== segValue],
              [[[x, y + dy, z], [x + dx, y + dy, z], [x + dx, y + dy, z + dz], [x, y + dy, z + dz]], at(i, j + step, k) !== segValue],
            ];
            for (const [quad, exposed] of faces) if (exposed) out.push(quad);
          }
        }
      }
      setTris(out);
      setBuilding(false);
    }, 10);
  };

  // Redraw on rotation or after a rebuild.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const W = cv.width, H = cv.height;
    ctx.fillStyle = "#05080b";
    ctx.fillRect(0, 0, W, H);

    if (!tris || tris.length === 0) return;

    // Centre on the painted region, not the volume — a small lesion in a large
    // scan would otherwise be a speck in the corner.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const q of tris) for (const [x, y, z] of q) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
    const scale = (Math.min(W, H) * 0.72) / extent;

    const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
    const project = ([x, y, z]: [number, number, number]) => {
      const dx = x - cx, dy = y - cy, dz = z - cz;
      const rx = dx * cosY - dz * sinY;
      const rz = dx * sinY + dz * cosY;
      const ry = dy * cosP - rz * sinP;
      const depth = dy * sinP + rz * cosP;
      return { sx: W / 2 + rx * scale, sy: H / 2 + ry * scale, depth };
    };

    const drawn: Tri[] = [];
    for (const quad of tris) {
      const pr = quad.map(project);
      const depth = pr.reduce((s, p) => s + p.depth, 0) / pr.length;
      // Cheap facing term so the shape reads as solid rather than flat.
      const ux = pr[1].sx - pr[0].sx, uy = pr[1].sy - pr[0].sy;
      const vx = pr[2].sx - pr[0].sx, vy = pr[2].sy - pr[0].sy;
      const area = ux * vy - uy * vx;
      drawn.push({
        z: depth,
        pts: pr.map((p) => [p.sx, p.sy] as [number, number]),
        shade: Math.min(1, 0.42 + Math.abs(area) / 900),
      });
    }
    drawn.sort((a, b) => b.z - a.z); // painter's algorithm, far to near

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
  }, [tris, yaw, pitch, color]);

  const painted = labels ? labels.some((v) => v === segValue) : false;

  return (
    <div className="rounded-lg border-2 border-neutral-700 bg-black p-2">
      <div className="mb-1.5 flex items-center justify-between px-1 text-[11px] uppercase tracking-wider text-neutral-400">
        <span className="inline-flex items-center gap-1.5"><Box className="h-3 w-3" /> 3D</span>
        <button onClick={build} disabled={building || !painted}
          className="rounded border border-neutral-600 px-2 py-0.5 text-[10px] normal-case tracking-normal text-neutral-300 hover:bg-neutral-800 disabled:opacity-40">
          {building ? "Building…" : tris ? "Rebuild" : "Build"}
        </button>
      </div>

      <div className="relative">
        <canvas ref={canvasRef} width={420} height={420}
          className="w-full cursor-grab rounded active:cursor-grabbing"
          style={{ aspectRatio: "1 / 1" }}
          onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY }; }}
          onMouseMove={(e) => {
            if (!drag.current) return;
            setYaw((v) => v + (e.clientX - drag.current!.x) * 0.01);
            setPitch((v) => Math.max(-1.4, Math.min(1.4, v + (e.clientY - drag.current!.y) * 0.01)));
            drag.current = { x: e.clientX, y: e.clientY };
          }}
          onMouseUp={() => { drag.current = null; }}
          onMouseLeave={() => { drag.current = null; }}
        />
        {!tris && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-neutral-500">
            {building ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> building surface…
              </span>
            ) : painted
              ? "Press Build to see the painted region in 3D."
              : "Paint something first, then press Build."}
          </div>
        )}
      </div>

      <p className="mt-2 px-1 text-[10px] leading-tight text-neutral-500">
        {tris ? `${tris.length.toLocaleString()} faces · drag to rotate` : "Drag to rotate once built."}
        {" "}A blob that looks clean in axial can be a staircase from the side — this is where you see that.
      </p>
    </div>
  );
}
