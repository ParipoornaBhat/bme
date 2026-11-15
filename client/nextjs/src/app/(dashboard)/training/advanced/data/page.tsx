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
  Server,
  Cloud,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Terminal,
  Database,
  ChevronDown,
  ChevronUp,
  Loader2,
  HardDrive,
  ArrowLeft,
  Upload,
  Info,
} from "lucide-react";
import { toast } from "sonner";

const fmtBytes = (bytes: number | null | undefined): string => {
  if (bytes == null || bytes === 0) return "0 B";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
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

export default function DataSyncPage() {
  const inReview = isReviewMode();

  // Core data states
  const [cards, setCards] = useState<AccountCard[]>([]);
  const [datasetTargets, setDatasetTargets] = useState<TargetDatasetStatus[]>([]);
  const [kaggleDatasets, setKaggleDatasets] = useState<KaggleDatasetOption[]>([]);
  const [defaultDatasetOwner, setDefaultDatasetOwner] = useState<string>("");
  const [localExport, setLocalExport] = useState<{
    cases?: number;
    files?: number;
    bytes?: number;
    hash?: string;
    bmeCases?: number;
    nonBmeCases?: number;
    bmeCount?: number;
    nonBmeCount?: number;
  } | null>(null);
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);

  // Loading & refresh states
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncBusyTarget, setSyncBusyTarget] = useState<string | null>(null);

  // Expanded log view for background tasks
  const [expandedTaskLogs, setExpandedTaskLogs] = useState<Record<string, boolean>>({});

  // History filters
  const [historyTargetFilter, setHistoryTargetFilter] = useState<string>("all");
  const [historyStatusFilter, setHistoryStatusFilter] = useState<string>("all");

  // Confirmation Modal
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean;
    title: string;
    description: string;
    warnings: string[];
    actionLabel: string;
    onConfirm: () => void;
  }>({
    open: false,
    title: "",
    description: "",
    warnings: [],
    actionLabel: "",
    onConfirm: () => {},
  });

  const loadData = useCallback(async (isSilent = false) => {
    if (inReview) {
      setLoading(false);
      return;
    }
    if (!isSilent) setRefreshing(true);

    const getJson = (url: string) =>
      fetch(url, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null));

    // 1. Accounts for connectivity and status
    const accQuickP = getJson("/api/training-advanced/accounts?quick=1")
      .then((j) => {
        if (j?.cards) setCards((prev) => (prev.length > 0 ? prev : j.cards));
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    const accFullP = getJson("/api/training-advanced/accounts")
      .then((j) => {
        if (j?.cards) setCards(j.cards);
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    // 2. Dataset status (local export, H200 targets, Kaggle targets)
    const dataP = getJson("/api/training-advanced/dataset")
      .then((j) => {
        if (!j) return;
        setLocalExport(j.localExport || null);
        setDatasetTargets(j.targets || []);
        setKaggleDatasets(j.kaggleDatasets || []);
        setDefaultDatasetOwner(j.defaultDatasetOwner || "");
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    // 3. Background tasks
    const tasksP = getJson("/api/training-advanced/tasks")
      .then((j) => {
        if (j?.tasks) setTasks(j.tasks);
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    await Promise.allSettled([accQuickP, accFullP, dataP, tasksP]);
    setLoading(false);
    setRefreshing(false);
  }, [inReview]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Filter tasks to sync tasks
  const syncTasks = useMemo(() => {
    return tasks.filter((t) => t.type === "sync" || t.id.startsWith("sync-"));
  }, [tasks]);

  // Polling: every 3.5s if any sync task is running, otherwise 15s
  const isAnySyncRunning = useMemo(() => {
    return syncTasks.some((t) => t.status === "running");
  }, [syncTasks]);

  useEffect(() => {
    if (inReview) return;
    const interval = setInterval(() => {
      loadData(true);
    }, isAnySyncRunning ? 3500 : 15000);
    return () => clearInterval(interval);
  }, [inReview, isAnySyncRunning, loadData]);

  const toggleTaskLog = (taskId: string) => {
    setExpandedTaskLogs((prev) => ({ ...prev, [taskId]: !prev[taskId] }));
  };

  // Find last sync task for a specific target
  const getLastSyncForTarget = useCallback(
    (targetId: string) => {
      const match = syncTasks.find((t) => t.target === targetId);
      return match || null;
    },
    [syncTasks]
  );

  // Execute sync call
  const executeSync = async (targetId: string, confirmed = false) => {
    const target = datasetTargets.find((t) => t.targetId === targetId);
    if (!target) return;

    if (target.runningJobBlocking) {
      toast.error(
        `Sync Refused: ${target.runningJobBlocking.method} is currently running on ${target.label}. Updating data while a run is in progress would corrupt it.`
      );
      return;
    }

    setSyncBusyTarget(targetId);
    try {
      const res = await fetch("/api/training-advanced/dataset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId, confirmed }),
      });
      const json = await res.json();
      if (res.ok) {
        if (json.requiresConfirmation) {
          const sizeStr = json.formattedSize || (target.bytesToSync ? fmtBytes(target.bytesToSync) : "data");
          setConfirmModal({
            open: true,
            title:
              target.platform === "h200"
                ? "Confirm Internet Data Sync to H200"
                : "Confirm Kaggle Dataset Upload",
            description: `Target: ${target.label}`,
            warnings: [
              target.platform === "h200"
                ? "H200 is connected through the Internet via jump host (pc-server-1)."
                : "Uploading dataset to Kaggle over your internet connection.",
              `Data transfer size: ~${sizeStr}. This will consume your mobile / internet data!`,
              target.platform === "h200"
                ? "On direct college Wi-Fi / LAN, no internet data is used and no confirmation is needed."
                : "On metered connections, wait for high-speed Wi-Fi.",
            ],
            actionLabel: "Confirm & Proceed",
            onConfirm: async () => {
              setConfirmModal((prev) => ({ ...prev, open: false }));
              await executeSync(targetId, true);
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

  // Sync handler for H200 account row
  const handleH200Sync = (target: TargetDatasetStatus) => {
    if (target.runningJobBlocking) {
      toast.error(
        `Sync Refused: ${target.runningJobBlocking.method} is currently running on ${target.label}. Updating data while a run is in progress would corrupt it.`
      );
      return;
    }

    // Direct college network: no prompt needed
    if (!target.isRemoteRoute) {
      toast.info("Syncing directly over local college network (no internet data used)...");
      executeSync(target.targetId, true);
      return;
    }

    // Remote jump-host route: prompt with size and route
    const sizeStr = target.bytesToSync ? fmtBytes(target.bytesToSync) : "estimated data";
    setConfirmModal({
      open: true,
      title: "Confirm Internet Data Sync to H200",
      description: `Target: ${target.label}`,
      warnings: [
        "H200 is connected through the Internet via jump host (pc-server-1).",
        `Data sync size: ~${sizeStr}. This will consume your mobile / internet data!`,
        "On direct college Wi-Fi / LAN, no internet data is used and no confirmation is needed.",
      ],
      actionLabel: "Confirm & Sync Over Internet",
      onConfirm: async () => {
        setConfirmModal((prev) => ({ ...prev, open: false }));
        await executeSync(target.targetId, true);
      },
    });
  };

  // Sync All Free H200 handler
  const handleSyncAllFreeH200 = () => {
    const freeTargets = datasetTargets.filter(
      (t) => t.platform === "h200" && !t.runningJobBlocking
    );

    if (freeTargets.length === 0) {
      toast.info("No idle H200 accounts available to sync (all active accounts are currently training).");
      return;
    }

    const runBatchSync = async (confirmed = false) => {
      setSyncBusyTarget("batch-h200");
      try {
        let started = 0;
        for (const t of freeTargets) {
          try {
            await fetch("/api/training-advanced/dataset", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ targetId: t.targetId, confirmed }),
            });
            started++;
          } catch {}
        }
        toast.success(`Started background sync for ${started} idle H200 account(s).`);
        loadData(true);
      } catch (err: any) {
        toast.error(`Batch sync error: ${err.message}`);
      } finally {
        setSyncBusyTarget(null);
      }
    };

    const isAnyRemote = freeTargets.some((t) => t.isRemoteRoute);
    if (!isAnyRemote) {
      toast.info(`Syncing ${freeTargets.length} free H200 account(s) directly via college network...`);
      runBatchSync(true);
      return;
    }

    const totalBytes = freeTargets.reduce((sum, t) => sum + (t.bytesToSync || 0), 0);
    const sizeStr = totalBytes ? fmtBytes(totalBytes) : "estimated data";

    setConfirmModal({
      open: true,
      title: `Sync All ${freeTargets.length} Free H200 Accounts`,
      description: `Target accounts: ${freeTargets.map((t) => t.label).join(", ")}`,
      warnings: [
        "H200 connection is via Internet (jump host: pc-server-1).",
        `Estimated data transfer: ~${sizeStr} across ${freeTargets.length} account(s).`,
        "This will consume your mobile / internet data.",
      ],
      actionLabel: "Confirm & Sync All Free Accounts",
      onConfirm: async () => {
        setConfirmModal((prev) => ({ ...prev, open: false }));
        await runBatchSync(true);
      },
    });
  };

  // Upload handler for Kaggle
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
        await executeSync(target.targetId, true);
      },
    });
  };

  // Filtered history tasks
  const runningSyncFor = (targetId: string) =>
    syncTasks.find((x) => x.status === "running" && x.target === targetId);

  const stopSync = async (targetId: string) => {
    const res = await fetch("/api/training-advanced/cancel-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.success) toast.success(j.message || "Sync stopped");
    else toast.error(j.message || "Could not stop the sync");
    loadData(true);
  };

  const filteredSyncTasks = useMemo(() => {
    return syncTasks.filter((t) => {
      if (historyTargetFilter !== "all" && t.target !== historyTargetFilter) {
        return false;
      }
      if (historyStatusFilter !== "all") {
        if (historyStatusFilter === "refused") {
          const isRefused =
            (t.status as string) === "refused" ||
            t.message?.toLowerCase().includes("refused") ||
            t.message?.toLowerCase().includes("cannot sync");
          if (!isRefused) return false;
        } else if (historyStatusFilter === "completed") {
          if (t.status !== "completed") return false;
        } else if (historyStatusFilter === "running") {
          if (t.status !== "running") return false;
        } else if (historyStatusFilter === "failed") {
          if (t.status !== "failed") return false;
        }
      }
      return true;
    }).sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  }, [syncTasks, historyTargetFilter, historyStatusFilter]);

  // Unique target IDs from tasks
  const uniqueHistoryTargets = useMemo(() => {
    const set = new Set<string>();
    syncTasks.forEach((t) => {
      if (t.target) set.add(t.target);
    });
    return Array.from(set).sort();
  }, [syncTasks]);

  // H200 target rows
  const h200Targets = useMemo(() => {
    return datasetTargets.filter((t) => t.platform === "h200");
  }, [datasetTargets]);

  // Kaggle target & options
  const kaggleTarget = useMemo(() => {
    return datasetTargets.find((t) => t.platform === "kaggle") || null;
  }, [datasetTargets]);

  const kaggleCards = useMemo(() => {
    return cards.filter((c) => c.platform === "kaggle");
  }, [cards]);

  if (inReview) {
    return (
      <div className="space-y-6 pb-12">
        <div className="flex items-center gap-3">
          <Link
            href="/training/advanced"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Training (Advanced)
          </Link>
        </div>
        <div className="rounded-2xl border border-border bg-card p-8 text-center space-y-4">
          <Database className="h-10 w-10 text-muted-foreground mx-auto" />
          <h2 className="text-xl font-bold tracking-tight">Data Sync (Local Mode Only)</h2>
          <p className="max-w-md mx-auto text-xs text-muted-foreground leading-relaxed">
            Data synchronization with College H200 clusters and Kaggle accounts is available only when running the app locally on your machine with direct access to local datasets and credentials.
          </p>
          <div className="pt-2">
            <Link
              href="/training/advanced"
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-xs font-bold text-primary-foreground hover:bg-primary/90 transition-all"
            >
              Return to Training
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-[70vh] flex-col items-center justify-center space-y-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm font-medium text-muted-foreground">
          Loading dataset sync status, compute accounts, and history...
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8 pb-12">
      {/* 1. HEADER */}
      <div className="flex flex-col gap-4">
        <div>
          <Link
            href="/training/advanced"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors mb-2"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Training (Advanced)
          </Link>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold tracking-tight text-foreground">Data sync</h1>
                <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
                  Local Mode
                </span>
                {isAnySyncRunning && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    Sync in Progress
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Dedicated management center for synchronizing training datasets to College H200 cluster and Kaggle.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => loadData(false)}
                disabled={refreshing}
                className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-semibold text-muted-foreground transition-all hover:bg-accent hover:text-foreground cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
                Refresh Status
              </button>
            </div>
          </div>
        </div>

        {/* Local Export Summary Bar */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div>
            <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground block">
              Local Export Version
            </span>
            <span className="font-mono text-sm font-semibold text-foreground mt-0.5 block">
              {localExport?.hash ? localExport.hash : "Not exported yet"}
            </span>
          </div>

          <div>
            <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground block">
              Case Count
            </span>
            <span className="text-sm font-semibold text-foreground mt-0.5 block">
              {localExport?.cases ? (
                <>
                  {localExport.cases} total scans
                  {localExport.bmeCount != null && (
                    <span className="text-xs text-muted-foreground font-normal ml-1.5">
                      ({localExport.bmeCount} BME, {localExport.nonBmeCount || 0} non-BME)
                    </span>
                  )}
                  {localExport.bmeCases != null && localExport.bmeCount == null && (
                    <span className="text-xs text-muted-foreground font-normal ml-1.5">
                      ({localExport.bmeCases} BME, {localExport.nonBmeCases || 0} non-BME)
                    </span>
                  )}
                </>
              ) : (
                "0 scans"
              )}
            </span>
          </div>

          <div>
            <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground block">
              Files Exported
            </span>
            <span className="text-sm font-semibold text-foreground mt-0.5 block">
              {localExport?.files ? `${localExport.files} files` : "0 files"}
            </span>
          </div>

          <div>
            <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground block">
              Export Archive Size
            </span>
            <span className="text-sm font-semibold text-foreground mt-0.5 block">
              {fmtBytes(localExport?.bytes)}
            </span>
          </div>
        </div>
      </div>

      {/* 2. H200 PANEL */}
      <div className="space-y-4 rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border/50 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <Server className="h-5 w-5 text-purple-500" />
              <h2 className="text-lg font-bold tracking-tight">H200 Accounts (College Cluster)</h2>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Account-level synchronization states across student logins on College H200 cluster.
            </p>
          </div>

          {h200Targets.length > 0 && (
            <button
              onClick={handleSyncAllFreeH200}
              disabled={
                syncBusyTarget === "batch-h200" ||
                !h200Targets.some((t) => !t.runningJobBlocking)
              }
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-muted/40 px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted transition-all cursor-pointer disabled:opacity-40"
            >
              <RefreshCw
                className={`h-3 w-3 ${syncBusyTarget === "batch-h200" ? "animate-spin" : ""}`}
              />
              Sync All Free H200 ({h200Targets.filter((t) => !t.runningJobBlocking).length} idle)
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/40 text-[10px] uppercase tracking-wider font-bold text-muted-foreground border-b border-border">
              <tr>
                <th className="px-3.5 py-3">Account Label</th>
                <th className="px-3 py-3">Connection Route</th>
                <th className="px-3 py-3">Account Version</th>
                <th className="px-3 py-3">Local Version</th>
                <th className="px-3 py-3">Sync Status</th>
                <th className="px-3 py-3">Cases &amp; Files</th>
                <th className="px-3 py-3">Size to Send</th>
                <th className="px-3 py-3">Last Sync Time</th>
                <th className="px-3 py-3">State</th>
                <th className="px-3.5 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40 font-medium">
              {h200Targets.length > 0 ? (
                h200Targets.map((t) => {
                  const card = cards.find((c) => c.id === t.targetId);
                  const isConnected = card ? card.connected : true;
                  const isBlocked = Boolean(t.runningJobBlocking);
                  const lastSync = getLastSyncForTarget(t.targetId);
                  const isBusy = syncBusyTarget === t.targetId;

                  // Determine state label
                  let stateLabel = "Ready";
                  let stateClass = "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
                  if (!isConnected) {
                    stateLabel = "Not connected";
                    stateClass = "bg-destructive/10 text-destructive";
                  } else if (isBlocked) {
                    stateLabel = `Blocked: ${t.runningJobBlocking?.method || "job"} is running`;
                    stateClass = "bg-amber-500/10 text-amber-600 dark:text-amber-400";
                  }

                  return (
                    <tr key={t.targetId} className="hover:bg-muted/30 transition-colors">
                      <td className="px-3.5 py-3 font-semibold text-foreground whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <Server className="h-3.5 w-3.5 text-purple-500 shrink-0" />
                          <span>{t.label}</span>
                        </div>
                      </td>

                      <td className="px-3 py-3 whitespace-nowrap">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            t.isRemoteRoute
                              ? "bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20"
                              : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20"
                          }`}
                        >
                          {t.isRemoteRoute ? "Jump host (pc-server-1)" : "College Network (Direct)"}
                        </span>
                      </td>

                      <td className="px-3 py-3 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                        {t.datasetVersion || "server-synced"}
                      </td>

                      <td className="px-3 py-3 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                        {localExport?.hash ? localExport.hash.slice(0, 12) : t.localExportVersion || "-"}
                      </td>

                      <td className="px-3 py-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            t.isUpToDate
                              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                              : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                          }`}
                        >
                          {t.isUpToDate ? "Up to date" : "Update available"}
                        </span>
                      </td>

                      <td className="px-3 py-3 whitespace-nowrap text-muted-foreground">
                        {t.casesCount != null ? `${t.casesCount} scans (${t.filesCount} files)` : "-"}
                      </td>

                      <td className="px-3 py-3 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                        {t.bytesToSync ? fmtBytes(t.bytesToSync) : "0 B"}
                      </td>

                      <td className="px-3 py-3 whitespace-nowrap text-muted-foreground text-[11px]">
                        {lastSync
                          ? fmtDate(lastSync.endedAt || lastSync.startedAt)
                          : "Never synced"}
                      </td>

                      <td className="px-3 py-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${stateClass}`}
                        >
                          {isConnected && !isBlocked && (
                            <CheckCircle2 className="h-3 w-3 shrink-0" />
                          )}
                          {!isConnected && <XCircle className="h-3 w-3 shrink-0" />}
                          {isConnected && isBlocked && (
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                          )}
                          {stateLabel}
                        </span>
                      </td>

                      <td className="px-3.5 py-3 text-right whitespace-nowrap">
                        <button
                          onClick={() => handleH200Sync(t)}
                          disabled={isBlocked || !isConnected || isBusy || Boolean(runningSyncFor(t.targetId))}
                          className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground hover:bg-primary/90 transition-all cursor-pointer disabled:opacity-40"
                        >
                          {isBusy ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <HardDrive className="h-3 w-3" />
                          )}
                          Sync
                        </button>
                        {runningSyncFor(t.targetId) && (
                          <div className="mt-1.5 space-y-1">
                            <div className="max-w-[260px] truncate text-[10px] text-muted-foreground" title={runningSyncFor(t.targetId)?.message}>
                              {runningSyncFor(t.targetId)?.message}
                            </div>
                            <button type="button" onClick={() => { void stopSync(t.targetId); }} className="w-full rounded border border-destructive/50 px-2 py-0.5 text-[11px] text-destructive hover:bg-destructive/10">
                              Stop
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={10} className="py-8 text-center text-xs text-muted-foreground">
                    No H200 accounts configured in .env.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 3. KAGGLE PANEL */}
      <div className="space-y-4 rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border/50 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <Cloud className="h-5 w-5 text-sky-500" />
              <h2 className="text-lg font-bold tracking-tight">Kaggle Datasets &amp; Permissions</h2>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Private Kaggle training dataset ownership, upload versions, and shared access.
            </p>
          </div>

          {kaggleTarget && (
            <button
              onClick={() => handleKaggleUpload()}
              disabled={
                Boolean(kaggleTarget.runningJobBlocking) ||
                syncBusyTarget === kaggleTarget.targetId
              }
              className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-bold text-primary-foreground hover:bg-primary/90 transition-all cursor-pointer disabled:opacity-40"
            >
              {syncBusyTarget === kaggleTarget.targetId ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {kaggleTarget.hasUploaded ? "Update Kaggle Dataset" : "Upload to Kaggle"}
            </button>
          )}
        </div>

        {/* Ownership Notice */}
        <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-3 text-xs text-sky-800 dark:text-sky-200 flex items-start gap-2.5">
          <Info className="h-4 w-4 shrink-0 text-sky-500 mt-0.5" />
          <div className="space-y-1">
            <p className="font-semibold">Dataset Ownership &amp; Teammate Sharing Policy:</p>
            <p className="text-[11px] leading-relaxed">
              <strong>Owner:</strong> The designated account (configured via KAGGLE_DATASET_OWNER in .env, defaults to {defaultDatasetOwner ? `roll ${defaultDatasetOwner}` : "first Kaggle slot"}) uploads and updates the private dataset on Kaggle.
            </p>
            <p className="text-[11px] leading-relaxed">
              <strong>Readers:</strong> Other teammate Kaggle accounts train on this dataset once the owner adds them as collaborators under Dataset Settings on kaggle.com.
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/40 text-[10px] uppercase tracking-wider font-bold text-muted-foreground border-b border-border">
              <tr>
                <th className="px-3.5 py-3">Account / User</th>
                <th className="px-3 py-3">Role / Permission</th>
                <th className="px-3 py-3">Uploaded Version</th>
                <th className="px-3 py-3">Local Version</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Size (Scans &amp; Files)</th>
                <th className="px-3 py-3">Last Upload Time</th>
                <th className="px-3.5 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40 font-medium">
              {kaggleDatasets.length > 0 ? (
                kaggleDatasets.map((kd) => {
                  const isOwner =
                    kd.isDefault ||
                    (defaultDatasetOwner && kd.roll === defaultDatasetOwner);
                  const isUpToDate = Boolean(
                    kd.uploadedHash &&
                      localExport?.hash &&
                      kd.uploadedHash === localExport.hash
                  );
                  const isBusy = syncBusyTarget === kaggleTarget?.targetId;

                  return (
                    <tr key={kd.roll + (kd.slot || 1)} className="hover:bg-muted/30 transition-colors">
                      <td className="px-3.5 py-3 font-semibold text-foreground whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <Cloud className="h-3.5 w-3.5 text-sky-500 shrink-0" />
                          <span>{kd.label}</span>
                          <span className="font-mono text-[11px] text-muted-foreground">
                            ({kd.user})
                          </span>
                        </div>
                      </td>

                      <td className="px-3 py-3 whitespace-nowrap">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            isOwner
                              ? "bg-purple-500/10 text-purple-700 dark:text-purple-300 border border-purple-500/20"
                              : "bg-muted text-muted-foreground border border-border"
                          }`}
                        >
                          {isOwner ? "Dataset Owner (Uploads)" : "Reader (Trained on)"}
                        </span>
                      </td>

                      <td className="px-3 py-3 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                        {kd.uploadedHash ? kd.uploadedHash.slice(0, 12) : "Not uploaded"}
                      </td>

                      <td className="px-3 py-3 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                        {localExport?.hash ? localExport.hash.slice(0, 12) : "-"}
                      </td>

                      <td className="px-3 py-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            isUpToDate
                              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                              : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                          }`}
                        >
                          {isUpToDate ? "Up to date" : "Update available"}
                        </span>
                      </td>

                      <td className="px-3 py-3 whitespace-nowrap text-muted-foreground">
                        {kd.caseCount} scans ({kd.fileCount} files)
                      </td>

                      <td className="px-3 py-3 whitespace-nowrap text-muted-foreground text-[11px]">
                        {fmtDate(kd.uploadedAt)}
                      </td>

                      <td className="px-3.5 py-3 text-right whitespace-nowrap">
                        {isOwner ? (
                          <button
                            onClick={() => handleKaggleUpload()}
                            disabled={isBusy || Boolean(kaggleTarget?.runningJobBlocking)}
                            className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground hover:bg-primary/90 transition-all cursor-pointer disabled:opacity-40"
                          >
                            {isBusy ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Upload className="h-3 w-3" />
                            )}
                            {isUpToDate ? "Re-upload" : "Upload"}
                          </button>
                        ) : (
                          <span className="text-[11px] text-muted-foreground italic">
                            Shares owner&apos;s dataset
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : kaggleTarget ? (
                <tr className="hover:bg-muted/30 transition-colors">
                  <td className="px-3.5 py-3 font-semibold text-foreground whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <Cloud className="h-3.5 w-3.5 text-sky-500 shrink-0" />
                      <span>{kaggleTarget.label}</span>
                    </div>
                  </td>

                  <td className="px-3 py-3 whitespace-nowrap">
                    <span className="rounded-full bg-purple-500/10 text-purple-700 dark:text-purple-300 border border-purple-500/20 px-2 py-0.5 text-[10px] font-bold">
                      Designated Owner
                    </span>
                  </td>

                  <td className="px-3 py-3 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                    {kaggleTarget.datasetVersion || "not-uploaded"}
                  </td>

                  <td className="px-3 py-3 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                    {localExport?.hash ? localExport.hash.slice(0, 12) : "-"}
                  </td>

                  <td className="px-3 py-3 whitespace-nowrap">
                    <span className="rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 px-2 py-0.5 text-[10px] font-bold">
                      {kaggleTarget.isEmpty ? "Not uploaded yet" : "Update available"}
                    </span>
                  </td>

                  <td className="px-3 py-3 whitespace-nowrap text-muted-foreground">
                    {kaggleTarget.casesCount ? `${kaggleTarget.casesCount} scans (${kaggleTarget.filesCount} files)` : "-"}
                  </td>

                  <td className="px-3 py-3 whitespace-nowrap text-muted-foreground text-[11px]">
                    {fmtDate(kaggleTarget.lastUpdated)}
                  </td>

                  <td className="px-3.5 py-3 text-right whitespace-nowrap">
                    <button
                      onClick={() => handleKaggleUpload()}
                      disabled={
                        Boolean(kaggleTarget.runningJobBlocking) ||
                        syncBusyTarget === kaggleTarget.targetId
                      }
                      className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground hover:bg-primary/90 transition-all cursor-pointer disabled:opacity-40"
                    >
                      <Upload className="h-3 w-3" />
                      Upload to Kaggle
                    </button>
                  </td>
                </tr>
              ) : (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-xs text-muted-foreground">
                    No Kaggle accounts configured in .env.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Reader Teammates List */}
        {kaggleCards.length > 1 && (
          <div className="pt-2 text-[11px] text-muted-foreground border-t border-border/40">
            <span className="font-semibold text-foreground">Configured Teammate Accounts: </span>
            {kaggleCards.map((c) => c.label).join(", ")}
          </div>
        )}
      </div>

      {/* 4. HISTORY PANEL */}
      <div className="space-y-4 rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border/50 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-bold tracking-tight">Sync &amp; Upload History</h2>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Historical record of dataset synchronizations to H200 and Kaggle uploads with logs.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => loadData(false)}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 py-1">
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground block mb-1">
              Target
            </label>
            <select
              value={historyTargetFilter}
              onChange={(e) => setHistoryTargetFilter(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-medium cursor-pointer"
            >
              <option value="all">All Targets</option>
              {uniqueHistoryTargets.map((tgt) => (
                <option key={tgt} value={tgt}>
                  {tgt}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground block mb-1">
              Status
            </label>
            <select
              value={historyStatusFilter}
              onChange={(e) => setHistoryStatusFilter(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-medium cursor-pointer"
            >
              <option value="all">All Statuses</option>
              <option value="running">Running</option>
              <option value="completed">Done / Completed</option>
              <option value="failed">Failed</option>
              <option value="refused">Refused / Blocked</option>
            </select>
          </div>
        </div>

        {/* Task List */}
        <div className="space-y-3 pt-2">
          {filteredSyncTasks.length > 0 ? (
            filteredSyncTasks.map((task) => {
              const isExpanded = Boolean(expandedTaskLogs[task.id]);
              const isRefused =
                (task.status as string) === "refused" ||
                task.message?.toLowerCase().includes("refused") ||
                task.message?.toLowerCase().includes("cannot sync");

              let statusLabel = task.status === "completed" ? "Done" : task.status;
              let statusClass = "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";

              if (task.status === "running") {
                statusLabel = "Running";
                statusClass = "bg-sky-500/10 text-sky-600 dark:text-sky-400";
              } else if (isRefused) {
                statusLabel = "Refused";
                statusClass = "bg-amber-500/10 text-amber-600 dark:text-amber-400";
              } else if (task.status === "failed") {
                statusLabel = "Failed";
                statusClass = "bg-destructive/10 text-destructive";
              }

              return (
                <div
                  key={task.id}
                  className="rounded-xl border border-border/70 bg-muted/20 p-4 space-y-2.5 transition-all hover:border-border"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-bold ${statusClass}`}
                      >
                        {task.status === "running" && (
                          <span className="h-1.5 w-1.5 rounded-full bg-sky-500 animate-pulse" />
                        )}
                        {statusLabel}
                      </span>
                      <span className="font-semibold text-foreground text-xs">
                        Target: {task.target}
                      </span>
                    </div>

                    <div className="text-[11px] text-muted-foreground flex items-center gap-2">
                      <span>Started: {fmtDate(task.startedAt)}</span>
                      {task.endedAt && <span>Ended: {fmtDate(task.endedAt)}</span>}
                    </div>
                  </div>

                  <p className="text-xs text-foreground leading-relaxed">
                    {task.message || "Dataset synchronization task"}
                  </p>

                  {task.error && (
                    <p className="text-xs text-destructive font-mono bg-destructive/10 p-2 rounded-lg">
                      {task.error}
                    </p>
                  )}

                  {task.log && task.log.length > 0 && (
                    <div className="pt-1">
                      <button
                        onClick={() => toggleTaskLog(task.id)}
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground cursor-pointer"
                      >
                        <Terminal className="h-3 w-3" />
                        {isExpanded ? "Hide execution log" : `View execution log (${task.log.length} lines)`}
                        {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                      </button>

                      {isExpanded && (
                        <pre className="mt-2 max-h-48 overflow-y-auto rounded-xl bg-muted/60 p-3 font-mono text-[10px] leading-relaxed text-muted-foreground">
                          {task.log.join("\n")}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <div className="py-8 text-center text-xs text-muted-foreground">
              No sync tasks match the selected filters.
            </div>
          )}
        </div>
      </div>

      {/* Confirmation Modal */}
      {confirmModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-2.5 text-foreground">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              <h3 className="text-base font-bold">{confirmModal.title}</h3>
            </div>
            <p className="text-xs text-muted-foreground">{confirmModal.description}</p>

            {confirmModal.warnings.length > 0 && (
              <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                {confirmModal.warnings.map((w, i) => (
                  <p key={i} className="leading-snug">
                    - {w}
                  </p>
                ))}
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={() => setConfirmModal((prev) => ({ ...prev, open: false }))}
                className="rounded-xl border border-border px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={confirmModal.onConfirm}
                className="rounded-xl bg-primary px-4 py-2 text-xs font-bold text-primary-foreground hover:bg-primary/90 cursor-pointer"
              >
                {confirmModal.actionLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
