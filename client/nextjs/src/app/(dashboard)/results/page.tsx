"use client";

import { useEffect, useState } from "react";
import { Activity, Boxes, CheckCircle2, Eye, Layers, Loader2, RefreshCw } from "lucide-react";
import TestImage from "./TestImage";

/**
 * Model results, split into two independent pipelines.
 *
 * 2D is the classifier baseline: it answers "does this scan look like it has
 * edema" from case-level labels, needs no drawing, and is what currently has
 * numbers. 3D is the segmentation system from docs/PRD.md — it locates and
 * measures lesions, and needs annotated cases before it can train.
 *
 * 2D is the default tab because it is the one with results today.
 */

type Metric = {
  accuracy: number; precision: number; recall: number; f1: number;
  auc: number; n: number; confusion: number[][];
};

type Payload = {
  twoD: {
    available: boolean;
    reviewCount: number;
    selectedRun: string | null;
    selectionExplicit: boolean;
    metrics: null | {
      model: string; device: string; folds: number; epochs: number; seed: number;
      n_slices: number; n_cases: number;
      slice_level: Metric; case_level: Metric;
      per_fold: Metric[];
      per_fold_summary: Record<string, { mean: number; std: number } | null>;
      caveat: string;
    };
  };
  threeD: {
    available: boolean;
    annotations: { total: number; cases: string[] };
    worklist: null | {
      totalCases: number;
      byPerson: Record<string, { total: number; isotropic: number; bme: number }>;
    };
  };
};

type CamEntry = { case_id: string; true: number; pred: number; prob: number; fold: number; thumb: string };
type CamPayload = {
  available: boolean; running: boolean; log: string; trained: boolean;
  data: null | { arch: string; device: string; n: number; n_folds: number;
                 trained_at: string | null; caveat: string; entries: CamEntry[] };
};

