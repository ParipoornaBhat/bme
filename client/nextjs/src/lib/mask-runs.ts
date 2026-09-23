/*
 * Label masks travel between collaborators as runs: a flat array of
 * [start, length, label, ...] over the row-major pixel array. A mask is mostly
 * long stretches of one value, so this is small, and it carries exact label
 * values. The server's copy of these helpers lives in
 * server/hono/src/lib/collab-server.ts.
 */

import type { MaskRuns } from "./useCollaboration";

/** Set every run in `labels`. */
export function applyRuns(labels: Uint8Array, runs: MaskRuns) {
  for (let i = 0; i < runs.length; i += 3) {
    labels.fill(runs[i + 2], runs[i], runs[i] + runs[i + 1]);
  }
}

/** The non-empty parts of a mask; everything else is 0. */
export function nonZeroRuns(labels: Uint8Array): MaskRuns {
  const runs: MaskRuns = [];
  let i = 0;
  while (i < labels.length) {
    const v = labels[i];
    let j = i + 1;
    while (j < labels.length && labels[j] === v) j++;
    if (v !== 0) runs.push(i, j - i, v);
    i = j;
  }
  return runs;
}

/**
 * The pixels where `after` differs from `before`, with their values in `after`
 * - including 0, so an erase is carried as an edit like any other.
 */
export function diffRuns(before: Uint8Array, after: Uint8Array): MaskRuns {
  const runs: MaskRuns = [];
  const n = after.length;
  let i = 0;
  while (i < n) {
    if (before[i] === after[i]) {
      i++;
      continue;
    }
    const v = after[i];
    let j = i + 1;
    while (j < n && before[j] !== after[j] && after[j] === v) j++;
    runs.push(i, j - i, v);
    i = j;
  }
  return runs;
}
