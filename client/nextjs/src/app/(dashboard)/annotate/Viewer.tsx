"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, Lasso, Link2, Link2Off, Loader2, Minus, Paintbrush, Plus, Redo2, RotateCcw, Save } from "lucide-react";
import { useSession } from "~/lib/auth-client";
import Render3D from "./Render3D";

/**
 * Three-plane viewer with painting, modelled on 3D Slicer's Four-Up layout.
 *
 * CROSSHAIR MODEL
 * One voxel position drives all three views — exactly as Slicer does it. Click
 * anywhere in any view and the other two jump to that location, so you are
 * always looking at the same point in the body from three directions. Without
 * this, three independent sliders show three unrelated places and checking a
 * lesion across planes is guesswork.
 *
 * ONE SHARED LABEL VOLUME
 * Painting writes into a single 3D array, so a stroke in the axial view is
 * immediately visible in coronal and sagittal. That only actually appears on
 * screen if every plane is redrawn after a stroke — redrawing just the active
 * one (the earlier bug here) makes the others look stale and the labels look
 * lost.
 *
 * INDEXING
 * Volume and labels are flat typed arrays in i,j,k order with i fastest — the
 * same order NIfTI stores and write_seg.py reshapes with (numpy order="F").
 * If those ever diverge, annotations land in the wrong voxels silently, so the
 * indexing helper below is the single place it is expressed.
 */

export const SEGMENTS = [
  { value: 1, name: "bone_marrow", label: "Bone marrow", color: "#3ddc84" },
  { value: 2, name: "bme", label: "Edema (BME)", color: "#f24c38" },
  { value: 3, name: "uncertain", label: "Uncertain", color: "#8c8c99" },
] as const;

type Plane = "axial" | "coronal" | "sagittal";
const PLANES: Plane[] = ["axial", "coronal", "sagittal"];

// Slicer's slice-view colours. Familiar to anyone who has used it, and they
// make "which view am I in" answerable at a glance.
const PLANE_COLOR: Record<Plane, string> = {
  axial: "#f04b4b",
  coronal: "#4bc46b",
  sagittal: "#e8c93a",
};

type Vol = {
  data: Float32Array;
  dims: [number, number, number];
  /** mm per voxel along i, j, k. Needed because our voxels are ~10:1 anisotropic. */
  spacing: [number, number, number];
  /** Which array axis each anatomical plane slices along, and how to lay it out. */
  axes: Record<Plane, PlaneAxes>;
  lo: number; hi: number;
};

/**
 * How one anatomical plane maps onto the array.
 *
 * `slice` is the array axis stepped through; `h` and `v` are the two in-plane
 * axes. Flips put superior/anterior at the top of the image.
 */
type PlaneAxes = { slice: 0 | 1 | 2; h: 0 | 1 | 2; v: 0 | 1 | 2; flipH: boolean; flipV: boolean };

/**
 * Work out which array axis corresponds to which anatomical direction.
 *
 * Array axis order is NOT fixed: it follows how the scan was acquired. An
 * axially-acquired volume has k running inferior-superior, but a sagittal
 * acquisition has k running left-right and a coronal one has k running
 * posterior-anterior. Assuming "k is always axial" mislabels every
 * non-axial acquisition — which is why some cases looked correct and others
 * had their three views rotated.
 *
 * The affine's columns give each array axis a direction in world space
 * (x = L-R, y = P-A, z = I-S); the dominant component tells us which one.
 */
