"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ImageUp, Loader2 } from "lucide-react";
import Render3D from "../annotate/Render3D";

type Plane = "axial" | "coronal" | "sagittal";
const PLANES: Plane[] = ["axial", "coronal", "sagittal"];
const PLANE_COLOR: Record<Plane, string> = {
  axial: "#f04b4b",
  coronal: "#4bc46b",
  sagittal: "#e8c93a",
};
const SEGMENTS = [
  { value: 1, label: "Bone marrow", color: "#3ddc84" },
  { value: 2, label: "Edema (BME)", color: "#f24c38" },
] as const;

type AxisEnds = { atZero: string; atMax: string };
type PlaneAxes = { slice: 0 | 1 | 2; h: 0 | 1 | 2; v: 0 | 1 | 2; flipH: boolean; flipV: boolean };
type Cursor = { i: number; j: number; k: number };

type Result = {
  filename: string;
  device: string;
  folds: number;
  edema_present: boolean;
  volume_mm3: number;
  volume_cm3: number;
  bone_mm3: number;
  bone_voxels: number;
  bme_voxels: number;
  fraction_of_bone: number | null;
  lesion_count: number;
  shape: [number, number, number];
  spacing_mm: [number, number, number];
  affine: number[][];
  cursor: [number, number, number];
  image: string;
  mask: string;
  note: string;
};

function b64(s: string) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function orientationEnds(affine: number[][]): [AxisEnds, AxisEnds, AxisEnds] {
  const pos = ["R", "A", "S"];
  const neg = ["L", "P", "I"];
  const ends: AxisEnds[] = [];
  for (let a = 0; a < 3; a++) {
    let w = 0;
    let best = -1;
    for (let r = 0; r < 3; r++) {
      const v = Math.abs(affine[r]?.[a] ?? 0);
      if (v > best) { best = v; w = r; }
    }
    const sign = Math.sign(affine[w]?.[a] ?? 1) || 1;
    ends.push(sign > 0 ? { atZero: neg[w], atMax: pos[w] } : { atZero: pos[w], atMax: neg[w] });
  }
  return ends as [AxisEnds, AxisEnds, AxisEnds];
}

function deriveAxes(affine: number[][]): Record<Plane, PlaneAxes> {
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
    axial: { slice: IS.ax, h: LR.ax, v: PA.ax, flipH: LR.sign < 0, flipV: PA.sign > 0 },
    coronal: { slice: PA.ax, h: LR.ax, v: IS.ax, flipH: LR.sign < 0, flipV: IS.sign < 0 },
    sagittal: { slice: LR.ax, h: PA.ax, v: IS.ax, flipH: PA.sign < 0, flipV: IS.sign < 0 },
  };
}

const idx = (d: [number, number, number], i: number, j: number, k: number) => i + d[0] * (j + d[1] * k);
const axisVal = (c: Cursor, ax: 0 | 1 | 2) => (ax === 0 ? c.i : ax === 1 ? c.j : c.k);
const setAxis = (c: Cursor, ax: 0 | 1 | 2, v: number): Cursor =>
  ax === 0 ? { ...c, i: v } : ax === 1 ? { ...c, j: v } : { ...c, k: v };

