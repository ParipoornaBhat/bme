/**
 * Pointer for the pencil tool: a fine crosshair in the colour of the label
 * being drawn, with a small pencil beside it. The crosshair's centre is the
 * hotspot, so tracing is as exact as the plain crosshair was, and the colour
 * says which label an outline will fill before it is drawn. Falls back to the
 * browser crosshair if the image cannot be used.
 */
const PENCIL =
  '<polygon points="5.54,18.46 13.31,10.69 15.15,12.52 7.37,20.30" fill="#f5f5f5"/>' +
  '<polygon points="5.54,18.46 13.31,10.69 11.48,8.85 3.70,16.63" fill="#d4d4d4"/>' +
  '<polygon points="13.31,10.69 15.08,8.92 16.92,10.76 15.15,12.52 11.48,8.85 13.24,7.08 15.08,8.92" fill="#f0a3b1"/>' +
  '<polygon points="2,22 7.37,20.30 3.70,16.63" fill="#e8c9a0"/>' +
  '<polygon points="2,22 3.63,21.48 2.52,20.37" fill="#222"/>' +
  '<polygon points="2,22 7.37,20.30 16.92,10.76 13.24,7.08 3.70,16.63" fill="none" stroke="#000" stroke-width="1.1" stroke-linejoin="round"/>';

const ARMS = "M10 1v6M10 13v6M1 10h6M13 10h6";

const cache = new Map<string, string>();

/** CSS `cursor` value for the pencil tool drawing in `color` (a #rrggbb hex). */
export function pencilCursor(color: string): string {
  const hit = cache.get(color);
  if (hit) return hit;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
    `<path d="${ARMS}" stroke="#000" stroke-width="3" stroke-linecap="round"/>` +
    `<path d="${ARMS}" stroke="${color}" stroke-width="1.3" stroke-linecap="round"/>` +
    `<circle cx="10" cy="10" r="1" fill="${color}" stroke="#000" stroke-width="0.6"/>` +
    `<g transform="translate(15.5 12.5) scale(0.72)">${PENCIL}</g>` +
    "</svg>";
  const css = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 10 10, crosshair`;
  cache.set(color, css);
  return css;
}
