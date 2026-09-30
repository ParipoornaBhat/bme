"use client";

import { useEffect, useRef, useState } from "react";

/**
 * True while Space is held: a temporary hand, as in most image editors. It
 * works in the middle of a stroke or a pencil trace - keep the mouse button
 * down, hold Space and move to pan, let go of Space and carry on drawing.
 *
 * Space is taken from the page only while no text field has focus, so it
 * neither scrolls the page nor presses whichever toolbar button was clicked
 * last.
 */
export function useSpaceHeld() {
  const [held, setHeld] = useState(false);
  const ref = useRef(false);
  ref.current = held;

  useEffect(() => {
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLInputElement && !["checkbox", "radio", "range"].includes(t.type) ||
      t instanceof HTMLTextAreaElement ||
      t instanceof HTMLSelectElement ||
      (t instanceof HTMLElement && t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || typing(e.target)) return;
      e.preventDefault();
      if (!ref.current) setHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (!typing(e.target)) e.preventDefault();
      setHeld(false);
    };
    const release = () => setHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, []);

  return { spaceHeld: held, spaceHeldRef: ref };
}

const EDGE = 40;
// Pixels per second at the very edge. Time-based, so a 120Hz screen pans no
// faster than a 60Hz one.
const MAX_SPEED = 480;

/**
 * Auto-pan: how far to move the view over `dtMs` while drawing with the
 * pointer near an edge of `area` (the visible window onto the image), or null
 * to stay put. It only moves towards image that is out of sight, so it stops
 * by itself at the image's edge. Speed grows as the pointer nears the edge.
 */
export function edgePanStep(
  pointer: { x: number; y: number },
  area: DOMRect,
  content: DOMRect,
  dtMs: number,
): { dx: number; dy: number } | null {
  const perFrame = (MAX_SPEED * Math.min(dtMs, 50)) / 1000;
  const pull = (distance: number) => perFrame * Math.min(1, Math.max(0, 1 - distance / EDGE));
  let dx = 0;
  let dy = 0;
  if (pointer.x > area.right - EDGE && content.right > area.right + 0.5) dx = -pull(area.right - pointer.x);
  else if (pointer.x < area.left + EDGE && content.left < area.left - 0.5) dx = pull(pointer.x - area.left);
  if (pointer.y > area.bottom - EDGE && content.bottom > area.bottom + 0.5) dy = -pull(area.bottom - pointer.y);
  else if (pointer.y < area.top + EDGE && content.top < area.top - 0.5) dy = pull(pointer.y - area.top);
  return dx || dy ? { dx, dy } : null;
}

/** The Auto-pan toggle, remembered across visits and shared by 2D and 3D. */
export function useAutoPanSetting() {
  const [autoPan, setAutoPanState] = useState(true);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("bme_autopan");
      if (saved !== null) setAutoPanState(saved === "true");
    } catch { /* ignore */ }
  }, []);
  const setAutoPan = (on: boolean) => {
    setAutoPanState(on);
    try {
      localStorage.setItem("bme_autopan", String(on));
    } catch { /* ignore */ }
  };
  return { autoPan, setAutoPan };
}