function FourUp({ result }: { result: Result }) {
  const dims = result.shape;
  const spacing = result.spacing_mm;
  const image = useRef(b64(result.image));
  const labels = useRef(b64(result.mask));
  const axes = deriveAxes(result.affine);
  const orient = orientationEnds(result.affine);
  const [cursor, setCursor] = useState<Cursor>({
    i: result.cursor[0], j: result.cursor[1], k: result.cursor[2],
  });
  const [zoom, setZoom] = useState<Record<Plane, number>>({ axial: 1, coronal: 1, sagittal: 1 });
  const [active, setActive] = useState<Plane>("axial");
  const canvases = useRef<Record<Plane, HTMLCanvasElement | null>>({ axial: null, coronal: null, sagittal: null });

  const geom = (p: Plane) => {
    const ax = axes[p];
    return {
      w: dims[ax.h], h: dims[ax.v], depth: dims[ax.slice], axis: ax,
      mmW: dims[ax.h] * spacing[ax.h],
      mmH: dims[ax.v] * spacing[ax.v],
    };
  };
  const sampleAt = (p: Plane, a: number, b: number, s: number) => {
    const ax = axes[p];
    const c: [number, number, number] = [0, 0, 0];
    c[ax.slice] = s;
    c[ax.h] = ax.flipH ? dims[ax.h] - 1 - a : a;
    c[ax.v] = ax.flipV ? dims[ax.v] - 1 - b : b;
    return idx(dims, c[0], c[1], c[2]);
  };

  const draw = useCallback((p: Plane) => {
    const cv = canvases.current[p];
    if (!cv) return;
    const g = geom(p);
    const s = axisVal(cursor, g.axis.slice);
    if (cv.width !== g.w || cv.height !== g.h) { cv.width = g.w; cv.height = g.h; }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(g.w, g.h);
    const pix = image.current;
    const lab = labels.current;
    for (let b = 0; b < g.h; b++) {
      for (let a = 0; a < g.w; a++) {
        const flat = sampleAt(p, a, b, s);
        let gray = pix[flat] ?? 0;
        let r = gray, gg = gray, bl = gray;
        const v = lab[flat] ?? 0;
        if (v === 1) {
          r = Math.round(0.55 * gray + 0.45 * 61);
          gg = Math.round(0.55 * gray + 0.45 * 220);
          bl = Math.round(0.55 * gray + 0.45 * 132);
        } else if (v === 2) {
          r = Math.round(0.35 * gray + 0.65 * 242);
          gg = Math.round(0.35 * gray + 0.65 * 76);
          bl = Math.round(0.35 * gray + 0.65 * 56);
        }
        const o = ((g.h - 1 - b) * g.w + a) * 4;
        img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = bl; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const ax = axes[p];
    const c = [cursor.i, cursor.j, cursor.k];
    const ca = ax.flipH ? dims[ax.h] - 1 - c[ax.h] : c[ax.h];
    const cb = ax.flipV ? dims[ax.v] - 1 - c[ax.v] : c[ax.v];
    const y = g.h - 1 - cb;
    ctx.save();
    ctx.strokeStyle = PLANE_COLOR[p];
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(ca, 0); ctx.lineTo(ca, g.h);
    ctx.moveTo(0, y); ctx.lineTo(g.w, y);
    ctx.stroke();
    ctx.restore();
  }, [cursor, dims, axes]);

  useEffect(() => { PLANES.forEach(draw); }, [draw]);

  const move = (p: Plane, ev: React.MouseEvent<HTMLCanvasElement>) => {
    const g = geom(p);
    const rect = ev.currentTarget.getBoundingClientRect();
    const a = Math.min(g.w - 1, Math.max(0, Math.floor(((ev.clientX - rect.left) / rect.width) * g.w)));
    const b = g.h - 1 - Math.min(g.h - 1, Math.max(0, Math.floor(((ev.clientY - rect.top) / rect.height) * g.h)));
    const ax = axes[p];
    const ha = ax.flipH ? dims[ax.h] - 1 - a : a;
    const vb = ax.flipV ? dims[ax.v] - 1 - b : b;
    setCursor((c) => setAxis(setAxis(c, ax.h, ha), ax.v, vb));
  };

  return (
    <div className="grid gap-2 grid-cols-1 md:grid-cols-2 lg:h-[min(calc(100vh-180px),980px)]">
      {PLANES.map((p) => {
        const g = geom(p);
        const s = axisVal(cursor, g.axis.slice);
        return (
          <div key={p}
            onMouseEnter={() => setActive(p)}
            onWheel={(e) => {
              e.preventDefault();
              const delta = e.deltaY < 0 ? 0.15 : -0.15;
              setZoom((z) => ({ ...z, [p]: Math.min(4, Math.max(0.4, Number((z[p] + delta).toFixed(2)))) }));
            }}
            className="flex min-h-[280px] flex-col overflow-hidden rounded-lg border-2 bg-black p-1.5"
            style={{ borderColor: PLANE_COLOR[p], opacity: active === p ? 1 : 0.94 }}>
            <div className="mb-1 flex items-center justify-between px-1 text-[10px] uppercase tracking-wider"
              style={{ color: PLANE_COLOR[p] }}>
              <span>{p}</span>
              <span className="tabular-nums text-neutral-400">{s + 1}/{g.depth} · {zoom[p].toFixed(1)}x</span>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
              <div className="flex h-full w-full items-center justify-center"
                style={{ transform: `scale(${zoom[p]})`, transformOrigin: "center" }}>
                <canvas
                  ref={(el) => { canvases.current[p] = el; }}
                  onMouseDown={(e) => move(p, e)}
                  className="cursor-crosshair rounded"
                  style={{ aspectRatio: `${g.mmW} / ${g.mmH}`, maxWidth: "100%", maxHeight: "100%" }}
                />
              </div>
            </div>
            <input type="range" min={0} max={Math.max(0, g.depth - 1)} value={s}
              onChange={(e) => setCursor((c) => setAxis(c, g.axis.slice, Number(e.target.value)))}
              className="mt-1 w-full" />
          </div>
        );
      })}

      <div className="space-y-2 overflow-auto">
        <Render3D
          labels={labels.current}
          dims={dims}
          spacing={spacing}
          orient={orient}
          segments={SEGMENTS}
        />
        <div className="rounded-lg border border-border bg-card p-3 text-xs">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <span className="font-semibold">{result.edema_present ? "Edema present" : "Edema not seen"}</span>
            <span className="tabular-nums text-muted-foreground">
              {dims.join(" × ")} · {spacing.map((s) => s.toFixed(2)).join(" × ")} mm
            </span>
          </div>
          <table className="w-full tabular-nums">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="pb-1 font-medium">Segment</th>
                <th className="pb-1 text-right font-medium">Voxels</th>
                <th className="pb-1 text-right font-medium">mm³</th>
                <th className="pb-1 text-right font-medium">cm³</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="py-0.5"><span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-[#3ddc84]" />Bone marrow</td>
                <td className="py-0.5 text-right">{result.bone_voxels.toLocaleString()}</td>
                <td className="py-0.5 text-right">{result.bone_mm3.toLocaleString()}</td>
                <td className="py-0.5 text-right">{(result.bone_mm3 / 1000).toFixed(3)}</td>
              </tr>
              <tr>
                <td className="py-0.5"><span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-[#f24c38]" />Edema (BME)</td>
                <td className="py-0.5 text-right">{result.bme_voxels.toLocaleString()}</td>
                <td className="py-0.5 text-right">{result.volume_mm3.toLocaleString()}</td>
                <td className="py-0.5 text-right">{result.volume_cm3.toFixed(3)}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-muted-foreground">
            {result.lesion_count} lesion{result.lesion_count === 1 ? "" : "s"}
            {result.fraction_of_bone != null ? ` · ${(result.fraction_of_bone * 100).toFixed(2)}% of predicted bone` : ""}
            {" · "}{result.folds} folds · {result.device}
          </p>
          <p className="mt-1 text-muted-foreground">{result.filename}. Click a view to move the crosshair. Scroll to zoom that view.</p>
        </div>
      </div>
    </div>
  );
}

export default function Test3D({ ready = false }: { ready?: boolean }) {
  const [trained, setTrained] = useState<boolean | null>(ready ? true : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => { if (ready) setTrained(true); }, [ready]);
  useEffect(() => {
    fetch("/api/predict-3d", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (j.trained) setTrained(true); else if (!ready) setTrained(false); })
      .catch(() => { if (!ready) setTrained(false); });
  }, [ready]);

  const enabled = ready || trained === true;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body = new FormData();
      body.set("file", file);
      const r = await fetch("/api/predict-3d", { method: "POST", body });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "failed");
      setResult(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="text-sm font-semibold">Test one scan</div>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload the scan <code className="rounded bg-muted px-1">.nrrd</code>, the same file 3D Slicer saves.
          The direction in the file decides which way is axial, coronal, and sagittal, and the three views stay linked.
        </p>
        <label className={`mt-3 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground ${!enabled || busy ? "pointer-events-none opacity-40" : "cursor-pointer"}`}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageUp className="h-4 w-4" />}
          {busy ? "Running" : "Choose NRRD"}
          <input type="file" accept=".nrrd" className="hidden" disabled={!enabled || busy}
            onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
        {!enabled && (
          <p className="mt-3 text-xs text-muted-foreground">
            No 3D weights yet. Open Training, use the 3D tab, and train the model first.
          </p>
        )}
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>
      {result && <FourUp result={result} />}
    </div>
  );
}
