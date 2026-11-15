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
  Upload,
  Info,
  Radio,
  RotateCcw,
  Trash2,
  Copy,
  Check,
  Layers,
  FileCode,
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

function parseProgressPercent(message?: string): number | null {
  if (!message) return null;
  const m = message.match(/([\d.]+)\s*(MB|GB|KB)\s+of\s+~?([\d.]+)\s*(MB|GB|KB)/i);
  if (!m) return null;
  const toMb = (val: number, unit: string) => {
    const u = unit.toUpperCase();
    if (u === "GB") return val * 1024;
    if (u === "KB") return val / 1024;
    return val;
  };
  const currentMb = toMb(parseFloat(m[1]), m[2]);
  const totalMb = toMb(parseFloat(m[3]), m[4]);
  if (totalMb > 0) {
    return Math.min(100, Math.max(0, Math.round((currentMb / totalMb) * 100)));
  }
  return null;
}

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
  const [copiedHash, setCopiedHash] = useState(false);

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

    // 1. Accounts for connectivity and status (quick first)
    const accQuickP = getJson("/api/training-advanced/accounts?quick=1")
      .then((j) => {
        if (j?.cards && j.cards.length > 0) setCards((prev) => (prev.length > 0 ? prev : j.cards));
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    const accFullP = getJson("/api/training-advanced/accounts")
      .then((j) => {
        if (j?.cards && j.cards.length > 0) setCards(j.cards);
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    // 2. Dataset status (local export, H200 targets, Kaggle targets)
    const dataP = getJson("/api/training-advanced/dataset")
      .then((j) => {
        if (!j) return;
        setLocalExport(j.localExport || null);
        if (j.targets && j.targets.length > 0) setDatasetTargets(j.targets);
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

  // Polling: every 3.5s if any sync task is running, otherwise 12s
  const isAnySyncRunning = useMemo(() => {
    return syncTasks.some((t) => t.status === "running");
  }, [syncTasks]);

  useEffect(() => {
    if (inReview) return;
    const interval = setInterval(() => {
      loadData(true);
    }, isAnySyncRunning ? 3500 : 12000);
    return () => clearInterval(interval);
  }, [inReview, isAnySyncRunning, loadData]);

  const toggleTaskLog = (taskId: string) => {
    setExpandedTaskLogs((prev) => ({ ...prev, [taskId]: !prev[taskId] }));
  };

  const copyHashToClipboard = (hash?: string) => {
    if (!hash) return;
    navigator.clipboard.writeText(hash);
    setCopiedHash(true);
    toast.success("Export version hash copied to clipboard");
    setTimeout(() => setCopiedHash(false), 2000);
  };

  // Find last sync task for a specific target
  const getLastSyncForTarget = useCallback(
    (targetId: string) => {
      const match = syncTasks.find((t) => t.target === targetId);
      return match || null;
    },
    [syncTasks]
  );

  // Execute sync call (supports isFresh)
  const executeSync = async (targetId: string, confirmed = false, isFresh = false) => {
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
        body: JSON.stringify({ targetId, confirmed, isFresh }),
      });
      const json = await res.json();
      if (res.ok) {
        if (json.requiresConfirmation) {
          const sizeStr = json.formattedSize || (target.bytesToSync ? fmtBytes(target.bytesToSync) : "data");
          setConfirmModal({
            open: true,
            title:
              target.platform === "h200"
                ? (isFresh ? "Confirm Fresh Re-upload to H200" : "Confirm Internet Data Sync to H200")
                : (isFresh ? "Confirm Fresh Re-upload to Kaggle" : "Confirm Kaggle Dataset Upload"),
            description: `Target: ${target.label}`,
            warnings: [
              ...(isFresh
                ? [
                    target.platform === "h200"
                      ? "This will delete remote annotations, scans, splits, and worklist on H200 and re-upload everything fresh."
                      : "This will force a full re-export, re-verify de-identification, and publish a new Kaggle version."
                  ]
                : []),
              target.platform === "h200"
                ? "H200 is connected through the Internet via jump host (pc-server-1)."
                : "Uploading dataset to Kaggle over your internet connection.",
              `Data transfer size: ~${sizeStr}. This will consume your mobile / internet data!`,
              target.platform === "h200"
                ? "On direct college Wi-Fi / LAN, no internet data is used and no confirmation is needed."
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
      title: `Confirm Fresh Re-upload to H200 (${target.label})`,
      description: `Target: ${target.label}`,
      warnings: [
        "This will DELETE previously uploaded annotations, scans, splits, and worklist on this H200 account.",
        `Full dataset size: ~${sizeStr}. All files will be transferred fresh from this PC.`,
        target.isRemoteRoute
          ? "H200 is connected through Internet (jump host: pc-server-1). This will consume mobile/metered data!"
          : "Direct college network route will be used.",
        "Use this option if remote data is corrupted, out-of-sync, or missing files.",
      ],
      actionLabel: "Delete Old Data & Fresh Re-upload",
      onConfirm: async () => {
        setConfirmModal((prev) => ({ ...prev, open: false }));
        await executeSync(target.targetId, true, true);
      },
    });
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

    const runBatchSync = async (confirmed = false) => {
      setSyncBusyTarget("batch-h200");
      try {
        let started = 0;
        for (const t of freeTargets) {
          try {
            await fetch("/api/training-advanced/dataset", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ targetId: t.targetId, confirmed, isFresh: false }),
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
  const runningSyncFor = (targetId: string) =>
    syncTasks.find((x) => x.status === "running" && x.target === targetId);

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

  const uniqueHistoryTargets = useMemo(() => {
    const set = new Set<string>();
    syncTasks.forEach((t) => {
      if (t.target) set.add(t.target);
    });
    return Array.from(set).sort();
  }, [syncTasks]);

  const h200Targets = useMemo(() => {
    return datasetTargets.filter((t) => t.platform === "h200");
  }, [datasetTargets]);

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

      {/* 1. HEADER & LOCAL EXPORT SUMMARY */}
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
              onClick={() => loadData(false)}
              disabled={refreshing}
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-semibold text-muted-foreground transition-all hover:bg-accent hover:text-foreground cursor-pointer disabled:opacity-50 shadow-xs"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
              Refresh Status
            </button>
          </div>
        </div>

        {/* Local Export Summary Bar */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-2xl border border-border bg-card p-4 shadow-xs space-y-1">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-[10px] uppercase font-bold tracking-wider">Local Export Version</span>
              <FileCode className="h-4 w-4 text-primary/70" />
            </div>
            <div className="flex items-center justify-between pt-1">
              <span className="font-mono text-xs font-semibold text-foreground truncate max-w-[190px]" title={localExport?.hash || ""}>
                {localExport?.hash ? localExport.hash.slice(0, 16) : "Not exported yet"}
              </span>
              {localExport?.hash && (
                <button
                  type="button"
                  onClick={() => copyHashToClipboard(localExport.hash)}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                  title="Copy full hash"
                >
                  {copiedHash ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4 shadow-xs space-y-1">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-[10px] uppercase font-bold tracking-wider">Annotated Scans</span>
              <Layers className="h-4 w-4 text-emerald-500/70" />
            </div>
            <div className="text-sm font-semibold text-foreground pt-1">
              {localExport?.cases ? (
                <div className="flex items-baseline gap-2">
                  <span>{localExport.cases} total</span>
                  {(localExport.bmeCount != null || localExport.bmeCases != null) && (
                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                      {localExport.bmeCount ?? localExport.bmeCases} BME + {localExport.nonBmeCount ?? localExport.nonBmeCases ?? 0} Control
                    </span>
                  )}
                </div>
              ) : (
                "0 scans"
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4 shadow-xs space-y-1">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-[10px] uppercase font-bold tracking-wider">Files in Export</span>
              <Database className="h-4 w-4 text-purple-500/70" />
            </div>
            <div className="text-sm font-semibold text-foreground pt-1">
              {localExport?.files ? `${localExport.files} files (masks & volumes)` : "0 files"}
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4 shadow-xs space-y-1">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-[10px] uppercase font-bold tracking-wider">Archive Size</span>
              <HardDrive className="h-4 w-4 text-sky-500/70" />
            </div>
            <div className="text-sm font-semibold text-foreground pt-1 font-mono">
              {fmtBytes(localExport?.bytes)}
            </div>
          </div>
        </div>
      </div>

      {/* 2. H200 PANEL */}
      <div className="space-y-4 rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border/50 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <Server className="h-5 w-5 text-purple-500" />
              <h2 className="text-lg font-bold tracking-tight">H200 Cluster Accounts</h2>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Target storage states across student logins on the College H200 cluster.
            </p>
          </div>

          {h200Targets.length > 0 && (
            <div className="flex items-center gap-2">
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
                Sync All Idle ({h200Targets.filter((t) => !t.runningJobBlocking).length})
              </button>
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/40 text-[10px] uppercase tracking-wider font-bold text-muted-foreground border-b border-border">
              <tr>
                <th className="px-3.5 py-3">Account Label</th>
                <th className="px-3 py-3">Route</th>
                <th className="px-3 py-3">Remote Version</th>
                <th className="px-3 py-3">Local Version</th>
                <th className="px-3 py-3">Sync Status</th>
                <th className="px-3 py-3">Data to Send</th>
                <th className="px-3 py-3">Last Sync</th>
                <th className="px-3 py-3">Node State</th>
                <th className="px-3.5 py-3 text-right">Actions</th>
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
                  const activeSync = runningSyncFor(t.targetId);
                  const percent = parseProgressPercent(activeSync?.message);

                  let stateLabel = "Ready";
                  let stateClass = "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
                  if (!isConnected) {
                    stateLabel = "Offline";
                    stateClass = "bg-destructive/10 text-destructive";
                  } else if (isBlocked) {
                    stateLabel = `Busy: ${t.runningJobBlocking?.method || "training"}`;
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
                          {t.isRemoteRoute ? "pc-server-1" : "College LAN"}
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
                          {t.isUpToDate ? "Up to date" : "Needs sync"}
                        </span>
                      </td>

                      <td className="px-3 py-3 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                        {t.bytesToSync ? fmtBytes(t.bytesToSync) : "0 B"}
                      </td>

                      <td className="px-3 py-3 whitespace-nowrap text-muted-foreground text-[11px]">
                        {lastSync
                          ? fmtDate(lastSync.endedAt || lastSync.startedAt)
                          : "Never"}
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
                        <div className="flex items-center justify-end gap-1.5">
                          {/* Incremental Sync Button */}
                          <button
                            onClick={() => handleH200Sync(t)}
                            disabled={isBlocked || !isConnected || isBusy || Boolean(activeSync)}
                            className="inline-flex items-center gap-1 rounded-xl bg-primary px-2.5 py-1.5 text-xs font-bold text-primary-foreground hover:bg-primary/90 transition-all cursor-pointer disabled:opacity-40"
                            title="Incremental sync: transfers changed and new files only"
                          >
                            {isBusy ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <HardDrive className="h-3 w-3" />
                            )}
                            Sync
                          </button>

                          {/* Fresh Re-upload Button */}
                          <button
                            onClick={() => handleH200FreshUpload(t)}
                            disabled={isBlocked || !isConnected || isBusy || Boolean(activeSync)}
                            className="inline-flex items-center gap-1 rounded-xl border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 transition-all cursor-pointer disabled:opacity-40"
                            title="Fresh Re-upload: deletes remote annotations and scans, then uploads everything fresh"
                          >
                            <RotateCcw className="h-3 w-3" />
                            Fresh Upload
                          </button>
                        </div>

                        {/* Running Progress Bar & Stop Button */}
                        {activeSync && (
                          <div className="mt-2 space-y-1.5 max-w-[280px] ml-auto text-left">
                            {percent !== null && (
                              <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                                <div
                                  className="bg-emerald-500 h-1.5 rounded-full transition-all duration-300"
                                  style={{ width: `${percent}%` }}
                                />
                              </div>
                            )}
                            <div className="flex items-center justify-between text-[10px] text-muted-foreground gap-2">
                              <span className="truncate" title={activeSync.message}>
                                {activeSync.message}
                              </span>
                              {percent !== null && (
                                <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400 shrink-0">
                                  {percent}%
                                </span>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => { void stopSync(t.targetId); }}
                              className="w-full rounded border border-destructive/50 px-2 py-0.5 text-[11px] text-destructive hover:bg-destructive/10 cursor-pointer"
                            >
                              Stop Sync
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-xs text-muted-foreground">
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
              Private Kaggle training dataset ownership, upload versions, and team sharing.
            </p>
          </div>

          {kaggleTarget && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleKaggleUpload()}
                disabled={
                  Boolean(kaggleTarget.runningJobBlocking) ||
                  syncBusyTarget === kaggleTarget.targetId ||
                  Boolean(runningSyncFor(kaggleTarget.targetId))
                }
                className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground hover:bg-primary/90 transition-all cursor-pointer disabled:opacity-40"
              >
                {syncBusyTarget === kaggleTarget.targetId ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                {kaggleTarget.hasUploaded ? "Update Dataset" : "Upload to Kaggle"}
              </button>

              <button
                onClick={() => handleKaggleFreshUpload()}
                disabled={
                  Boolean(kaggleTarget.runningJobBlocking) ||
                  syncBusyTarget === kaggleTarget.targetId ||
                  Boolean(runningSyncFor(kaggleTarget.targetId))
                }
                className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 transition-all cursor-pointer disabled:opacity-40"
                title="Force complete fresh re-export and upload a new dataset version"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Fresh Re-upload
              </button>
            </div>
          )}
        </div>

        {/* Ownership Notice */}
        <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-3 text-xs text-sky-800 dark:text-sky-200 flex items-start gap-2.5">
          <Info className="h-4 w-4 shrink-0 text-sky-500 mt-0.5" />
          <div className="space-y-1">
            <p className="font-semibold">Dataset Ownership &amp; Teammate Sharing Policy:</p>
            <p className="text-[11px] leading-relaxed">
              <strong>Owner:</strong> The designated account (configured via <code className="font-mono text-[10px]">KAGGLE_DATASET_OWNER</code> in .env, defaults to {defaultDatasetOwner ? `roll ${defaultDatasetOwner}` : "first Kaggle slot"}) uploads and updates the private dataset on Kaggle.
            </p>
            <p className="text-[11px] leading-relaxed">
              <strong>Readers:</strong> Teammates train on this dataset once the owner adds them as collaborators under Dataset Settings on kaggle.com.
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
                <th className="px-3 py-3">Scans &amp; Files</th>
                <th className="px-3 py-3">Last Upload</th>
                <th className="px-3.5 py-3 text-right">Actions</th>
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
                  const activeSync = kaggleTarget ? runningSyncFor(kaggleTarget.targetId) : null;
                  const percent = parseProgressPercent(activeSync?.message);

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
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() => handleKaggleUpload()}
                                disabled={isBusy || Boolean(kaggleTarget?.runningJobBlocking) || Boolean(activeSync)}
                                className="inline-flex items-center gap-1 rounded-xl bg-primary px-2.5 py-1.5 text-xs font-bold text-primary-foreground hover:bg-primary/90 transition-all cursor-pointer disabled:opacity-40"
                              >
                                {isBusy ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Upload className="h-3 w-3" />
                                )}
                                {isUpToDate ? "Update" : "Upload"}
                              </button>

                              <button
                                onClick={() => handleKaggleFreshUpload()}
                                disabled={isBusy || Boolean(kaggleTarget?.runningJobBlocking) || Boolean(activeSync)}
                                className="inline-flex items-center gap-1 rounded-xl border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 transition-all cursor-pointer disabled:opacity-40"
                                title="Force complete fresh re-export and upload a new dataset version"
                              >
                                <RotateCcw className="h-3 w-3" />
                                Fresh
                              </button>
                            </div>

                            {activeSync && (
                              <div className="space-y-1.5 max-w-[260px] ml-auto text-left">
                                {percent !== null && (
                                  <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                                    <div
                                      className="bg-emerald-500 h-1.5 rounded-full transition-all duration-300"
                                      style={{ width: `${percent}%` }}
                                    />
                                  </div>
                                )}
                                <div className="text-[10px] text-muted-foreground truncate" title={activeSync.message}>
                                  {activeSync.message}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => { if (kaggleTarget) void stopSync(kaggleTarget.targetId); }}
                                  className="w-full rounded border border-destructive/50 px-2 py-0.5 text-[11px] text-destructive hover:bg-destructive/10 cursor-pointer"
                                >
                                  Stop Upload
                                </button>
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-[11px] text-muted-foreground italic">
                            Uses owner&apos;s dataset
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
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        onClick={() => handleKaggleUpload()}
                        disabled={
                          Boolean(kaggleTarget.runningJobBlocking) ||
                          syncBusyTarget === kaggleTarget.targetId
                        }
                        className="inline-flex items-center gap-1 rounded-xl bg-primary px-2.5 py-1.5 text-xs font-bold text-primary-foreground hover:bg-primary/90 transition-all cursor-pointer disabled:opacity-40"
                      >
                        <Upload className="h-3 w-3" />
                        Upload
                      </button>
                      <button
                        onClick={() => handleKaggleFreshUpload()}
                        disabled={
                          Boolean(kaggleTarget.runningJobBlocking) ||
                          syncBusyTarget === kaggleTarget.targetId
                        }
                        className="inline-flex items-center gap-1 rounded-xl border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 transition-all cursor-pointer disabled:opacity-40"
                      >
                        <RotateCcw className="h-3 w-3" />
                        Fresh
                      </button>
                    </div>
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
              Historical record of dataset synchronizations to H200 and Kaggle with live streaming logs.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {syncTasks.length > 0 && (
              <button
                onClick={handleClearHistory}
                className="inline-flex items-center gap-1.5 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10 transition-all cursor-pointer"
                title="Clear all finished and failed sync task logs"
              >
                <Trash2 className="h-3 w-3" />
                Clear History
              </button>
            )}
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
              Filter by Target
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
              Filter by Status
            </label>
            <select
              value={historyStatusFilter}
              onChange={(e) => setHistoryStatusFilter(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-medium cursor-pointer"
            >
              <option value="all">All Statuses</option>
              <option value="running">Running</option>
              <option value="completed">Completed</option>
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
              const isCancelled = task.status === "cancelled";
              const percent = parseProgressPercent(task.message);

              let statusLabel = task.status === "completed" ? "Done" : task.status;
              let statusClass = "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";

              if (task.status === "running") {
                statusLabel = "Running";
                statusClass = "bg-sky-500/10 text-sky-600 dark:text-sky-400";
              } else if (isRefused) {
                statusLabel = "Refused";
                statusClass = "bg-amber-500/10 text-amber-600 dark:text-amber-400";
              } else if (isCancelled) {
                statusLabel = "Stopped";
                statusClass = "bg-muted text-muted-foreground";
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

                  {/* Progress Bar for active running sync */}
                  {task.status === "running" && percent !== null && (
                    <div className="space-y-1">
                      <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                        <div
                          className="bg-sky-500 h-1.5 rounded-full transition-all duration-300"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                        <span>Transferring...</span>
                        <span>{percent}%</span>
                      </div>
                    </div>
                  )}

                  <p className="text-xs text-foreground leading-relaxed font-mono">
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
                        <pre className="mt-2 max-h-48 overflow-y-auto rounded-xl bg-muted/60 p-3 font-mono text-[10px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
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
              <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />
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