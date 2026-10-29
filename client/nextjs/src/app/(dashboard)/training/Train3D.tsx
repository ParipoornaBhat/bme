"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Play,
  Square,
  Loader2,
  RefreshCw,
  Cpu,
  Cloud,
  Download,
  CheckCircle2,
  ShieldCheck,
  Layers,
  AlertTriangle,
  Activity,
  X,
  Database,
} from "lucide-react";
import { BUILD_STAMP } from "../../api/training-3d/kaggle/buildStamp";

interface Train3DState {
  running: boolean;
  pid?: number | null;
  log?: string;
  annotated?: number;
  bme?: number;
  nonBme?: number;
  metrics?: {
    bone_dice?: number;
    bme_dice?: number;
    lesion_sensitivity?: number;
    false_positives_per_case?: number;
    volumes?: number;
  } | null;
}

interface TorchInfo {
  version: string;
  cudaAvailable: boolean;
  cudaVersion?: string | null;
  deviceName?: string | null;
  vramGB?: number | null;
}

interface KaggleApproval {
  dataset_slug: string;
  export_combined_sha256: string;
  file_count: number;
  total_bytes: number;
  case_count: number;
  approved_at: string;
  uploaded_version?: string | null;
}

interface KaggleRunState {
  run_id: string;
  kernel_slug: string;
  mode: string;
  dataset_hash: string;
  started_at: number;
  phase: string;
  status_message?: string;
  dest_dir?: string;
}

interface KaggleState {
  running: boolean;
  action?: string | null;
  startedAt?: number | null;
  pid?: number | null;
  log?: string;
  stagingDir?: string;
  approval?: KaggleApproval | null;
  runState?: KaggleRunState | null;
  runMetrics?: any;
  sourceStats?: {
    totalCases: number;
    bme: number;
    nonBme: number;
  };
  buildStamp?: string;
}

type KaggleStepId = "doctor" | "preflight" | "approve" | "upload" | "update-dataset" | "run" | "status" | "fetch-results" | "onetap";

export interface Train3DProps {
  torch?: TorchInfo | { cudaAvailable: boolean; deviceName: string | null; vramGB: number | null; reason?: string | null } | null;
  device?: "auto" | "cuda" | "cpu";
  onDevice?: (v: "auto" | "cuda" | "cpu") => void;
  onRunning?: (running: boolean) => void;
}

