"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, Circle, Info, Layers, Loader2, PenTool, Play, Square, Target, Trash2, Trophy } from "lucide-react";

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
type SegProg = Prog & { phase: string };
type SegState = {
  annotated: number; cases: string[]; running: boolean;
  metrics: SegMetrics | null; log: string; progress: SegProg | null;
};

type Torch = {
  cudaAvailable: boolean; deviceName: string | null; vramGB: number | null;
  torchVersion: string | null; cudaBuild: string | null; reason: string | null;
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

/**
 * Plain-language definitions of the metrics on this page.
 *
 * Collapsed and unstyled by default. It is a reference for us, not a feature
 * for a viewer, so it sits behind a quiet "i" rather than competing with the
 * controls. Every example uses this project's own numbers, because an abstract
 * definition of recall is not what anyone is stuck on at 1am.
 */
function Terms() {
  const rows: { term: string; plain: string; example: string }[] = [
    {
      term: "Accuracy",
      plain: "Out of every scan, how many did we label correctly — BME or not.",
      example:
        "Misleading here. We have 69 non-BME and 18 BME patients, so a model that always says “no BME” scores 79% and has found nothing. Only worth quoting next to the 79% baseline.",
    },
    {
      term: "Recall (Sensitivity)",
      plain: "Of the patients who really have BME, what fraction did we catch?",
      example:
        "We catch 12 of 18 → recall 0.67. The 6 we miss are the ones that matter clinically: a missed lesion goes untreated. This is the metric to lead with.",
    },
    {
      term: "Precision",
      plain: "When we say “BME”, how often are we right?",
      example:
        "12 correct out of 14 alarms → 0.86. Low precision means radiologists stop trusting the tool because it cries wolf.",
    },
    {
      term: "F1",
      plain: "One number balancing precision and recall. High only when both are high.",
      example:
        "0.75 for us. Rough guide: below 0.5 poor, 0.5–0.7 usable, above 0.8 strong. It ignores the 69 correct “no BME” calls entirely — that is deliberate.",
    },
    {
      term: "AUC",
      plain:
        "Pick one BME patient and one healthy patient at random. AUC is the chance the model scores the BME one higher.",
      example:
        "0.92 for us. 0.5 is a coin flip, 1.0 is perfect. It measures ranking, not the yes/no decision — which is why one of our folds hit AUC 1.00 while catching zero patients: the ranking was perfect, the cut-off was wrong.",
    },
    {
      term: "Dice",
      plain:
        "For segmentation: how much the painted lesion and the predicted lesion overlap. 0 = no overlap, 1 = identical.",
      example:
        "Published work gets ~0.88 on bone but only ~0.69 on lesions. Expect 0.6–0.7. Anything above 0.85 on a dataset this size means something has leaked.",
    },
    {
      term: "Lesion / lesion-level",
      plain:
        "One connected patch of edema. Lesion-level asks “did we find this patch at all”, not “did we trace it perfectly”.",
      example:
        "A model can score a bad Dice by getting edges wrong while still finding every lesion — clinically that is a success, so we report both.",
    },
    {
      term: "Fold / cross-validation",
      plain:
        "Split the patients into k groups; train on k−1 and test on the held-out one, k times. No patient is ever tested by a model that trained on them.",
      example:
        "With 18 BME patients and 5 folds, each test group holds only 3–4. One unlucky group swings the score hard — which is why we report the spread, not just the average.",
    },
    {
      term: "Mean ± std",
      plain: "The average across folds, and how much the folds disagreed.",
      example:
        "F1 0.63 ± 0.34 means folds ranged 0.00 to 1.00 — the average is real but you cannot rely on it. F1 0.66 ± 0.06 is a number you can defend.",
    },
    {
      term: "Overfitting",
      plain: "The model memorises the training scans instead of learning what edema looks like.",
      example:
        "Our 7-epoch run scored worse than the 4-epoch one. That is the signature: more training, worse results on unseen patients.",
    },
  ];

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-4">
      <p className="mb-3 text-xs text-muted-foreground">
        Internal reference. Numbers below are from this project, so they change as the model does.
      </p>
      <dl className="space-y-3">
        {rows.map((r) => (
          <div key={r.term} className="border-b border-border/40 pb-3 last:border-0 last:pb-0">
            <dt className="text-sm font-semibold text-foreground">{r.term}</dt>
            <dd className="mt-0.5 text-sm text-muted-foreground">{r.plain}</dd>
            <dd className="mt-1 text-xs text-muted-foreground/80">{r.example}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Where to train. Shown in both tabs because the choice matters far more for
 * segmentation (20-40x) than for the classifier, and a reader who saw it only
 * once would reasonably assume it applied to whichever tab they were on.
 *
 * "GPU" is disabled, with the reason attached, when torch cannot actually use
 * one — an option that silently does nothing is worse than no option.
 */
function DevicePicker({
  torch, value, onChange, disabled,
}: {
  torch: Torch | null;
  value: "auto" | "cuda" | "cpu";
  onChange: (v: "auto" | "cuda" | "cpu") => void;
  disabled?: boolean;
}) {
  const gpuReady = Boolean(torch?.cudaAvailable);
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">Run on</label>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as "auto" | "cuda" | "cpu")}
        className="rounded-md border border-border bg-background px-2 py-1.5 text-sm disabled:opacity-50">
        <option value="auto">Auto{gpuReady ? " (GPU)" : " (CPU)"}</option>
        <option value="cuda" disabled={!gpuReady}>
          GPU{gpuReady && torch?.deviceName ? ` — ${torch.deviceName}` : " (unavailable)"}
        </option>
        <option value="cpu">CPU</option>
      </select>
      <p className="max-w-[22rem] text-[11px] leading-snug text-muted-foreground">
        {gpuReady ? (
          <>
            {torch?.deviceName}
            {torch?.vramGB ? ` · ${torch.vramGB} GB` : ""} ready. Segmentation is roughly
            20–40× faster here than on CPU.
          </>
        ) : (
          torch?.reason ?? "Checking what this machine can use…"
        )}
      </p>
    </div>
  );
}

export default function TrainingPage() {
  const [archs, setArchs] = useState<string[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  // The run the whole dashboard stands behind. Server-side in
  // data/results2d/selected.json, so the results page sees the same choice.
  const [selected, setSelected] = useState<string | null>(null);
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
  const [torch, setTorch] = useState<Torch | null>(null);
  const [device, setDevice] = useState<"auto" | "cuda" | "cpu">("auto");
  const [showWhy, setShowWhy] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
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
      const savedDevice = localStorage.getItem("bme_training_device");
      if (savedDevice === "auto" || savedDevice === "cuda" || savedDevice === "cpu") setDevice(savedDevice);
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
    setSelected(j.selected ?? null);
    setTorch(j.torch ?? null);
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
          device,
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
          device,
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

  // Clicking the marked run again unmarks it, which returns every page to
  // "latest run" rather than leaving a stale choice nobody can find.
  const markRun = async (id: string) => {
    const next = selected === id ? null : id;
    setSelected(next);
    await fetch("/api/selected-model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run: next }),
    });
    load();
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

      <div className="flex items-center gap-1 border-b border-border">
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
        {/* Ours, not the viewer's. Deliberately quiet: it explains the numbers
            rather than being one of the two things this page does. */}
        <button onClick={() => setShowTerms((v) => !v)}
          aria-expanded={showTerms}
          title="What these numbers mean"
          className={`ml-auto mb-1 rounded p-1.5 transition ${
            showTerms ? "text-foreground" : "text-muted-foreground/40 hover:text-muted-foreground"}`}>
          <Info className="h-4 w-4" />
        </button>
      </div>

      {showTerms && <Terms />}

      {tab === "seg" ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-border border-l-4 border-l-primary bg-card p-4 text-sm text-muted-foreground">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="font-semibold text-foreground text-base">2D Dual-Channel U-Net Segmenter</span>
              <span className="rounded bg-primary/10 text-primary px-2 py-0.5 text-xs font-medium">Architecture: 2D U-Net</span>
              <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium">Loss: Dice + Focal</span>
              <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium">Outputs: Bone + BME</span>
            </div>
            <button onClick={() => setShowWhy((v) => !v)}
              aria-expanded={showWhy}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showWhy ? "rotate-180" : ""}`} />
              Why this architecture
            </button>
            <div className={`grid transition-all duration-200 ${
              showWhy ? "grid-rows-[1fr] opacity-100 mt-2" : "grid-rows-[0fr] opacity-0"
            }`}>
              <div className="overflow-hidden">
                <p className="leading-relaxed">
                  Learns a joint representation of <strong>Bone Marrow</strong> (Channel 1) and{" "}
                  <strong>BME Lesion</strong> (Channel 2). At inference the predicted lesion is clipped to
                  the bone mask, which removes muscle and joint-effusion false positives — edema outside
                  bone is, by definition, not bone marrow edema.
                </p>
                <p className="mt-2 leading-relaxed">
                  A 2D U-Net reached DSC <strong>0.96</strong> on marrow segmentation against 0.91 for a
                  semi-automatic 3D Grow-Cut algorithm (<em>Paper 1</em>). Plain U-Net also beat UNet++,
                  Attention-UNet and HRNet on hip BME, scoring <strong>88.5%</strong> on bone but only{" "}
                  <strong>69.4%</strong> on the lesion (<em>Paper 5</em>) — that twenty-point gap is what
                  this model has to close, and it is the realistic target to expect.
                </p>
              </div>
            </div>
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

              <DevicePicker torch={torch} value={device} disabled={seg?.running}
                onChange={(v) => { setDevice(v); try { localStorage.setItem("bme_training_device", v); } catch { /* ignore */ } }} />
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

              {seg?.running && seg.progress && (
                <div className="mb-3">
                  <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                    <span className="font-medium tabular-nums">
                      {(seg.progress.fraction * 100).toFixed(0)}%
                      <span className="ml-2 font-normal text-muted-foreground">
                        {seg.progress.phase}
                        {seg.progress.doneEpochs > 0 && (
                          <>
                            {" · "}fold {seg.progress.currentFold + 1} of {seg.progress.folds}
                            {" · "}epoch {seg.progress.currentEpoch} of {seg.progress.epochs}
                          </>
                        )}
                      </span>
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {fmt(seg.progress.elapsedSeconds)} elapsed
                      {seg.progress.etaSeconds != null && (
                        <> {"·"} <span className="font-medium text-foreground">
                          ~{fmt(seg.progress.etaSeconds)} left
                        </span></>
                      )}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary transition-all duration-500"
                      style={{ width: `${seg.progress.fraction * 100}%` }} />
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {seg.progress.doneEpochs > 0
                      ? `${seg.progress.doneEpochs} of ${seg.progress.totalEpochs} epochs done. The estimate assumes remaining epochs cost the same as those already finished, so it reads high until a few have passed.`
                      : "Converting and validating annotations before training starts. No estimate yet — the first epoch is what makes one possible."}
                  </p>
                </div>
              )}

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

          <DevicePicker torch={torch} value={device} disabled={running}
            onChange={(v) => { setDevice(v); try { localStorage.setItem("bme_training_device", v); } catch { /* ignore */ } }} />

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
                  <th className="p-2 text-left">Use</th>
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
                  <tr key={r.id}
                    className={`border-b border-border/50 ${
                      selected === r.id ? "bg-primary/10" : ""
                    }`}>
                    <td className="p-2">
                      <button onClick={() => markRun(r.id)}
                        title={selected === r.id
                          ? "This run is used on the Results page. Click to unmark."
                          : "Use this run as the project's model"}
                        aria-pressed={selected === r.id}
                        className={`rounded p-1 transition ${
                          selected === r.id
                            ? "text-primary"
                            : "text-muted-foreground/40 hover:text-foreground"
                        }`}>
                        {selected === r.id
                          ? <CheckCircle2 className="h-4 w-4" />
                          : <Circle className="h-4 w-4" />}
                      </button>
                    </td>
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
