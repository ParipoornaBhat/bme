"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * AI suggestions on the 3D annotate page.
 *
 * The server runs the 2D U-Net and the yes/no classifier on every axial slice
 * (ml/scripts/suggest_3d.py, queued by lib/suggest-queue.ts) and returns one
 * label volume. It lives here, beside the real labels and never inside them:
 * it is drawn as a dotted outline, it is not saved, and a slice only reaches
 * the real mask when the person accepts it.
 */

export type SliceDecision = "pending" | "accepted" | "rejected";

export type AxialAxes = { slice: 0 | 1 | 2; h: 0 | 1 | 2; v: 0 | 1 | 2; flipH: boolean; flipV: boolean };

export type Suggestion = {
  caseId: string;
  series: string;
  /** One byte per voxel: 0 none, 1 bone, 2 edema. Same layout as the real labels. */
  labels: Uint8Array;
  /** Per axial slice, indexed by position along the axial array axis. */
  slices: { bone: number; lesion: number; prob: number | null }[];
  decisions: SliceDecision[];
  models: string;
};

export type SuggestJobView = {
  id: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  position: number;
  progress: { done: number; total: number } | null;
  waiting: string | null;
  error: string | null;
};

type Result = {
  dims: number[];
  axial: AxialAxes;
  slices: { index: number; bone: number; lesion: number; prob: number | null }[];
  segmentation: { folds: number[] } | null;
  detection: { folds: number[] } | null;
};

export function useSuggestions({
  caseId, series, dims, axial, enabled,
}: {
  caseId: string;
  series: string;
  dims: [number, number, number] | null;
  axial: AxialAxes | null;
  enabled: boolean;
}) {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [job, setJob] = useState<SuggestJobView | null>(null);
  const target = useRef({ caseId, series, dims, axial });
  target.current = { caseId, series, dims, axial };
  const jobRef = useRef(job);
  jobRef.current = job;

  // A suggestion belongs to one scan. Moving to another case or series drops
  // it, and stops a run nobody is waiting for any more.
  useEffect(() => {
    setSuggestion(null);
    return () => {
      const j = jobRef.current;
      if (j && (j.state === "queued" || j.state === "running")) {
        void fetch(`/api/suggest/${j.id}`, { method: "DELETE" }).catch(() => {});
      }
      setJob(null);
    };
  }, [caseId, series]);

  const request = useCallback(async () => {
    if (!enabled) return;
    try {
      const res = await fetch("/api/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, series: series || "primary" }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "could not queue the suggestion run");
      setJob(j as SuggestJobView);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "could not queue the suggestion run");
    }
  }, [caseId, series, enabled]);

  const cancel = useCallback(async () => {
    const j = jobRef.current;
    if (!j) return;
    await fetch(`/api/suggest/${j.id}`, { method: "DELETE" }).catch(() => {});
    setJob(null);
  }, []);

  const load = useCallback(async (jobId: string, result: Result, forCase: string, forSeries: string) => {
    const t = target.current;
    if (t.caseId !== forCase || (t.series || "primary") !== forSeries || !t.dims || !t.axial) return;
    const n = t.dims[0] * t.dims[1] * t.dims[2];
    if (result.dims.join() !== t.dims.join()) {
      throw new Error(`suggestion is ${result.dims.join("x")}, the scan is ${t.dims.join("x")}`);
    }
    // The server works out the axial axis from the affine the same way this
    // viewer does. If the two ever disagree, the marks would sit on the wrong
    // slices, so nothing is shown.
    const a = result.axial, b = t.axial;
    if (a.slice !== b.slice || a.h !== b.h || a.v !== b.v || a.flipH !== b.flipH || a.flipV !== b.flipV) {
      throw new Error("the server and the viewer disagree on which axis is axial; suggestion not shown");
    }
    const res = await fetch(`/api/suggest/${jobId}/labels`, { cache: "no-store" });
    if (!res.ok) throw new Error("could not download the suggestion");
    const nifti = await import("nifti-reader-js");
    let buf = await res.arrayBuffer();
    if (nifti.isCompressed(buf)) buf = nifti.decompress(buf) as ArrayBuffer;
    const labels = new Uint8Array(buf);
    if (labels.length !== n) throw new Error(`suggestion has ${labels.length} voxels, the scan has ${n}`);

    const depth = t.dims[b.slice];
    const slices = Array.from({ length: depth }, (_, s) => {
      const r = result.slices.find((x) => x.index === s);
      return { bone: r?.bone ?? 0, lesion: r?.lesion ?? 0, prob: r?.prob ?? null };
    });
    const folds = (f: { folds: number[] } | null) => (f ? f.folds.join(", ") : "none");
    setSuggestion({
      caseId: forCase,
      series: forSeries,
      labels,
      slices,
      // A slice where the model marked nothing has nothing to accept.
      decisions: slices.map((x) => (x.bone + x.lesion > 0 ? "pending" : "rejected")),
      models: `U-Net fold ${folds(result.segmentation)} · yes/no fold ${folds(result.detection)}`,
    });
  }, []);

  // Poll the job until it finishes.
  const jobId = job?.id;
  const live = job?.state === "queued" || job?.state === "running";
  useEffect(() => {
    if (!jobId || !live) return;
    const forCase = caseId, forSeries = series || "primary";
    let stopped = false;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const res = await fetch(`/api/suggest/${jobId}`, { cache: "no-store" });
        const j = await res.json();
        if (stopped) return;
        if (!res.ok) throw new Error(j.error ?? "lost the suggestion run");
        // The labels are loaded before the job is marked done here, since
        // marking it done ends this loop.
        if (j.state === "done" && j.result) await load(jobId, j.result as Result, forCase, forSeries);
        else if (j.state === "failed") toast.error(`AI suggestions failed: ${j.error ?? "unknown error"}`);
        if (!stopped) setJob(j as SuggestJobView);
      } catch (e) {
        if (stopped) return;
        setJob((cur) => (cur ? { ...cur, state: "failed", error: e instanceof Error ? e.message : String(e) } : cur));
        toast.error(e instanceof Error ? e.message : "AI suggestions failed");
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => { void tick(); }, 1500);
    void tick();
    return () => { stopped = true; clearInterval(timer); };
  }, [jobId, live, caseId, series, load]);

  const decide = useCallback((slice: number, d: SliceDecision) => {
    setSuggestion((cur) => {
      if (!cur || cur.decisions[slice] === d) return cur;
      const decisions = cur.decisions.slice();
      decisions[slice] = d;
      return { ...cur, decisions };
    });
  }, []);

  const discard = useCallback(() => { setSuggestion(null); setJob(null); }, []);

  return { suggestion, job, request, cancel, decide, discard };
}

