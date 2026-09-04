"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Layers, Loader2, PenTool, Play, Square, Target, Trash2, Trophy } from "lucide-react";

type Metric = { accuracy: number; precision: number; recall: number; f1: number; auc: number; n: number };
type Prog = {
  fraction: number; doneEpochs: number; totalEpochs: number;
  currentFold: number; currentEpoch: number; folds: number; epochs: number;
  etaSeconds: number | null; elapsedSeconds: number | null;
};
type SegMetrics = {
  model: string; device: string; folds: number; epochs: number;
  n_slices: number; n_cases: number; note: string;
  summary: Record<string, { mean: number; std: number } | null>;
};
type SegState = {
  annotated: number; cases: string[]; running: boolean;
  metrics: SegMetrics | null; log: string;
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
  const [freeze, setFreeze] = useState<string>("");
  const [patience, setPatience] = useState<string>("5");
  const [him, setHim] = useState(false);
  const [tta, setTta] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Prog | null>(null);
  const [tab, setTab] = useState<"cls" | "seg">("cls");
  const [seg, setSeg] = useState<SegState | null>(null);
  const [segEpochs, setSegEpochs] = useState(40);
  const [segFolds, setSegFolds] = useState(5);
  const [segBatch, setSegBatch] = useState(8);
  const [segBusy, setSegBusy] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  // Restore training tab and options from localStorage
  useEffect(() => {
    try {
      const savedTab = localStorage.getItem("bme_training_tab") as "cls" | "seg" | null;
      if (savedTab === "cls" || savedTab === "seg") setTab(savedTab);
      const savedArch = localStorage.getItem("bme_training_arch");
      if (savedArch) setArch(savedArch);
      const savedFolds = localStorage.getItem("bme_training_folds");
      if (savedFolds) setFolds(Number(savedFolds));
      const savedEpochs = localStorage.getItem("bme_training_epochs");
      if (savedEpochs) setEpochs(Number(savedEpochs));
      const savedFreeze = localStorage.getItem("bme_training_freeze");
      if (savedFreeze !== null) setFreeze(savedFreeze);
      const savedPatience = localStorage.getItem("bme_training_patience");
      if (savedPatience !== null) setPatience(savedPatience);
      const savedHim = localStorage.getItem("bme_training_him");
      if (savedHim !== null) setHim(savedHim === "true");
      const savedTta = localStorage.getItem("bme_training_tta");
      if (savedTta !== null) setTta(savedTta === "true");
      const savedSegEpochs = localStorage.getItem("bme_training_seg_epochs");
      if (savedSegEpochs) setSegEpochs(Number(savedSegEpochs));
      const savedSegFolds = localStorage.getItem("bme_training_seg_folds");
      if (savedSegFolds) setSegFolds(Number(savedSegFolds));
      const savedSegBatch = localStorage.getItem("bme_training_seg_batch");
      if (savedSegBatch) setSegBatch(Number(savedSegBatch));
    } catch { /* ignore */ }
  }, []);

  const handleTabChange = (newTab: "cls" | "seg") => {
    setTab(newTab);
    try { localStorage.setItem("bme_training_tab", newTab); } catch { /* ignore */ }
  };


  const load = useCallback(async () => {
    const res = await fetch("/api/training", { cache: "no-store" });
    if (!res.ok) return;
    const j = await res.json();
    setArchs(j.archs); setRuns(j.runs); setRunning(j.running); setLog(j.log);
    setProgress(j.progress ?? null);
  }, []);

  const loadSeg = useCallback(async () => {
    try {
      const r = await fetch("/api/training-seg", { cache: "no-store" });
      if (r.ok) setSeg(await r.json());
    } catch { /* optional */ }
  }, []);

  const startSeg = async () => {
    setSegBusy(true);
    try {
      const r = await fetch("/api/training-seg", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          epochs: segEpochs,
          folds: segFolds,
          batch: segBatch,
        }),
      });
      const j = await r.json();
      if (!r.ok) alert(j.error ?? "could not start");
    } finally { setSegBusy(false); setTimeout(loadSeg, 1200); }
  };

  const stopSeg = async () => {
    await fetch("/api/training-seg", { method: "DELETE" });
    loadSeg();
  };

  useEffect(() => { load(); loadSeg(); }, [load, loadSeg]);

  useEffect(() => {
    if (!seg?.running) return;
    const id = setInterval(loadSeg, 4000);
    return () => clearInterval(id);
  }, [seg?.running, loadSeg]);

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
        body: JSON.stringify({
          arch,
          folds,
          epochs,
          him,
          tta,
          freeze: freeze === "" ? null : Number(freeze),
          patience: patience === "" ? null : Number(patience),
        }),
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

  const removeRun = async (id: string) => {
    if (!confirm(`Delete run ${id}? This removes its metrics only — the dataset, annotations and slice images are untouched.`)) return;
    await fetch(`/api/training?run=${encodeURIComponent(id)}`, { method: "DELETE" });
    load();
  };

  const clearAll = async () => {
    if (!confirm(`Delete all ${runs.length} run(s)? This clears the history and the chart. Nothing else is affected.`)) return;
    await fetch("/api/training?run=all", { method: "DELETE" });
    load();
  };

  const best = runs.length
    ? runs.reduce((a, b) => (b.case.auc > a.case.auc ? b : a))
    : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">2D Deep Learning Training</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Two complementary 2D pipelines: <strong>Detection / Screening</strong> (Is BME Present?) and <strong>2D U-Net</strong> (Dual-Channel Bone &amp; Edema Segmentation).
        </p>
      </div>

      <div className="flex gap-1 border-b border-border">
        {([
          ["cls", "1. Detection (BME Present / Absent)", Layers],
          ["seg", "2. Segmentation (2D U-Net Mark Edema)", Target],
        ] as const).map(([id, label, Icon]) => (
          <button key={id} onClick={() => handleTabChange(id)}
            className={`-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition ${
              tab === id ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      {tab === "seg" ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-border border-l-4 border-l-primary bg-card p-4 text-sm text-muted-foreground">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="font-semibold text-foreground text-base">2D Dual-Channel U-Net Segmenter</span>
              <span className="rounded bg-primary/10 text-primary px-2 py-0.5 text-xs font-medium">Architecture: 2D U-Net</span>
              <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium">Loss: Dice + Focal</span>
              <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium">Outputs: Bone + BME</span>
            </div>
            <p className="leading-relaxed">
              Learns joint representation of <strong>Bone Marrow</strong> (Channel 1) and <strong>BME Lesion</strong> (Channel 2).
              At inference, the predicted lesion is clipped to the bone mask, removing muscle and joint-effusion false positives
              (grounded in <em>Research Papers 01 &amp; 03</em>). 2D U-Net operates directly on crisp in-plane slice resolution,
              outperforming 3D models on anisotropic MRI volumes (<em>Research Paper 10</em>).
            </p>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Annotated cases
                </div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">
                  {seg?.annotated ?? 0}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {(seg?.annotated ?? 0) < 5 ? "\u2014 aim for 10 before trusting a number" : "ready"}
                  </span>
                </div>
              </div>

              <label className="text-sm">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Model
                </span>
                <div className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm font-medium">
                  2D Dual-Channel U-Net
                </div>
              </label>

              <label className="text-sm">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Epochs
                </span>
                <input type="number" min={1} max={200} value={segEpochs} disabled={seg?.running}
                  onChange={(e) => setSegEpochs(Number(e.target.value))}
                  className="w-20 rounded-md border border-border bg-background px-3 py-2 text-sm" />
              </label>

              <label className="text-sm">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Folds
                </span>
                <input type="number" min={2} max={10} value={segFolds} disabled={seg?.running}
                  onChange={(e) => setSegFolds(Number(e.target.value))}
                  className="w-20 rounded-md border border-border bg-background px-3 py-2 text-sm" />
              </label>

              <label className="text-sm">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Batch size
                </span>
                <select value={segBatch} onChange={(e) => setSegBatch(Number(e.target.value))} disabled={seg?.running}
                  className="rounded-md border border-border bg-background px-3 py-2 text-sm">
                  {[4, 8, 16, 32].map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </label>

              <div className="ml-auto">
                {seg?.running ? (
                  <button onClick={stopSeg}
                    className="inline-flex items-center gap-2 rounded-md border border-destructive px-4 py-2 text-sm font-medium text-destructive">
                    <Square className="h-4 w-4" /> Stop
                  </button>
                ) : (
                  <button onClick={startSeg} disabled={segBusy || (seg?.annotated ?? 0) === 0}
                    className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40">
                    {segBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    Train 2D U-Net
                  </button>
                )}
              </div>
            </div>

            {(seg?.annotated ?? 0) === 0 && (
              <p className="mt-3 inline-flex items-center gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                <PenTool className="h-3.5 w-3.5" />
                Nothing to train on yet. Annotate a case on the <strong>Annotate</strong> page, save,
                then come back.
              </p>
            )}
          </div>

          {(seg?.running || seg?.log) && (
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="mb-2 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {seg?.running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {seg?.running ? "Running 2D U-Net Training" : "Last run"}
              </div>
              <pre className="max-h-64 overflow-auto rounded bg-muted p-3 font-mono text-[11px] leading-relaxed">
                {seg?.log || "waiting for output\u2026"}
              </pre>
            </div>
          )}

          {seg?.metrics && (
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                2D U-Net result &mdash; {seg.metrics.n_cases} case(s), {seg.metrics.n_slices} slices
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {(["bone_dice", "lesion_dice", "lesion_sensitivity"] as const).map((k) => {
                  const s = seg.metrics!.summary[k];
                  return (
                    <div key={k} className="rounded-lg border border-border p-3">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {k.replace(/_/g, " ")}
                      </div>
                      <div className="mt-1 text-xl font-semibold tabular-nums">
                        {s ? `${s.mean.toFixed(3)} \u00b1 ${s.std.toFixed(3)}` : "\u2014"}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">{seg.metrics.note}</p>
            </div>
          )}
        </div>
      ) : (
        <>
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

          <label className="text-sm">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Freeze blocks
            </span>
            <select value={freeze} onChange={(e) => setFreeze(e.target.value)} disabled={running}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm">
              <option value="">Full fine-tuning (0)</option>
              <option value="4">4 blocks</option>
              <option value="6">6 blocks</option>
              <option value="8">8 blocks</option>
            </select>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Patience
            </span>
            <input type="number" min={1} max={20} value={patience} disabled={running}
              placeholder="5"
              onChange={(e) => setPatience(e.target.value)}
              className="w-20 rounded-md border border-border bg-background px-3 py-2 text-sm" />
          </label>

          <div className="flex flex-col gap-1.5 text-sm">
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={him} disabled={running}
                onChange={(e) => setHim(e.target.checked)} />
              <span>High-intensity mask</span>
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={tta} disabled={running}
                onChange={(e) => setTta(e.target.checked)} />
              <span>Test-time augmentation</span>
            </label>
          </div>

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
          <strong>High-intensity mask</strong> keeps only the bright voxels — on a
          fat-suppressed scan edema <em>is</em> brightness, so this hands the model the signal
          instead of making it find it. <strong>Test-time augmentation</strong> averages the
          prediction over flips and shifts at inference; no retraining, and it trims false
          positives. Both are worth an A/B against a plain run.
          <br />
          Runs on CPU — five folds at six epochs takes about 45 minutes. Lower both while
          experimenting.
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
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            History — {runs.length} run{runs.length === 1 ? "" : "s"}
          </span>
          {runs.length > 0 && (
            <button onClick={clearAll} disabled={running}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-destructive hover:text-destructive disabled:opacity-40">
              <Trash2 className="h-3.5 w-3.5" /> Clear all
            </button>
          )}
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
                  <th className="p-2"><span className="sr-only">Delete</span></th>
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
                    <td className="p-2 text-right">
                      <button onClick={() => removeRun(r.id)} disabled={running}
                        title={`Delete ${r.id}`}
                        className="rounded p-1 text-muted-foreground/60 hover:bg-accent hover:text-destructive disabled:opacity-30">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
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
        </>
      )}
    </div>
  );
}
