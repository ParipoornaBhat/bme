"use client";

import React from "react";

export interface OverlayQuickControlsProps {
  opacity: number;
  setOpacity: (val: number | ((prev: number) => number)) => void;
  outline: boolean;
  setOutline: (val: boolean | ((prev: boolean) => boolean)) => void;
  className?: string;
}

export function OverlayQuickControls({
  opacity,
  setOpacity,
  outline,
  setOutline,
  className = "",
}: OverlayQuickControlsProps) {
  return (
    <div className={`inline-flex items-center gap-2 ${className}`}>
      {/* Opacity Slider */}
      <label
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer"
        title="Label opacity"
      >
        <span className="text-[11px] font-medium text-muted-foreground select-none">Opacity</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={opacity}
          onChange={(e) => setOpacity(Number(e.target.value))}
          className="w-[90px] h-1.5 accent-primary cursor-pointer bg-muted rounded-lg"
          title="Label opacity"
        />
        <span className="w-7 text-[10px] tabular-nums font-mono text-muted-foreground select-none">
          {opacity}%
        </span>
      </label>

      {/* Outline Toggle Button */}
      <button
        type="button"
        aria-pressed={outline}
        onClick={() => setOutline((prev) => !prev)}
        title="Show only the borders of the markings (O)"
        className={`px-2 py-1 rounded-md border text-xs font-medium transition cursor-pointer select-none ${
          outline
            ? "border-primary bg-primary text-primary-foreground font-semibold shadow-xs"
            : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
        }`}
      >
        Outline
      </button>
    </div>
  );
}

export default OverlayQuickControls;
