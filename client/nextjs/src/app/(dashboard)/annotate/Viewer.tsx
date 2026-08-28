"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, Loader2, Paintbrush, RotateCcw, Save } from "lucide-react";

/**
 * Three-plane MPR viewer with painting, in the browser.
 *
 * Volume and labels are held as flat typed arrays in i,j,k order with i fastest
 * — the same order NIfTI stores and the same order write_seg.py reshapes with
 * (numpy order="F"). If that ever diverges, annotations land in the wrong voxels
 * without any error, so the indexing helper below is the single place it is
 * expressed.
 */

export const SEGMENTS = [
  { value: 1, name: "bone_marrow", label: "Bone marrow", color: "#dbd2b5" },
  { value: 2, name: "bme", label: "Edema (BME)", color: "#f24c38" },
  { value: 3, name: "uncertain", label: "Uncertain", color: "#8c8c99" },
] as const;

type Plane = "axial" | "coronal" | "sagittal";
const PLANES: Plane[] = ["axial", "coronal", "sagittal"];

type Vol = {
  data: Float32Array;
  dims: [number, number, number];
  lo: number;
  hi: number;
};

export default function Viewer({ caseId }: { caseId: string }) {
  const [vol, setVol] = useState<Vol | null>(null);
  const [labels, setLabels] = useState<Uint8Array | null>(null);
  const [status, setStatus] = useState("Loading scan…");
  const [busy, setBusy] = useState(true);
  const [seg, setSeg] = useState<number>(1);
  const [brush, setBrush] = useState(6);
  const [erasing, setErasing] = useState(false);
  const [maskInside, setMaskInside] = useState(true);
  const [slice, setSlice] = useState<Record<Plane, number>>({
    axial: 0, coronal: 0, sagittal: 0,
  });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const canvases = useRef<Record<Plane, HTMLCanvasElement | null>>({
    axial: null, coronal: null, sagittal: null,
  });
  const painting = useRef(false);
  const undoStack = useRef<Uint8Array[]>([]);

  // flat index — i fastest, then j, then k
  const idx = useCallback(
    (d: [number, number, number], i: number, j: number, k: number) =>
      i + d[0] * (j + d[1] * k),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setStatus("Loading scan…");
    setLabels(null);
    setVol(null);
    undoStack.current = [];

    (async () => {
      try {
        const nifti = await import("nifti-reader-js");
        const res = await fetch(`/api/volume/${caseId}`);
        if (!res.ok) throw new Error((await res.json()).error ?? "load failed");
        // decompress() is typed as returning ArrayBufferLike; the runtime value
        // is always a plain ArrayBuffer here (never SharedArrayBuffer).
        let buf = await res.arrayBuffer();
        if (nifti.isCompressed(buf)) buf = nifti.decompress(buf) as ArrayBuffer;
        if (!nifti.isNIFTI(buf)) throw new Error("not a NIfTI file");

        const hdr = nifti.readHeader(buf)!;
        const raw = nifti.readImage(hdr, buf);
        const dims: [number, number, number] = [
          hdr.dims[1], hdr.dims[2], hdr.dims[3],
        ];
        const n = dims[0] * dims[1] * dims[2];

        // Normalise whatever datatype came back into Float32.
        const ctor: Record<number, any> = {
          2: Uint8Array, 4: Int16Array, 8: Int32Array,
          16: Float32Array, 64: Float64Array, 512: Uint16Array, 768: Uint32Array,
        };
        const Typed = ctor[hdr.datatypeCode] ?? Int16Array;
        const src = new Typed(raw);
        const data = new Float32Array(n);
        for (let i = 0; i < n; i++) data[i] = Number(src[i]);

        // Percentile window — robust to a few very bright voxels.
        const sample = new Float32Array(Math.min(n, 200_000));
        const step = Math.max(1, Math.floor(n / sample.length));
        for (let i = 0, s = 0; s < sample.length; i += step, s++) sample[s] = data[i];
        sample.sort();
        const lo = sample[Math.floor(sample.length * 0.01)];
        const hi = sample[Math.floor(sample.length * 0.99)] || lo + 1;

        if (cancelled) return;
        setVol({ data, dims, lo, hi });
        setLabels(new Uint8Array(n));
        setSlice({
          axial: Math.floor(dims[2] / 2),
          coronal: Math.floor(dims[1] / 2),
          sagittal: Math.floor(dims[0] / 2),
        });
        setStatus(`${dims[0]}×${dims[1]}×${dims[2]}`);
        setDirty(false);
      } catch (e) {
        if (!cancelled) setStatus(e instanceof Error ? e.message : "failed to load");
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();

    return () => { cancelled = true; };
  }, [caseId]);

  // ---- rendering -------------------------------------------------------
  const planeSize = useCallback(
    (p: Plane, d: [number, number, number]): [number, number] =>
      p === "axial" ? [d[0], d[1]] : p === "coronal" ? [d[0], d[2]] : [d[1], d[2]],
    [],
  );

  const sampleAt = useCallback(
    (p: Plane, d: [number, number, number], a: number, b: number, s: number) =>
      p === "axial" ? idx(d, a, b, s)
        : p === "coronal" ? idx(d, a, s, b)
          : idx(d, s, a, b),
    [idx],
  );

  const draw = useCallback((p: Plane) => {
    const cv = canvases.current[p];
    if (!cv || !vol || !labels) return;
    const { data, dims, lo, hi } = vol;
    const [w, h] = planeSize(p, dims);
    const s = slice[p];
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }

    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    const range = hi - lo || 1;

    for (let b = 0; b < h; b++) {
      for (let a = 0; a < w; a++) {
        const v = data[sampleAt(p, dims, a, b, s)];
        let g = Math.round(((Math.min(Math.max(v, lo), hi) - lo) / range) * 255);
        let r = g, bl = g;
        const lv = labels[sampleAt(p, dims, a, b, s)];
        if (lv) {
          const c = SEGMENTS.find((x) => x.value === lv)!.color;
          const cr = parseInt(c.slice(1, 3), 16),
            cg = parseInt(c.slice(3, 5), 16),
            cb = parseInt(c.slice(5, 7), 16);
          r = Math.round(g * 0.5 + cr * 0.5);
          g = Math.round(g * 0.5 + cg * 0.5);
          bl = Math.round(bl * 0.5 + cb * 0.5);
        }
        // flip vertically so anatomy is not upside down
        const o = ((h - 1 - b) * w + a) * 4;
        img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = bl; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [vol, labels, slice, planeSize, sampleAt]);

  useEffect(() => { PLANES.forEach(draw); }, [draw]);

  // ---- painting --------------------------------------------------------
  const paintAt = useCallback((p: Plane, ev: React.MouseEvent<HTMLCanvasElement>) => {
    if (!vol || !labels) return;
    const cv = ev.currentTarget;
    const rect = cv.getBoundingClientRect();
    const { dims } = vol;
    const [w, h] = planeSize(p, dims);
    const a0 = Math.floor(((ev.clientX - rect.left) / rect.width) * w);
    const b0 = h - 1 - Math.floor(((ev.clientY - rect.top) / rect.height) * h);
    const s = slice[p];
    const r = brush;

    for (let db = -r; db <= r; db++) {
      for (let da = -r; da <= r; da++) {
        if (da * da + db * db > r * r) continue;
        const a = a0 + da, b = b0 + db;
        if (a < 0 || b < 0 || a >= w || b >= h) continue;
        const i = sampleAt(p, dims, a, b, s);
        if (erasing) {
          labels[i] = 0;
        } else {
          // Editable area: inside bone_marrow. Stops a lesion being painted into
          // muscle — the single guard that makes this usable for a non-radiologist.
          if (maskInside && seg !== 1 && labels[i] !== 1 && labels[i] !== seg) continue;
          labels[i] = seg;
        }
      }
    }
    setDirty(true);
    draw(p);
  }, [vol, labels, slice, brush, erasing, seg, maskInside, planeSize, sampleAt, draw]);

  const pushUndo = () => {
    if (!labels) return;
    undoStack.current.push(labels.slice());
    if (undoStack.current.length > 20) undoStack.current.shift();
  };

  const undo = () => {
    const prev = undoStack.current.pop();
    if (prev) { setLabels(prev); setDirty(true); }
  };

  const save = async () => {
    if (!labels) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/annotation/${caseId}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(labels),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "save failed");
      setStatus("Saved to data/annotations/" + caseId);
      setDirty(false);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  const counts = labels
    ? SEGMENTS.map((s) => {
        let n = 0;
        for (let i = 0; i < labels.length; i++) if (labels[i] === s.value) n++;
        return n;
      })
    : [0, 0, 0];

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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3">
        {SEGMENTS.map((s) => (
          <button
            key={s.value}
            onClick={() => { setSeg(s.value); setErasing(false); }}
            className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium ${
              seg === s.value && !erasing ? "border-primary bg-accent" : "border-border"
            }`}
          >
            <span className="h-3 w-3 rounded-sm" style={{ background: s.color }} />
            {s.label}
            <span className="tabular-nums text-xs text-muted-foreground">
              {counts[s.value - 1].toLocaleString()}
            </span>
          </button>
        ))}

        <div className="mx-1 h-6 w-px bg-border" />

        <button
          onClick={() => setErasing((e) => !e)}
          className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ${
            erasing ? "border-primary bg-accent" : "border-border"
          }`}
        >
          {erasing ? <Eraser className="h-4 w-4" /> : <Paintbrush className="h-4 w-4" />}
          {erasing ? "Erase" : "Paint"}
        </button>

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
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
          <button onClick={undo}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm">
            <RotateCcw className="h-4 w-4" /> Undo
          </button>
          <button onClick={save} disabled={saving || !dirty}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-40">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {dirty ? "Save" : "Saved"}
          </button>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {PLANES.map((p) => {
          const max = p === "axial" ? vol.dims[2] - 1 : p === "coronal" ? vol.dims[1] - 1 : vol.dims[0] - 1;
          return (
            <div key={p} className="rounded-lg border border-border bg-black p-2">
              <div className="mb-1.5 flex items-center justify-between px-1 text-[11px] uppercase tracking-wider text-neutral-400">
                <span>{p}</span>
                <span className="tabular-nums">{slice[p] + 1} / {max + 1}</span>
              </div>
              <canvas
                ref={(el) => { canvases.current[p] = el; }}
                className="w-full cursor-crosshair rounded"
                style={{ imageRendering: "pixelated", aspectRatio: "1 / 1", objectFit: "contain" }}
                onMouseDown={(e) => { pushUndo(); painting.current = true; paintAt(p, e); }}
                onMouseMove={(e) => { if (painting.current) paintAt(p, e); }}
                onMouseUp={() => { painting.current = false; }}
                onMouseLeave={() => { painting.current = false; }}
                onWheel={(e) => {
                  const d = e.deltaY > 0 ? 1 : -1;
                  setSlice((s) => ({ ...s, [p]: Math.min(max, Math.max(0, s[p] + d)) }));
                }}
              />
              <input type="range" min={0} max={max} value={slice[p]}
                onChange={(e) => setSlice((s) => ({ ...s, [p]: Number(e.target.value) }))}
                className="mt-2 w-full" />
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        Scroll on a panel to move through slices. Paint bone marrow first, then switch to
        Edema — &ldquo;only inside bone&rdquo; keeps the lesion from leaking into muscle.
        Saves to <code className="rounded bg-muted px-1">data/annotations/{caseId}/{caseId}.seg.nrrd</code>.
        <span className="ml-1 opacity-70">{status}</span>
      </p>
    </div>
  );
}
