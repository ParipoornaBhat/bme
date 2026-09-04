"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  Eraser,
  Layers,
  Loader2,
  Paintbrush,
  RotateCcw,
  Save,
  Search,
  Trash2,
} from "lucide-react";

export type Case2DSlice = {
  caseId: string;
  label: "bme" | "non_bme";
  relPath: string;
  stem: string;
  hasMask: boolean;
  maskSavedAt: string | null;
};

const LABELS = [
  { id: 1, name: "Bone Marrow", color: "rgba(16, 185, 129, 0.45)", stroke: "#10b981", badge: "bg-emerald-500/20 text-emerald-400 border-emerald-500/40" },
  { id: 2, name: "BME Lesion", color: "rgba(239, 68, 68, 0.55)", stroke: "#ef4444", badge: "bg-red-500/20 text-red-400 border-red-500/40" },
  { id: 3, name: "Uncertain", color: "rgba(245, 158, 11, 0.50)", stroke: "#f59e0b", badge: "bg-amber-500/20 text-amber-400 border-amber-500/40" },
] as const;

export default function Painter2D() {
  const [slices, setSlices] = useState<Case2DSlice[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Case2DSlice | null>(null);
  const [filter, setFilter] = useState<"all" | "bme" | "non_bme" | "annotated" | "unannotated">("all");
  const [query, setQuery] = useState("");

  const [activeLabel, setActiveLabel] = useState<number>(1);
  const [brushSize, setBrushSize] = useState(12);
  const [isErasing, setIsErasing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  const [imgDim, setImgDim] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [counts, setCounts] = useState<{ bone: number; bme: number; uncertain: number }>({ bone: 0, bme: 0, uncertain: 0 });

  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskDataRef = useRef<Uint8Array | null>(null);
  const undoStackRef = useRef<Uint8Array[]>([]);
  const isDrawingRef = useRef(false);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

  const loadSlices = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/cases2d", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setSlices(data.slices || []);
      if (!selected && data.slices?.length > 0) {
        setSelected(data.slices[0]);
      }
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    loadSlices();
  }, [loadSlices]);

  const renderMaskToCanvas = useCallback(() => {
    const canvas = maskCanvasRef.current;
    const mask = maskDataRef.current;
    if (!canvas || !mask || imgDim.w === 0 || imgDim.h === 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const imgData = ctx.createImageData(imgDim.w, imgDim.h);
    const data = imgData.data;

    let bCount = 0, lCount = 0, uCount = 0;

    for (let i = 0; i < mask.length; i++) {
      const v = mask[i];
      const p = i * 4;
      if (v === 1) {
        // Bone: Green
        data[p] = 16;
        data[p + 1] = 185;
        data[p + 2] = 129;
        data[p + 3] = 115;
        bCount++;
      } else if (v === 2) {
        // BME: Red
        data[p] = 239;
        data[p + 1] = 68;
        data[p + 2] = 68;
        data[p + 3] = 140;
        lCount++;
      } else if (v === 3) {
        // Uncertain: Amber
        data[p] = 245;
        data[p + 1] = 158;
        data[p + 2] = 11;
        data[p + 3] = 128;
        uCount++;
      } else {
        data[p + 3] = 0;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    setCounts({ bone: bCount, bme: lCount, uncertain: uCount });
  }, [imgDim]);

  const pushUndo = () => {
    if (!maskDataRef.current) return;
    undoStackRef.current.push(new Uint8Array(maskDataRef.current));
    if (undoStackRef.current.length > 20) {
      undoStackRef.current.shift();
    }
  };

  const undo = () => {
    const prev = undoStackRef.current.pop();
    if (prev && maskDataRef.current) {
      maskDataRef.current.set(prev);
      renderMaskToCanvas();
    }
  };

  const clearMask = () => {
    if (!maskDataRef.current) return;
    pushUndo();
    maskDataRef.current.fill(0);
    renderMaskToCanvas();
  };

  // Load image and existing mask on slice change
  useEffect(() => {
    if (!selected) return;

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = `/api/cases2d?image=${encodeURIComponent(selected.relPath)}`;

    img.onload = async () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      setImgDim({ w, h });

      // Draw background scan
      const bgCanvas = bgCanvasRef.current;
      if (bgCanvas) {
        bgCanvas.width = w;
        bgCanvas.height = h;
        const bgCtx = bgCanvas.getContext("2d");
        if (bgCtx) {
          bgCtx.drawImage(img, 0, 0);
        }
      }

      // Initialize mask array
      const maskCanvas = maskCanvasRef.current;
      if (maskCanvas) {
        maskCanvas.width = w;
        maskCanvas.height = h;
      }

      const maskArr = new Uint8Array(w * h);
      maskDataRef.current = maskArr;
      undoStackRef.current = [];

      // Try to load existing mask
      try {
        const maskRes = await fetch(
          `/api/annotation2d/${selected.caseId}?stem=${encodeURIComponent(selected.stem)}&raw=true`,
        );
        if (maskRes.ok && maskRes.headers.get("content-type")?.includes("image")) {
          const blob = await maskRes.blob();
          const maskImg = new Image();
          maskImg.src = URL.createObjectURL(blob);
          maskImg.onload = () => {
            const off = document.createElement("canvas");
            off.width = w;
            off.height = h;
            const offCtx = off.getContext("2d");
            if (offCtx) {
              offCtx.drawImage(maskImg, 0, 0, w, h);
              const pxData = offCtx.getImageData(0, 0, w, h).data;
              for (let i = 0; i < maskArr.length; i++) {
                maskArr[i] = pxData[i * 4]; // Grayscale value 0, 1, 2, 3
              }
              renderMaskToCanvas();
            }
          };
        } else {
          renderMaskToCanvas();
        }
      } catch {
        renderMaskToCanvas();
      }
    };
  }, [selected, renderMaskToCanvas]);

  // Painting drawing logic
  const paintAt = (cx: number, cy: number) => {
    const mask = maskDataRef.current;
    if (!mask || imgDim.w === 0 || imgDim.h === 0) return;

    const val = isErasing ? 0 : activeLabel;
    const r = Math.max(1, Math.round(brushSize / 2));
    const r2 = r * r;

    const minX = Math.max(0, cx - r);
    const maxX = Math.min(imgDim.w - 1, cx + r);
    const minY = Math.max(0, cy - r);
    const maxY = Math.min(imgDim.h - 1, cy + r);

    for (let y = minY; y <= maxY; y++) {
      const dy2 = (y - cy) * (y - cy);
      const rowOffset = y * imgDim.w;
      for (let x = minX; x <= maxX; x++) {
        if ((x - cx) * (x - cx) + dy2 <= r2) {
          mask[rowOffset + x] = val;
        }
      }
    }
  };

  const getCanvasCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = maskCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    };
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    pushUndo();
    isDrawingRef.current = true;
    const pos = getCanvasCoords(e);
    lastPosRef.current = pos;
    paintAt(pos.x, pos.y);
    renderMaskToCanvas();
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    const pos = getCanvasCoords(e);
    const last = lastPosRef.current || pos;

    // Line interpolation between mouse move steps
    const dist = Math.hypot(pos.x - last.x, pos.y - last.y);
    const steps = Math.max(1, Math.ceil(dist / 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      paintAt(Math.round(last.x + (pos.x - last.x) * t), Math.round(last.y + (pos.y - last.y) * t));
    }

    lastPosRef.current = pos;
    renderMaskToCanvas();
  };

  const handleMouseUp = () => {
    isDrawingRef.current = false;
    lastPosRef.current = null;
  };

  const saveMask = async () => {
    if (!selected || !maskDataRef.current || imgDim.w === 0 || imgDim.h === 0) return;
    setSaving(true);
    setSavedSuccess(false);

    try {
      const res = await fetch(
        `/api/annotation2d/${selected.caseId}?stem=${encodeURIComponent(selected.stem)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            width: imgDim.w,
            height: imgDim.h,
            pixels: Array.from(maskDataRef.current),
          }),
        },
      );

      if (res.ok) {
        setSavedSuccess(true);
        setTimeout(() => setSavedSuccess(false), 2500);
        // Refresh local slice state
        setSlices((prev) =>
          prev.map((s) =>
            s.relPath === selected.relPath
              ? { ...s, hasMask: true, maskSavedAt: new Date().toISOString() }
              : s,
          ),
        );
      } else {
        alert("Failed to save mask");
      }
    } finally {
      setSaving(false);
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "1") { setActiveLabel(1); setIsErasing(false); }
      else if (e.key === "2") { setActiveLabel(2); setIsErasing(false); }
      else if (e.key === "3") { setActiveLabel(3); setIsErasing(false); }
      else if (e.key === "0" || e.key.toLowerCase() === "e") { setIsErasing(true); }
      else if (e.key === "z" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); }
      else if (e.key === "s" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveMask(); }
      else if (e.key === "[") { setBrushSize((b) => Math.max(2, b - 4)); }
      else if (e.key === "]") { setBrushSize((b) => Math.min(60, b + 4)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, saveMask]);

  const filtered = slices.filter((s) => {
    if (filter === "bme" && s.label !== "bme") return false;
    if (filter === "non_bme" && s.label !== "non_bme") return false;
    if (filter === "annotated" && !s.hasMask) return false;
    if (filter === "unannotated" && s.hasMask) return false;
    if (query) {
      const q = query.toLowerCase();
      return s.caseId.toLowerCase().includes(q) || s.stem.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      {/* Left sidebar: Slice list */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 h-[750px]">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search 2D slices..."
            className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-sm"
          />
        </div>

        <div className="flex flex-wrap gap-1 text-xs">
          {(["all", "bme", "non_bme", "annotated", "unannotated"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded px-2 py-1 transition ${
                filter === f
                  ? "bg-primary text-primary-foreground font-medium"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {f.replace("_", " ")}
            </button>
          ))}
        </div>

        <div className="text-xs text-muted-foreground font-medium">
          Showing {filtered.length} of {slices.length} slices
          ({slices.filter((s) => s.hasMask).length} annotated)
        </div>

        <div className="flex-1 overflow-y-auto space-y-1 pr-1">
          {loading ? (
            <div className="py-12 text-center text-xs text-muted-foreground">
              <Loader2 className="mx-auto h-4 w-4 animate-spin mb-2" />
              Loading 2D slices...
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-xs text-muted-foreground">No slices match.</div>
          ) : (
            filtered.map((s) => {
              const active = selected?.relPath === s.relPath;
              return (
                <button
                  key={s.relPath}
                  onClick={() => setSelected(s)}
                  className={`w-full flex items-center justify-between rounded px-2.5 py-2 text-left text-xs transition border ${
                    active
                      ? "border-primary bg-primary/10 text-foreground font-medium"
                      : "border-transparent hover:bg-muted/60 text-muted-foreground"
                  }`}
                >
                  <div className="truncate pr-2">
                    <span className="font-mono font-medium text-foreground">{s.caseId}</span>
                    <span className="ml-1.5 opacity-60 text-[10px] truncate">{s.stem}</span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span
                      className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                        s.label === "bme" ? "bg-red-500/15 text-red-400" : "bg-blue-500/15 text-blue-400"
                      }`}
                    >
                      {s.label === "bme" ? "BME" : "Non-BME"}
                    </span>
                    {s.hasMask && (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right side: 2D Canvas Editor */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 h-[750px]">
        {/* Editor Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mr-1">
              Label:
            </span>
            {LABELS.map((l) => (
              <button
                key={l.id}
                onClick={() => { setActiveLabel(l.id); setIsErasing(false); }}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition ${
                  !isErasing && activeLabel === l.id
                    ? `${l.badge} ring-1 ring-primary`
                    : "border-border bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.stroke }} />
                {l.name} <span className="text-[10px] opacity-60">({l.id})</span>
              </button>
            ))}

            <button
              onClick={() => setIsErasing(true)}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition ${
                isErasing
                  ? "border-destructive bg-destructive/10 text-destructive ring-1 ring-destructive"
                  : "border-border bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              <Eraser className="h-3.5 w-3.5" /> Eraser <span className="text-[10px] opacity-60">(0)</span>
            </button>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Paintbrush className="h-3.5 w-3.5" />
              <span>Brush: {brushSize}px</span>
              <input
                type="range"
                min={2}
                max={50}
                value={brushSize}
                onChange={(e) => setBrushSize(Number(e.target.value))}
                className="w-20 accent-primary"
              />
            </div>

            <button
              onClick={undo}
              title="Undo (Ctrl+Z)"
              className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="h-3 w-3" /> Undo
            </button>

            <button
              onClick={clearMask}
              title="Clear Mask"
              className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-xs text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3 w-3" />
            </button>

            <button
              onClick={saveMask}
              disabled={saving || !selected}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition ${
                savedSuccess
                  ? "bg-emerald-600 text-white"
                  : "bg-primary text-primary-foreground hover:bg-primary/90"
              }`}
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : savedSuccess ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {savedSuccess ? "Saved!" : "Save Mask"}
            </button>
          </div>
        </div>

        {/* Info bar */}
        {selected && (
          <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
            <div className="flex items-center gap-3">
              <span className="font-mono font-medium text-foreground">{selected.caseId}</span>
              <span>{selected.stem}.png</span>
              <span>{imgDim.w} &times; {imgDim.h} px</span>
            </div>
            <div className="flex items-center gap-3">
              <span>Bone: <strong className="text-emerald-400 font-mono">{counts.bone}</strong> px</span>
              <span>BME: <strong className="text-red-400 font-mono">{counts.bme}</strong> px</span>
              {counts.uncertain > 0 && <span>Uncertain: <strong className="text-amber-400 font-mono">{counts.uncertain}</strong> px</span>}
            </div>
          </div>
        )}

        {/* Viewport Canvas Container */}
        <div className="relative flex-1 overflow-auto rounded border border-border/80 bg-black/90 flex items-center justify-center select-none p-4">
          <div
            className="relative shadow-2xl inline-block"
            style={{ width: imgDim.w || 512, height: imgDim.h || 512 }}
          >
            {/* Base MRI image canvas */}
            <canvas
              ref={bgCanvasRef}
              className="absolute inset-0 block pointer-events-none"
            />
            {/* Drawing mask layer canvas */}
            <canvas
              ref={maskCanvasRef}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              className="absolute inset-0 block cursor-crosshair"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
