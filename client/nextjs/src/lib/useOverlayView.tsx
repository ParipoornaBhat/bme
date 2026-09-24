"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

export type OverlayViewMode = "both" | "lesion" | "bone" | "none";

export type MaskCounts = {
  bone: number;
  bme: number;
  uncertain: number;
};

/**
 * Pure helper deciding if a label (1 = Bone Marrow, 2 = BME Lesion, 3 = Uncertain)
 * should be rendered under the given view mode.
 */
export function isLabelVisible(label: number, view: OverlayViewMode): boolean {
  if (view === "none" || label === 0) return false;
  if (view === "both") return true;
  if (view === "lesion") return label === 2;
  if (view === "bone") return label === 1;
  return false;
}

/**
 * Derives the Set of hidden segment values for 3D rendering.
 */
export function hiddenLabelsForView(view: OverlayViewMode): Set<number> {
  if (view === "both") return new Set();
  if (view === "lesion") return new Set([1, 3]);
  if (view === "bone") return new Set([2, 3]);
  if (view === "none") return new Set([1, 2, 3]);
  return new Set();
}

/**
 * Pure helper: paints labels onto a RGBA pixel array (e.g. ImageData.data).
 * Always calculates accurate counts for all labels regardless of view mode.
 * Labels not visible in `view` receive alpha 0.
 */
export function renderLabels(
  mask: Uint8Array,
  width: number,
  height: number,
  view: OverlayViewMode,
  outData?: Uint8ClampedArray
): { data: Uint8ClampedArray; counts: MaskCounts } {
  const data = outData ?? new Uint8ClampedArray(width * height * 4);
  let bCount = 0;
  let lCount = 0;
  let uCount = 0;
  const len = width * height;

  for (let i = 0; i < len; i++) {
    const v = mask[i];
    const p = i * 4;

    if (v === 1) {
      bCount++;
      if (isLabelVisible(1, view)) {
        // Bone: Green rgba(16, 185, 129, 165)
        data[p] = 16;
        data[p + 1] = 185;
        data[p + 2] = 129;
        data[p + 3] = 165;
      } else {
        data[p] = 0;
        data[p + 1] = 0;
        data[p + 2] = 0;
        data[p + 3] = 0;
      }
    } else if (v === 2) {
      lCount++;
      if (isLabelVisible(2, view)) {
        // BME: Red rgba(239, 68, 68, 185)
        data[p] = 239;
        data[p + 1] = 68;
        data[p + 2] = 68;
        data[p + 3] = 185;
      } else {
        data[p] = 0;
        data[p + 1] = 0;
        data[p + 2] = 0;
        data[p + 3] = 0;
      }
    } else if (v === 3) {
      uCount++;
      if (isLabelVisible(3, view)) {
        // Uncertain: Amber rgba(245, 158, 11, 175)
        data[p] = 245;
        data[p + 1] = 158;
        data[p + 2] = 11;
        data[p + 3] = 175;
      } else {
        data[p] = 0;
        data[p + 1] = 0;
        data[p + 2] = 0;
        data[p + 3] = 0;
      }
    } else {
      data[p] = 0;
      data[p + 1] = 0;
      data[p + 2] = 0;
      data[p + 3] = 0;
    }
  }

  return {
    data,
    counts: { bone: bCount, bme: lCount, uncertain: uCount },
  };
}

/**
 * Pure helper for 3D slice rendering blend.
 * Colour weight = 0.55 * (opacity / 100), grey weight = 1 - colour weight.
 * At opacity 100: reproduces 0.45 grey + 0.55 colour.
 * At opacity 0: pure grey.
 */
export function blendLabel(
  grey: number,
  rgb: [number, number, number],
  opacity: number
): [number, number, number] {
  const clampedOp = Math.max(0, Math.min(100, opacity));
  const wCol = 0.55 * (clampedOp / 100);
  const wGrey = 1 - wCol;
  return [
    Math.round(grey * wGrey + rgb[0] * wCol),
    Math.round(grey * wGrey + rgb[1] * wCol),
    Math.round(grey * wGrey + rgb[2] * wCol),
  ];
}

const STORAGE_KEY = "bme_overlay_view";

