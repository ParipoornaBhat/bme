"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Play, Square, Trophy } from "lucide-react";

type Metric = { accuracy: number; precision: number; recall: number; f1: number; auc: number; n: number };
type Prog = {
  fraction: number; doneEpochs: number; totalEpochs: number;
  currentFold: number; currentEpoch: number; folds: number; epochs: number;
  etaSeconds: number | null; elapsedSeconds: number | null;
};
type Run = {
  id: string; arch: string; folds: number; epochs: number;
  finishedAt: string | null; nSlices: number; nCases: number;
  case: Metric; slice: Metric;
};

/** Seconds as a compact human duration. */
const fmt = (s: number | null) => {
  if (s == null) return "—";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), sec = s % 60;
  if (m < 60) return `${m}m ${sec}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

const pct = (v?: number) => (v == null || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(1)}%`);

/** Case-level AUC across runs, oldest first. Inline SVG — no chart library. */
function AucChart({ runs }: { runs: Run[] }) {
  const data = [...runs].reverse();
  if (data.length < 2) {
    return (
      <p className="py-8 text-center text-xs text-muted-foreground">
        Two or more runs needed before a trend is worth drawing.
      </p>
    );
  }
  const W = 620, H = 170, pad = 34;
  const xs = (i: number) => pad + (i * (W - pad * 2)) / (data.length - 1);
  // fixed 0.4–1.0 window: AUC below 0.5 is worse than guessing, and a
  // self-scaling axis would make a flat, poor run look like progress.
  const ys = (v: number) => H - pad - ((Math.max(0.4, Math.min(1, v)) - 0.4) / 0.6) * (H - pad * 2);
  const pts = data.map((r, i) => `${xs(i)},${ys(r.case.auc)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Case-level AUC by run">
      {[0.5, 0.7, 0.9].map((g) => (
        <g key={g}>
          <line x1={pad} x2={W - pad} y1={ys(g)} y2={ys(g)}
            stroke="currentColor" strokeOpacity={g === 0.5 ? 0.35 : 0.12}
            strokeDasharray={g === 0.5 ? "4 3" : undefined} />
          <text x={4} y={ys(g) + 4} fontSize="10" fill="currentColor" fillOpacity={0.5}>
            {g.toFixed(1)}
          </text>
        </g>
      ))}
      <text x={4} y={ys(0.5) - 6} fontSize="9" fill="currentColor" fillOpacity={0.45}>chance</text>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" className="text-primary" />
      {data.map((r, i) => (
        <g key={r.id}>
          <circle cx={xs(i)} cy={ys(r.case.auc)} r="4" className="fill-primary" />
          <text x={xs(i)} y={H - 10} fontSize="9" textAnchor="middle" fill="currentColor" fillOpacity={0.6}>
            {r.arch.replace("_", " ").slice(0, 10)}
          </text>
        </g>
      ))}
    </svg>
  );
}

export default function TrainingPage() {
  const [archs, setArchs] = useState<string[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState("");
  const [arch, setArch] = useState("resnet18");
  const [folds, setFolds] = useState(5);
  const [epochs, setEpochs] = useState(4);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Prog | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/training", { cache: "no-store" });
    if (!res.ok) return;
    const j = await res.json();
    setArchs(j.archs); setRuns(j.runs); setRunning(j.running); setLog(j.log);
    setProgress(j.progress ?? null);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll only while a run is in flight.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [running, load]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const start = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/training", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ arch, folds, epochs }),
      });
      const j = await res.json();
      if (!res.ok) alert(j.error ?? "could not start");
      else { setRunning(true); setLog(""); }
    } finally { setBusy(false); load(); }
  };

  const stop = async () => {
    setBusy(true);
    try { await fetch("/api/training", { method: "DELETE" }); }
    finally { setBusy(false); setRunning(false); load(); }
  };

  const best = runs.length
    ? runs.reduce((a, b) => (b.case.auc > a.case.auc ? b : a))
    : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Training</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          2D classifier. Every model listed ships with torchvision — switching needs no install.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Model
            </span>
            <select value={arch} onChange={(e) => setArch(e.target.value)} disabled={running}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm">
              {archs.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Folds
            </span>
            <input type="number" min={2} max={10} value={folds} disabled={running}
              onChange={(e) => setFolds(Number(e.target.value))}
              className="w-20 rounded-md border border-border bg-background px-3 py-2 text-sm" />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Epochs
            </span>
            <input type="number" min={1} max={50} value={epochs} disabled={running}
              onChange={(e) => setEpochs(Number(e.target.value))}
              className="w-20 rounded-md border border-border bg-background px-3 py-2 text-sm" />
          </label>

          <div className="ml-auto">
            {running ? (
              <button onClick={stop} disabled={busy}
                className="inline-flex items-center gap-2 rounded-md border border-destructive px-4 py-2 text-sm font-medium text-destructive">
                <Square className="h-4 w-4" /> Stop
              </button>
            ) : (
              <button onClick={start} disabled={busy}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Start training
              </button>
            )}
          </div>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          Runs on CPU here — PyTorch has no CUDA build for Python 3.14 yet. Five folds at
          six epochs took about 45 minutes. Lower both while experimenting.
        </p>
      </div>

      {(running || log) && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {running ? "Training in progress" : "Last run log"}
          </div>

          {running && progress && (
            <div className="mb-3">
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium tabular-nums">
                  {(progress.fraction * 100).toFixed(0)}%
                  <span className="ml-2 font-normal text-muted-foreground">
                    fold {progress.currentFold + 1} of {progress.folds}
                    {" · "}epoch {progress.currentEpoch} of {progress.epochs}
                  </span>
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {fmt(progress.elapsedSeconds)} elapsed
                  {progress.etaSeconds != null && (
                    <> {"·"} <span className="font-medium text-foreground">
                      ~{fmt(progress.etaSeconds)} left
                    </span></>
                  )}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-all duration-500"
                  style={{ width: `${progress.fraction * 100}%` }} />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {progress.doneEpochs} of {progress.totalEpochs} epochs done. Estimate assumes
                remaining epochs cost the same as those already finished.
              </p>
            </div>
          )}
          <pre ref={logRef}
            className="max-h-56 overflow-auto rounded bg-muted p-3 font-mono text-[11px] leading-relaxed">
            {log || "waiting for output…"}
          </pre>
        </div>
      )}

      {best && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Trophy className="h-3.5 w-3.5" /> Best run so far — case level
          </div>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <span className="text-lg font-semibold">{best.arch}</span>
            {(["accuracy", "f1", "auc"] as const).map((k) => (
              <span key={k} className="text-sm text-muted-foreground">
                {k === "auc" ? "AUC" : k} <span className="ml-1 font-semibold tabular-nums text-foreground">{pct(best.case[k])}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Case-level AUC by run
        </div>
        <AucChart runs={runs} />
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          History — {runs.length} run{runs.length === 1 ? "" : "s"}
        </div>
        {runs.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No runs yet. Start one above.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="p-2 text-left">Model</th>
                  <th className="p-2 text-left">Finished</th>
                  <th className="p-2 text-right">Folds</th>
                  <th className="p-2 text-right">Epochs</th>
                  <th className="p-2 text-right">Accuracy</th>
                  <th className="p-2 text-right">F1</th>
                  <th className="p-2 text-right">AUC</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-border/50">
                    <td className="p-2 font-medium">{r.arch}</td>
                    <td className="p-2 text-muted-foreground">
                      {r.finishedAt ? new Date(r.finishedAt).toLocaleString() : "—"}
                    </td>
                    <td className="p-2 text-right tabular-nums">{r.folds}</td>
                    <td className="p-2 text-right tabular-nums">{r.epochs}</td>
                    <td className="p-2 text-right tabular-nums">{pct(r.case.accuracy)}</td>
                    <td className="p-2 text-right tabular-nums">{pct(r.case.f1)}</td>
                    <td className="p-2 text-right font-semibold tabular-nums">{pct(r.case.auc)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          All figures are case level — slice probabilities averaged per patient. Cross-validation
          is split by patient, so no case appears in both training and validation.
        </p>
      </div>
    </div>
  );
}
