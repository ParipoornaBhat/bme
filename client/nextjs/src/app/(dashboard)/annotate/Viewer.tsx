"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, Loader2, Paintbrush, Redo2, RotateCcw, Save } from "lucide-react";
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
  { value: 1, name: "bone_marrow", label: "Bone marrow", color: "#dbd2b5" },
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
  lo: number; hi: number;
};
type Cursor = { i: number; j: number; k: number };

export default function Viewer({ caseId, onSaved }: { caseId: string; onSaved?: () => void }) {
  const { data: session } = useSession();
  const [vol, setVol] = useState<Vol | null>(null);
  const [labels, setLabels] = useState<Uint8Array | null>(null);
  const [status, setStatus] = useState("Loading scan…");
  const [busy, setBusy] = useState(true);
  const [seg, setSeg] = useState<number>(1);
  const [brush, setBrush] = useState(6);
  const [erasing, setErasing] = useState(false);
  const [maskInside, setMaskInside] = useState(true);
  const [cursor, setCursor] = useState<Cursor>({ i: 0, j: 0, k: 0 });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [counts, setCounts] = useState<[number, number, number]>([0, 0, 0]);

  const canvases = useRef<Record<Plane, HTMLCanvasElement | null>>({
    axial: null, coronal: null, sagittal: null,
  });
  const painting = useRef(false);
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

        if (cancelled) return;
        setVol({ data, dims, spacing, lo, hi });
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
   * In-plane voxel size, the axis this plane slices along, and the PHYSICAL
   * aspect ratio in millimetres. The canvas is drawn at voxel resolution but
   * displayed at the physical ratio, so anatomy keeps its true proportions on
   * anisotropic data instead of being stretched or flattened.
   */
  const planeGeom = useCallback((p: Plane, d: [number, number, number], sp?: [number, number, number]) => {
    const s = sp ?? [1, 1, 1];
    if (p === "axial")
      return { w: d[0], h: d[1], depth: d[2], axis: "k" as const,
               mmW: d[0] * s[0], mmH: d[1] * s[1] };
    if (p === "coronal")
      return { w: d[0], h: d[2], depth: d[1], axis: "j" as const,
               mmW: d[0] * s[0], mmH: d[2] * s[2] };
    return { w: d[1], h: d[2], depth: d[0], axis: "i" as const,
             mmW: d[1] * s[1], mmH: d[2] * s[2] };
  }, []);

  const sampleAt = useCallback(
    (p: Plane, d: [number, number, number], a: number, b: number, s: number) =>
      p === "axial" ? idx(d, a, b, s) : p === "coronal" ? idx(d, a, s, b) : idx(d, s, a, b),
    [idx],
  );

  /** In-plane (a,b) of the crosshair, for drawing the guide lines. */
  const cursorInPlane = useCallback((p: Plane, c: Cursor) =>
    p === "axial" ? { a: c.i, b: c.j } : p === "coronal" ? { a: c.i, b: c.k } : { a: c.j, b: c.k },
  []);

  const sliceOf = useCallback((p: Plane, c: Cursor) =>
    p === "axial" ? c.k : p === "coronal" ? c.j : c.i, []);

  // ---- render ----------------------------------------------------------
  const draw = useCallback((p: Plane) => {
    const cv = canvases.current[p];
    if (!cv || !vol || !labels) return;
    const { data, dims, lo, hi } = vol;
    const { w, h } = planeGeom(p, dims);
    const s = sliceOf(p, cursor);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }

    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    const range = hi - lo || 1;

    for (let b = 0; b < h; b++) {
      for (let a = 0; a < w; a++) {
        const flat = sampleAt(p, dims, a, b, s);
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
    const { a: ca, b: cb } = cursorInPlane(p, cursor);
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
  }, [vol, labels, cursor, planeGeom, sampleAt, cursorInPlane, sliceOf]);

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
    const { w, h } = planeGeom(p, vol.dims);
    const a = Math.floor(((ev.clientX - rect.left) / rect.width) * w);
    const b = h - 1 - Math.floor(((ev.clientY - rect.top) / rect.height) * h);
    if (a < 0 || b < 0 || a >= w || b >= h) return null;
    return { a, b };
  }, [vol, planeGeom]);

  /** Move the crosshair so the other two views follow this click. */
  const moveCursor = useCallback((p: Plane, a: number, b: number) => {
    setCursor((c) =>
      p === "axial" ? { ...c, i: a, j: b }
        : p === "coronal" ? { ...c, i: a, k: b }
          : { ...c, j: a, k: b });
  }, []);

  const paintAt = useCallback((p: Plane, ev: React.MouseEvent<HTMLCanvasElement>) => {
    if (!vol || !labels) return;
    const hit = toVoxel(p, ev);
    if (!hit) return;
    const { dims } = vol;
    const { w, h } = planeGeom(p, dims);
    const s = sliceOf(p, cursor);
    const r = brush;

    for (let db = -r; db <= r; db++) {
      for (let da = -r; da <= r; da++) {
        if (da * da + db * db > r * r) continue;
        const a = hit.a + da, b = hit.b + db;
        if (a < 0 || b < 0 || a >= w || b >= h) continue;
        const i = sampleAt(p, dims, a, b, s);
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
      else if (e.key === "[") setBrush((b) => Math.max(1, b - 1));
      else if (e.key === "]") setBrush((b) => Math.min(20, b + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // ---- save ------------------------------------------------------------
  const save = async () => {
    if (!labels) return;
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
    <div className="space-y-3">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3">
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

        <button onClick={() => setErasing((e) => !e)} title="Toggle erase  (E)"
          className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ${
            erasing ? "border-primary bg-accent" : "border-border"
          }`}>
          {erasing ? <Eraser className="h-4 w-4" /> : <Paintbrush className="h-4 w-4" />}
          {erasing ? "Erase" : "Paint"}
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
      <div className="grid gap-2 lg:grid-cols-2">
        {PLANES.map((p) => {
          const g = planeGeom(p, vol.dims, vol.spacing);
          const depth = g.depth;
          const s = sliceOf(p, cursor);
          return (
            <div key={p} className="rounded-lg border-2 bg-black p-2"
              style={{ borderColor: PLANE_COLOR[p] }}>
              <div className="mb-1.5 flex items-center justify-between px-1 text-[11px] uppercase tracking-wider"
                style={{ color: PLANE_COLOR[p] }}>
                <span>{p}</span>
                <span className="tabular-nums text-neutral-400">{s + 1} / {depth}</span>
              </div>
              <canvas
                ref={(el) => { canvases.current[p] = el; }}
                className="w-full cursor-crosshair rounded"
                style={{ imageRendering: "auto", aspectRatio: `${g.mmW} / ${g.mmH}`, width: "100%" }}
                onMouseDown={(e) => {
                  const hit = toVoxel(p, e);
                  if (!hit) return;
                  if (e.button === 0 && !e.shiftKey) {
                    pushUndo(); painting.current = true; paintAt(p, e);
                  }
                  // Shift-click moves the crosshair without painting.
                  moveCursor(p, hit.a, hit.b);
                }}
                onMouseMove={(e) => { if (painting.current) paintAt(p, e); }}
                onMouseUp={() => { painting.current = false; drawAll(); }}
                onMouseLeave={() => { painting.current = false; }}
                onWheel={(e) => {
                  const d = e.deltaY > 0 ? 1 : -1;
                  setCursor((c) => {
                    const ax = g.axis;
                    const cur = ax === "i" ? c.i : ax === "j" ? c.j : c.k;
                    const next = Math.min(depth - 1, Math.max(0, cur + d));
                    return { ...c, [ax]: next };
                  });
                }}
              />
              <input type="range" min={0} max={depth - 1} value={s}
                onChange={(e) => {
                  const ax = g.axis;
                  setCursor((c) => ({ ...c, [ax]: Number(e.target.value) }));
                }}
                className="mt-2 w-full" />
            </div>
          );
        })}

        <div className="space-y-2">
          <Render3D
            labels={labels}
            dims={vol.dims}
            spacing={vol.spacing}
            segValue={seg}
            color={SEGMENTS.find((s) => s.value === seg)!.color}
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
              <kbd className="font-mono">E</kbd><span>Erase on/off</span>
              <kbd className="font-mono">[ ]</kbd><span>Brush size</span>
              <kbd className="font-mono">Scroll</kbd><span>Move through slices</span>
              <kbd className="font-mono">Shift+click</kbd><span>Crosshair only</span>
            </div>
            <p className="mt-2 text-muted-foreground">{status}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