export function useOverlayView() {
  const [opacity, setOpacityState] = useState<number>(100);
  const [view, setViewState] = useState<OverlayViewMode>("both");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.opacity === "number" && parsed.opacity >= 0 && parsed.opacity <= 100) {
          setOpacityState(parsed.opacity);
        }
        if (["both", "lesion", "bone", "none"].includes(parsed.view)) {
          setViewState(parsed.view);
        }
      }
    } catch {
      // LocalStorage access may fail in restricted contexts; fall back to defaults
    }
  }, []);

  const setOpacity = useCallback((val: number | ((prev: number) => number)) => {
    setOpacityState((prev) => {
      const next = Math.max(0, Math.min(100, typeof val === "function" ? val(prev) : val));
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        const current = saved ? JSON.parse(saved) : {};
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, opacity: next }));
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  const setView = useCallback((val: OverlayViewMode | ((prev: OverlayViewMode) => OverlayViewMode)) => {
    setViewState((prev) => {
      const next = typeof val === "function" ? val(prev) : val;
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        const current = saved ? JSON.parse(saved) : {};
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, view: next }));
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  const cycleView = useCallback(() => {
    const order: OverlayViewMode[] = ["both", "lesion", "bone", "none"];
    setView((curr) => {
      const idx = order.indexOf(curr);
      return order[(idx + 1) % order.length];
    });
  }, [setView]);

  return {
    opacity,
    view,
    setOpacity,
    setView,
    cycleView,
  };
}

export function OverlayControls({
  view,
  setView,
  opacity,
  setOpacity,
  compact = false,
}: {
  view: OverlayViewMode;
  setView: (v: OverlayViewMode) => void;
  opacity: number;
  setOpacity: (o: number) => void;
  compact?: boolean;
}) {
  return (
    <div className={`flex items-center ${compact ? "gap-1.5" : "gap-2.5"}`}>
      {/* Segmented View Mode: Both | Red | Green | None */}
      <div className="inline-flex overflow-hidden rounded-md border border-border bg-background p-0.5 text-xs shadow-2xs">
        <button
          type="button"
          onClick={() => setView("both")}
          title="Show both Bone and Lesion labels (Key V to cycle)"
          className={`px-2 py-0.5 rounded text-[11px] font-medium transition cursor-pointer ${
            view === "both"
              ? "bg-primary text-primary-foreground font-semibold shadow-xs"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
          }`}
        >
          Both
        </button>
        <button
          type="button"
          onClick={() => setView("lesion")}
          title="Show only BME Lesion (Red) (Key V to cycle)"
          className={`px-2 py-0.5 rounded text-[11px] font-medium transition cursor-pointer ${
            view === "lesion"
              ? "bg-red-600 text-white font-semibold shadow-xs"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
          }`}
        >
          Red
        </button>
        <button
          type="button"
          onClick={() => setView("bone")}
          title="Show only Bone Marrow (Green) (Key V to cycle)"
          className={`px-2 py-0.5 rounded text-[11px] font-medium transition cursor-pointer ${
            view === "bone"
              ? "bg-emerald-600 text-white font-semibold shadow-xs"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
          }`}
        >
          Green
        </button>
        <button
          type="button"
          onClick={() => setView("none")}
          title="Hide all labels (Key V to cycle)"
          className={`px-2 py-0.5 rounded text-[11px] font-medium transition cursor-pointer ${
            view === "none"
              ? "bg-muted text-foreground font-semibold shadow-xs"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
          }`}
        >
          None
        </button>
      </div>

      {/* Opacity Slider */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="text-[11px] font-medium select-none hidden sm:inline">Opacity:</span>
        <input
          type="range"
          min={0}
          max={100}
          value={opacity}
          onChange={(e) => setOpacity(Number(e.target.value))}
          className={`${compact ? "w-14" : "w-16 sm:w-20"} accent-primary cursor-pointer h-1.5 bg-muted rounded-lg`}
          title={`Mask opacity: ${opacity}%`}
        />
        <span className="w-7 text-[10px] tabular-nums font-mono text-muted-foreground">{opacity}%</span>
      </div>
    </div>
  );
}
