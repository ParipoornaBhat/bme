/**
 * Two-finger pinch on a touch screen.
 *
 * Feed it every touch pointer's down, move and up. While exactly two fingers
 * are down, move() reports the spread and midpoint relative to when the second
 * finger landed, so a caller can scale from a fixed starting zoom instead of
 * compounding small steps (which rounding would stall).
 */
export type PinchFrame = {
  /** Finger spread now, over the spread when the pinch began. */
  scale: number;
  /** Midpoint now and when the pinch began, in client pixels. */
  mid: { x: number; y: number };
  mid0: { x: number; y: number };
};

type Pt = { x: number; y: number };

export class Pinch {
  private pts = new Map<number, Pt>();
  private start: { dist: number; mid: Pt } | null = null;

  get count() {
    return this.pts.size;
  }

  get active() {
    return this.start !== null;
  }

  down(e: { pointerId: number; clientX: number; clientY: number }) {
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.start = this.pts.size === 2 ? this.measure() : null;
  }

  move(e: { pointerId: number; clientX: number; clientY: number }): PinchFrame | null {
    if (!this.pts.has(e.pointerId)) return null;
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!this.start || this.pts.size !== 2) return null;
    const now = this.measure();
    return { scale: now.dist / this.start.dist, mid: now.mid, mid0: this.start.mid };
  }

  up(e: { pointerId: number }) {
    this.pts.delete(e.pointerId);
    this.start = null;
  }

  private measure() {
    const [a, b] = [...this.pts.values()];
    return {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  }
}