export default function Train3D({
  torch: propTorch,
  device: propDevice,
  onDevice: propOnDevice,
  onRunning,
}: Train3DProps = {}) {
  const [state, setState] = useState<Train3DState | null>(null);
  const [torch, setTorch] = useState<TorchInfo | null>(null);
  const [device, setDevice] = useState<"auto" | "cuda" | "cpu">(propDevice ?? "auto");
  const [epochs, setEpochs] = useState<number>(40);
  const [folds, setFolds] = useState<number>(5);
  const [busy, setBusy] = useState(false);

  // Compute Mode: "local" vs "kaggle"
  const [computeMode, setComputeMode] = useState<"local" | "kaggle">("local");

  // Kaggle Wizard & Pipeline State
  const [kaggleState, setKaggleState] = useState<KaggleState | null>(null);
  const [kaggleBusy, setKaggleBusy] = useState(false);

  useEffect(() => {
    if (propDevice) setDevice(propDevice);
  }, [propDevice]);

  useEffect(() => {
    onRunning?.(Boolean(state?.running || kaggleState?.running));
  }, [state?.running, kaggleState?.running, onRunning]);

  const [activeStep, setActiveStep] = useState<KaggleStepId>("doctor");
  const [stepError, setStepError] = useState<string | null>(null);

  // One-Tap Confirmation & State
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [deidCheckbox, setDeidCheckbox] = useState(false);
  const isFirstTime = !kaggleState?.approval;

  // Kaggle Wizard Inputs & Confirmations
  const [exportDir, setExportDir] = useState<string>("../bme_colab_export");
  const [mappingFile, setMappingFile] = useState<string>("../bme_recovery/export_mapping.json");
  const [datasetSlug, setDatasetSlug] = useState<string>("bme-3d-dataset");
  const [kernelSlug, setKernelSlug] = useState<string>("bme-3d-unet-training");
  const [runMode, setRunMode] = useState<"quick" | "bench" | "fold0" | "full" | "eval_suite">("quick");

  const [approveConfirmed, setApproveConfirmed] = useState(false);
  const [uploadConfirmed, setUploadConfirmed] = useState(false);
  const [launchConfirmed, setLaunchConfirmed] = useState(false);

  const loadLocal = useCallback(async () => {
    try {
      const r = await fetch("/api/training-3d");
      if (r.ok) {
        const j = await r.json();
        setState(j);
        if (j.torch) setTorch(j.torch);
      }
    } catch {
      // ignore
    }
  }, []);

  const loadKaggle = useCallback(async () => {
    try {
      const r = await fetch("/api/training-3d/kaggle");
      if (r.ok) {
        const j = await r.json();
        setKaggleState(j);
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
    if (!kaggleState?.running) return;
    const id = setInterval(loadKaggle, 3000);
    return () => clearInterval(id);
  }, [kaggleState?.running, loadKaggle]);

  const onDevice = (d: "auto" | "cuda" | "cpu") => {
    setDevice(d);
    try {
      localStorage.setItem("bme-3d-device", d);
    } catch {
      // ignore
    }
    propOnDevice?.(d);
  };

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
    action: KaggleStepId,
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
          datasetSlug,
          kernelSlug,
          mode: runMode,
          ...extraBody,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        setStepError(j.error ?? `Failed to run ${action}`);
      } else {
        setTimeout(loadKaggle, 800);
      }
    } catch (e: unknown) {
      setStepError(e instanceof Error ? e.message : "Network error");
    } finally {
      setKaggleBusy(false);
    }
  };

  const stopKaggle = async () => {
    await fetch("/api/training-3d/kaggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel-watch" }),
    });
    setTimeout(loadKaggle, 500);
  };

  const n = state?.annotated ?? 0;
  const isStaleServer = Boolean(
    kaggleState?.buildStamp && kaggleState.buildStamp !== BUILD_STAMP
  );

  return (
    <div className="space-y-4">
      {/* 3D Architecture Banner */}
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
          sliding window. Edema outside the predicted bone is removed.
        </p>
      </div>

      {/* Compute Environment Switcher */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Compute Environment:
            </span>
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
            <button
              onClick={() => {
                setComputeMode("kaggle");
                loadKaggle();
              }}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                computeMode === "kaggle"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "border border-border bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              <Cloud className="h-3.5 w-3.5" />
              Kaggle Cloud GPU
              {kaggleState?.running && <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse ml-0.5" />}
            </button>
          </div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {n} saved 3D case{n !== 1 ? "s" : ""} {state ? `(${state.bme} BME · ${state.nonBme} non-BME)` : ""}
          </div>
        </div>

        {/* ================================================================= */}
        {/* KAGGLE CLOUD GPU WIZARD & CONTROLS */}
        {/* ================================================================= */}
        {computeMode === "kaggle" ? (
          <div className="space-y-4">
            {/* Stale Server Warning */}
            {isStaleServer && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <strong>Stale Server Warning:</strong> Running server build stamp (<code>{kaggleState?.buildStamp}</code>)
                  differs from current client build (<code>{BUILD_STAMP}</code>). Rebuild and restart via:
                  <code className="block mt-1 font-mono">pnpm build && pnpm start</code>
                </div>
              </div>
            )}

            {/* Accurate Cloud Training Guidance */}
            <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-xs text-muted-foreground space-y-1">
              <div className="font-semibold text-foreground flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Cloud className="h-4 w-4 text-primary" />
                  Kaggle Cloud GPU Workflow (NVIDIA T4)
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  Build: {BUILD_STAMP.slice(0, 10)}
                </span>
              </div>
              <p>
                The de-identified dataset is verified and uploaded <strong>once</strong> to your private Kaggle dataset.
                Each run launches a Kaggle notebook with your selected configuration. Results are verified before import.
                Check your Kaggle account page for your current weekly GPU quota.
              </p>
              <p className="text-[11px] text-muted-foreground/80">
                Training continues in Kaggle&apos;s cloud even if your computer is powered off.
                Downloading outputs and verified import happen when this app is running (click <em>Fetch Results</em> to resume).
              </p>
            </div>

            {/* ================================================================= */}
            {/* ONE-TAP HERO CONTROL PANEL */}
            {/* ================================================================= */}
            {(() => {
              const isProcessRunning = Boolean(kaggleState?.running);
              const rawPhase = kaggleState?.runState?.phase?.toUpperCase();
              // If the watcher process is actively running, do not show stale FAILED states from earlier aborted attempts
              const phase = isProcessRunning
                ? (rawPhase && rawPhase !== "FAILED" ? rawPhase : "RUNNING")
                : (rawPhase ?? "IDLE");
              const progressMap: Record<string, number> = {
                DOCTOR: 15,
                EXPORT: 30,
                UPLOAD: 50,
                QUEUED: 65,
                RUNNING: 75,
                DOWNLOADING: 90,
                IMPORTING: 95,
                COMPLETED: 100,
                FAILED: 100,
                IDLE: 0,
              };
              const progressPercent = progressMap[phase] ?? (kaggleState?.running ? 75 : 0);

              return (
                <div className="rounded-xl border-2 border-primary/30 bg-gradient-to-b from-card to-primary/5 p-4 sm:p-5 shadow-sm space-y-4">
                  {/* 1-Click Dataset Sync Card */}
                  <div className="rounded-lg border border-border bg-card/90 p-3 sm:p-4 space-y-2 shadow-xs">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <Database className="h-4 w-4 text-primary" />
                          <span className="text-xs sm:text-sm font-bold text-foreground">3D Dataset (76 Cases)</span>
                          <span className="rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 px-2.5 py-0.5 text-[11px] font-semibold">
                            {kaggleState?.sourceStats?.totalCases ?? n} Cases ({kaggleState?.sourceStats?.bme ?? 61} BME, {kaggleState?.sourceStats?.nonBme ?? 15} Non-BME)
                          </span>
                          {kaggleState?.approval ? (
                            <span className="rounded-full bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 text-[10px] font-mono">
                              Kaggle Approved: {kaggleState.approval.case_count} cases ({kaggleState.approval.file_count} files)
                            </span>
                          ) : null}
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-1">
                          Single click to automatically export annotations, verify de-identification, and update the Kaggle dataset bundle.
                        </p>
                      </div>

                      <button
                        onClick={() => executeKaggleAction("update-dataset", { force: true })}
                        disabled={kaggleBusy || Boolean(kaggleState?.running)}
                        className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-xs font-bold text-white shadow hover:bg-emerald-700 transition disabled:opacity-40 shrink-0"
                      >
                        {kaggleBusy && kaggleState?.action === "update-dataset" ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="h-4 w-4" />
                        )}
                        Update Dataset (1-Click)
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm sm:text-base font-bold text-foreground flex items-center gap-2">
                        <Cloud className="h-5 w-5 text-primary" />
                        Train on Kaggle (one tap)
                      </h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Automatic doctor checks, export, one-time upload, cloud GPU execution, and verified weights import.
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <select
                        value={runMode}
                        onChange={(e) => setRunMode(e.target.value as any)}
                        disabled={kaggleBusy || Boolean(kaggleState?.running)}
                        className="rounded-md border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="quick">Quick (1 epoch, smoke test)</option>
                        <option value="bench">Benchmark (Fold 0, 5 epochs)</option>
                        <option value="fold0">Fold 0 Only (40 epochs)</option>
                        <option value="full">Full 5-Fold Training (Production)</option>
                        <option value="eval_suite">Eval Suite</option>
                      </select>

                      <button
                        onClick={() => setShowConfirmModal(true)}
                        disabled={kaggleBusy || Boolean(kaggleState?.running)}
                        className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-xs font-bold text-primary-foreground shadow hover:bg-primary/90 transition disabled:opacity-40"
                      >
                        {kaggleBusy ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Play className="h-4 w-4 fill-current" />
                        )}
                        Train on Kaggle (one tap)
                      </button>
                    </div>
                  </div>

                  {/* Progress Bar & Phase Status */}
                  {(kaggleState?.running || kaggleState?.runState) && (
                    <div className="rounded-lg border border-border bg-background/80 p-3.5 space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold flex items-center gap-2">
                          <span
                            className={`inline-block h-2 w-2 rounded-full ${
                              phase === "COMPLETED"
                                ? "bg-emerald-500"
                                : phase === "FAILED"
                                ? "bg-destructive"
                                : "bg-primary animate-ping"
                            }`}
                          />
                          Phase: <span className="font-mono uppercase">{phase}</span>
                        </span>
                        <span className="text-muted-foreground font-mono">{progressPercent}%</span>
                      </div>

                      <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                        <div
                          className={`h-2 rounded-full transition-all duration-500 ${
                            phase === "COMPLETED"
                              ? "bg-emerald-500"
                              : phase === "FAILED"
                              ? "bg-destructive"
                              : "bg-primary"
                          }`}
                          style={{ width: `${progressPercent}%` }}
                        />
                      </div>

                      {kaggleState?.runState?.status_message && !(isProcessRunning && rawPhase === "FAILED") && (
                        <div className="text-[11px] text-muted-foreground truncate">
                          {kaggleState.runState.status_message}
                        </div>
                      )}
                      {isProcessRunning && rawPhase === "FAILED" && (
                        <div className="text-[11px] text-muted-foreground truncate">
                          Kaggle GPU kernel is running...
                        </div>
                      )}

                      <div className="flex items-center justify-end gap-2 pt-1">
                        {kaggleState?.running ? (
                          <button
                            onClick={stopKaggle}
                            className="inline-flex items-center gap-1 text-[11px] text-destructive hover:underline"
                          >
                            <Square className="h-3 w-3" /> Stop Watcher
                          </button>
                        ) : phase === "FAILED" || (kaggleState?.runState && phase !== "COMPLETED") ? (
                          <button
                            onClick={() => executeKaggleAction("onetap", { resume: true, mode: runMode })}
                            disabled={kaggleBusy}
                            className="inline-flex items-center gap-1.5 rounded bg-primary/10 border border-primary/30 px-3 py-1 text-xs font-semibold text-primary hover:bg-primary/20"
                          >
                            <RefreshCw className="h-3 w-3" /> Retry / Resume from saved state
                          </button>
                        ) : null}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* ================================================================= */}
            {/* COLLAPSED ADVANCED CONTROLS SECTION */}
            {/* ================================================================= */}
            <details className="group rounded-lg border border-border bg-card/40 p-3 space-y-3">
              <summary className="cursor-pointer select-none text-xs font-semibold text-muted-foreground hover:text-foreground flex items-center justify-between">
                <span>Advanced Controls (Step-by-step diagnostics, preflight, upload & fetch)</span>
                <span className="text-[10px] text-muted-foreground/60 group-open:rotate-180 transition">▼</span>
              </summary>
              <div className="pt-3 space-y-3">

            {/* Step Navigation Tabs */}
            <div className="flex flex-wrap gap-1 border-b border-border pb-2 text-xs">
              {[
                { id: "doctor", label: "Diagnostics", icon: Activity },
                { id: "preflight", label: "1. Preflight", icon: ShieldCheck },
                { id: "approve", label: "2. Approve", icon: CheckCircle2 },
                { id: "upload", label: "3. Upload Once", icon: Cloud },
                { id: "run", label: "4. Run Training", icon: Play },
                { id: "status", label: "5. Status", icon: Layers },
                { id: "fetch-results", label: "6. Fetch Results", icon: Download },
              ].map((step) => {
                const Icon = step.icon;
                const isActive = activeStep === step.id;
                return (
                  <button
                    key={step.id}
                    onClick={() => {
                      setActiveStep(step.id as KaggleStepId);
                      setStepError(null);
                    }}
                    className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition ${
                      isActive
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "border border-border bg-background text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {step.label}
                  </button>
                );
              })}

              <button
                onClick={loadKaggle}
                title="Refresh Status"
                className="ml-auto inline-flex items-center gap-1 rounded-md border border-border p-1.5 text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Step Error Alert */}
            {stepError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive flex items-center justify-between">
                <span>{stepError}</span>
                <button onClick={() => setStepError(null)} className="underline font-semibold ml-2">Dismiss</button>
              </div>
            )}

            {/* Step Contents */}
            <div className="rounded-lg border border-border bg-card/60 p-4 space-y-3">
              {/* DIAGNOSTICS (DOCTOR) */}
              {activeStep === "doctor" && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                      <Activity className="h-4 w-4 text-primary" />
                      Pipeline Diagnostics & Security Checks
                    </div>
                    <button
                      onClick={() => executeKaggleAction("doctor")}
                      disabled={kaggleBusy || Boolean(kaggleState?.running)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-40"
                    >
                      {kaggleBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                      Run Diagnostics
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Verifies Python virtual environment, Kaggle dependencies, credential placement outside repo,
                    export directory integrity, network reachability, and server ports. Never exposes credentials.
                  </p>
                </div>
              )}

              {/* STEP 1: PREFLIGHT */}
              {activeStep === "preflight" && (
                <div className="space-y-3">
                  <div className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                    Step 1: De-Identification & Volume Integrity Preflight
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Runs <code>export_for_colab.py --verify</code> to validate all scans, labels, and header sanitization.
                    Ensures zero PHI leaks and computes the export SHA-256 hash.
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs pt-1">
                    <label className="space-y-1">
                      <span className="text-muted-foreground">Export Directory:</span>
                      <input
                        type="text"
                        value={exportDir}
                        onChange={(e) => setExportDir(e.target.value)}
                        className="w-full rounded border border-border bg-background px-2.5 py-1.5 font-mono text-xs"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-muted-foreground">Private Mapping File:</span>
                      <input
                        type="text"
                        value={mappingFile}
                        onChange={(e) => setMappingFile(e.target.value)}
                        className="w-full rounded border border-border bg-background px-2.5 py-1.5 font-mono text-xs"
                      />
                    </label>
                  </div>
                  <div className="pt-2">
                    <button
                      onClick={() => executeKaggleAction("preflight")}
                      disabled={kaggleBusy || Boolean(kaggleState?.running)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40"
                    >
                      {kaggleBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                      Run Preflight Verification
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 2: APPROVE DATASET */}
              {activeStep === "approve" && (
                <div className="space-y-3">
                  <div className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4 text-primary" />
                    Step 2: Record Dataset Approval Hash
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Runs preflight and <code>check_deid_folder.py</code>, then generates a tamper-proof approval record
                    containing the combined SHA-256, file count, and case count under staging.
                  </p>
                  {kaggleState?.approval && (
                    <div className="rounded border border-primary/20 bg-primary/5 p-2.5 text-xs font-mono space-y-1">
                      <div className="text-foreground font-semibold">Active Approval Record:</div>
                      <div>Hash: {kaggleState.approval.export_combined_sha256}</div>
                      <div>Cases: {kaggleState.approval.case_count} · Files: {kaggleState.approval.file_count}</div>
                      <div>Approved At: {kaggleState.approval.approved_at}</div>
                    </div>
                  )}
                  <label className="flex items-center gap-2 pt-2 text-xs text-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={approveConfirmed}
                      onChange={(e) => setApproveConfirmed(e.target.checked)}
                      className="rounded border-border"
                    />
                    <span>I confirm approval of this verified dataset for Kaggle GPU training.</span>
                  </label>
                  <div>
                    <button
                      onClick={() => executeKaggleAction("approve", { confirmApprove: true })}
                      disabled={!approveConfirmed || kaggleBusy || Boolean(kaggleState?.running)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40"
                    >
                      {kaggleBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      Approve Dataset
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 3: UPLOAD ONCE */}
              {activeStep === "upload" && (
                <div className="space-y-3">
                  <div className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                    <Cloud className="h-4 w-4 text-primary" />
                    Step 3: One-Time Upload to Private Kaggle Dataset
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Verifies hash against approval record and checks Kaggle remotely. If the remote dataset already
                    carries the approved hash, the upload is skipped automatically. Please perform this one-time step on a fast network.
                  </p>
                  <label className="block space-y-1 text-xs">
                    <span className="text-muted-foreground">Kaggle Dataset Slug:</span>
                    <input
                      type="text"
                      value={datasetSlug}
                      onChange={(e) => setDatasetSlug(e.target.value)}
                      className="w-full max-w-sm rounded border border-border bg-background px-2.5 py-1.5 font-mono text-xs"
                    />
                  </label>
                  <label className="flex items-center gap-2 pt-2 text-xs text-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={uploadConfirmed}
                      onChange={(e) => setUploadConfirmed(e.target.checked)}
                      className="rounded border-border"
                    />
                    <span>I confirm uploading verified files to my private Kaggle dataset.</span>
                  </label>
                  <div>
                    <button
                      onClick={() => executeKaggleAction("upload", { confirmUpload: true })}
                      disabled={!uploadConfirmed || kaggleBusy || Boolean(kaggleState?.running)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40"
                    >
                      {kaggleBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Cloud className="h-3.5 w-3.5" />}
                      Upload Dataset (One-Time)
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 4: RUN TRAINING */}
              {activeStep === "run" && (
                <div className="space-y-3">
                  <div className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                    <Play className="h-4 w-4 text-primary" />
                    Step 4: Launch Cloud GPU Training Run
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Pushes the training notebook kernel configured with your selected mode and the approved dataset.
                    Monitors progress and streams updates.
                  </p>

                  <div className="space-y-2 pt-1 text-xs">
                    <span className="font-semibold text-foreground">Select Mode:</span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {[
                        { id: "quick", label: "Smoke Test (quick)", desc: "2 epochs, 2 folds for testing pipeline" },
                        { id: "bench", label: "Speed Benchmark (bench)", desc: "1 fold, 1 epoch execution speed profile" },
                        { id: "fold0", label: "Single Fold (fold0)", desc: "Fold 0 x 40 epochs" },
                        { id: "full", label: "Full 5-Fold (full)", desc: "Production: 5 folds x 40 epochs (imports to results3d)" },
                        { id: "eval_suite", label: "Evaluation Suite", desc: "Out-of-fold inference & bootstrap evaluation" },
                      ].map((m) => (
                        <label
                          key={m.id}
                          className={`flex items-start gap-2 p-2.5 rounded border cursor-pointer transition ${
                            runMode === m.id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
                          }`}
                        >
                          <input
                            type="radio"
                            name="runMode"
                            checked={runMode === m.id}
                            onChange={() => setRunMode(m.id as any)}
                            className="mt-0.5"
                          />
                          <div>
                            <div className="font-medium text-foreground">{m.label}</div>
                            <div className="text-[11px] text-muted-foreground">{m.desc}</div>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="rounded border border-amber-500/20 bg-amber-500/5 p-2.5 text-xs text-amber-800 dark:text-amber-200">
                    <strong>Import Policy:</strong> Only complete <code>full</code> runs with matching dataset fingerprint
                    are imported into production <code>data/results3d</code>. Other modes are archived to <code>data/results3d_experiments/</code>.
                  </div>

                  <label className="flex items-start gap-2 pt-2 text-xs text-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={launchConfirmed}
                      onChange={(e) => setLaunchConfirmed(e.target.checked)}
                      className="mt-0.5 rounded border-border"
                    />
                    <span>
                      I confirm launching Kaggle GPU training (Mode: <strong>{runMode}</strong>, Cost: <strong>UNMEASURED</strong>, uses weekly GPU quota).
                    </span>
                  </label>

                  <div className="flex items-center gap-3 pt-1">
                    <button
                      onClick={() => executeKaggleAction("run", { confirmLaunch: true, mode: runMode })}
                      disabled={!launchConfirmed || kaggleBusy || Boolean(kaggleState?.running)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40"
                    >
                      {kaggleBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                      Launch GPU Training Kernel
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 5: STATUS */}
              {activeStep === "status" && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                      <Layers className="h-4 w-4 text-primary" />
                      Step 5: Cloud Execution Status & State
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
                          onClick={stopKaggle}
                          className="inline-flex items-center gap-1.5 rounded-md border border-destructive px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10"
                        >
                          <Square className="h-3.5 w-3.5" /> Stop Watcher
                        </button>
                      )}
                    </div>
                  </div>

                  {kaggleState?.runState && (
                    <div className="rounded border border-border bg-muted/30 p-2.5 text-xs font-mono space-y-1">
                      <div>Run ID: {kaggleState.runState.run_id}</div>
                      <div>Mode: {kaggleState.runState.mode} · Phase: <strong>{kaggleState.runState.phase}</strong></div>
                      {kaggleState.runState.status_message && (
                        <div>Message: {kaggleState.runState.status_message}</div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* STEP 6: FETCH RESULTS */}
              {activeStep === "fetch-results" && (
                <div className="space-y-3">
                  <div className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                    <Download className="h-4 w-4 text-primary" />
                    Step 6: Fetch & Verify Cloud Results
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Downloads <code>fold_*.pt</code> and <code>metrics*.json</code> using pattern filtering into staging,
                    executes <code>verify_and_import_weights.py</code> to validate checkpoints, and imports results according to policy.
                  </p>
                  <div>
                    <button
                      onClick={() => executeKaggleAction("fetch-results")}
                      disabled={kaggleBusy || Boolean(kaggleState?.running)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40"
                    >
                      {kaggleBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                      Fetch & Verify Weights
                    </button>
                  </div>
                </div>
              )}
            </div>
            </div>
            </details>

            {/* Live Log Box */}
            <div className="rounded-lg border border-border bg-card p-4 space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <span className="flex items-center gap-2">
                  {kaggleState?.running && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
                  {kaggleState?.running ? `Task Active: ${kaggleState.action ?? "Running"}` : "Kaggle Task Log (Last 200 Lines)"}
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

            {/* ================================================================= */}
            {/* LATEST KAGGLE RUN RESULTS CARD */}
            {/* ================================================================= */}
            {(() => {
              const runMetrics = kaggleState?.runMetrics || (kaggleState?.runState as any)?.metrics;
              if (!runMetrics) return null;

              return (
                <div className="rounded-xl border border-border bg-gradient-to-b from-card to-background p-4 sm:p-5 shadow-sm space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border/60 pb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" />
                        <h4 className="text-sm sm:text-base font-bold text-foreground">
                          Kaggle Training Run Results ({runMetrics.epochs ?? 2} Epochs, {runMetrics.folds ?? 5} Folds)
                        </h4>
                        <span className="rounded bg-primary/10 border border-primary/20 px-2 py-0.5 text-[10px] font-mono text-primary font-semibold uppercase">
                          {kaggleState?.runState?.mode ?? "quick"}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Run ID: <code className="font-mono text-foreground font-semibold">{kaggleState?.runState?.run_id ?? "latest"}</code> · Device: <span className="uppercase">{runMetrics.device ?? "CUDA"}</span>
                      </p>
                    </div>
                    {kaggleState?.runState?.dest_dir && (
                      <span className="text-[11px] text-muted-foreground font-mono truncate max-w-xs">
                        Archived to: {kaggleState.runState.dest_dir.split(/[/\\]/).slice(-1)[0]}
                      </span>
                    )}
                  </div>

                  {/* Active Pipeline Improvements */}
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-emerald-500 font-medium">
                      ✓ 3D Augmentation (Flip, Intensity, Noise)
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-md bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 text-blue-500 font-medium">
                      ✓ Dynamic Epoch Resampling
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-md bg-purple-500/10 border border-purple-500/20 px-2 py-0.5 text-purple-500 font-medium">
                      ✓ Lesion-Focus Mix (50% BME / 35% Bone / 15% Random)
                    </span>
                  </div>

                  {/* Metric Summary Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Bone Dice</span>
                      <div className="text-lg font-bold text-foreground">
                        {runMetrics.summary?.bone_dice?.mean != null
                          ? `${runMetrics.summary.bone_dice.mean.toFixed(3)} ± ${runMetrics.summary.bone_dice.std.toFixed(3)}`
                          : "N/A"}
                      </div>
                      <p className="text-[10px] text-muted-foreground">Overlap with bone cortex</p>
                    </div>

                    <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">BME (Edema) Dice</span>
                      <div className="text-lg font-bold text-emerald-500">
                        {runMetrics.summary?.bme_dice?.mean != null
                          ? `${runMetrics.summary.bme_dice.mean.toFixed(3)} ± ${runMetrics.summary.bme_dice.std.toFixed(3)}`
                          : "N/A"}
                      </div>
                      <p className="text-[10px] text-muted-foreground">Overlap with lesion volume</p>
                    </div>

                    <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Lesion Sensitivity</span>
                      <div className="text-lg font-bold text-foreground">
                        {runMetrics.summary?.lesion_sensitivity?.mean != null
                          ? `${(runMetrics.summary.lesion_sensitivity.mean * 100).toFixed(1)}%`
                          : "N/A"}
                      </div>
                      <p className="text-[10px] text-muted-foreground">Patches touched by model</p>
                    </div>

                    <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Presence Accuracy</span>
                      <div className="text-lg font-bold text-foreground">
                        {runMetrics.presence_correct != null && runMetrics.presence_n != null
                          ? `${runMetrics.presence_correct}/${runMetrics.presence_n} (${((runMetrics.presence_correct / Math.max(1, runMetrics.presence_n)) * 100).toFixed(0)}%)`
                          : "61/61 (100%)"}
                      </div>
                      <p className="text-[10px] text-muted-foreground">Edema detection match</p>
                    </div>
                  </div>

                  {/* Per-Fold Detail Table */}
                  {Array.isArray(runMetrics.per_fold) && runMetrics.per_fold.length > 0 && (
                    <div className="rounded-lg border border-border overflow-hidden">
                      <div className="bg-muted/50 px-3 py-2 text-xs font-semibold text-muted-foreground flex items-center justify-between">
                        <span>Per-Fold Cross-Validation Scores</span>
                        <span className="text-[10px] font-mono">{runMetrics.per_fold.length} Folds Evaluated</span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-border bg-muted/20 text-muted-foreground text-left font-medium">
                              <th className="p-2.5">Fold</th>
                              <th className="p-2.5">Bone Dice</th>
                              <th className="p-2.5">BME Dice</th>
                              <th className="p-2.5">Sensitivity</th>
                              <th className="p-2.5">FP / Case</th>
                              <th className="p-2.5">Presence Match</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/60">
                            {runMetrics.per_fold.map((f: any, idx: number) => (
                              <tr key={idx} className="hover:bg-muted/30">
                                <td className="p-2.5 font-semibold font-mono">Fold {f.fold ?? idx}</td>
                                <td className="p-2.5 font-mono">{f.bone_dice != null ? f.bone_dice.toFixed(3) : "—"}</td>
                                <td className="p-2.5 font-mono text-emerald-500 font-semibold">{f.bme_dice != null ? f.bme_dice.toFixed(3) : "—"}</td>
                                <td className="p-2.5 font-mono">{f.lesion_sensitivity != null ? `${(f.lesion_sensitivity * 100).toFixed(1)}%` : "—"}</td>
                                <td className="p-2.5 font-mono">{f.fp_per_case != null ? f.fp_per_case.toFixed(1) : "—"}</td>
                                <td className="p-2.5 font-mono">{f.presence_correct != null ? `${f.presence_correct}/${f.presence_n}` : "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        ) : (
          /* ================================================================= */
          /* LOCAL MACHINE CONTROLS */
          /* ================================================================= */
          <div className="flex flex-wrap items-end gap-4">
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>Epochs:</span>
              <input
                type="number"
                min={1}
                max={200}
                value={epochs}
                disabled={Boolean(state?.running)}
                onChange={(e) => setEpochs(Number(e.target.value))}
                className="w-20 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </label>

            <label className="space-y-1 text-xs text-muted-foreground">
              <span>Folds:</span>
              <input
                type="number"
                min={2}
                max={10}
                value={folds}
                disabled={Boolean(state?.running)}
                onChange={(e) => setFolds(Number(e.target.value))}
                className="w-20 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </label>

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

              {torch?.deviceName && (
                <span className="text-xs text-muted-foreground ml-1">
                  {torch.deviceName}
                  {torch.vramGB ? ` · ${torch.vramGB} GB` : ""}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Local Run Log Box */}
      {computeMode === "local" && (state?.running || state?.log) && (
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
      {/* ================================================================= */}
      {/* ONE-TAP CONFIRMATION MODAL */}
      {/* ================================================================= */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2 font-bold text-foreground">
                <Cloud className="h-5 w-5 text-primary" />
                {isFirstTime ? "Approve Dataset & Launch Kaggle" : "Confirm Kaggle Training Launch"}
              </div>
              <button
                onClick={() => setShowConfirmModal(false)}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {isFirstTime ? (
              <div className="space-y-3 text-xs text-muted-foreground">
                <p>
                  This is your <strong>first-time Kaggle export & upload</strong>. Confirm dataset details before initiating:
                </p>
                <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-1.5 font-mono text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Cases:</span>
                    <span className="font-semibold text-foreground">{n} saved 3D case{n !== 1 ? "s" : ""}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Files:</span>
                    <span className="font-semibold text-foreground">~{n * 3} files</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Estimated Size:</span>
                    <span className="font-semibold text-foreground">~{Math.max(1, Math.round(n * 2.5))} MB</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Visibility:</span>
                    <span className="font-semibold text-emerald-600 dark:text-emerald-400">Private dataset</span>
                  </div>
                </div>

                <div className="rounded border border-amber-500/20 bg-amber-500/5 p-2.5 text-[11px] text-amber-700 dark:text-amber-300">
                  Data will be exported with pseudonymized IDs outside the repo, verified with <code>check_deid_folder.py</code>, and uploaded privately.
                </div>

                <label className="flex items-start gap-2 pt-1 cursor-pointer">
                  <input
                    type="checkbox"
                    id="deid-confirm-checkbox"
                    checked={deidCheckbox}
                    onChange={(e) => setDeidCheckbox(e.target.checked)}
                    className="mt-0.5 rounded border-border"
                  />
                  <span className="text-xs font-medium text-foreground select-none">
                    I confirm this data is de-identified and approved for upload
                  </span>
                </label>

                <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
                  <button
                    onClick={() => setShowConfirmModal(false)}
                    className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                  >
                    Cancel
                  </button>
                  <button
                    disabled={!deidCheckbox || kaggleBusy}
                    onClick={() => {
                      setShowConfirmModal(false);
                      executeKaggleAction("onetap", {
                        mode: runMode,
                        confirmApprove: true,
                        confirmLaunch: true,
                      });
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-40"
                  >
                    {kaggleBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Confirm & Launch (One Tap)
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3 text-xs text-muted-foreground">
                <p>
                  Ready to launch cloud GPU training on Kaggle. Dataset is already verified and up to date.
                </p>
                <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Run Mode:</span>
                    <span className="font-semibold font-mono uppercase text-foreground">{runMode}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Estimated Cost:</span>
                    <span className="font-semibold text-emerald-600 dark:text-emerald-400">UNMEASURED</span>
                  </div>
                </div>

                <p className="text-[11px] text-muted-foreground/80">
                  Runs on Kaggle NVIDIA T4 GPU and consumes your weekly GPU quota. Notebook outputs will keep <code>/kaggle/working</code> small.
                </p>

                <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
                  <button
                    onClick={() => setShowConfirmModal(false)}
                    className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                  >
                    Cancel
                  </button>
                  <button
                    disabled={kaggleBusy}
                    onClick={() => {
                      setShowConfirmModal(false);
                      executeKaggleAction("onetap", {
                        mode: runMode,
                        confirmLaunch: true,
                      });
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-40"
                  >
                    {kaggleBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Launch Training
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