function hex(c: string): [number, number, number] {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

/**
 * Draw the pending part of a suggestion as dotted outlines into a slice image.
 *
 * Only edge pixels are touched, never the inside. A pixel is an edge when one
 * of its four neighbours is outside the region, and a voxel on a slice that
 * has been accepted or rejected counts as outside, so the outline closes
 * there in coronal and sagittal too. The dot pattern is skewed so that no
 * common boundary direction (horizontal, vertical, diagonal) comes out solid.
 */
export function drawSuggestionEdges(
  img: ImageData,
  w: number,
  h: number,
  sug: Suggestion,
  dims: [number, number, number],
  axialAxis: 0 | 1 | 2,
  at: (a: number, b: number) => number,
  show: { bone: boolean; edema: boolean; skip?: (a: number, b: number) => boolean },
  colors: { bone: string; edema: string },
) {
  const lab = sug.labels, dec = sug.decisions;
  const plane = dims[0] * dims[1];
  const axialOf = axialAxis === 0
    ? (f: number) => f % dims[0]
    : axialAxis === 1
      ? (f: number) => Math.floor(f / dims[0]) % dims[1]
      : (f: number) => Math.floor(f / plane);
  const value = (a: number, b: number) => {
    if (a < 0 || b < 0 || a >= w || b >= h) return 0;
    const f = at(a, b);
    const v = lab[f];
    return v && dec[axialOf(f)] === "pending" ? v : 0;
  };
  const bone = hex(colors.bone), edema = hex(colors.edema);
  for (let b = 0; b < h; b++) {
    for (let a = 0; a < w; a++) {
      const v = value(a, b);
      if (!v || (a * 2 + b * 3) % 7 >= 4) continue;
      if (show.skip?.(a, b)) continue;
      const n = [value(a - 1, b), value(a + 1, b), value(a, b - 1), value(a, b + 1)];
      let rgb: [number, number, number] | null = null;
      if (show.edema && v === 2 && n.some((x) => x !== 2)) rgb = edema;
      else if (show.bone && n.some((x) => x === 0)) rgb = bone;
      if (!rgb) continue;
      const o = ((h - 1 - b) * w + a) * 4;
      img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
    }
  }
}
