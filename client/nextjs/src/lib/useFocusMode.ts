"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Focus mode: the viewer takes the whole screen, with only the painting
 * tools beside it. `solo` is the one view shown full size, or null for the
 * four-up; it lives here rather than in the viewer so a case switch, which
 * remounts the viewer, keeps both the mode and the layout.
 *
 * Fullscreen is requested on the document, not on the viewer: the viewer is
 * replaced on every case switch, and the browser leaves fullscreen when the
 * fullscreen element goes away. Whatever ends fullscreen (Esc, F11, the
 * browser's own control) also ends focus mode, since the browser takes Esc
 * for itself and the page may never see it. If fullscreen is refused, focus
 * mode still covers the window.
 */
export function useFocusMode<V extends string>() {
  const [active, setActive] = useState(false);
  const [solo, setSolo] = useState<V | null>(null);
  const activeRef = useRef(false);
  activeRef.current = active;

  const enter = useCallback(() => {
    setActive(true);
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen().catch(() => { /* window-only focus */ });
    }
  }, []);

  const exit = useCallback(() => {
    setActive(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }, []);

  const toggle = useCallback(() => {
    if (activeRef.current) exit();
    else enter();
  }, [enter, exit]);

  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setActive(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      // Leaving the page should not strand the browser in fullscreen.
      if (activeRef.current && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);

  return { active, enter, exit, toggle, solo, setSolo };
}

export type FocusMode<V extends string> = ReturnType<typeof useFocusMode<V>>;