function deriveAxes(affine: number[][]): Record<Plane, PlaneAxes> {
  // Greedy assignment over the whole matrix: repeatedly take the largest
  // remaining |value|, bind that (world axis, array axis) pair, and strike both
  // out.
  //
  // Scanning row by row instead was the earlier bug. For an axial knee volume
  // the affine row for left-right is [-0.335, -0.083, 0.495], so that row's
  // largest entry sits in array axis 2 — and left-right would claim it before
  // inferior-superior could, even though axis 2's own column is [0.495, 0.447,
  // 4.147] and overwhelmingly inferior-superior. Comparing globally cannot make
  // that mistake, because 4.147 is picked before 0.495 is ever considered.
  const pairs: Array<{ w: number; a: number; v: number }> = [];
  for (let w = 0; w < 3; w++)
    for (let a = 0; a < 3; a++)
      pairs.push({ w, a, v: Math.abs(affine[w]?.[a] ?? 0) });
  pairs.sort((x, y) => y.v - x.v);

  const forWorld: Array<{ ax: 0 | 1 | 2; sign: number } | null> = [null, null, null];
  const takenW = new Set<number>(), takenA = new Set<number>();
  for (const { w, a } of pairs) {
    if (takenW.has(w) || takenA.has(a)) continue;
    takenW.add(w); takenA.add(a);
    forWorld[w] = { ax: a as 0 | 1 | 2, sign: Math.sign(affine[w]?.[a] ?? 1) || 1 };
    if (takenW.size === 3) break;
  }
  for (let w = 0; w < 3; w++)
    if (!forWorld[w]) {
      const free = [0, 1, 2].find((a) => !takenA.has(a)) ?? w;
      takenA.add(free);
      forWorld[w] = { ax: free as 0 | 1 | 2, sign: 1 };
    }

  const LR = forWorld[0]!, PA = forWorld[1]!, IS = forWorld[2]!;
  return {
    // Axial: step through inferior-superior. Anterior at the top of the image.
    axial: { slice: IS.ax, h: LR.ax, v: PA.ax, flipH: LR.sign < 0, flipV: PA.sign > 0 },
    // Coronal: step through posterior-anterior. Superior at the top.
    coronal: { slice: PA.ax, h: LR.ax, v: IS.ax, flipH: LR.sign < 0, flipV: IS.sign < 0 },
    // Sagittal: step through left-right. Superior at the top.
    sagittal: { slice: LR.ax, h: PA.ax, v: IS.ax, flipH: PA.sign < 0, flipV: IS.sign < 0 },
  };
}

type Cursor = { i: number; j: number; k: number };

/** Cursor component along a numeric array axis (0=i, 1=j, 2=k). */
const axisVal = (c: Cursor, ax: 0 | 1 | 2) => (ax === 0 ? c.i : ax === 1 ? c.j : c.k);
const setAxis = (c: Cursor, ax: 0 | 1 | 2, v: number): Cursor =>
  ax === 0 ? { ...c, i: v } : ax === 1 ? { ...c, j: v } : { ...c, k: v };

