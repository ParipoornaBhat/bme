"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  Eraser,
  Lasso,
  Layers,
  Loader2,
  Maximize2,
  Move,
  Paintbrush,
  RotateCcw,
  Save,
  Search,
  Trash2,
  ZoomIn,
  ZoomOut,
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
  const [tool, setTool] = useState<"brush" | "pencil">("brush");
  const [maskInside, setMaskInside] = useState(false);
  const [activeLabel, setActiveLabel] = useState<number>(1);
  const [brushSize, setBrushSize] = useState(12);
  const [isErasing, setIsErasing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  const [imgDim, setImgDim] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [counts, setCounts] = useState<{ bone: number; bme: number; uncertain: number }>({ bone: 0, bme: 0, uncertain: 0 });

  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const maskDataRef = useRef<Uint8Array | null>(null);
  const imgDimRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const undoStackRef = useRef<Uint8Array[]>([]);
  const isDrawingRef = useRef(false);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);
  const outlineRef = useRef<Array<[number, number]>>([]);
  const lastLoadedStemRef = useRef<string>("");

  const resetZoom = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // Load slices once on mount
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setLoading(true);
        const res = await fetch("/api/cases2d", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!mounted) return;
        const list: Case2DSlice[] = data.slices || [];
        setSlices(list);
        setSelected((prev) => prev ?? (list.length > 0 ? list[0] : null));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const renderMaskToCanvas = useCallback(() => {
    const canvas = maskCanvasRef.current;
    const mask = maskDataRef.current;
    const { w, h } = imgDimRef.current;
    if (!canvas || !mask || w === 0 || h === 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const imgData = ctx.createImageData(w, h);
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
  }, []);

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

  const selectedRelPath = selected?.relPath;
  const selectedCaseId = selected?.caseId;
  const selectedStem = selected?.stem;

  // Load image and existing mask on slice change
  useEffect(() => {
    if (!selectedRelPath || !selectedCaseId || !selectedStem) return;

    const sliceKey = `${selectedCaseId}/${selectedStem}`;
    if (lastLoadedStemRef.current === sliceKey) {
      return;
    }
    lastLoadedStemRef.current = sliceKey;

    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = `/api/cases2d?image=${encodeURIComponent(selectedRelPath)}`;

    img.onload = async () => {
      if (cancelled) return;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      imgDimRef.current = { w, h };
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

      const overlayCanvas = overlayCanvasRef.current;
      if (overlayCanvas) {
        overlayCanvas.width = w;
        overlayCanvas.height = h;
      }

      const maskArr = new Uint8Array(w * h);
      maskDataRef.current = maskArr;
      undoStackRef.current = [];

      // Try to load existing mask
      try {
        const maskRes = await fetch(
          `/api/annotation2d/${selectedCaseId}?stem=${encodeURIComponent(selectedStem)}&raw=true`,
        );
        if (cancelled) return;
        if (maskRes.ok && maskRes.headers.get("content-type")?.includes("image")) {
          const blob = await maskRes.blob();
          if (cancelled) return;
          const maskImg = new Image();
          const blobUrl = URL.createObjectURL(blob);
          maskImg.src = blobUrl;
          maskImg.onload = () => {
            URL.revokeObjectURL(blobUrl);
            if (cancelled) return;
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
        if (!cancelled) renderMaskToCanvas();
      }
    };

  return () => {
      cancelled = true;
    };
  }, [selectedRelPath, selectedCaseId, selectedStem, renderMaskToCanvas]);

  // Clear overlay canvas
  const clearOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  // Redraw live pencil polygon outline
  const drawOutlineOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const pts = outlineRef.current;
    if (pts.length < 2) return;

    ctx.save();
    const strokeColor = isErasing
      ? "#ef4444"
      : activeLabel === 1
      ? "#10b981"
      : activeLabel === 2
      ? "#ef4444"
      : "#f59e0b";

    const fillColor = isErasing
      ? "rgba(239, 68, 68, 0.15)"
      : activeLabel === 1
      ? "rgba(16, 185, 129, 0.18)"
      : activeLabel === 2
      ? "rgba(239, 68, 68, 0.22)"
      : "rgba(245, 158, 11, 0.20)";

    // Draw polygon fill preview
    ctx.fillStyle = fillColor;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i][0], pts[i][1]);
    }
    ctx.closePath();
    ctx.fill();

    // Draw clear, solid, non-dotted boundary line
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.setLineDash([]); // SOLID line, NOT dotted

    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i][0], pts[i][1]);
    }
    ctx.stroke();

    ctx.restore();
  }, [isErasing, activeLabel]);

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
          const idx = rowOffset + x;
          // Only inside bone guard: prevents accidental painting outside bone marrow
          if (maskInside && !isErasing && activeLabel !== 1 && mask[idx] !== 1 && mask[idx] !== activeLabel) {
            continue;
          }
          mask[idx] = val;
        }
      }
    }
  };

  /**
   * Pencil: close the traced outline and fill everything inside it using even-odd scanline fill.
   */
  const commitOutline = useCallback(() => {
    const pts = outlineRef.current;
    outlineRef.current = [];
    clearOverlay();

    const mask = maskDataRef.current;
    const { w, h } = imgDimRef.current;
    if (!mask || w === 0 || h === 0 || pts.length < 3) {
      return;
    }

    pushUndo();

    let minB = Infinity,
      maxB = -Infinity;
    for (const [, b] of pts) {
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
    }
    minB = Math.max(0, Math.floor(minB));
    maxB = Math.min(h - 1, Math.ceil(maxB));

    const val = isErasing ? 0 : activeLabel;

    for (let b = minB; b <= maxB; b++) {
      const xs: number[] = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [ax, ay] = pts[i],
          [bx, by] = pts[j];
        if (ay > b !== by > b) {
          xs.push(ax + ((b - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((m, n) => m - n);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil(xs[k]));
        const to = Math.min(w - 1, Math.floor(xs[k + 1]));
        const rowOffset = b * w;
        for (let a = from; a <= to; a++) {
          const idx = rowOffset + a;
          if (maskInside && !isErasing && activeLabel !== 1 && mask[idx] !== 1 && mask[idx] !== activeLabel) {
            continue;
          }
          mask[idx] = val;
        }
      }
    }

    renderMaskToCanvas();
  }, [clearOverlay, isErasing, activeLabel, maskInside, renderMaskToCanvas]);

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
    const pos = getCanvasCoords(e);

    if (tool === "pencil") {
      isDrawingRef.current = true;
      outlineRef.current = [[pos.x, pos.y]];
      drawOutlineOverlay();
      return;
    }

    pushUndo();
    isDrawingRef.current = true;
    lastPosRef.current = pos;
    paintAt(pos.x, pos.y);
    renderMaskToCanvas();
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    const pos = getCanvasCoords(e);

    if (tool === "pencil") {
      const pts = outlineRef.current;
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(pos.x - last[0], pos.y - last[1]) >= 2) {
        pts.push([pos.x, pos.y]);
        drawOutlineOverlay();
      }
      return;
    }

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
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    lastPosRef.current = null;

    if (tool === "pencil") {
      commitOutline();
    }
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
      else if (e.key === "0" || e.key.toLowerCase() === "e") { setIsErasing((prev) => !prev); }
      else if (e.key.toLowerCase() === "p") { setTool((t) => (t === "brush" ? "pencil" : "brush")); }
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
    <div className="grid gap-3 lg:grid-cols-[270px_minmax(0,1fr)] h-[calc(100vh-115px)]">
      {/* Left sidebar: Slice list */}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2.5 h-full overflow-hidden">
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
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 h-full overflow-hidden">
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

            <div className="mx-1 h-5 w-px bg-border" />

            {/* Tool Mode: Brush vs Pencil (Lasso Outline) */}
            <div className="inline-flex overflow-hidden rounded-md border border-border">
              <button
                type="button"
                onClick={() => setTool("brush")}
                title="Brush mode (P toggles)"
                className={`inline-flex items-center gap-1 px-2 py-1 text-xs transition ${
                  tool === "brush" ? "bg-primary text-primary-foreground font-medium" : "bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                <Paintbrush className="h-3 w-3" /> Brush
              </button>
              <button
                type="button"
                onClick={() => setTool("pencil")}
                title="Pencil mode — trace an outline, the inside auto-fills (P toggles)"
                className={`inline-flex items-center gap-1 border-l border-border px-2 py-1 text-xs transition ${
                  tool === "pencil" ? "bg-primary text-primary-foreground font-medium" : "bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                <Lasso className="h-3 w-3" /> Pencil
              </button>
            </div>

            <button
              onClick={() => setIsErasing((e) => !e)}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition ${
                isErasing
                  ? "border-destructive bg-destructive/10 text-destructive ring-1 ring-destructive"
                  : "border-border bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              <Eraser className="h-3.5 w-3.5" /> Eraser <span className="text-[10px] opacity-60">(E)</span>
            </button>

            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none ml-1">
              <input
                type="checkbox"
                checked={maskInside}
                onChange={(e) => setMaskInside(e.target.checked)}
                className="rounded border-border accent-primary h-3.5 w-3.5"
              />
              <span>Only inside bone</span>
            </label>
          </div>

          <div className="flex items-center gap-3">
            {tool === "brush" && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Paintbrush className="h-3.5 w-3.5" />
                <span>Size: {brushSize}px</span>
                <input
                  type="range"
                  min={2}
                  max={50}
                  value={brushSize}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                  className="w-20 accent-primary"
                />
              </div>
            )}

            {/* Zoom Controls */}
            <div className="flex items-center gap-1 border-l border-border pl-2">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(0.4, Number((z - 0.2).toFixed(1))))}
                title="Zoom Out"
                className="inline-flex items-center justify-center h-7 w-7 rounded border border-border bg-background text-muted-foreground hover:text-foreground transition"
              >
                <ZoomOut className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={resetZoom}
                title="Reset Zoom to 100%"
                className="px-1.5 py-0.5 rounded text-xs font-mono font-medium text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(4, Number((z + 0.2).toFixed(1))))}
                title="Zoom In"
                className="inline-flex items-center justify-center h-7 w-7 rounded border border-border bg-background text-muted-foreground hover:text-foreground transition"
              >
                <ZoomIn className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={resetZoom}
                title="Fit / Reset"
                className="inline-flex items-center justify-center h-7 w-7 rounded border border-border bg-background text-muted-foreground hover:text-foreground transition"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
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

        {/* Viewport Canvas Container with Zoom and Pan */}
        <div
          ref={viewportRef}
          className="relative flex-1 overflow-hidden rounded border border-border/80 bg-black/95 flex items-center justify-center select-none p-2 cursor-default"
          onWheel={(e) => {
            e.preventDefault();
            const delta = e.deltaY < 0 ? 0.15 : -0.15;
            setZoom((z) => Math.min(4, Math.max(0.4, Number((z + delta).toFixed(2)))));
          }}
        >
          <div
            className="relative shadow-2xl inline-block transition-transform duration-75 origin-center"
            style={{
              width: imgDim.w || 512,
              height: imgDim.h || 512,
              transform: `scale(${zoom}) translate(${pan.x}px, ${pan.y}px)`,
            }}
          >
            {/* Base MRI image as rock-solid <img> element (never blanks or wipes) */}
            {selected && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/cases2d?image=${encodeURIComponent(selected.relPath)}`}
                alt={selected.stem}
                className="absolute inset-0 block pointer-events-none select-none w-full h-full object-contain"
                style={{ imageRendering: "pixelated" }}
              />
            )}
            {/* Drawing mask layer canvas */}
            <canvas
              ref={maskCanvasRef}
              width={imgDim.w || 512}
              height={imgDim.h || 512}
              style={{ width: "100%", height: "100%" }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              className="absolute inset-0 block cursor-crosshair"
            />
            {/* Live pencil polygon overlay preview canvas */}
            <canvas
              ref={overlayCanvasRef}
              width={imgDim.w || 512}
              height={imgDim.h || 512}
              style={{ width: "100%", height: "100%" }}
              className="absolute inset-0 block pointer-events-none"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
