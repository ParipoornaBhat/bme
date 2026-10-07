"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type PaintTool = "brush" | "pencil" | "pan" | "torch" | "move";
type DrawTool = "brush" | "pencil";

const draws = (t: PaintTool): t is DrawTool => t === "brush" || t === "pencil";

/**
 * The active tool and the eraser, shared by the 2D painter and the 3D viewer
 * so both follow the same rules:
 *
 * - The eraser is a mode of the brush or the pencil, never of hand, torch or
 *   move. Choosing one of those turns it off; turning it on from one of them
 *   goes back to the last drawing tool.
 * - Switching between brush and pencil keeps the eraser as it was, so an
 *   outline can be erased with the pencil.
 * - Picking a label means "draw this": it turns the eraser off and returns to
 *   the last drawing tool.
 */
export function usePaintTools(initial: PaintTool) {
  const [tool, setTool] = useState<PaintTool>(initial);
  const [erasing, setErasing] = useState(false);
  const lastDraw = useRef<DrawTool>(initial === "pencil" ? "pencil" : "brush");
  const current = useRef({ tool, erasing });
  current.current = { tool, erasing };

  const pickTool = useCallback((t: PaintTool) => {
    if (draws(t)) lastDraw.current = t;
    else setErasing(false);
    setTool(t);
  }, []);

  const toggleEraser = useCallback(() => {
    const { tool: t, erasing: on } = current.current;
    if (!on && !draws(t)) setTool(lastDraw.current);
    setErasing(!on);
  }, []);

  const drawWithLabel = useCallback(() => {
    if (!draws(current.current.tool)) setTool(lastDraw.current);
    setErasing(false);
  }, []);

  return {
    tool,
    erasing,
    /** Brush or pencil is active, so a label is what the next stroke paints. */
    drawing: draws(tool),
    pickTool,
    toggleEraser,
    drawWithLabel,
  };
}

/**
 * How the pencil trace looks while it is being drawn: a dotted edge only, or
 * a solid edge over a tinted preview of the area that will be filled.
 * Remembered across visits and shared by 2D and 3D.
 */
export function usePencilDottedSetting() {
  const [pencilDotted, setDottedState] = useState(true);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("bme_pencil_dotted");
      if (saved !== null) setDottedState(saved === "true");
    } catch { /* ignore */ }
  }, []);
  const setPencilDotted = (on: boolean) => {
    setDottedState(on);
    try {
      localStorage.setItem("bme_pencil_dotted", String(on));
    } catch { /* ignore */ }
  };
  return { pencilDotted, setPencilDotted };
}