const pct = (v?: number) =>
  v === undefined || v === null || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(1)}%`;

function MetricRow({ label, m, muted }: { label: string; m: Metric; muted?: boolean }) {
  const keys: (keyof Metric)[] = ["accuracy", "precision", "recall", "f1", "auc"];
  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {keys.map((k) => (
          <div
            key={k}
            className={`rounded-lg border border-border bg-card p-3 ${muted ? "opacity-70" : ""}`}
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {k === "auc" ? "ROC AUC" : k}
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{pct(m[k] as number)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ResultsPage() {
  const [tab, setTab] = useState<"2d" | "3d">("2d");
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [cam, setCam] = useState<CamPayload | null>(null);
  const [camBusy, setCamBusy] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  // The same choice the training page writes. Both read data/results2d/selected.json,
  // so marking a run in either place changes what the other shows.
  const [runs, setRuns] = useState<{ id: string; arch: string; folds: number; epochs: number }[]>([]);

  // Hydrate results tab from localStorage
  useEffect(() => {
    try {
      const savedTab = localStorage.getItem("bme_results_tab") as "2d" | "3d" | null;
      if (savedTab === "2d" || savedTab === "3d") {
        setTab(savedTab);
      }
    } catch { /* ignore */ }
  }, []);

  const handleTabChange = (newTab: "2d" | "3d") => {
    setTab(newTab);
    try {
      localStorage.setItem("bme_results_tab", newTab);
    } catch { /* ignore */ }
  };


  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/results", { cache: "no-store" });
      if (res.ok) setData(await res.json());
      const rr = await fetch("/api/training", { cache: "no-store" });
      if (rr.ok) setRuns((await rr.json()).runs ?? []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const markRun = async (id: string | null) => {
    await fetch("/api/selected-model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run: id }),
    });
    load();
  };

  const loadCam = async () => {
    try {
      const r = await fetch("/api/gradcam", { cache: "no-store" });
      if (r.ok) setCam(await r.json());
    } catch { /* optional */ }
  };

  const makeCam = async () => {
    setCamBusy(true); setCamError(null);
    try {
      const r = await fetch("/api/gradcam", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n: 24 }),
      });
      if (!r.ok) setCamError((await r.json().catch(() => ({}))).error ?? "could not start");
    } finally { setCamBusy(false); setTimeout(loadCam, 1500); }
  };

  useEffect(() => { load(); loadCam(); }, []);

  // Poll only while heatmaps are being generated.
  useEffect(() => {
    if (!cam?.running) return;
    const t = setInterval(loadCam, 4000);
    return () => clearInterval(t);
  }, [cam?.running]);

  const m = data?.twoD.metrics;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Model results</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Two independent pipelines. Neither blocks the other.
          </p>
        </div>
        <button
          onClick={load}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <div className="flex gap-1 border-b border-border">
        {([
          ["2d", "2D classifier", Layers],
          ["3d", "3D segmentation", Boxes],
        ] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => handleTabChange(id)}
            className={`-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition ${
              tab === id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
            {id === "3d" && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Next
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === "2d" && (
        <div className="space-y-5">
          <div className="rounded-lg border border-border border-l-4 border-l-primary bg-card p-4 text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">What this answers.</span>{" "}
            Whether a scan looks like it has bone marrow edema. It does not locate or
            measure anything — that is the 3D pipeline. Labels are per case and applied
            to every slice, so a BME patient&apos;s normal-looking slices are still
            labelled BME. <span className="font-semibold text-foreground">Quote the
            case-level row</span>, not the slice-level one.
          </div>

          <TestImage />

          {!data?.twoD.available ? (
            <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
              <Activity className="mx-auto mb-3 h-6 w-6 opacity-50" />
              No results yet. Run{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                ml/scripts/train_2d.py
              </code>
              .
            </div>
          ) : m ? (
            <>
              <div className="rounded-lg border border-border bg-card p-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Model in use
                  </span>
                  {data.twoD.selectionExplicit ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-primary">
                      <CheckCircle2 className="h-3.5 w-3.5" /> marked
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      nothing marked — showing the latest run
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={data.twoD.selectedRun ?? ""}
                    onChange={(e) => markRun(e.target.value || null)}
                    className="min-w-[18rem] rounded-md border border-border bg-background px-2 py-1.5 text-sm">
                    <option value="">Latest run (no choice saved)</option>
                    {runs.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.arch} · {r.folds} folds · {r.epochs} epochs · {r.id.slice(0, 13)}
                      </option>
                    ))}
                  </select>
                  {data.twoD.selectionExplicit && (
                    <button onClick={() => markRun(null)}
                      className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground">
                      Unmark
                    </button>
                  )}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Every number on this page comes from this run. The same choice is shown on the
                  Training page — changing it in either place changes both.
                </p>
              </div>

              <MetricRow label="Case level — the headline number" m={m.case_level} />
              <MetricRow label="Slice level — noisy labels, read the caveat" m={m.slice_level} muted />

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-lg border border-border bg-card p-4">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Confusion — case level
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 text-sm">
                    <div />
                    <div className="p-2 text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Pred clear</div>
                    <div className="p-2 text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Pred BME</div>
                    <div className="flex items-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">True clear</div>
                    <div className="rounded bg-muted p-3 text-center text-lg font-semibold tabular-nums">{m.case_level.confusion[0][0]}</div>
                    <div className="rounded bg-muted p-3 text-center text-lg font-semibold tabular-nums">{m.case_level.confusion[0][1]}</div>
                    <div className="flex items-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">True BME</div>
                    <div className="rounded bg-muted p-3 text-center text-lg font-semibold tabular-nums">{m.case_level.confusion[1][0]}</div>
                    <div className="rounded bg-muted p-3 text-center text-lg font-semibold tabular-nums">{m.case_level.confusion[1][1]}</div>
                  </div>
                </div>

                <div className="rounded-lg border border-border bg-card p-4">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Setup
                  </div>
                  <dl className="space-y-1.5 text-sm">
                    {[
                      ["Model", m.model],
                      ["Cases", `${m.n_cases}`],
                      ["Slices", `${m.n_slices}`],
                      ["Cross-validation", `${m.folds}-fold, split by patient`],
                      ["Epochs", `${m.epochs}`],
                      ["Device", m.device],
                      ["Seed", `${m.seed}`],
                    ].map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">{k}</dt>
                        <dd className="text-right font-medium tabular-nums">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </div>

              <div className="rounded-lg border border-border bg-card p-4">
                <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Per fold
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                        <th className="p-2 text-left">Fold</th>
                        <th className="p-2 text-right">Slices</th>
                        <th className="p-2 text-right">Accuracy</th>
                        <th className="p-2 text-right">F1</th>
                        <th className="p-2 text-right">AUC</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.per_fold.map((f, i) => (
                        <tr key={i} className="border-b border-border/50">
                          <td className="p-2 tabular-nums">{i}</td>
                          <td className="p-2 text-right tabular-nums">{f.n}</td>
                          <td className="p-2 text-right tabular-nums">{pct(f.accuracy)}</td>
                          <td className="p-2 text-right tabular-nums">{pct(f.f1)}</td>
                          <td className="p-2 text-right tabular-nums">{pct(f.auc)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : null}

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Eye className="h-3.5 w-3.5" /> Grad-CAM — what the model looked at
              </span>
              <button onClick={makeCam} disabled={camBusy || cam?.running}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs disabled:opacity-40">
                {camBusy || cam?.running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {cam?.running ? "Generating…" : cam?.available ? "Regenerate" : "Generate"}
              </button>
            </div>

            {camError && (
              <p className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                {camError}
              </p>
            )}

            {cam?.running && (
              <pre className="mb-3 max-h-28 overflow-auto rounded bg-muted p-2 font-mono text-[10px]">
                {cam.log || "starting…"}
              </pre>
            )}

            {cam?.available && cam.data ? (
              <>
                <p className="mb-3 text-xs text-muted-foreground">
                  {cam.data.arch} on {cam.data.device}, from the {cam.data.n_folds} saved fold
                  checkpoints — no training was done to produce these. Each slice is explained by
                  the fold model that held its case out, so{" "}
                  <strong>no model saw the patient it is explaining</strong>. Red marks the regions
                  that most raised that model&apos;s score.
                </p>
                {(() => {
                  // A model that predicts one class for nearly everything has not
                  // learnt anything, and its heatmaps mean nothing. Say so rather
                  // than letting a wall of green ticks imply it is working.
                  const n = cam.data.entries.length;
                  const pos = cam.data.entries.filter((e) => e.pred === 1).length;
                  const skew = Math.max(pos, n - pos) / Math.max(1, n);
                  return skew >= 0.9 ? (
                    <p className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                      <strong>This model predicts &ldquo;{pos > n - pos ? "BME" : "clear"}&rdquo;
                      on {Math.round(skew * 100)}% of slices.</strong> It has collapsed to one
                      class and has not learnt the task, so these heatmaps show what an untrained
                      network attends to — not evidence about edema. Train properly, then
                      regenerate.
                    </p>
                  ) : null;
                })()}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                  {cam.data.entries.map((e, i) => (
                    <figure key={i} className="m-0">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={e.thumb} alt={`Grad-CAM for ${e.case_id}`}
                        className="w-full rounded border border-border" />
                      <figcaption className="mt-1 text-[10px] leading-tight text-muted-foreground">
                        <span className="tabular-nums">{e.case_id}</span>
                        <span className={`ml-1 font-semibold ${e.pred === e.true ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                          {e.pred === e.true ? "agrees" : "differs"}
                        </span>
                        <span className="block tabular-nums opacity-70">
                          p={e.prob.toFixed(2)} · case is {e.true ? "BME" : "clear"}
                        </span>
                      </figcaption>
                    </figure>
                  ))}
                </div>
                <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                  <p>
                    <span className="font-semibold text-foreground">
                      &ldquo;Agrees&rdquo; is not the same as &ldquo;correct&rdquo;.
                    </span>{" "}
                    The comparison is against the <em>case</em> label — which folder the scan came
                    from — applied to every slice of it. A BME patient&apos;s scan contains many
                    slices with no edema on them, so a slice marked{" "}
                    <span className="text-amber-600 dark:text-amber-400">differs</span> may well be
                    a slice the model read correctly. <strong>Only you can judge a single
                    slice</strong>; this column shows label agreement, nothing more.
                  </p>
                  <p>
                    <span className="font-semibold text-foreground">
                      Heat outside the bone is expected here.
                    </span>{" "}
                    The classifier has no anatomical constraint — it attends anywhere in the image,
                    muscle included. That is precisely the failure the segmentation model is built
                    to avoid: it predicts bone and lesion together and clips the lesion to bone, so
                    muscle cannot be labelled as edema.
                  </p>
                  <p>{cam.data.caveat}</p>
                </div>
              </>
            ) : !cam?.running ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {cam?.trained
                  ? "No heatmaps yet. Generating loads the saved fold checkpoints and explains held-out slices — seconds, not minutes."
                  : "No trained classifier yet. Train one on the Training page; Grad-CAM explains those weights rather than training its own."}
              </p>
            ) : null}
          </div>
        </div>
      )}

      {tab === "3d" && (
        <div className="space-y-5">
          <div className="rounded-lg border border-border border-l-4 border-l-primary bg-card p-4 text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">What this will answer.</span>{" "}
            Exactly where the edema is, its volume in mm³, and a 3D surface — segmenting
            bone first, then edema only inside it. It needs annotated cases before it can
            train.
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Annotated
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">
                {data?.threeD.annotations.total ?? 0}
                <span className="text-base font-normal text-muted-foreground">
                  {" "}/ {data?.threeD.worklist?.totalCases ?? "—"}
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                ~10 needed before first training
              </div>
            </div>
          </div>

          {data?.threeD.worklist && (
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Assigned work
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="p-2 text-left">Annotator</th>
                      <th className="p-2 text-right">Cases</th>
                      <th className="p-2 text-right">Isotropic</th>
                      <th className="p-2 text-right">BME+</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.threeD.worklist.byPerson).map(([who, s]) => (
                      <tr key={who} className="border-b border-border/50">
                        <td className="p-2 font-medium">{who}</td>
                        <td className="p-2 text-right tabular-nums">{s.total}</td>
                        <td className="p-2 text-right tabular-nums">{s.isotropic}</td>
                        <td className="p-2 text-right tabular-nums">{s.bme}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Drawing happens in 3D Slicer, not here. Start a case with{" "}
                <code className="rounded bg-muted px-1.5 py-0.5">ml/scripts/slicer_setup.py</code>.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
