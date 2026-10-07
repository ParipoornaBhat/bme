/**
 * Select a painted region on one view and move or resize it.
 *
 * Coordinates are in-plane voxels (a to the right, b upwards, as the viewer
 * draws them) plus the slice s. A box is half-open: [x0, x1) x [y0, y1).
 *
 * The region keeps the voxels it was selected with, and every placement is
 * stamped from those, never from the previous placement. Resizing back and
 * forth therefore does not wear the shape down, and dragging part of it off
 * the image and back loses nothing.
 */

export type Box = { x0: number; y0: number; x1: number; y1: number };

/** "move" drags the whole box; the rest are the edge or corner being dragged. */
export type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export type Region = {
  /** The label that was clicked. */
  label: number;
  /** Box around the region as selected, over every slice it covers. */
  from: Box;
  /** Slice -> label per voxel of `from`, row-major, 0 where not selected. */
  masks: Map<number, Uint8Array>;
  /** Voxels selected. */
  size: number;
};

export type PlaneAccess = {
  w: number;
  h: number;
  depth: number;
  /** Flat index into the label volume of in-plane (a, b) on slice s. */
  flat: (a: number, b: number, s: number) => number;
  labels: Uint8Array;
};

/**
 * The connected region of the label under (a, b, s). Bone marrow carries the
 * edema and uncertain marks inside it, so moving a bone moves its lesion with
 * it; clicking edema takes the edema alone. With `allSlices` the region is
 * followed through neighbouring slices too (6-connected); otherwise it stays
 * on slice s (4-connected).
 */
export function selectRegion(
  at: { a: number; b: number; s: number },
  g: PlaneAccess,
  allSlices: boolean,
  visible: (label: number) => boolean,
): Region | null {
  const { w, h, depth, flat, labels } = g;
  const label = labels[flat(at.a, at.b, at.s)];
  if (!label || !visible(label)) return null;
  const takes = (v: number) => (label === 1 ? v !== 0 && visible(v) : v === label);

  const plane = w * h;
  const seen = new Uint8Array(plane * depth);
  const queue: number[] = [at.a + w * (at.b + h * at.s)];
  seen[queue[0]] = 1;
  const found: number[] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;

  const visit = (a: number, b: number, s: number) => {
    if (a < 0 || b < 0 || s < 0 || a >= w || b >= h || s >= depth) return;
    const p = a + w * (b + h * s);
    if (seen[p]) return;
    seen[p] = 1;
    if (takes(labels[flat(a, b, s)])) queue.push(p);
  };

  while (queue.length) {
    const p = queue.pop()!;
    const s = Math.floor(p / plane);
    const r = p - s * plane;
    const b = Math.floor(r / w);
    const a = r - b * w;
    found.push(p);
    if (a < x0) x0 = a;
    if (a > x1) x1 = a;
    if (b < y0) y0 = b;
    if (b > y1) y1 = b;
    visit(a - 1, b, s); visit(a + 1, b, s);
    visit(a, b - 1, s); visit(a, b + 1, s);
    if (allSlices) { visit(a, b, s - 1); visit(a, b, s + 1); }
  }

  const from = { x0, y0, x1: x1 + 1, y1: y1 + 1 };
  const bw = from.x1 - from.x0;
  const masks = new Map<number, Uint8Array>();
  for (const p of found) {
    const s = Math.floor(p / plane);
    const r = p - s * plane;
    const b = Math.floor(r / w);
    const a = r - b * w;
    let m = masks.get(s);
    if (!m) { m = new Uint8Array(bw * (from.y1 - from.y0)); masks.set(s, m); }
    m[(a - from.x0) + bw * (b - from.y0)] = labels[flat(a, b, s)];
  }
  return { label, from, masks, size: found.length };
}

/**
 * Every voxel the region covers when its box is placed at `to`, with the label
 * it carries there. Nearest-neighbour, mapped back from the target so a
 * stretched region has no holes. Voxels off the image are skipped.
 */
