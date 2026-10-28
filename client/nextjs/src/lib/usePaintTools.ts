"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type PaintTool = "brush" | "pencil" | "pan" | "torch" | "move";
export type DrawTool = "brush" | "pencil";

const draws = (t: PaintTool): t is DrawTool => t === "brush" || t === "pencil";

const DRAW_DEFAULT_KEY = "bme_draw_default_tool";
const ERASE_DEFAULT_KEY = "bme_erase_default_tool";

function readDefault(key: string, fallback: DrawTool): DrawTool {
  try {
    const saved = localStorage.getItem(key);
    if (saved === "brush" || saved === "pencil") return saved;
  } catch { /* ignore */ }
  return fallback;
}

function saveDefault(key: string, tool: DrawTool) {
  try {
    localStorage.setItem(key, tool);
  } catch { /* ignore */ }
}

/**
 * The active tool and the eraser, shared by the 2D painter and the 3D viewer
 * so both follow the same rules:
 *
 * - The eraser is a mode of the brush or the pencil, never of hand, torch or
 *   move. Choosing one of those turns it off.
 * - Each mode has a default tool, set in the settings and remembered across
 *   visits: the pencil for drawing a label, the brush for erasing. Switching
 *   into a mode (turning the eraser on or off, picking a label) lands on that
 *   mode's default.
 * - Picking brush or pencil by hand overrides the default until the next
 *   switch, and keeps the eraser as it was, so an outline can be erased with
 *   the pencil.
 */
export function usePaintTools(initial: PaintTool) {
  const [tool, setTool] = useState<PaintTool>(initial);
  const [erasing, setErasing] = useState(false);
  const [drawDefault, setDrawDefaultState] = useState<DrawTool>("pencil");
  const [eraseDefault, setEraseDefaultState] = useState<DrawTool>("brush");
  const current = useRef({ tool, erasing, drawDefault, eraseDefault });
  current.current = { tool, erasing, drawDefault, eraseDefault };
  const touched = useRef(false);

  useEffect(() => {
    const draw = readDefault(DRAW_DEFAULT_KEY, "pencil");
    setDrawDefaultState(draw);
    setEraseDefaultState(readDefault(ERASE_DEFAULT_KEY, "brush"));
    if (!touched.current && draws(initial)) setTool(draw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickTool = useCallback((t: PaintTool) => {
    touched.current = true;
    if (!draws(t)) setErasing(false);
    setTool(t);
  }, []);

  const toggleEraser = useCallback(() => {
    touched.current = true;
    const { erasing: on, drawDefault: d, eraseDefault: e } = current.current;
    setTool(on ? d : e);
    setErasing(!on);
  }, []);

  const drawWithLabel = useCallback(() => {
    touched.current = true;
    setTool(current.current.drawDefault);
    setErasing(false);
  }, []);

  // Changing a default also applies it to the mode in use, so the setting
  // shows its effect straight away.
  const setDrawDefault = useCallback((t: DrawTool) => {
    setDrawDefaultState(t);
    saveDefault(DRAW_DEFAULT_KEY, t);
    const { tool: cur, erasing: on } = current.current;
    if (!on && draws(cur)) setTool(t);
  }, []);

  const setEraseDefault = useCallback((t: DrawTool) => {
    setEraseDefaultState(t);
    saveDefault(ERASE_DEFAULT_KEY, t);
    const { tool: cur, erasing: on } = current.current;
    if (on && draws(cur)) setTool(t);
  }, []);

  return {
    tool,
    erasing,
    /** Brush or pencil is active, so a label is what the next stroke paints. */
    drawing: draws(tool),
    pickTool,
    toggleEraser,
    drawWithLabel,
    drawDefault,
    eraseDefault,
    setDrawDefault,
    setEraseDefault,
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
