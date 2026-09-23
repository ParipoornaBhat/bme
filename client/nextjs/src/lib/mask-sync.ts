/*
 * Keeps one client's copy of a slice's mask in step with a live review session.
 *
 * Every edit goes to the server as just the pixels that changed. The server
 * applies it, numbers it, and sends it to everyone - author included - in that
 * one order. This client keeps the server's copy (confirmed) and lays its own
 * not-yet-echoed edits (pending) on top, so every participant ends on the same
 * mask and the author's own brush never flickers.
 *
 * It replaces sending the whole canvas on every stroke, where the last canvas
 * to arrive replaced everyone else's work: two people editing the same area
 * kept undoing each other, and an erase would vanish and then come back.
 *
 * `screen` is the mask on display, which the drawing tools edit directly. The
 * class never owns it; it is passed in, so the caller keeps its buffers.
 */

import { applyRuns, diffRuns, nonZeroRuns } from "./mask-runs";
import type { MaskOpApplied, MaskRuns, MaskSnapshot } from "./useCollaboration";

export type MaskSyncIO = {
  /** Send one edit to the server. */
  sendOp: (opId: string, runs: MaskRuns) => void;
  /** Redraw the screen after the sync layer has rewritten it. */
  render: () => void;
  newOpId: () => string;
};

export class MaskSync {
  /** `${caseId}::${stem}` of the slice being synced, or null. */
  key: string | null = null;
  /** True once the server's copy has arrived for `key`. */
  ready = false;
  /** The server's copy: every edit it has numbered, in its order. */
  confirmed: Uint8Array | null = null;
  /** confirmed + pending: the screen minus anything drawn since the last flush. */
  baseline: Uint8Array | null = null;
  /** This client's edits, sent but not yet echoed back, in send order. */
  pending: { opId: string; runs: MaskRuns }[] = [];
  seq = -1;
  private joinBase: Uint8Array | null = null;
  private resendOnSnapshot = false;

  constructor(private io: MaskSyncIO) {}

  /**
   * Open `key` (or reopen it after a reconnect). Returns what to offer the
   * server as the starting mask; it keeps that only if nobody opened the
   * slice first.
   */
  join(key: string, screen: Uint8Array, canEdit: boolean): MaskRuns {
    if (this.key !== key) {
      this.key = key;
      this.ready = false;
      this.confirmed = null;
      this.baseline = null;
      this.pending = [];
      this.seq = -1;
    } else if (this.ready) {
      // Same slice, new connection: what went out on the old one may never
      // have arrived, so it is resent once the server's copy is back.
      this.flush(screen, canEdit);
      this.resendOnSnapshot = true;
      this.ready = false;
    }
    this.joinBase = new Uint8Array(screen);
    return nonZeroRuns(screen);
  }

  leave() {
    this.key = null;
    this.ready = false;
  }

  /** Send whatever has been drawn since the last flush. */
  flush(screen: Uint8Array, canEdit: boolean) {
    if (!canEdit || !this.ready || !this.baseline || screen.length !== this.baseline.length) return;
    const runs = diffRuns(this.baseline, screen);
    if (runs.length === 0) return;
    applyRuns(this.baseline, runs);
    this.send(runs);
  }

  onSnapshot(d: MaskSnapshot, screen: Uint8Array, canEdit: boolean, history: Uint8Array[][]) {
    if (this.key !== `${d.caseId}::${d.stem}` || screen.length !== d.width * d.height) return;

    // Anything drawn locally since the last point we were in step.
    const since = this.baseline ?? this.joinBase;
    const localRuns = canEdit && since && since.length === screen.length ? diffRuns(since, screen) : [];

    const confirmed = new Uint8Array(screen.length);
    applyRuns(confirmed, d.runs);
    this.confirmed = confirmed;
    this.seq = d.seq;

    if (this.resendOnSnapshot) {
      this.resendOnSnapshot = false;
      const lost = this.pending;
      this.pending = [];
      if (canEdit) for (const op of lost) this.send(op.runs);
    }
    if (localRuns.length > 0) this.send(localRuns);

    if (!this.ready) {
      // History from before the first sync could restore pixels other people
      // have since changed, so it starts fresh from the shared copy.
      for (const stack of history) stack.length = 0;
      this.ready = true;
    }
    this.rebuild(screen);
  }

  onOp(d: MaskOpApplied, screen: Uint8Array, canEdit: boolean, myUserId: string, history: Uint8Array[][]) {
    if (!this.ready || this.key !== `${d.caseId}::${d.stem}`) return;
    const confirmed = this.confirmed;
    if (!confirmed || d.seq <= this.seq || screen.length !== confirmed.length) return;

    this.flush(screen, canEdit);
    applyRuns(confirmed, d.runs);
    this.seq = d.seq;

    const mineAt = this.pending.findIndex((op) => op.opId === d.opId);
    if (mineAt >= 0) {
      this.pending.splice(mineAt, 1);
    } else if (d.userId !== myUserId) {
      // Someone else's edit goes into history too, so undoing your own stroke
      // can never bring back what they just erased.
      for (const stack of history) {
        for (const snap of stack) if (snap.length === confirmed.length) applyRuns(snap, d.runs);
      }
    }
    this.rebuild(screen);
  }

  private send(runs: MaskRuns) {
    const opId = this.io.newOpId();
    this.pending.push({ opId, runs });
    this.io.sendOp(opId, runs);
  }

  /** Screen := server's copy + this client's unconfirmed edits. */
  private rebuild(screen: Uint8Array) {
    const confirmed = this.confirmed;
    if (!confirmed || screen.length !== confirmed.length) return;
    screen.set(confirmed);
    for (const op of this.pending) applyRuns(screen, op.runs);
    this.baseline = new Uint8Array(screen);
    this.io.render();
  }
}
