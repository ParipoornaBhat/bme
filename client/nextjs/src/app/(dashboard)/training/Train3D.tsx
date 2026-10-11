"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Cloud, Cpu, Download, Loader2, Play, RefreshCw, Square } from "lucide-react";

type Torch = {
  cudaAvailable: boolean; deviceName: string | null; vramGB: number | null; reason: string | null;
};
type Summary = { mean: number; std: number } | null;
type Metrics = {
  n_cases: number; n_bme: number; n_negative: number; folds: number; epochs: number;
  presence_correct: number; presence_n: number; note: string;
  summary: Record<string, Summary>;
};
type Prog = {
  fraction: number; phase: string; currentFold: number; folds: number;
  currentEpoch: number; epochs: number; doneEpochs: number;
  etaSeconds: number | null; elapsedSeconds: number | null;
};
type State = {
  annotated: number; bme: number; nonBme: number; running: boolean;
  metrics: Metrics | null; log: string; progress: Prog | null;
};
type KaggleState = {
  running: boolean;
  log: string;
  state: { startedAt?: number; action?: string; pid?: number };
  metrics: Metrics | null;
};

const fmt = (s: number | null) => {
  if (s == null) return "—";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

export default function Train3D({
  torch, device, onDevice, onRunning,
}: {
  torch: Torch | null;
  device: "auto" | "cuda" | "cpu";
  onDevice: (v: "auto" | "cuda" | "cpu") => void;
  onRunning: (running: boolean) => void;
}) {
  const [computeMode, setComputeMode] = useState<"kaggle" | "local">("kaggle");
  const [state, setState] = useState<State | null>(null);
  const [kaggleState, setKaggleState] = useState<KaggleState | null>(null);
  const [epochs, setEpochs] = useState(40);
  const [folds, setFolds] = useState(5);
  const [busy, setBusy] = useState(false);
  const [kaggleBusy, setKaggleBusy] = useState(false);
  const onRunningRef = useRef(onRunning);
  onRunningRef.current = onRunning;

  // Local state polling
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/training-3d", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json() as State;
      setState(j);
      if (computeMode === "local") onRunningRef.current(j.running);
    } catch { /* ignore */ }
  }, [computeMode]);

  // Kaggle state polling
  const loadKaggle = useCallback(async () => {
    try {
      const r = await fetch("/api/training-3d/kaggle", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json() as KaggleState;
      setKaggleState(j);
      if (computeMode === "kaggle") onRunningRef.current(j.running);
    } catch { /* ignore */ }
  }, [computeMode]);

  useEffect(() => {
    load();
    loadKaggle();
  }, [load, loadKaggle]);

  useEffect(() => {
    if (!state?.running) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [state?.running, load]);

  useEffect(() => {
    if (!kaggleState?.running) return;
    const id = setInterval(loadKaggle, 3000);
    return () => clearInterval(id);
  }, [kaggleState?.running, loadKaggle]);

  const startLocal = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/training-3d", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epochs, folds, device }),
      });
      const j = await r.json();
      if (!r.ok) alert(j.error ?? "could not start");
    } finally {
      setBusy(false);
      setTimeout(load, 800);
    }
  };

  const stopLocal = async () => {
    await fetch("/api/training-3d", { method: "DELETE" });
    load();
  };

  const startKaggle = async () => {
    setKaggleBusy(true);
    try {
      const r = await fetch("/api/training-3d/kaggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      const j = await r.json();
      if (!r.ok) alert(j.error ?? "could not start Kaggle training");
    } finally {
      setKaggleBusy(false);
      setTimeout(loadKaggle, 800);
    }
  };

  const stopKaggle = async () => {
    await fetch("/api/training-3d/kaggle", { method: "DELETE" });
    loadKaggle();
  };

  const downloadKaggle = async () => {
    setKaggleBusy(true);
    try {
      const r = await fetch("/api/training-3d/kaggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "download" }),
      });
      const j = await r.json();
      if (!r.ok) alert(j.error ?? "could not download weights");
    } finally {
      setKaggleBusy(false);
      setTimeout(loadKaggle, 800);
    }
  };

  const n = state?.annotated ?? 0;
  const activeMetrics = kaggleState?.metrics || state?.metrics;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border border-l-4 border-l-primary bg-card p-4 text-sm text-muted-foreground">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold text-foreground">3D U-Net</span>
          <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">Patch 96×96×12</span>
          <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium">Loss: Dice + focal</span>
          <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium">Bone + edema, edema kept inside bone</span>
        </div>
        <p>
          Trains on patches of each saved volume at its own spacing. Bone and edema are learned
          together, patients stay on one side of each fold, and a new scan is predicted with a
          sliding window. Edema outside the predicted bone is removed. Volume on the results page
          is the predicted edema in mm³.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        {/* Compute Target Selector */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Compute:</span>
            <button
              onClick={() => setComputeMode("kaggle")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                computeMode === "kaggle"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "border border-border bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              <Cloud className="h-3.5 w-3.5" />
              ☁ Kaggle Cloud GPU (Free NVIDIA T4 — Zero Setup)
            </button>
            <button
              onClick={() => setComputeMode("local")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                computeMode === "local"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "border border-border bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              <Cpu className="h-3.5 w-3.5" />
              Local Machine
            </button>
          </div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {n} saved 3D case{n !== 1 ? "s" : ""} {state ? `(${state.bme} BME · ${state.nonBme} non-BME)` : ""}
          </div>
        </div>

        {computeMode === "kaggle" ? (
          /* Kaggle Cloud GPU Controls */
          <div className="space-y-3">
            <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-xs text-muted-foreground">
              <div className="font-semibold text-foreground flex items-center gap-1.5 mb-1">
                <Cloud className="h-4 w-4 text-primary" />
                100% Automated Background Cloud GPU Training (30 Free Hours/Week)
              </div>
              <p>
                One-click pipeline: your 3D dataset is de-identified, uploaded to Kaggle, and trained on an <strong>NVIDIA T4 GPU</strong> in Google&apos;s cloud.
                When training finishes, weights (<code>fold_*.pt</code>) and metrics are automatically downloaded directly into <code>data/results3d/</code>.
                You can close your laptop and walk away anytime!
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              {kaggleState?.running ? (
                <button
                  onClick={stopKaggle}
                  className="inline-flex items-center gap-2 rounded-md border border-destructive px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10"
                >
                  <Square className="h-4 w-4" /> Stop Watcher
                </button>
              ) : (
                <button
                  onClick={startKaggle}
                  disabled={kaggleBusy || n < 2}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow hover:opacity-95 disabled:opacity-40"
                >
                  {kaggleBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  ☁ Train on Kaggle GPU
                </button>
              )}

              <button
                onClick={downloadKaggle}
                disabled={kaggleBusy}
                className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-40"
              >
                {kaggleBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Fetch Latest Weights from Kaggle
              </button>

              <button
                onClick={loadKaggle}
                title="Refresh Status"
                className="inline-flex items-center gap-1 rounded-md border border-border p-2 text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : (
          /* Local Machine Controls */
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Saved 3D cases</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">
                {n}
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {state ? `${state.bme} BME · ${state.nonBme} non-BME` : ""}
                </span>
              </div>
            </div>
            <label className="text-sm">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Epochs</span>
              <input type="number" min={1} max={200} value={epochs} disabled={state?.running}
                onChange={(e) => setEpochs(Number(e.target.value))}
                className="w-20 rounded-md border border-border bg-background px-3 py-2 text-sm" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Folds</span>
              <input type="number" min={2} max={Math.max(2, n)} value={folds} disabled={state?.running}
                onChange={(e) => setFolds(Number(e.target.value))}
                className="w-20 rounded-md border border-border bg-background px-3 py-2 text-sm" />
            </label>
            <div className="ml-auto">
              {state?.running ? (
                <button onClick={stopLocal}
                  className="inline-flex items-center gap-2 rounded-md border border-destructive px-4 py-2 text-sm font-medium text-destructive">
                  <Square className="h-4 w-4" /> Stop
                </button>
              ) : (
                <button onClick={startLocal} disabled={busy || n < 2}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  Train 3D U-Net (Local)
                </button>
              )}
            </div>
            <div className="flex items-center gap-2 text-sm">
              {(["auto", "cuda", "cpu"] as const).map((v) => (
                <button key={v} disabled={Boolean(state?.running || (v === "cuda" && torch && !torch.cudaAvailable))}
                  onClick={() => onDevice(v)}
                  className={`rounded-md border px-3 py-2 ${device === v ? "border-primary text-foreground" : "border-border text-muted-foreground"} disabled:opacity-40`}>
                  {v === "auto" ? "Auto" : v === "cuda" ? "GPU" : "CPU"}
                </button>
              ))}
              {torch?.deviceName && (
                <span className="text-xs text-muted-foreground">{torch.deviceName}{torch.vramGB ? ` · ${torch.vramGB} GB` : ""}</span>
              )}
            </div>
          </div>
        )}

        {n < 2 && (
          <p className="mt-3 text-xs text-muted-foreground">
            Save at least two 3D annotations first. The 2D training tabs are unchanged.
          </p>
        )}
      </div>

      {/* Kaggle Log Box */}
      {computeMode === "kaggle" && (kaggleState?.running || kaggleState?.log) && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-2 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {kaggleState?.running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {kaggleState?.running ? "Kaggle Cloud Training Active" : "Last Kaggle Run Log"}
          </div>
          <pre className="max-h-64 overflow-auto rounded bg-muted p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {kaggleState?.log || "Waiting for Kaggle pipeline output…"}
          </pre>
        </div>
      )}

      {/* Local Log Box */}
      {computeMode === "local" && (state?.running || state?.log) && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-2 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {state?.running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {state?.running ? "Training 3D U-Net" : "Last run"}
          </div>
          {state?.running && state.progress && (
            <div className="mb-3">
              <div className="mb-1.5 flex flex-wrap justify-between gap-2 text-sm">
                <span className="font-medium tabular-nums">
                  {(state.progress.fraction * 100).toFixed(0)}%
                  <span className="ml-2 font-normal text-muted-foreground">
                    {state.progress.phase}
                    {state.progress.doneEpochs > 0 && (
                      <> · fold {state.progress.currentFold + 1} of {state.progress.folds} · epoch {state.progress.currentEpoch} of {state.progress.epochs}</>
                    )}
                  </span>
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {fmt(state.progress.elapsedSeconds)} elapsed
                  {state.progress.etaSeconds != null && <> · ~{fmt(state.progress.etaSeconds)} left</>}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${state.progress.fraction * 100}%` }} />
              </div>
            </div>
          )}
          <pre className="max-h-64 overflow-auto rounded bg-muted p-3 font-mono text-[11px] leading-relaxed">
            {state?.log || "waiting for output…"}
          </pre>
        </div>
      )}

      {/* Metrics Result Display */}
      {activeMetrics && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            3D result — {activeMetrics.n_cases} volumes, {activeMetrics.n_bme} with edema, {activeMetrics.n_negative} without
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(["bone_dice", "bme_dice", "lesion_sensitivity", "fp_per_case"] as const).map((k) => {
              const s = activeMetrics.summary[k];
              return (
                <div key={k} className="rounded-lg border border-border p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{k.replace(/_/g, " ")}</div>
                  <div className="mt-1 text-xl font-semibold tabular-nums">
                    {s ? `${s.mean.toFixed(3)} ± ${s.std.toFixed(3)}` : "—"}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-sm">
            Edema present/absent matched on {activeMetrics.presence_correct} of {activeMetrics.presence_n} held-out volumes.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{activeMetrics.note}</p>
        </div>
      )}
    </div>
  );
}
