/**
 * Draws a label grid at a finer scale than the grid itself, with smooth
 * anti-aliased edges instead of one hard square per pixel.
 *
 * Display only: the labels stay one per scan pixel. Each label's coverage is
 * interpolated bilinearly between pixel centres and the edge is drawn where it
 * crosses one half, so outlines come out as curves that follow the painted
 * pixels. A one-pixel line keeps a one-pixel width.
 */

export type Rgba = readonly [number, number, number, number];

/** How many display pixels per grid pixel, keeping the larger side within `maxSide`. */
export function smoothScale(w: number, h: number, maxSide: number): number {
  return Math.max(1, Math.min(4, Math.floor(maxSide / Math.max(w, h, 1))));
}

/**
 * Render `grid` (row-major, `w` x `h`, top row first, 0 = nothing shown) into
 * `out`, an RGBA buffer of (w * k) x (h * k) pixels. `colors[label]` gives
 * each label's colour and alpha.
 */
export function renderSmoothLabels(
  grid: Uint8Array,
  w: number,
  h: number,
  k: number,
  colors: readonly (Rgba | undefined)[],
  out: Uint8ClampedArray,
): void {
  const W = w * k;
  const H = h * k;
  const px = new Uint32Array(out.buffer, out.byteOffset, W * H);
  px.fill(0);
  // ImageData is little-endian on every platform browsers ship on.
  const packed = colors.map((c) => (c ? ((c[3] << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0 : 0));
  const half = k >> 1;
  const at = (x: number, y: number) =>
    grid[(y < 0 ? 0 : y >= h ? h - 1 : y) * w + (x < 0 ? 0 : x >= w ? w - 1 : x)];

  const lab = [0, 0, 0, 0];
  const wt = [0, 0, 0, 0];

  // Cell (i, j) spans the pixel centres (i, j) to (i + 1, j + 1).
  for (let j = -1; j < h; j++) {
    const Y0 = j * k + half;
    const Ya = Math.max(0, Y0);
    const Yb = Math.min(H, Y0 + k);
    if (Ya >= Yb) continue;
    for (let i = -1; i < w; i++) {
      const X0 = i * k + half;
      const Xa = Math.max(0, X0);
      const Xb = Math.min(W, X0 + k);
      if (Xa >= Xb) continue;
      const l00 = at(i, j), l10 = at(i + 1, j), l01 = at(i, j + 1), l11 = at(i + 1, j + 1);

      if (l00 === l10 && l00 === l01 && l00 === l11) {
        if (!l00 || !packed[l00]) continue;
        const c = packed[l00];
        for (let Y = Ya; Y < Yb; Y++) px.fill(c, Y * W + Xa, Y * W + Xb);
        continue;
      }

      lab[0] = l00; lab[1] = l10; lab[2] = l01; lab[3] = l11;
      for (let Y = Ya; Y < Yb; Y++) {
        const fy = (Y + 0.5) / k - 0.5 - j;
        for (let X = Xa; X < Xb; X++) {
          const fx = (X + 0.5) / k - 0.5 - i;
          wt[0] = (1 - fx) * (1 - fy);
          wt[1] = fx * (1 - fy);
          wt[2] = (1 - fx) * fy;
          wt[3] = fx * fy;

          let cover = 0, best = 0, bestW = 0;
          for (let n = 0; n < 4; n++) {
            const l = lab[n];
            if (!l) continue;
            cover += wt[n];
            let s = 0;
            for (let m = 0; m < 4; m++) if (lab[m] === l) s += wt[m];
            if (s > bestW) { bestW = s; best = l; }
          }
          // Coverage changes by about one per grid pixel, so (cover - 0.5) * k
          // is the distance to the edge in display pixels: a one-pixel ramp.
          const a = 0.5 + (cover - 0.5) * k;
          if (a <= 0 || !best) continue;
          const c = colors[best];
          if (!c) continue;
          const o = (Y * W + X) * 4;
          out[o] = c[0];
          out[o + 1] = c[1];
          out[o + 2] = c[2];
          out[o + 3] = a >= 1 ? c[3] : Math.round(c[3] * a);
        }
      }
    }
  }
}

/** A canvas kept off-screen and reused, keyed by purpose. */
const scratch = new Map<string, HTMLCanvasElement>();
export function scratchCanvas(key: string, w: number, h: number): HTMLCanvasElement {
  let cv = scratch.get(key);
  if (!cv) {
    cv = document.createElement("canvas");
    scratch.set(key, cv);
  }
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  return cv;
}