export default function Viewer({ caseId, onSaved }: { caseId: string; onSaved?: () => void }) {
  const { data: session } = useSession();
  const [vol, setVol] = useState<Vol | null>(null);
  const [labels, setLabels] = useState<Uint8Array | null>(null);
  const [status, setStatus] = useState("Loading scan…");
  const [busy, setBusy] = useState(true);
  const [seg, setSeg] = useState<number>(1);
  const [brush, setBrush] = useState(6);
  const [erasing, setErasing] = useState(false);
  const [tool, setTool] = useState<"brush" | "pencil">("brush");
  const outline = useRef<[number, number][]>([]);
  const [outlineTick, setOutlineTick] = useState(0);
  // Zoom is per view: you often want a lesion magnified in one plane while
  // keeping the others wide for context.
  const [zoom, setZoom] = useState<Record<Plane, number>>({ axial: 1, coronal: 1, sagittal: 1 });
  const [maskInside, setMaskInside] = useState(true);
  // Locked by default: painting should not drag the other two views around.
  // Slicer behaves the same way — the crosshair moves when you deliberately
  // move it, not as a side effect of every brush stroke.
  const [locked, setLocked] = useState(true);
  // Which view the arrow keys act on. Set by hovering, so navigation follows
  // the pointer without needing a click that might paint.
  const [activePlane, setActivePlane] = useState<Plane>("axial");
  const [cursor, setCursor] = useState<Cursor>({ i: 0, j: 0, k: 0 });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [counts, setCounts] = useState<[number, number, number]>([0, 0, 0]);

  const canvases = useRef<Record<Plane, HTMLCanvasElement | null>>({
    axial: null, coronal: null, sagittal: null,
  });
  const painting = useRef(false);
  const pencilPlane = useRef<Plane | null>(null);
  const undoStack = useRef<Uint8Array[]>([]);
  const redoStack = useRef<Uint8Array[]>([]);

  const idx = useCallback(
    (d: [number, number, number], i: number, j: number, k: number) => i + d[0] * (j + d[1] * k),
    [],
  );

  // ---- load ------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setBusy(true); setStatus("Loading scan…"); setLabels(null); setVol(null);
    undoStack.current = []; redoStack.current = [];

    (async () => {
      try {
        const nifti = await import("nifti-reader-js");
        const res = await fetch(`/api/volume/${caseId}`);
        if (!res.ok) throw new Error((await res.json()).error ?? "load failed");
        let buf = await res.arrayBuffer();
        if (nifti.isCompressed(buf)) buf = nifti.decompress(buf) as ArrayBuffer;
        if (!nifti.isNIFTI(buf)) throw new Error("not a NIfTI file");

        const hdr = nifti.readHeader(buf)!;
        const raw = nifti.readImage(hdr, buf);
        const dims: [number, number, number] = [hdr.dims[1], hdr.dims[2], hdr.dims[3]];
        // pixDims[1..3] is mm per voxel. Our data is ~0.35 mm in-plane against
        // 3-4 mm slices, so a coronal view is 432 voxels wide and 33 tall but
        // roughly SQUARE in millimetres. Rendering by voxel count alone squashes
        // it into a sliver — which is exactly what it looked like.
        const spacing: [number, number, number] = [
          Math.abs(hdr.pixDims?.[1]) || 1,
          Math.abs(hdr.pixDims?.[2]) || 1,
          Math.abs(hdr.pixDims?.[3]) || 1,
        ];
        const n = dims[0] * dims[1] * dims[2];

        const ctor: Record<number, new (b: ArrayBuffer) => ArrayLike<number>> = {
          2: Uint8Array, 4: Int16Array, 8: Int32Array,
          16: Float32Array, 64: Float64Array, 512: Uint16Array, 768: Uint32Array,
        } as never;
        const Typed = ctor[hdr.datatypeCode] ?? Int16Array;
        const src = new Typed(raw);
        const data = new Float32Array(n);
        for (let i = 0; i < n; i++) data[i] = Number(src[i]);

        const sample = new Float32Array(Math.min(n, 200_000));
        const step = Math.max(1, Math.floor(n / sample.length));
        for (let i = 0, s = 0; s < sample.length; i += step, s++) sample[s] = data[i];
        sample.sort();
        const lo = sample[Math.floor(sample.length * 0.01)];
        const hi = sample[Math.floor(sample.length * 0.99)] || lo + 1;

        // nifti-reader-js exposes the sform/qform-derived affine; fall back to
        // an identity mapping if a file somehow lacks one.
        const aff: number[][] =
          (hdr as unknown as { affine?: number[][] }).affine ??
          [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
        const axes = deriveAxes(aff);

        if (cancelled) return;
        setVol({ data, dims, spacing, axes, lo, hi });
        setLabels(new Uint8Array(n));
        setCursor({
          i: Math.floor(dims[0] / 2), j: Math.floor(dims[1] / 2), k: Math.floor(dims[2] / 2),
        });
        setCounts([0, 0, 0]);
        setStatus(`${dims[0]} x ${dims[1]} x ${dims[2]}`);
        setDirty(false);
      } catch (e) {
        if (!cancelled) setStatus(e instanceof Error ? e.message : "failed to load");
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [caseId]);

  // ---- geometry --------------------------------------------------------
  /**
   * In-plane voxel extent, slice depth, and the PHYSICAL size in millimetres.
   * All of it comes from the affine-derived axis map, so a sagittally-acquired
   * volume shows a true sagittal view rather than whatever array axis happened
   * to be third.
   */
  const planeGeom = useCallback((p: Plane, v: Vol) => {
    const ax = v.axes[p];
    return {
      w: v.dims[ax.h],
      h: v.dims[ax.v],
      depth: v.dims[ax.slice],
      axis: ax,
      mmW: v.dims[ax.h] * v.spacing[ax.h],
      mmH: v.dims[ax.v] * v.spacing[ax.v],
    };
  }, []);

  /** In-plane (a,b) at slice s -> flat array index, honouring axis order and flips. */
  const sampleAt = useCallback((p: Plane, v: Vol, a: number, b: number, s: number) => {
    const ax = v.axes[p];
    const c: [number, number, number] = [0, 0, 0];
    c[ax.slice] = s;
    c[ax.h] = ax.flipH ? v.dims[ax.h] - 1 - a : a;
    c[ax.v] = ax.flipV ? v.dims[ax.v] - 1 - b : b;
    return idx(v.dims, c[0], c[1], c[2]);
  }, [idx]);

  /** Where the crosshair sits within this plane, for the guide lines. */
  const cursorInPlane = useCallback((p: Plane, v: Vol, cur: Cursor) => {
    const ax = v.axes[p];
    const c = [cur.i, cur.j, cur.k];
    const a = ax.flipH ? v.dims[ax.h] - 1 - c[ax.h] : c[ax.h];
    const b = ax.flipV ? v.dims[ax.v] - 1 - c[ax.v] : c[ax.v];
    return { a, b };
  }, []);

  const sliceOf = useCallback((p: Plane, v: Vol, cur: Cursor) => {
    const c = [cur.i, cur.j, cur.k];
    return c[v.axes[p].slice];
  }, []);

  // ---- render ----------------------------------------------------------
  const draw = useCallback((p: Plane) => {
    const cv = canvases.current[p];
    if (!cv || !vol || !labels) return;
    const { data, dims, lo, hi } = vol;
    const { w, h } = planeGeom(p, vol);
    const s = sliceOf(p, vol, cursor);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }

    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    const range = hi - lo || 1;

    for (let b = 0; b < h; b++) {
      for (let a = 0; a < w; a++) {
        const flat = sampleAt(p, vol, a, b, s);
        const v = data[flat];
        let g = Math.round(((Math.min(Math.max(v, lo), hi) - lo) / range) * 255);
        let r = g, bl = g;
        const lv = labels[flat];
        if (lv) {
          const c = SEGMENTS.find((x) => x.value === lv)!.color;
          const cr = parseInt(c.slice(1, 3), 16),
            cg = parseInt(c.slice(3, 5), 16),
            cb = parseInt(c.slice(5, 7), 16);
          r = Math.round(g * 0.45 + cr * 0.55);
          g = Math.round(g * 0.45 + cg * 0.55);
          bl = Math.round(bl * 0.45 + cb * 0.55);
        }
        const o = ((h - 1 - b) * w + a) * 4; // flip so anatomy is upright
        img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = bl; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // Crosshair, drawn after the pixels so it sits on top.
    const { a: ca, b: cb } = cursorInPlane(p, vol, cursor);
    const y = h - 1 - cb;
    ctx.save();
    ctx.strokeStyle = PLANE_COLOR[p];
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = Math.max(1, Math.round(w / 400));
    const gap = Math.max(6, Math.round(w / 28));
    ctx.beginPath();
    ctx.moveTo(ca, 0); ctx.lineTo(ca, Math.max(0, y - gap));
    ctx.moveTo(ca, Math.min(h, y + gap)); ctx.lineTo(ca, h);
    ctx.moveTo(0, y); ctx.lineTo(Math.max(0, ca - gap), y);
    ctx.moveTo(Math.min(w, ca + gap), y); ctx.lineTo(w, y);
    ctx.stroke();
    ctx.restore();

    // Live pencil trace on the plane being drawn in.
    if (pencilPlane.current === p && outline.current.length > 1) {
      ctx.save();
      ctx.strokeStyle = SEGMENTS.find((x) => x.value === seg)!.color;
      ctx.lineWidth = Math.max(1.5, Math.round(w / 300));
      ctx.setLineDash([Math.max(3, w / 90), Math.max(3, w / 90)]);
      ctx.beginPath();
      const [x0, y0] = outline.current[0];
      ctx.moveTo(x0, h - 1 - y0);
      for (const [x, y] of outline.current.slice(1)) ctx.lineTo(x, h - 1 - y);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
  }, [vol, labels, cursor, seg, outlineTick, planeGeom, sampleAt, cursorInPlane, sliceOf]);

  const drawAll = useCallback(() => { PLANES.forEach(draw); }, [draw]);
  useEffect(() => { drawAll(); }, [drawAll]);

  const recount = useCallback(() => {
    if (!labels) return;
    const c: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < labels.length; i++) {
      const v = labels[i];
      if (v) c[v - 1]++;
    }
    setCounts(c);
  }, [labels]);

  // ---- history ---------------------------------------------------------
  const pushUndo = useCallback(() => {
    if (!labels) return;
    undoStack.current.push(labels.slice());
    if (undoStack.current.length > 30) undoStack.current.shift();
    redoStack.current = []; // a new stroke invalidates the redo branch
  }, [labels]);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev || !labels) return;
    redoStack.current.push(labels.slice());
    setLabels(prev); setDirty(true);
  }, [labels]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next || !labels) return;
    undoStack.current.push(labels.slice());
    setLabels(next); setDirty(true);
  }, [labels]);

  useEffect(() => { recount(); }, [labels, recount]);

  // ---- painting --------------------------------------------------------
  const toVoxel = useCallback((p: Plane, ev: React.MouseEvent<HTMLCanvasElement>) => {
    if (!vol) return null;
    const rect = ev.currentTarget.getBoundingClientRect();
    const { w, h } = planeGeom(p, vol);
    const a = Math.floor(((ev.clientX - rect.left) / rect.width) * w);
    const b = h - 1 - Math.floor(((ev.clientY - rect.top) / rect.height) * h);
    if (a < 0 || b < 0 || a >= w || b >= h) return null;
    return { a, b };
  }, [vol, planeGeom]);

  /** Move the crosshair so the other two views follow this click. */
  const moveCursor = useCallback((p: Plane, a: number, b: number) => {
    if (!vol) return;
    const ax = vol.axes[p];
    const ha = ax.flipH ? vol.dims[ax.h] - 1 - a : a;
    const vb = ax.flipV ? vol.dims[ax.v] - 1 - b : b;
    setCursor((c) => setAxis(setAxis(c, ax.h, ha), ax.v, vb));
  }, [vol]);

  const paintAt = useCallback((p: Plane, ev: React.MouseEvent<HTMLCanvasElement>) => {
    if (!vol || !labels) return;
    const hit = toVoxel(p, ev);
    if (!hit) return;
    const { dims } = vol;
    const { w, h } = planeGeom(p, vol);
    const s = sliceOf(p, vol, cursor);
    const r = brush;

    for (let db = -r; db <= r; db++) {
      for (let da = -r; da <= r; da++) {
        if (da * da + db * db > r * r) continue;
        const a = hit.a + da, b = hit.b + db;
        if (a < 0 || b < 0 || a >= w || b >= h) continue;
        const i = sampleAt(p, vol, a, b, s);
        if (erasing) {
          labels[i] = 0;
        } else {
          // Editable area: inside bone_marrow. Stops a lesion being painted
          // into muscle — the guard that makes this usable for a
          // non-radiologist annotator.
          if (maskInside && seg !== 1 && labels[i] !== 1 && labels[i] !== seg) continue;
          labels[i] = seg;
        }
      }
    }
    setDirty(true);
    // Every plane, not just this one — the label volume is shared, so a stroke
    // here changes what the other two views should be showing.
    drawAll();
  }, [vol, labels, cursor, brush, erasing, seg, maskInside,
      planeGeom, sampleAt, sliceOf, toVoxel, drawAll]);

  /**
   * Pencil: close the traced outline and fill everything inside it.
   *
   * Even-odd scanline fill rather than flood fill. Flood fill leaks the moment
   * the traced boundary has a single-pixel gap — easy to do with a mouse, and
   * the leak is silent and large. A polygon is closed by definition, so the
   * worst case is a slightly wrong shape rather than a whole slice filled.
   */
  const commitOutline = useCallback(() => {
    const pts = outline.current;
    const p = pencilPlane.current;
    outline.current = [];
    pencilPlane.current = null;
    setOutlineTick((n) => n + 1);
    if (!vol || !labels || !p || pts.length < 3) { drawAll(); return; }
    const { w, h } = planeGeom(p, vol);
    const s = sliceOf(p, vol, cursor);

    let minB = Infinity, maxB = -Infinity;
    for (const [, b] of pts) { if (b < minB) minB = b; if (b > maxB) maxB = b; }
    minB = Math.max(0, Math.floor(minB)); maxB = Math.min(h - 1, Math.ceil(maxB));

    for (let b = minB; b <= maxB; b++) {
      const xs: number[] = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[j];
        if ((ay > b) !== (by > b)) xs.push(ax + ((b - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((m, n) => m - n);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil(xs[k]));
        const to = Math.min(w - 1, Math.floor(xs[k + 1]));
        for (let a = from; a <= to; a++) {
          const flat = sampleAt(p, vol, a, b, s);
          if (erasing) { labels[flat] = 0; continue; }
          if (maskInside && seg !== 1 && labels[flat] !== 1 && labels[flat] !== seg) continue;
          labels[flat] = seg;
        }
      }
    }
    setDirty(true);
    drawAll();
  }, [vol, labels, cursor, erasing, maskInside, seg, planeGeom, sliceOf, sampleAt, drawAll]);

  // ---- keyboard --------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault(); redo(); return;
      }
      if (mod) return;
      if (e.key === "1") setSeg(1);
      else if (e.key === "2") setSeg(2);
      else if (e.key === "3") setSeg(3);
      else if (e.key.toLowerCase() === "e") setErasing((v) => !v);
      else if (e.key.toLowerCase() === "p") setTool((v) => (v === "brush" ? "pencil" : "brush"));
      else if (e.key.toLowerCase() === "l") setLocked((v) => !v);
      else if (e.key === "Enter") { e.preventDefault(); commitOutline(); }
      else if (e.key === "Escape") {
        outline.current = []; pencilPlane.current = null; setOutlineTick((n) => n + 1); drawAll();
      }
      else if (e.key === "[") setBrush((b) => Math.max(1, b - 1));
      else if (e.key === "]") setBrush((b) => Math.min(20, b + 1));
      else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
                "PageUp", "PageDown"].includes(e.key)) {
        if (!vol) return;
        e.preventDefault();
        const ax = vol.axes[activePlane].slice;
        const depth = vol.dims[ax];
        const big = e.key.startsWith("Page") ? 10 : 1;
        const dir = (e.key === "ArrowUp" || e.key === "ArrowRight" || e.key === "PageUp") ? 1 : -1;
        setCursor((c) => setAxis(c, ax, Math.min(depth - 1, Math.max(0, axisVal(c, ax) + dir * big))));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, commitOutline, drawAll, vol, activePlane]);

  // ---- save ------------------------------------------------------------
  const save = async () => {
    if (!labels) return;
    const total = counts[0] + counts[1] + counts[2];
    if (total === 0) {
      setStatus("Cannot save empty annotation: No voxels annotated yet.");
      return;
    }
    setSaving(true);

    try {
      const me = session?.user?.name || session?.user?.email || "unknown";
      const res = await fetch(`/api/annotation/${caseId}?by=${encodeURIComponent(me)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(labels),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "save failed");

      let logged = false;
      try {
        const logRes = await fetch("/api/annotation-log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            caseId, annotator: me,
            counts: { bone_marrow: counts[0], bme: counts[1], uncertain: counts[2] },
          }),
        });
        logged = (await logRes.json())?.ok === true;
      } catch { /* ledger unavailable */ }

      setStatus(logged
        ? `Saved — recorded as annotated by ${me}`
        : "Saved to disk (not recorded: database unreachable)");
      setDirty(false);
      onSaved?.();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  if (busy) {
    return (
      <div className="flex h-96 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {status}
      </div>
    );
  }
  if (!vol) {
    return <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">{status}</div>;
  }

  return (
    <div className="space-y-2">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2">
        {SEGMENTS.map((s, i) => (
          <button key={s.value}
            onClick={() => { setSeg(s.value); setErasing(false); }}
            title={`${s.label}  (key ${i + 1})`}
            className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium ${
              seg === s.value && !erasing ? "border-primary bg-accent" : "border-border"
            }`}>
            <span className="h-3 w-3 rounded-sm" style={{ background: s.color }} />
            {s.label}
            <span className="tabular-nums text-xs text-muted-foreground">
              {counts[s.value - 1].toLocaleString()}
            </span>
          </button>
        ))}

        <div className="mx-1 h-6 w-px bg-border" />

        <div className="inline-flex overflow-hidden rounded-md border border-border">
          <button onClick={() => setTool("brush")} title="Brush  (P toggles)"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm ${
              tool === "brush" ? "bg-accent" : ""}`}>
            <Paintbrush className="h-4 w-4" /> Brush
          </button>
          <button onClick={() => setTool("pencil")} title="Pencil — trace an outline, the inside fills  (P)"
            className={`inline-flex items-center gap-1.5 border-l border-border px-2.5 py-1.5 text-sm ${
              tool === "pencil" ? "bg-accent" : ""}`}>
            <Lasso className="h-4 w-4" /> Pencil
          </button>
        </div>

        <button onClick={() => setErasing((e) => !e)} title="Toggle erase  (E)"
          className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ${
            erasing ? "border-primary bg-accent" : "border-border"
          }`}>
          <Eraser className="h-4 w-4" />
          {erasing ? "Erasing" : "Erase"}
        </button>

        <label className="flex items-center gap-2 text-sm text-muted-foreground" title="[ and ]">
          Brush
          <input type="range" min={1} max={20} value={brush}
            onChange={(e) => setBrush(Number(e.target.value))} className="w-24" />
          <span className="w-6 tabular-nums">{brush}</span>
        </label>

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={maskInside}
            onChange={(e) => setMaskInside(e.target.checked)} />
          Only inside bone
        </label>

        <button onClick={() => setLocked((v) => !v)}
          title={locked
            ? "Views locked: painting leaves the other two slices where they are"
            : "Views linked: clicking moves the crosshair and the other two follow"}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm ${
            locked ? "border-border" : "border-primary bg-accent"}`}>
          {locked ? <Link2Off className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
          {locked ? "Views locked" : "Views linked"}
        </button>

        <div className="ml-auto flex items-center gap-2">
          <button onClick={undo} title="Undo  (Ctrl+Z)"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm">
            <RotateCcw className="h-4 w-4" />
          </button>
          <button onClick={redo} title="Redo  (Ctrl+Y)"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm">
            <Redo2 className="h-4 w-4" />
          </button>
          <button onClick={save} disabled={saving || !dirty}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-40">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {dirty ? "Save" : "Saved"}
          </button>
        </div>
      </div>

      {/* Four-Up: three orthogonal views plus an info panel, as in Slicer */}
      <div
        className="grid gap-1.5 lg:grid-cols-2 lg:grid-rows-2"
        // Fit the four views in the viewport rather than forcing square tiles,
        // which pushed the bottom two below the fold and made checking a lesion
        // across planes a scrolling exercise.
        style={{ height: "min(calc(100vh - 215px), 1100px)", minHeight: 440 }}
      >
        {PLANES.map((p) => {
          const g = planeGeom(p, vol);
          const depth = g.depth;
          const s = sliceOf(p, vol, cursor);
          return (
            <div key={p}
              onMouseEnter={() => setActivePlane(p)}
              className="flex min-h-0 flex-col overflow-hidden rounded-lg border-2 bg-black p-1.5"
              style={{
                borderColor: PLANE_COLOR[p],
                opacity: activePlane === p ? 1 : 0.94,
                boxShadow: activePlane === p ? `0 0 0 1px ${PLANE_COLOR[p]}` : undefined,
              }}>
              <div className="mb-1 flex shrink-0 items-center justify-between gap-1 px-1 text-[10px] uppercase tracking-wider"
                style={{ color: PLANE_COLOR[p] }}>
                <span>{p}</span>
                <span className="flex items-center gap-0.5">
                  <button type="button" title="Zoom out"
                    onClick={() => setZoom((z) => ({ ...z, [p]: Math.max(1, +(z[p] - 0.25).toFixed(2)) }))}
                    className="rounded border border-neutral-700 px-1 text-neutral-300 hover:bg-neutral-800">
                    <Minus className="h-2.5 w-2.5" />
                  </button>
                  <button type="button" title="Reset zoom"
                    onClick={() => setZoom((z) => ({ ...z, [p]: 1 }))}
                    className="w-8 rounded border border-neutral-700 text-[9px] tabular-nums text-neutral-300 hover:bg-neutral-800">
                    {zoom[p].toFixed(1)}x
                  </button>
                  <button type="button" title="Zoom in"
                    onClick={() => setZoom((z) => ({ ...z, [p]: Math.min(6, +(z[p] + 0.25).toFixed(2)) }))}
                    className="rounded border border-neutral-700 px-1 text-neutral-300 hover:bg-neutral-800">
                    <Plus className="h-2.5 w-2.5" />
                  </button>
                  <span className="ml-1 tabular-nums text-neutral-400">{s + 1}/{depth}</span>
                </span>
              </div>
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
              <div className="flex h-full w-full items-center justify-center"
                style={{ transform: `scale(${zoom[p]})`, transformOrigin: "center" }}>
              <canvas
                ref={(el) => { canvases.current[p] = el; }}
                className="cursor-crosshair rounded"
                style={{
                  imageRendering: "auto",
                  // Fill the square tile while keeping true physical proportions.
                  aspectRatio: `${g.mmW} / ${g.mmH}`,
                  maxWidth: "100%", maxHeight: "100%",
                  margin: "0 auto", display: "block",
                }}
                onMouseDown={(e) => {
                  const hit = toVoxel(p, e);
                  if (!hit) return;
                  if (e.shiftKey) { moveCursor(p, hit.a, hit.b); return; }
                  if (e.button !== 0) return;
                  pushUndo();
                  if (tool === "pencil") {
                    pencilPlane.current = p;
                    outline.current = [[hit.a, hit.b]];
                    painting.current = true;
                    setOutlineTick((n) => n + 1);
                  } else {
                    painting.current = true;
                    paintAt(p, e);
                    if (!locked) moveCursor(p, hit.a, hit.b);
                  }
                }}
                onMouseMove={(e) => {
                  if (!painting.current) return;
                  if (tool === "pencil") {
                    const hit = toVoxel(p, e);
                    if (!hit) return;
                    const last = outline.current[outline.current.length - 1];
                    // Skip duplicate points so the polygon stays cheap to fill.
                    if (!last || last[0] !== hit.a || last[1] !== hit.b) {
                      outline.current.push([hit.a, hit.b]);
                      setOutlineTick((n) => n + 1);
                    }
                  } else {
                    paintAt(p, e);
                  }
                }}
                onMouseUp={() => {
                  // Pencil follows Slicer's Draw effect: releasing the mouse
                  // leaves the outline on screen so it can be inspected (and
                  // extended) before Enter commits it. Only the brush paints
                  // on release.
                  painting.current = false;
                  drawAll();
                }}
                onMouseLeave={() => { painting.current = false; }}
                // Deliberately no onWheel. Scrolling stepped the slice, which
                // fought with page scrolling and moved the image out from under
                // the brush mid-stroke. Arrow keys step slices instead.
                onMouseEnter={() => setActivePlane(p)}
              />
              </div>
              </div>
              <input type="range" min={0} max={depth - 1} value={s}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setCursor((c) => setAxis(c, g.axis.slice, v));
                }}
                className="mt-1 w-full shrink-0" />
            </div>
          );
        })}

        <div className="space-y-2">
          <Render3D
            labels={labels}
            dims={vol.dims}
            spacing={vol.spacing}
            segments={SEGMENTS}
          />

          <div className="rounded-lg border border-border bg-card p-3 text-xs">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="font-semibold">{caseId}</span>
              <span className="tabular-nums text-muted-foreground">
                {vol.dims.join(" x ")} &middot; {vol.spacing.map((s) => s.toFixed(2)).join(" x ")} mm
              </span>
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
              <kbd className="font-mono">Ctrl+Z</kbd><span>Undo</span>
              <kbd className="font-mono">Ctrl+Y</kbd><span>Redo</span>
              <kbd className="font-mono">1 2 3</kbd><span>Pick segment</span>
              <kbd className="font-mono">P</kbd><span>Brush / pencil</span>
              <kbd className="font-mono">Enter</kbd><span>Fill pencil outline</span>
              <kbd className="font-mono">Esc</kbd><span>Discard outline</span>
              <kbd className="font-mono">E</kbd><span>Erase on/off</span>
              <kbd className="font-mono">[ ]</kbd><span>Brush size</span>
              <kbd className="font-mono">&uarr;&darr;&larr;&rarr;</kbd><span>Step slice (hovered view)</span>
              <kbd className="font-mono">PgUp/PgDn</kbd><span>Step 10 slices</span>
              <kbd className="font-mono">Shift+click</kbd><span>Move crosshair (always)</span>
              <kbd className="font-mono">L</kbd><span>Lock / link views</span>
            </div>
            {outlineTick >= 0 && outline.current.length > 2 && (
              <p className="mt-2 rounded bg-accent px-2 py-1 font-medium text-foreground">
                Outline ready — press <kbd className="font-mono">Enter</kbd> to fill it,
                or <kbd className="font-mono">Esc</kbd> to discard.
              </p>
            )}
            <p className="mt-2 text-muted-foreground">{status}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
