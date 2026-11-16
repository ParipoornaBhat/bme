"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { isReviewMode } from "~/lib/app-mode";
import type {
  AccountCard,
  RunItem,
  TargetDatasetStatus,
  MethodSpec,
  BackgroundTask,
  KaggleDatasetOption,
} from "~/lib/training-advanced/types";
import {
  Database,
  ExternalLink,
  Loader2,
  Radio,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { ComputeAccountsGrid } from "./components/ComputeAccountsGrid";
import { StartTrainingForm } from "./components/StartTrainingForm";
import { RunHistoryTable } from "./components/RunHistoryTable";
import { useTrainingData } from "./TrainingDataProvider";

const METHODS: MethodSpec[] = [
  {
    n: 1,
    id: "nnunet-3d",
    where: "h200",
    label: "nnU-Net ResEnc M, 3D",
    tests: "the baseline every custom model has to beat (3D)",
    needsMib: 9000,
  },
  {
    n: 2,
    id: "nnunet-2d",
    where: "h200",
    label: "nnU-Net ResEnc M, 2D",
    tests: "the same baseline, slice by slice (2D)",
    needsMib: 9000,
  },
  {
    n: 3,
    id: "unet-aug-med",
    where: "h200",
    label: "3D U-Net, augmentation med",
    tests: "augmentation strength (compare with 4 and no-augmentation control)",
    localSupported: true,
  },
  {
    n: 4,
    id: "unet-aug-max",
    where: "h200",
    label: "3D U-Net, augmentation max",
    tests: "augmentation strength (compare with 3)",
    localSupported: true,
  },
  {
    n: 5,
    id: "unet-holdout",
    where: "h200",
    label: "3D U-Net, one round on fixed 80/20 split",
    tests: "no folds: one model, scored on a validation set that never changes",
    localSupported: true,
  },
  {
    n: 6,
    id: "k-unet3d",
    where: "kaggle",
    label: "3D U-Net (Kaggle settings), augmentation med",
    tests: "the Kaggle reference for 7-9",
    arch: "unet3d",
    localSupported: true,
  },
  {
    n: 7,
    id: "k-mednext",
    where: "kaggle",
    label: "MedNeXt, augmentation med",
    tests: "architecture (compare with 6)",
    arch: "mednext",
    localSupported: true,
  },
  {
    n: 8,
    id: "k-orthogate",
    where: "kaggle",
    label: "OrthoGate-MedNeXt, augmentation med",
    tests: "architecture (compare with 6)",
    arch: "orthogate_mednext",
    localSupported: true,
  },
  {
    n: 9,
    id: "k-cnet-dual",
    where: "kaggle",
    label: "C-Net dual U-Net, augmentation med",
    tests: "architecture (compare with 6)",
    arch: "cnet_dual_unet",
    localSupported: true,
  },
  {
    n: 10,
    id: "unet-noaug",
    where: "h200",
    label: "3D U-Net, no augmentation (control)",
    tests: "the control for 3-4: same model, no augmentation",
    localSupported: false,
  },
  {
    n: 11,
    id: "unet-aug-low",
    where: "h200",
    label: "3D U-Net, augmentation low",
    tests: "augmentation strength (compare with 3 and 4)",
    localSupported: true,
  },
  {
    n: 12,
    id: "selftest-aug",
    where: "h200",
    label: "Self-test, 2 minutes, with augmentation",
    tests: "the dashboard itself: start, stop with a checkpoint, continue. Not a result.",
    localSupported: false,
  },
  {
    n: 13,
    id: "selftest-plain",
    where: "h200",
    label: "Self-test, 2 minutes, no augmentation",
    tests: "the dashboard itself: start, stop with a checkpoint, continue. Not a result.",
    localSupported: false,
  },
];

const fmtDuration = (sec: number | null | undefined): string => {
  if (sec == null) return "-";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

const fmtDate = (isoStr: string | null | undefined): string => {
  if (!isoStr) return "-";
  try {
    const d = new Date(isoStr);
    return d.toLocaleString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoStr;
  }
};

export default function AdvancedTrainingPage() {
  const inReview = isReviewMode();

  const { cards, runs, datasetTargets, kaggleDatasets, tasks, refreshing, refresh } = useTrainingData();

  // Selection states for Start form
  const [selectedMethodId, setSelectedMethodId] = useState<string>(METHODS[0].id);
  const [selectedTargetId, setSelectedTargetId] = useState<string>("");
  const [selectedDatasetOwner, setSelectedDatasetOwner] = useState<string>("");
  const [augLevel, setAugLevel] = useState<"low" | "med" | "max">("med");
  const [splitMode, setSplitMode] = useState<"5folds" | "holdout">("5folds");
  const [epochs, setEpochs] = useState<number>(50);

  // Loading states
  const [startBusy, setStartBusy] = useState(false);

  const h200Route = datasetTargets.find((t) => t.platform === "h200") || null;
  const loadData = useCallback((_silent?: boolean) => refresh(), [refresh]);

  useEffect(() => {
    if (!selectedTargetId && cards.length > 0) setSelectedTargetId(cards[0].id);
  }, [cards, selectedTargetId]);

  useEffect(() => {
    if (!selectedDatasetOwner && kaggleDatasets.length > 0) {
      const def = kaggleDatasets.find((d) => d.isDefault) || kaggleDatasets[0];
      setSelectedDatasetOwner(def.roll);
    }
  }, [kaggleDatasets, selectedDatasetOwner]);

  // Launch a new training run
  const handleStartSubmit = async () => {
    setStartBusy(true);
    try {
      const targetCard = cards.find((c) => c.id === selectedTargetId);
      if (!targetCard) throw new Error("Please select an execution target");

      const res = await fetch("/api/training-advanced/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: targetCard.platform,
          targetId: selectedTargetId,
          methodId: selectedMethodId,
          extra: {
            augLevel,
            splitMode,
            epochs,
            datasetOwnerRoll: selectedDatasetOwner,
          },
        }),
      });

      const json = await res.json();
      if (res.ok) {
        toast.success(json.message || "Training job started");
        loadData(true);
      } else {
        toast.error(json.error || "Failed to start training run");
      }
    } catch (err: any) {
      toast.error(err.message || "Start request failed");
    } finally {
      setStartBusy(false);
    }
  };

  // Resume a stopped job
  const handleResume = async (card: AccountCard) => {
    try {
      const res = await fetch("/api/training-advanced/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: card.platform,
          targetId: card.id,
          methodId: card.currentJob?.methodId || "unet-aug-med",
          extra: { resume: true },
        }),
      });
      const json = await res.json();
      if (res.ok) {
        toast.success(json.message || `Resumed run on ${card.label}`);
        loadData(true);
      } else {
        toast.error(json.error || "Failed to resume run");
      }
    } catch (err: any) {
      toast.error(err.message || "Resume request failed");
    }
  };

  // Resume from run table item
  const handleResumeRunItem = (run: RunItem) => {
    const card = cards.find((c) => c.accountName === run.account || c.id.includes(run.account));
    if (card) {
      void handleResume(card);
    } else {
      toast.error(`Target node for ${run.account} not currently loaded`);
    }
  };

  // Cancel an active job
  const handleCancel = async (card: AccountCard) => {
    try {
      const res = await fetch("/api/training-advanced/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: card.platform,
          targetId: card.id,
          slurmJobId: card.currentJob?.slurmJobId,
          pid: card.currentJob?.pid,
          kernelSlug: card.currentJob?.kernelSlug,
        }),
      });
      const json = await res.json();
      if (res.ok) {
        toast.success(json.message || `Cancelled run on ${card.label}`);
        loadData(true);
      } else {
        toast.error(json.error || "Failed to cancel run");
      }
    } catch (err: any) {
      toast.error(err.message || "Cancel request failed");
    }
  };

  const isAnySyncRunning = useMemo(() => {
    return tasks.some((t) => t.type === "sync" && t.status === "running");
  }, [tasks]);

  if (inReview) {
    return (
      <div className="space-y-6 pb-12">
        <div className="rounded-2xl border border-border bg-card p-8 text-center space-y-4">
          <Radio className="h-10 w-10 text-muted-foreground mx-auto" />
          <h2 className="text-xl font-bold tracking-tight">Advanced Training (Local Mode Only)</h2>
          <p className="max-w-md mx-auto text-xs text-muted-foreground leading-relaxed">
            Multi-target distributed compute across H200 GPU nodes and Kaggle is available when running locally with direct hardware and SSH access.
          </p>
        </div>
      </div>
    );
  }


  return (
    <div className="space-y-8 pb-12">
      {/* Top Navigation Tab Bar & Route Status */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-2xl border border-border bg-card/60 p-2.5 backdrop-blur-xs shadow-xs">
        <div className="flex items-center gap-1.5">
          <Link
            href="/training/advanced"
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-xs font-bold text-primary-foreground shadow-xs transition-all"
          >
            <Radio className="h-3.5 w-3.5" />
            Compute &amp; Training
          </Link>
          <Link
            href="/training/advanced/data"
            className="inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-accent hover:text-foreground transition-all"
          >
            <Database className="h-3.5 w-3.5" />
            Dataset &amp; Sync Hub
            {isAnySyncRunning && (
              <span className="flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
            )}
          </Link>
        </div>

        <div className="flex items-center gap-2 px-2">
          {h200Route && (
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold ${
                h200Route.isRemoteRoute
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              }`}
              title={h200Route.routeLabel || ""}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${h200Route.isRemoteRoute ? "bg-amber-500" : "bg-emerald-500"}`} />
              {h200Route.isRemoteRoute ? "H200: remote route (uses internet data)" : "H200: college network, direct"}
            </span>
          )}
        </div>
      </div>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Advanced Training Hub</h1>
            <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
              Distributed Compute
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage multi-account GPU cluster training on College H200, Kaggle slots, and Local hardware.
          </p>
        </div>

        <button
          type="button"
          onClick={() => loadData(false)}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-semibold text-muted-foreground transition-all hover:bg-accent hover:text-foreground cursor-pointer disabled:opacity-50 shadow-xs"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh Status
        </button>
      </div>

      {/* 1. Compute Accounts Grid */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold tracking-tight">Active Compute Nodes &amp; Quotas</h2>
          <span className="text-xs text-muted-foreground">
            {cards.filter((c) => c.connected).length} of {cards.length} connected
          </span>
        </div>
        <ComputeAccountsGrid
          cards={cards}
          refreshing={refreshing}
          onRetryConnection={() => loadData(false)}
          onResume={handleResume}
          onCancel={handleCancel}
          fmtDuration={fmtDuration}
        />
      </div>

      {/* 2. Start a Run Section & Dataset Sync Shortcut */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <StartTrainingForm
            methods={METHODS}
            cards={cards}
            datasetTargets={datasetTargets}
            kaggleDatasets={kaggleDatasets}
            tasks={tasks}
            selectedMethodId={selectedMethodId}
            selectedTargetId={selectedTargetId}
            selectedDatasetOwner={selectedDatasetOwner}
            augLevel={augLevel}
            splitMode={splitMode}
            epochs={epochs}
            startBusy={startBusy}
            onMethodChange={setSelectedMethodId}
            onTargetChange={setSelectedTargetId}
            onDatasetOwnerChange={setSelectedDatasetOwner}
            onAugLevelChange={setAugLevel}
            onSplitModeChange={setSplitMode}
            onEpochsChange={setEpochs}
            onSubmit={handleStartSubmit}
          />
        </div>

        {/* Dataset Hub Shortcut Card */}
        <div className="space-y-4 rounded-2xl border border-border bg-card p-6 shadow-sm flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Database className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-bold tracking-tight">Dataset &amp; Sync Hub</h2>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Ensure compute nodes have the latest de-identified scans before training. Supports incremental delta sync and fresh re-uploads.
            </p>

            <div className="rounded-xl border border-border/60 bg-muted/20 p-3.5 space-y-2 text-xs">
              <div className="flex items-center justify-between text-muted-foreground font-semibold">
                <span>Cluster Readiness:</span>
                <span className="text-foreground">
                  {datasetTargets.filter((t) => t.isUpToDate).length} / {datasetTargets.length} Up to Date
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                In remote route, incremental sync sends only new scans over jump host. Fresh upload clears remote data and uploads fresh copy.
              </p>
            </div>
          </div>

          <Link
            href="/training/advanced/data"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-muted/50 border border-border px-4 py-2.5 text-xs font-semibold text-foreground hover:bg-muted transition-all"
          >
            <span>Open Dataset &amp; Sync Hub</span>
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
          </Link>
        </div>
      </div>

      {/* 3. Runs History Table */}
      <RunHistoryTable runs={runs} onResumeRun={handleResumeRunItem} fmtDate={fmtDate} />
    </div>
  );
}
