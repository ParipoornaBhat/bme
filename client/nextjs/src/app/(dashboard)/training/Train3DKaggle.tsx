"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Download,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  X,
} from "lucide-react";
import { BUILD_STAMP } from "../../api/training-3d/kaggle/buildStamp";
import { KaggleRunSummary } from "./KaggleRunSummary";

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
  buildStamp?: string;
}

type KaggleStepId = "doctor" | "preflight" | "approve" | "upload" | "run" | "status" | "fetch-results" | "onetap";

export default function Train3DKaggle({
  n,
  modelArch = "orthogate_mednext",
  onRunning,
}: {
  n: number;
  modelArch?: string;
  onRunning?: (running: boolean) => void;
}) {
  const [kaggleState, setKaggleState] = useState<KaggleState | null>(null);
  const [kaggleBusy, setKaggleBusy] = useState(false);

  useEffect(() => {
    onRunning?.(Boolean(kaggleState?.running));
  }, [kaggleState?.running, onRunning]);

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
    loadKaggle();
  }, [loadKaggle]);

  useEffect(() => {
    if (!kaggleState?.running) return;
    const id = setInterval(loadKaggle, 3000);
    return () => clearInterval(id);
  }, [kaggleState?.running, loadKaggle]);

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
          modelArch,
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

  const stopKaggle = async (reset = false) => {
    await fetch("/api/training-3d/kaggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel-watch", reset }),
    });
    setTimeout(loadKaggle, 400);
  };

  const isStaleServer = Boolean(
    kaggleState?.buildStamp && kaggleState.buildStamp !== BUILD_STAMP
  );

  return (
    <>
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
                CANCELLED: 100,
                IDLE: 0,
              };
              const progressPercent = progressMap[phase] ?? (kaggleState?.running ? 75 : 0);

              return (
                <div className="rounded-xl border-2 border-primary/30 bg-gradient-to-b from-card to-primary/5 p-4 sm:p-5 shadow-sm space-y-4">
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

                      <div className="flex items-center justify-end gap-2 pt-1 flex-wrap">
                        {(kaggleState?.running || phase === "RUNNING" || phase === "QUEUED") && (
                          <button
                            onClick={() => stopKaggle(false)}
                            className="inline-flex items-center gap-1.5 rounded bg-destructive/10 border border-destructive/30 px-2.5 py-1 text-xs font-semibold text-destructive hover:bg-destructive/20 transition"
                          >
                            <Square className="h-3 w-3" /> Stop / Cancel Run
                          </button>
                        )}
                        {(phase === "FAILED" || phase === "CANCELLED") ? (
                          <button
                            onClick={() => executeKaggleAction("onetap", { confirmLaunch: true, mode: runMode })}
                            disabled={kaggleBusy}
                            className="inline-flex items-center gap-1.5 rounded bg-primary/10 border border-primary/30 px-3 py-1 text-xs font-semibold text-primary hover:bg-primary/20 transition"
                          >
                            <RefreshCw className="h-3 w-3" /> Retry (Fresh Launch)
                          </button>
                        ) : (kaggleState?.runState && phase !== "COMPLETED") ? (
                          <button
                            onClick={() => executeKaggleAction("onetap", { resume: true, mode: runMode })}
                            disabled={kaggleBusy}
                            className="inline-flex items-center gap-1.5 rounded bg-primary/10 border border-primary/30 px-3 py-1 text-xs font-semibold text-primary hover:bg-primary/20 transition"
                          >
                            <RefreshCw className="h-3 w-3" /> Resume from saved state
                          </button>
                        ) : null}
                        {(phase === "CANCELLED" || phase === "FAILED" || phase === "COMPLETED") && (
                          <button
                            onClick={() => stopKaggle(true)}
                            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline ml-1"
                          >
                            Dismiss / Reset
                          </button>
                        )}
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
                      {(kaggleState?.running || kaggleState?.runState?.phase === "RUNNING") && (
                        <button
                          onClick={() => stopKaggle(false)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-destructive px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10"
                        >
                          <Square className="h-3.5 w-3.5" /> Stop / Cancel Run
                        </button>
                      )}
                      {kaggleState?.runState && (
                        <button
                          onClick={() => stopKaggle(true)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                        >
                          Reset State
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
              return <KaggleRunSummary runMetrics={runMetrics} runState={kaggleState?.runState} />;
            })()}
          </div>
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
    </>
  );
}
