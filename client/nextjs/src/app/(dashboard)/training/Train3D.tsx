"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Cpu,
  Download,
  Info,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  UploadCloud,
  X,
} from "lucide-react";

type Torch = {
  cudaAvailable: boolean;
  deviceName: string | null;
  vramGB: number | null;
  reason: string | null;
};

type Summary = { mean: number; std: number } | null;

type Metrics = {
  n_cases: number;
  n_bme: number;
  n_negative: number;
  folds: number;
  epochs: number;
  presence_correct: number;
  presence_n: number;
  note: string;
  summary: Record<string, Summary>;
};

type Prog = {
  fraction: number;
  phase: string;
  currentFold: number;
  folds: number;
  currentEpoch: number;
  epochs: number;
  doneEpochs: number;
  etaSeconds: number | null;
  elapsedSeconds: number | null;
};

type State = {
  annotated: number;
  bme: number;
  nonBme: number;
  running: boolean;
  metrics: Metrics | null;
  log: string;
  progress: Prog | null;
};

type KaggleRouteState = {
  running: boolean;
  action: string | null;
  startedAt: number | null;
  pid: number | null;
  log: string;
  stagingDir?: string;
  error?: string;
};

type PreflightCounts = {
  cases?: number;
  files?: number;
  size_mb?: number;
  combined_sha256?: string;
};

type StepId = "preflight" | "upload" | "launch" | "status" | "download" | "import";

