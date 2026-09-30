"use client";

import { useCallback, useRef, useState } from "react";

export type PaintTool = "brush" | "pencil" | "pan" | "torch";
type DrawTool = "brush" | "pencil";

const draws = (t: PaintTool): t is DrawTool => t === "brush" || t === "pencil";

/**
 * The active tool and the eraser, shared by the 2D painter and the 3D viewer
 * so both follow the same rules:
 *
 * - The eraser is a mode of the brush or the pencil, never of hand or torch.
 *   Choosing hand or torch turns it off; turning it on from hand or torch
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
