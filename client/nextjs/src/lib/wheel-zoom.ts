/**
 * Zoom factor for a Ctrl+wheel event over a view, or null for a plain wheel,
 * which is left to scroll the page.
 *
 * The caller must call preventDefault on a non-null result, from a listener
 * added with { passive: false }: that is what stops the browser zooming the
 * whole page. A touchpad pinch arrives as Ctrl+wheel with small deltas, so the
 * factor follows the delta instead of taking a fixed step per event.
 */
export function wheelZoomFactor(e: WheelEvent): number | null {
  if (!e.ctrlKey && !e.metaKey) return null;
  // deltaMode 1 is lines (Firefox with a mouse wheel), about 33px each.
  const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
  return Math.exp(-Math.max(-300, Math.min(300, px)) * 0.0015);
}