export function placeRegion(
  r: Region,
  to: Box,
  w: number,
  h: number,
  put: (a: number, b: number, s: number, label: number) => void,
) {
  const fw = r.from.x1 - r.from.x0, fh = r.from.y1 - r.from.y0;
  const tw = to.x1 - to.x0, th = to.y1 - to.y0;
  const ax0 = Math.max(0, to.x0), ax1 = Math.min(w, to.x1);
  const by0 = Math.max(0, to.y0), by1 = Math.min(h, to.y1);
  for (const [s, m] of r.masks) {
    for (let b = by0; b < by1; b++) {
      const sb = Math.min(fh - 1, Math.floor(((b - to.y0 + 0.5) * fh) / th));
      for (let a = ax0; a < ax1; a++) {
        const sa = Math.min(fw - 1, Math.floor(((a - to.x0 + 0.5) * fw) / tw));
        const v = m[sa + fw * sb];
        if (v) put(a, b, s, v);
      }
    }
  }
}

/**
 * Which part of the box is under the point: an edge or corner within `tol`
 * voxels, the inside, or nothing.
 */
export function handleAt(box: Box, x: number, y: number, tol: number): Handle | null {
  // A small box keeps its middle for moving rather than being all handles.
  const tx = Math.min(tol, (box.x1 - box.x0) / 4), ty = Math.min(tol, (box.y1 - box.y0) / 4);
  const nearX0 = Math.abs(x - box.x0) <= tx, nearX1 = Math.abs(x - box.x1) <= tx;
  const nearY0 = Math.abs(y - box.y0) <= ty, nearY1 = Math.abs(y - box.y1) <= ty;
  const inX = x >= box.x0 - tx && x <= box.x1 + tx;
  const inY = y >= box.y0 - ty && y <= box.y1 + ty;
  if (!inX || !inY) return null;
  // b runs upwards, so y1 is the top edge on screen.
  const ns = nearY1 ? "n" : nearY0 ? "s" : "";
  const ew = nearX1 ? "e" : nearX0 ? "w" : "";
  if (ns || ew) return (ns + ew) as Handle;
  return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 ? "move" : null;
}

/**
 * The box after dragging `handle` by (dx, dy) whole voxels from `start`.
 * The opposite edge stays put and the box never shrinks below one voxel.
 * With `keepAspect`, a corner scales both sides by the same factor.
 */
export function dragBox(start: Box, handle: Handle, dx: number, dy: number, keepAspect: boolean): Box {
  if (handle === "move") {
    return { x0: start.x0 + dx, y0: start.y0 + dy, x1: start.x1 + dx, y1: start.y1 + dy };
  }
  const b = { ...start };
  if (handle.includes("w")) b.x0 = Math.min(start.x0 + dx, start.x1 - 1);
  if (handle.includes("e")) b.x1 = Math.max(start.x1 + dx, start.x0 + 1);
  if (handle.includes("s")) b.y0 = Math.min(start.y0 + dy, start.y1 - 1);
  if (handle.includes("n")) b.y1 = Math.max(start.y1 + dy, start.y0 + 1);
  if (keepAspect && handle.length === 2) {
    const sw = start.x1 - start.x0, sh = start.y1 - start.y0;
    const k = Math.max((b.x1 - b.x0) / sw, (b.y1 - b.y0) / sh);
    const nw = Math.max(1, Math.round(sw * k)), nh = Math.max(1, Math.round(sh * k));
    if (handle.includes("w")) b.x0 = b.x1 - nw; else b.x1 = b.x0 + nw;
    if (handle.includes("s")) b.y0 = b.y1 - nh; else b.y1 = b.y0 + nh;
  }
  return b;
}

export const sameBox = (p: Box, q: Box) => p.x0 === q.x0 && p.y0 === q.y0 && p.x1 === q.x1 && p.y1 === q.y1;

export const HANDLE_CURSOR: Record<Handle, string> = {
  move: "move",
  n: "ns-resize", s: "ns-resize",
  e: "ew-resize", w: "ew-resize",
  ne: "nesw-resize", sw: "nesw-resize",
  nw: "nwse-resize", se: "nwse-resize",
};