export default function Train3D({
  torch,
  device,
  onDevice,
  onRunning,
}: {
  torch: Torch | null;
  device: "auto" | "cuda" | "cpu";
  onDevice: (v: "auto" | "cuda" | "cpu") => void;
  onRunning: (running: boolean) => void;
}) {
  const [state, setState] = useState<State | null>(null);
  const [epochs, setEpochs] = useState(40);
  const [folds, setFolds] = useState(5);
  const [busy, setBusy] = useState(false);

  // Kaggle Step Modal State
  const [showKaggleModal, setShowKaggleModal] = useState(false);
  const [currentStep, setCurrentStep] = useState<StepId>("preflight");
  const [kaggleState, setKaggleState] = useState<KaggleRouteState | null>(null);
  const [kaggleBusy, setKaggleBusy] = useState(false);
  const [exportDir, setExportDir] = useState("../bme_colab_export");
  const [mappingFile, setMappingFile] = useState("../bme_recovery/export_mapping.json");
  const [preflightCounts, setPreflightCounts] = useState<PreflightCounts | null>(null);
  const [preflightPassed, setPreflightPassed] = useState(false);
  const [uploadConfirmed, setUploadConfirmed] = useState(false);
  const [launchConfirmed, setLaunchConfirmed] = useState(false);
  const [fullTraining, setFullTraining] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);

  const onRunningRef = useRef(onRunning);
  onRunningRef.current = onRunning;

  // Local state polling
  const loadLocal = useCallback(async () => {
    try {
      const r = await fetch("/api/training-3d", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as State;
      setState(j);
      onRunningRef.current(j.running);
    } catch {
      // ignore
    }
  }, []);

  // Kaggle state polling
  const loadKaggle = useCallback(async () => {
    try {
      const r = await fetch("/api/training-3d/kaggle", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as KaggleRouteState;
      setKaggleState(j);

      // Parse counts from log if preflight ran
      if (j.log.includes("KAGGLE PREFLIGHT: FULL PASS")) {
        setPreflightPassed(true);
        const casesMatch = /Cases\s*:\s*(\d+)/.exec(j.log);
        const filesMatch = /Files\s*:\s*(\d+)/.exec(j.log);
        const sizeMatch = /Size\s*:\s*([\d.]+)\s*MB/.exec(j.log);
        const shaMatch = /Combined SHA\s*:\s*([a-f0-9]+)/.exec(j.log);
        if (casesMatch || filesMatch) {
          setPreflightCounts({
            cases: casesMatch ? Number(casesMatch[1]) : undefined,
            files: filesMatch ? Number(filesMatch[1]) : undefined,
            size_mb: sizeMatch ? Number(sizeMatch[1]) : undefined,
            combined_sha256: shaMatch ? shaMatch[1] : undefined,
          });
        }
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadLocal();
    loadKaggle();
  }, [loadLocal, loadKaggle]);

  useEffect(() => {
    if (!state?.running) return;
    const id = setInterval(loadLocal, 3000);
    return () => clearInterval(id);
  }, [state?.running, loadLocal]);

  useEffect(() => {
    if (!kaggleState?.running && !showKaggleModal) return;
    const id = setInterval(loadKaggle, 3000);
    return () => clearInterval(id);
  }, [kaggleState?.running, showKaggleModal, loadKaggle]);

  const startLocal = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/training-3d", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epochs, folds, device }),
      });
      const j = await r.json();
      if (!r.ok) alert(j.error ?? "Could not start local training");
    } finally {
      setBusy(false);
      setTimeout(loadLocal, 800);
    }
  };

  const stopLocal = async () => {
    await fetch("/api/training-3d", { method: "DELETE" });
    loadLocal();
  };

  const executeKaggleAction = async (
    action: StepId,
    extraBody: Record<string, unknown> = {}
  ) => {
    setKaggleBusy(true);
    setStepError(null);
    try {
      const r = await fetch("/api/training-3d/kaggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          exportDir,
          mappingFile,
          ...extraBody,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        setStepError(j.error ?? `Failed to run ${action}`);
      } else {
        setTimeout(loadKaggle, 500);
      }
    } catch (e: unknown) {
      setStepError((e as Error).message || "Network request failed");
    } finally {
      setKaggleBusy(false);
    }
  };

  const stopKaggleProcess = async () => {
    setKaggleBusy(true);
    try {
      await fetch("/api/training-3d/kaggle", { method: "DELETE" });
      setTimeout(loadKaggle, 500);
    } finally {
      setKaggleBusy(false);
    }
  };

  const n = state?.annotated ?? 0;
  const activeMetrics = state?.metrics;

  const stepsList: { id: StepId; label: string; desc: string }[] = [
    { id: "preflight", label: "1. Preflight", desc: "Verify de-identification and zero leaks" },
    { id: "upload", label: "2. Confirm Upload", desc: "Upload verified data to private dataset" },
    { id: "launch", label: "3. Launch Kernel", desc: "Start background GPU training on Kaggle" },
    { id: "status", label: "4. Cloud Status", desc: "Poll cloud status and inspect live logs" },
    { id: "download", label: "5. Download", desc: "Download outputs to isolated staging folder" },
    { id: "import", label: "6. Import", desc: "Verify weights (weights_only) into results" },
  ];

  return (
    <div className="space-y-4">
      {/* 3D Model Info Card */}
      <div className="rounded-lg border border-border border-l-4 border-l-primary bg-card p-4 text-sm text-muted-foreground">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold text-foreground">3D U-Net</span>
          <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">Patch 96×96×12</span>
          <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium">Loss: Dice + focal</span>
          <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium">Bone + edema joint segmentation</span>
        </div>
        <p>
          Trains on volumetric patches at natural spacing. Bone and edema are learned together, and edema
          outside predicted bone is clipped at inference. Select local execution or open the safeguarded
          Kaggle Cloud GPU workflow.
        </p>
      </div>

      {/* Main Training Controls */}
      <div className="rounded-lg border border-border bg-card p-4">
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
            <input
              type="number"
              min={1}
              max={200}
              value={epochs}
              disabled={state?.running}
              onChange={(e) => setEpochs(Number(e.target.value))}
              className="w-20 rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Folds</span>
            <input
              type="number"
              min={2}
              max={Math.max(2, n)}
              value={folds}
              disabled={state?.running}
              onChange={(e) => setFolds(Number(e.target.value))}
              className="w-20 rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </label>

          {/* Action Buttons */}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {state?.running ? (
              <button
                onClick={stopLocal}
                className="inline-flex items-center gap-2 rounded-md border border-destructive px-4 py-2 text-sm font-medium text-destructive"
              >
                <Square className="h-4 w-4" /> Stop Local
              </button>
            ) : (
              <button
                onClick={startLocal}
                disabled={busy || n < 2}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Train 3D U-Net (Local)
              </button>
            )}
          </div>

          {/* Device & Kaggle Switcher */}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {(["auto", "cuda", "cpu"] as const).map((v) => (
              <button
                key={v}
                disabled={Boolean(state?.running || (v === "cuda" && torch && !torch.cudaAvailable))}
                onClick={() => onDevice(v)}
                className={`rounded-md border px-3 py-2 ${
                  device === v ? "border-primary text-foreground font-semibold" : "border-border text-muted-foreground"
                } disabled:opacity-40`}
              >
                {v === "auto" ? "Auto" : v === "cuda" ? "GPU" : "CPU"}
              </button>
            ))}

            {/* Optional Kaggle Cloud GPU Option next to Auto | GPU | CPU */}
            <button
              onClick={() => {
                setShowKaggleModal(true);
                loadKaggle();
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/50 bg-primary/10 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/20 transition shadow-sm"
            >
              <Cloud className="h-4 w-4" />
              Kaggle Cloud GPU
              {kaggleState?.running && <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse ml-0.5" />}
            </button>

            {torch?.deviceName && (
              <span className="text-xs text-muted-foreground ml-1">
                {torch.deviceName}
                {torch.vramGB ? ` · ${torch.vramGB} GB` : ""}
              </span>
            )}
          </div>
        </div>

        {n < 2 && (
          <p className="mt-3 text-xs text-muted-foreground">
            Save at least two 3D annotations first. The 2D training tabs are unchanged.
          </p>
        )}
      </div>

      {/* Local Run Log Box */}
      {(state?.running || state?.log) && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-2 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {state?.running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {state?.running ? "Running Local 3D Training" : "Last Local Run Log"}
          </div>
          <pre className="max-h-64 overflow-auto rounded bg-muted p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {state?.log || "Waiting for output…"}
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

      {/* KAGGLE STEP MODAL (SAFEGUARDED WORKFLOW) */}
      {showKaggleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="relative w-full max-w-4xl rounded-xl border border-border bg-card shadow-2xl p-6 text-foreground space-y-6 max-h-[92vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="flex items-start justify-between border-b border-border pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <Cloud className="h-5 w-5 text-primary" />
                  <h2 className="text-lg font-semibold tracking-tight">Kaggle Cloud GPU Training (Safe Pipeline)</h2>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Zero automatic uploads. Requires explicit confirmation clicks. Transmits only verified de-identified data.
                </p>
              </div>
              <button
                onClick={() => setShowKaggleModal(false)}
                className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted"
                title="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Step Wizard Navigation */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
              {stepsList.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setCurrentStep(s.id)}
                  className={`text-left p-2.5 rounded-lg border text-xs transition ${
                    currentStep === s.id
                      ? "border-primary bg-primary/10 text-primary font-medium shadow-sm"
                      : "border-border bg-muted/30 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <div className="font-semibold truncate">{s.label}</div>
                  <div className="text-[10px] opacity-75 truncate">{s.desc}</div>
                </button>
              ))}
            </div>

            {/* Error Banner */}
            {stepError && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{stepError}</span>
              </div>
            )}

            {/* Current Step Content */}
            <div className="rounded-lg border border-border bg-muted/20 p-5 space-y-4">
              {/* STEP 1: PREFLIGHT */}
              {currentStep === "preflight" && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                    Step 1: Preflight Verification & Leak Check
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Preflight validates that the export folder exists outside the repository, re-runs{" "}
                    <code>export_for_colab.py --verify</code> (requiring exit code 0 and FULL PASS), and
                    confirms the private mapping file is not inside the export folder or any zip. No data is sent to Kaggle.
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <label>
                      <span className="block font-medium text-muted-foreground mb-1">Export Directory (outside repo)</span>
                      <input
                        type="text"
                        value={exportDir}
                        onChange={(e) => setExportDir(e.target.value)}
                        className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
                      />
                    </label>
                    <label>
                      <span className="block font-medium text-muted-foreground mb-1">Mapping File (outside repo)</span>
                      <input
                        type="text"
                        value={mappingFile}
                        onChange={(e) => setMappingFile(e.target.value)}
                        className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
                      />
                    </label>
                  </div>

                  <div className="flex items-center gap-3 pt-2">
                    <button
                      onClick={() => executeKaggleAction("preflight")}
                      disabled={kaggleBusy || Boolean(kaggleState?.running)}
                      className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40"
                    >
                      {kaggleBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                      Run Preflight Check
                    </button>
                    {preflightPassed && (
                      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-500 font-medium">
                        <CheckCircle2 className="h-4 w-4" /> Preflight PASSED
                      </span>
                    )}
                  </div>

                  {preflightCounts && (
                    <div className="rounded-md border border-border bg-background p-3 text-xs space-y-1 font-mono">
                      <div className="font-semibold text-foreground mb-1">Preflight Verified Counts:</div>
                      <div>• Cases: {preflightCounts.cases ?? "—"}</div>
                      <div>• Files: {preflightCounts.files ?? "—"}</div>
                      <div>• Size: {preflightCounts.size_mb ? `${preflightCounts.size_mb} MB` : "—"}</div>
                      <div>• Combined SHA-256: {preflightCounts.combined_sha256 ? `${preflightCounts.combined_sha256.slice(0, 16)}…` : "—"}</div>
                    </div>
                  )}
                </div>
              )}

              {/* STEP 2: CONFIRM UPLOAD */}
              {currentStep === "upload" && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <UploadCloud className="h-4 w-4 text-primary" />
                    Step 2: Confirm & Upload to Private Dataset
                  </div>

                  {/* Explicit Mandatory Confirmation Dialog */}
                  <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-xs space-y-2">
                    <div className="font-semibold text-amber-500 flex items-center gap-1.5">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      MANDATORY PRIVACY & DATA CONFIRMATION
                    </div>
                    <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                      <li>Only fully de-identified, ethics-approved data may ever be transmitted.</li>
                      <li>The target dataset will be created/versioned strictly as <strong>PRIVATE</strong> on Kaggle.</li>
                      <li>The private mapping file, internal ML scripts, and raw data are strictly excluded.</li>
                      <li>
                        Verified preflight counts: <strong>{preflightCounts?.cases ?? "—"} cases</strong>,{" "}
                        <strong>{preflightCounts?.files ?? "—"} files</strong> ({preflightCounts?.size_mb ?? "—"} MB).
                      </li>
                    </ul>

                    <label className="flex items-start gap-2 pt-2 text-foreground font-medium cursor-pointer">
                      <input
                        type="checkbox"
                        checked={uploadConfirmed}
                        onChange={(e) => setUploadConfirmed(e.target.checked)}
                        className="mt-0.5 rounded border-border"
                      />
                      <span>
                        I explicitly confirm that only approved, de-identified research data is selected and it will be stored as a private dataset.
                      </span>
                    </label>
                  </div>

                  <div className="flex items-center gap-3 pt-1">
                    <button
                      onClick={() => executeKaggleAction("upload", { confirmUpload: true })}
                      disabled={!uploadConfirmed || !preflightPassed || kaggleBusy || Boolean(kaggleState?.running)}
                      className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40"
                    >
                      {kaggleBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
                      Upload to Private Kaggle Dataset
                    </button>
                    {!preflightPassed && (
                      <span className="text-xs text-muted-foreground">
                        (Preflight verification must pass first in Step 1)
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* STEP 3: LAUNCH KERNEL */}
              {currentStep === "launch" && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Play className="h-4 w-4 text-primary" />
                    Step 3: Launch Training Kernel on Kaggle GPU
                  </div>

                  {/* Explicit Mandatory Launch Dialog */}
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-xs space-y-3">
                    <div className="font-semibold text-foreground flex items-center gap-1.5">
                      <Info className="h-4 w-4 text-primary shrink-0" />
                      KERNEL EXECUTION SPECIFICATION
                    </div>
                    <p className="text-muted-foreground">
                      Pushes the notebook kernel to Kaggle with GPU enabled (NVIDIA T4), Internet enabled,
                      and private visibility. The only attached dataset source is your private dataset.
                    </p>

                    <div className="flex items-center gap-4 pt-1">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="config_mode"
                          checked={!fullTraining}
                          onChange={() => setFullTraining(false)}
                        />
                        <span>Smoke Test (<code>quick_test</code>: 2 epochs, 2 folds)</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="config_mode"
                          checked={fullTraining}
                          onChange={() => setFullTraining(true)}
                        />
                        <span>Full Training (<code>full</code>: 40 epochs, 5 folds)</span>
                      </label>
                    </div>

                    <label className="flex items-start gap-2 pt-2 text-foreground font-medium cursor-pointer">
                      <input
                        type="checkbox"
                        checked={launchConfirmed}
                        onChange={(e) => setLaunchConfirmed(e.target.checked)}
                        className="mt-0.5 rounded border-border"
                      />
                      <span>I confirm launching the background Kaggle GPU training job.</span>
                    </label>
                  </div>

                  <div className="flex items-center gap-3 pt-1">
                    <button
                      onClick={() => executeKaggleAction("launch", { confirmLaunch: true, full: fullTraining })}
                      disabled={!launchConfirmed || kaggleBusy || Boolean(kaggleState?.running)}
                      className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40"
                    >
                      {kaggleBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                      Launch GPU Training Kernel
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 4: STATUS */}
              {currentStep === "status" && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <Layers className="h-4 w-4 text-primary" />
                      Step 4: Kaggle Cloud Execution Status
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => executeKaggleAction("status")}
                        disabled={kaggleBusy}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <RefreshCw className="h-3.5 w-3.5" /> Refresh Status
                      </button>
                      {kaggleState?.running && (
                        <button
                          onClick={stopKaggleProcess}
                          className="inline-flex items-center gap-1.5 rounded-md border border-destructive px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10"
                        >
                          <Square className="h-3.5 w-3.5" /> Stop Process
                        </button>
                      )}
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Polls read-only kernel status on Kaggle. You can safely close your browser or turn off your computer;
                    Kaggle continues running in the cloud.
                  </p>
                </div>
              )}

              {/* STEP 5: DOWNLOAD */}
              {currentStep === "download" && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Download className="h-4 w-4 text-primary" />
                    Step 5: Download Kernel Outputs to Staging
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Downloads outputs from Kaggle into an isolated staging folder outside the repository.
                    Nothing is written directly into <code>data/results3d</code> yet until verified in Step 6.
                  </p>

                  <div className="flex items-center gap-3 pt-1">
                    <button
                      onClick={() => executeKaggleAction("download")}
                      disabled={kaggleBusy || Boolean(kaggleState?.running)}
                      className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40"
                    >
                      {kaggleBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                      Download to Staging Folder
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 6: IMPORT */}
              {currentStep === "import" && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <CheckCircle2 className="h-4 w-4 text-primary" />
                    Step 6: Verified Weights Import
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Runs <code>verify_and_import_weights.py</code> to validate checkpoints using{" "}
                    <code>weights_only=True</code>, verify exact tensor shapes against UNet3D, back up existing
                    results, and import only verified weights and metrics into <code>data/results3d</code>.
                  </p>

                  <div className="flex items-center gap-3 pt-1">
                    <button
                      onClick={() => {
                        executeKaggleAction("import");
                        setTimeout(loadLocal, 1500);
                      }}
                      disabled={kaggleBusy || Boolean(kaggleState?.running)}
                      className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40"
                    >
                      {kaggleBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      Verify & Import to Results
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Live Tail Log Box */}
            <div className="rounded-lg border border-border bg-card p-4 space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <span className="flex items-center gap-2">
                  {kaggleState?.running && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
                  {kaggleState?.running ? `Task Active: ${kaggleState.action ?? "Running"}` : "Kaggle Task Log"}
                </span>
                {kaggleState?.stagingDir && (
                  <span className="text-[10px] font-mono lowercase opacity-70">
                    staging: {kaggleState.stagingDir.split(/[/\\]/).slice(-1)[0]}
                  </span>
                )}
              </div>
              <pre className="max-h-56 overflow-auto rounded bg-muted p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                {kaggleState?.log || "No log output yet."}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
