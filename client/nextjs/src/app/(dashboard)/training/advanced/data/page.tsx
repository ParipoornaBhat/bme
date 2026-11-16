"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { isReviewMode } from "~/lib/app-mode";
import type {
  AccountCard,
  TargetDatasetStatus,
  BackgroundTask,
  KaggleDatasetOption,
} from "~/lib/training-advanced/types";
import {
  Database,
  Loader2,
  Radio,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmationModal } from "../components/ConfirmationModal";
import { DatasetOverviewCard, fmtBytes, type LocalExportData } from "../components/DatasetOverviewCard";
import { H200DatasetTable } from "../components/H200DatasetTable";
import { KaggleDatasetCard } from "../components/KaggleDatasetCard";
import { SyncTasksHistory } from "../components/SyncTasksHistory";
import { useTrainingData } from "../TrainingDataProvider";

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

export default function DataSyncPage() {
  const inReview = isReviewMode();

  const {
    cards,
    datasetTargets,
    kaggleDatasets,
    localExport,
    tasks,
    setTasks,
    refreshing,
    refresh,
  } = useTrainingData();
  const [syncBusyTarget, setSyncBusyTarget] = useState<string | null>(null);
  const [checkingTarget, setCheckingTarget] = useState<string | null>(null);

  // Confirmation Modal
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean;
    title: string;
    description: string;
    warnings: string[];
    actionLabel: string;
    isFresh?: boolean;
    onConfirm: () => void;
  }>({
    open: false,
    title: "",
    description: "",
    warnings: [],
    actionLabel: "",
    isFresh: false,
    onConfirm: () => {},
  });

  const loadData = useCallback((_silent?: boolean) => refresh(), [refresh]);

  const syncTasks = useMemo(() => {
    return tasks.filter((t) => t.type === "sync");
  }, [tasks]);

  const isAnySyncRunning = useMemo(() => {
    return syncTasks.some((t) => t.status === "running");
  }, [syncTasks]);

  const getLastSyncForTarget = (targetId: string) => {
    const list = syncTasks.filter((t) => t.target === targetId);
    if (list.length === 0) return null;
    return list.sort((a, b) =>
      (b.endedAt || b.startedAt || "").localeCompare(a.endedAt || a.startedAt || "")
    )[0];
  };

  const getLastSyncDate = (targetId: string) => {
    const lastSync = getLastSyncForTarget(targetId);
    return lastSync ? fmtDate(lastSync.endedAt || lastSync.startedAt) : "Never";
  };

  // Execute sync helper
  const executeSync = async (targetId: string, confirmed = false, isFresh = false) => {
    setSyncBusyTarget(targetId);
    try {
      const res = await fetch("/api/training-advanced/dataset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId, confirmed, isFresh }),
      });
      const json = await res.json();

      if (res.ok) {
        if (json.requiresConfirmation) {
          const target = datasetTargets.find((t) => t.targetId === targetId);
          const sizeStr = json.formattedSize || (target?.bytesToSync ? fmtBytes(target.bytesToSync) : "full dataset");

          setConfirmModal({
            open: true,
            isFresh,
            title:
              target?.platform === "h200"
                ? (isFresh ? "Confirm Fresh Re-upload to H200" : "Confirm Internet Data Sync to H200")
                : (isFresh ? "Confirm Fresh Re-upload to Kaggle" : "Confirm Kaggle Dataset Upload"),
            description: `Target: ${target?.label || targetId}`,
            warnings: [
              ...(isFresh
                ? [
                    target?.platform === "h200"
                      ? "This will delete remote annotations, scans, splits, and worklist on H200 and re-upload everything fresh."
                      : "This will force a full re-export, re-verify de-identification, and publish a new Kaggle version.",
                  ]
                : []),
              target?.platform === "h200"
                ? "H200 is connected through the Internet via jump host (pc-server-1)."
                : "Uploading dataset to Kaggle over your internet connection.",
              `Data transfer size: ~${sizeStr}. This will consume your mobile / internet data!`,
              target?.platform === "h200"
                ? "On direct college Wi-Fi / LAN, no internet data is used."
                : "On metered connections, wait for high-speed Wi-Fi.",
            ],
            actionLabel: isFresh ? "Confirm & Fresh Re-upload" : "Confirm & Proceed",
            onConfirm: async () => {
              setConfirmModal((prev) => ({ ...prev, open: false }));
              await executeSync(targetId, true, isFresh);
            },
          });
          return;
        }
        toast.success(json.message || "Dataset sync started in background");
        loadData(true);
      } else if (res.status === 409) {
        toast.error(json.message || "Sync blocked by running training job");
      } else {
        toast.error(json.error || "Sync failed");
      }
    } catch (err: any) {
      toast.error(err.message || "Sync request failed");
    } finally {
      setSyncBusyTarget(null);
    }
  };

  // Sync handler for H200 account row (Incremental)
  const handleH200Sync = (target: TargetDatasetStatus) => {
    if (target.runningJobBlocking) {
      toast.error(
        `Sync Refused: ${target.runningJobBlocking.method} is currently running on ${target.label}. Updating data while a run is in progress would corrupt it.`
      );
      return;
    }

    if (!target.isRemoteRoute) {
      toast.info("Syncing directly over local college network (no internet data used)...");
      executeSync(target.targetId, true, false);
      return;
    }

    const sizeStr = target.bytesToSync ? fmtBytes(target.bytesToSync) : "estimated data";
    setConfirmModal({
      open: true,
      isFresh: false,
      title: "Confirm Internet Data Sync to H200",
      description: `Target: ${target.label}`,
      warnings: [
        "H200 is connected through the Internet via jump host (pc-server-1).",
        `Incremental sync size: ~${sizeStr}. This will consume mobile / internet data.`,
        "Only changed and new files will be pushed.",
      ],
      actionLabel: "Confirm & Sync Over Internet",
      onConfirm: async () => {
        setConfirmModal((prev) => ({ ...prev, open: false }));
        await executeSync(target.targetId, true, false);
      },
    });
  };

  // Fresh Re-upload handler for H200
  const handleH200FreshUpload = (target: TargetDatasetStatus) => {
    if (target.runningJobBlocking) {
      toast.error(
        `Fresh Upload Refused: ${target.runningJobBlocking.method} is currently running on ${target.label}. Updating data while a run is in progress would corrupt it.`
      );
      return;
    }

    const sizeStr = localExport?.bytes ? fmtBytes(localExport.bytes) : "full dataset";
    setConfirmModal({
      open: true,
      isFresh: true,
      title: `Confirm Fresh Re-upload to H200 (${target.label})`,
      description: `Target: ${target.label}`,
      warnings: [
        "This will DELETE previously uploaded annotations, scans, splits, and worklist on this H200 account.",
        `Full dataset size: ~${sizeStr}. All files will be transferred fresh from this PC.`,
        target.isRemoteRoute
          ? "H200 is connected through Internet (jump host: pc-server-1). This will consume mobile/metered data!"
          : "Direct college network route will be used.",
        "Existing model checkpoints and training logs are NOT deleted.",
      ],
      actionLabel: "Delete Old Data & Fresh Re-upload",
      onConfirm: async () => {
        setConfirmModal((prev) => ({ ...prev, open: false }));
        await executeSync(target.targetId, true, true);
      },
    });
  };

  // Check H200 sync plan without copying files
  const handleH200Check = async (targetId: string) => {
    setCheckingTarget(targetId);
    try {
      const res = await fetch("/api/training-advanced/dataset/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId }),
      });
      const j = await res.json();
      if (res.ok && j.success) {
        toast.success(`Check complete: ${j.files} file(s) to send (~${fmtBytes(j.bytes)}), ${j.same} already on server.`);
        loadData(true);
      } else {
        toast.error(j.error || "Failed to check H200 sync plan");
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to check sync plan");
    } finally {
      setCheckingTarget(null);
    }
  };

  // Batch Sync All Free H200
  const handleSyncAllFreeH200 = () => {
    const freeTargets = datasetTargets.filter(
      (t) => t.platform === "h200" && !t.runningJobBlocking
    );

    if (freeTargets.length === 0) {
      toast.info("No idle H200 accounts available to sync (all active accounts are currently training).");
      return;
    }

    const isAnyRemote = freeTargets.some((t) => t.isRemoteRoute);

    const runBatchSync = async (confirmed = false) => {
      setSyncBusyTarget("batch-h200");
      try {
        let started = 0;
        if (!isAnyRemote) {
          // Direct college network: run accounts in parallel
          const results = await Promise.allSettled(
            freeTargets.map((t) =>
              fetch("/api/training-advanced/dataset", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetId: t.targetId, confirmed, isFresh: false }),
              }).then((r) => r.ok)
            )
          );
          started = results.filter((r) => r.status === "fulfilled" && r.value).length;
        } else {
          // Remote route: run sequentially to avoid saturating jump host
          for (const t of freeTargets) {
            try {
              const res = await fetch("/api/training-advanced/dataset", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetId: t.targetId, confirmed, isFresh: false }),
              });
              if (res.ok) started++;
            } catch {}
          }
        }
        toast.success(`Started background sync for ${started} idle H200 account(s).`);
        loadData(true);
      } catch (err: any) {
        toast.error(`Batch sync error: ${err.message}`);
      } finally {
        setSyncBusyTarget(null);
      }
    };

    if (!isAnyRemote) {
      toast.info(`Syncing ${freeTargets.length} free H200 account(s) in parallel via college network...`);
      runBatchSync(true);
      return;
    }

    const totalBytes = freeTargets.reduce((sum, t) => sum + (t.bytesToSync || 0), 0);
    const sizeStr = totalBytes ? fmtBytes(totalBytes) : "estimated data";

    setConfirmModal({
      open: true,
      isFresh: false,
      title: `Sync All ${freeTargets.length} Free H200 Accounts`,
      description: `Target accounts: ${freeTargets.map((t) => t.label).join(", ")}`,
      warnings: [
        "H200 connection is via Internet (jump host: pc-server-1).",
        `Estimated data transfer: ~${sizeStr} across ${freeTargets.length} account(s).`,
        "This will consume mobile / internet data.",
      ],
      actionLabel: "Confirm & Sync All Free Accounts",
      onConfirm: async () => {
        setConfirmModal((prev) => ({ ...prev, open: false }));
        await runBatchSync(true);
      },
    });
  };

  // Upload handler for Kaggle (Incremental)
  const handleKaggleUpload = (targetId?: string) => {
    const target =
      datasetTargets.find((t) => t.platform === "kaggle" && (!targetId || t.targetId === targetId)) ||
      datasetTargets.find((t) => t.platform === "kaggle");

    if (!target) {
      toast.error("No Kaggle dataset target found");
      return;
    }

    if (target.runningJobBlocking) {
      toast.error(
        `Upload Refused: ${target.runningJobBlocking.method} is currently running on ${target.label}. Updating data while a run is in progress would corrupt it.`
      );
      return;
    }

    const sizeStr = target.bytesToSync
      ? fmtBytes(target.bytesToSync)
      : localExport?.bytes
      ? fmtBytes(localExport.bytes)
      : "dataset";

    setConfirmModal({
      open: true,
      isFresh: false,
      title: target.hasUploaded ? "Confirm Kaggle Dataset Update" : "Confirm Kaggle Dataset Upload",
      description: `Target: ${target.label}`,
      warnings: [
        `Uploading will transfer ~${sizeStr} over your internet connection to Kaggle.`,
        "This will consume your mobile / internet upload data.",
        "On metered data, consider waiting for high-speed Wi-Fi.",
      ],
      actionLabel: target.hasUploaded ? "Confirm & Update Kaggle Dataset" : "Confirm & Upload to Kaggle",
      onConfirm: async () => {
        setConfirmModal((prev) => ({ ...prev, open: false }));
        await executeSync(target.targetId, true, false);
      },
    });
  };

  // Fresh Re-upload handler for Kaggle
  const handleKaggleFreshUpload = (targetId?: string) => {
    const target =
      datasetTargets.find((t) => t.platform === "kaggle" && (!targetId || t.targetId === targetId)) ||
      datasetTargets.find((t) => t.platform === "kaggle");

    if (!target) {
      toast.error("No Kaggle dataset target found");
      return;
    }

    if (target.runningJobBlocking) {
      toast.error(
        `Upload Refused: ${target.runningJobBlocking.method} is currently running on ${target.label}. Updating data while a run is in progress would corrupt it.`
      );
      return;
    }

    const sizeStr = localExport?.bytes ? fmtBytes(localExport.bytes) : "full dataset";

    setConfirmModal({
      open: true,
      isFresh: true,
      title: "Confirm Fresh Re-export & Re-upload to Kaggle",
      description: `Target: ${target.label}`,
      warnings: [
        "This will clear the previous export cache and force a complete re-export from annotations.",
        "It will re-run full de-identification audits, regenerate hashes, and publish a new version to Kaggle.",
        `Estimated upload transfer size: ~${sizeStr} over your internet connection.`,
        "On metered data, ensure you have sufficient bandwidth.",
      ],
      actionLabel: "Confirm Fresh Re-upload to Kaggle",
      onConfirm: async () => {
        setConfirmModal((prev) => ({ ...prev, open: false }));
        await executeSync(target.targetId, true, true);
      },
    });
  };

  // Stop sync helper
  const stopSync = async (targetId: string) => {
    try {
      const res = await fetch("/api/training-advanced/cancel-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.success) toast.success(j.message || "Sync stopped");
      else toast.error(j.message || "Could not stop the sync");
      loadData(true);
    } catch (err: any) {
      toast.error(`Stop failed: ${err.message}`);
    }
  };

  // Clear all task history
  const handleClearHistory = async () => {
    try {
      const res = await fetch("/api/training-advanced/tasks", { method: "DELETE" });
      if (res.ok) {
        setTasks([]);
        toast.success("Task execution history cleared.");
      } else {
        toast.error("Failed to clear task history.");
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to clear tasks");
    }
  };

  const h200Targets = useMemo(() => {
    return datasetTargets.filter((t) => t.platform === "h200");
  }, [datasetTargets]);

  const kaggleTarget = useMemo(() => {
    return datasetTargets.find((t) => t.platform === "kaggle") || null;
  }, [datasetTargets]);

  if (inReview) {
    return (
      <div className="space-y-6 pb-12">
        <div className="flex items-center gap-3">
          <Link
            href="/training/advanced"
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-xs font-bold text-primary-foreground hover:bg-primary/90 transition-all"
          >
            <Radio className="h-4 w-4" />
            Back to Training (Advanced)
          </Link>
        </div>
        <div className="rounded-2xl border border-border bg-card p-8 text-center space-y-4">
          <Database className="h-10 w-10 text-muted-foreground mx-auto" />
          <h2 className="text-xl font-bold tracking-tight">Data Sync (Local Mode Only)</h2>
          <p className="max-w-md mx-auto text-xs text-muted-foreground leading-relaxed">
            Data synchronization with College H200 clusters and Kaggle accounts is available only when running the app locally on your machine with direct access to local datasets and credentials.
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
            className="inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-accent hover:text-foreground transition-all"
          >
            <Radio className="h-3.5 w-3.5 text-primary" />
            Compute &amp; Training
          </Link>
          <Link
            href="/training/advanced/data"
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-xs font-bold text-primary-foreground shadow-xs transition-all"
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
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            Remote Route: <code className="font-mono text-[10px]">pc-server-1</code>
          </span>
        </div>
      </div>

      {/* 1. Header & Local Export Summary */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight text-foreground">Dataset &amp; Sync Hub</h1>
              <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
                Local Primary Copy
              </span>
              {isAnySyncRunning && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Sync in Progress
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage dataset transfers, incremental synchronization, and fresh re-uploads across College H200 GPU nodes and Kaggle.
            </p>
          </div>

          <div className="flex items-center gap-2.5">
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
        </div>

        <DatasetOverviewCard exportData={localExport} />
      </div>

      {/* 2. H200 Cluster Accounts Table */}
      <H200DatasetTable
        targets={h200Targets}
        cards={cards}
        localExportHash={localExport?.hash}
        syncTasks={syncTasks}
        syncBusyTarget={syncBusyTarget}
        checkingTarget={checkingTarget}
        onCheck={handleH200Check}
        onSync={handleH200Sync}
        onFreshUpload={handleH200FreshUpload}
        onSyncAllFree={handleSyncAllFreeH200}
        onStopSync={stopSync}
        getLastSyncDate={getLastSyncDate}
      />

      {/* 3. Kaggle Dataset Card */}
      <KaggleDatasetCard
        target={kaggleTarget}
        cards={cards}
        kaggleDatasets={kaggleDatasets}
        syncTasks={syncTasks}
        syncBusyTarget={syncBusyTarget}
        onUpload={handleKaggleUpload}
        onFreshUpload={handleKaggleFreshUpload}
        onStopSync={stopSync}
      />

      {/* 4. Sync & Upload History Panel */}
      <SyncTasksHistory
        tasks={syncTasks}
        refreshing={refreshing}
        onRefresh={() => loadData(false)}
        onClearHistory={handleClearHistory}
        onResumeSync={(targetId) => { void executeSync(targetId, true, false); }}
        fmtDate={fmtDate}
      />

      {/* Shared Confirmation & Safety Modal */}
      <ConfirmationModal
        open={confirmModal.open}
        title={confirmModal.title}
        description={confirmModal.description}
        warnings={confirmModal.warnings}
        actionLabel={confirmModal.actionLabel}
        isFresh={confirmModal.isFresh}
        onConfirm={confirmModal.onConfirm}
        onCancel={() => setConfirmModal((prev) => ({ ...prev, open: false }))}
      />
    </div>
  );
}
