"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isReviewMode } from "~/lib/app-mode";
import type {
  AccountCard,
  RunItem,
  TargetDatasetStatus,
  MethodSpec,
  BackgroundTask,
  PlatformType,
} from "~/lib/training-advanced/types";
import {
  Server,
  Cloud,
  Cpu,
  RefreshCw,
  Play,
  RotateCcw,
  Square,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Terminal,
  Database,
  Filter,
  ChevronDown,
  ChevronUp,
  Info,
  Loader2,
  HardDrive,
  Radio,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";

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
];

const fmtDuration = (sec: number | null | undefined): string => {
  if (sec == null) return "-";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
};

const fmtMetric = (m: { mean: number; std?: number } | null | undefined): string => {
  if (!m || m.mean == null) return "-";
  return m.std != null && m.std > 0
    ? `${m.mean.toFixed(3)} +- ${m.std.toFixed(3)}`
    : m.mean.toFixed(3);
};

export default function AdvancedTrainingPage() {
  if (isReviewMode()) {
    notFound();
  }

  // Data states
  const [cards, setCards] = useState<AccountCard[]>([]);
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [datasetTargets, setDatasetTargets] = useState<TargetDatasetStatus[]>([]);
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Expanded log tails
  const [expandedLogs, setExpandedLogs] = useState<Record<string, boolean>>({});

  // Filters for Runs Table
  const [platformFilter, setPlatformFilter] = useState<string>("all");
  const [personFilter, setPersonFilter] = useState<string>("all");
  const [methodFilter, setMethodFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Start Form state
  const [selectedMethodId, setSelectedMethodId] = useState<string>("nnunet-3d");
  const [selectedTargetId, setSelectedTargetId] = useState<string>("");
  const [augLevel, setAugLevel] = useState<"low" | "med" | "max">("med");
  const [epochs, setEpochs] = useState<number>(40);
  const [splitMode, setSplitMode] = useState<"5folds" | "holdout">("5folds");
  const [startBusy, setStartBusy] = useState(false);

  // Sync state
  const [selectedSyncTarget, setSelectedSyncTarget] = useState<string>("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [kaggleDatasets, setKaggleDatasets] = useState<import("~/lib/training-advanced/types").KaggleDatasetOption[]>([]);
  const [selectedDatasetOwner, setSelectedDatasetOwner] = useState<string>("");

  // Action Confirmation Modal
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
    if (!isSilent) setRefreshing(true);
    const getJson = (url: string) =>
      fetch(url, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null));

    // 1. Account list from .env: instant, shown first.
    const quickP = getJson("/api/training-advanced/accounts?quick=1")
      .then((j) => {
        if (j?.cards && j.cards.length > 0) {
          setCards((prev) => (prev.length > 0 ? prev : j.cards));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    // 2. Full account checks (slow): replace the list when they finish.
    const accP = getJson("/api/training-advanced/accounts")
      .then((j) => {
        if (j?.cards && j.cards.length > 0) {
          setCards(j.cards);
          if (!selectedTargetId && j.cards.length > 0) setSelectedTargetId(j.cards[0].id);
        }
      })
      .catch((err: any) => { if (!isSilent) toast.error(`Account checks failed: ${err?.message ?? err}`); });

    // 3. Runs, datasets and tasks each fill in on their own.
    const runsP = getJson("/api/training-advanced/runs")
      .then((j) => { if (j?.runs) setRuns(j.runs); })
      .catch(() => {});
    const dataP = getJson("/api/training-advanced/dataset")
      .then((dataJson) => {
        if (!dataJson) return;
        if (dataJson.targets && dataJson.targets.length > 0) {
          setDatasetTargets(dataJson.targets);
        }
        const kds = dataJson.kaggleDatasets || [];
        setKaggleDatasets(kds);
        if (!selectedSyncTarget && dataJson.targets?.length > 0) {
          setSelectedSyncTarget(dataJson.targets[0].targetId);
        }
        if (kds.length > 0) {
          const defaultRoll = dataJson.defaultDatasetOwner || kds.find((k: any) => k.isDefault)?.roll || kds[0].roll;
          setSelectedDatasetOwner((prev) => prev || defaultRoll);
        }
      })
      .catch(() => {});
    const tasksP = getJson("/api/training-advanced/tasks")
      .then((j) => { if (j?.tasks) setTasks(j.tasks); })
      .catch(() => {});

    await Promise.allSettled([quickP, accP, runsP, dataP, tasksP]);
    setRefreshing(false);
  }, [selectedTargetId, selectedSyncTarget]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Polling: every 5s if any job or task is running, otherwise every 15s
  const isAnyJobActive = useMemo(() => {
    const cardActive = cards.some((c) => c.currentJob?.status === "running");
    const taskActive = tasks.some((t) => t.status === "running");
    return cardActive || taskActive;
  }, [cards, tasks]);

  useEffect(() => {
    const interval = setInterval(() => {
      loadData(true);
    }, isAnyJobActive ? 4000 : 15000);
    return () => clearInterval(interval);
  }, [isAnyJobActive, loadData]);

  const toggleLog = (cardId: string) => {
    setExpandedLogs((prev) => ({ ...prev, [cardId]: !prev[cardId] }));
  };

  // Unique list of people who started runs
  const uniquePeople = useMemo(() => {
    const set = new Set<string>();
    runs.forEach((r) => {
      if (r.startedBy?.name) set.add(r.startedBy.name);
      else if (r.startedBy?.usn) set.add(r.startedBy.usn);
    });
    return Array.from(set).sort();
  }, [runs]);

  // Filtered runs
  const filteredRuns = useMemo(() => {
    return runs.filter((r) => {
      if (platformFilter !== "all" && r.platform !== platformFilter) return false;
      if (personFilter !== "all") {
        const nameMatch = r.startedBy?.name?.toLowerCase() === personFilter.toLowerCase();
        const usnMatch = r.startedBy?.usn?.toLowerCase() === personFilter.toLowerCase();
        if (!nameMatch && !usnMatch) return false;
      }
      if (methodFilter !== "all" && r.methodId !== methodFilter) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const m1 = r.methodLabel.toLowerCase().includes(q);
        const m2 = r.account.toLowerCase().includes(q);
        const m3 = (r.startedBy?.name || "").toLowerCase().includes(q);
        const m4 = (r.startedBy?.usn || "").toLowerCase().includes(q);
        if (!m1 && !m2 && !m3 && !m4) return false;
      }
      return true;
    });
  }, [runs, platformFilter, personFilter, methodFilter, statusFilter, searchQuery]);

  // Selected method object
  const currentSelectedMethod = useMemo(() => {
    return METHODS.find((m) => m.id === selectedMethodId) || METHODS[0];
  }, [selectedMethodId]);

  // Selected target object
  const currentSelectedTarget = useMemo(() => {
    return cards.find((c) => c.id === selectedTargetId) || cards[0];
  }, [cards, selectedTargetId]);

  // Handlers
  const handleSyncAllFreeH200 = () => {
    const freeTargets = datasetTargets.filter(
      (t) => t.platform === "h200" && !t.runningJobBlocking
    );

    if (freeTargets.length === 0) {
      toast.info("No idle H200 accounts available to sync (all active accounts are currently training).");
      return;
    }

    const runBatchSync = async (confirmed = false) => {
      setSyncBusy(true);
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
        setSyncBusy(false);
      }
    };

    const isAnyRemote = freeTargets.some((t) => t.isRemoteRoute);
    if (!isAnyRemote) {
      toast.info(`Syncing ${freeTargets.length} free H200 account(s) directly via college network...`);
      runBatchSync(true);
      return;
    }

    const totalBytes = freeTargets.reduce((sum, t) => sum + (t.bytesToSync || 0), 0);
    const sizeStr = totalBytes ? `${(totalBytes / (1024 * 1024)).toFixed(1)} MB` : "estimated data";

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

  const handleStartSubmit = () => {
    if (!currentSelectedTarget) return;

    const warnings: string[] = [];
    if (currentSelectedTarget.platform === "h200" && currentSelectedTarget.isRemoteRoute) {
      warnings.push("Remote Route Warning: You are outside college network. This run goes through pc-server-1 and uses internet/mobile data.");
    }
    if (currentSelectedTarget.platform === "local" && currentSelectedTarget.deviceInfo?.includes("CPU only")) {
      warnings.push("CPU Warning: No usable NVIDIA/Apple GPU detected. Training on CPU is 20-40x slower (hours per fold).");
    }
    if (currentSelectedTarget.platform === "h200" && currentSelectedMethod.needsMib) {
      warnings.push(`VRAM Notice: ${currentSelectedMethod.label} requires ~${Math.round(currentSelectedMethod.needsMib / 1024)} GB VRAM. Slurm allocates 1g.18gb slice.`);
    }

    setConfirmModal({
      open: true,
      title: `Start ${currentSelectedMethod.label}`,
      description: `Target: ${currentSelectedTarget.label} | Platform: ${currentSelectedTarget.platform.toUpperCase()}`,
      warnings,
      actionLabel: "Start Training",
      onConfirm: async () => {
        setStartBusy(true);
        try {
          const res = await fetch("/api/training-advanced/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              platform: currentSelectedTarget.platform,
              targetId: currentSelectedTarget.id,
              methodId: currentSelectedMethod.id,
              datasetOwnerRoll: currentSelectedTarget.platform === "kaggle" ? selectedDatasetOwner : undefined,
              settings: {
                augLevel,
                epochs,
                folds: splitMode === "5folds" ? 5 : 1,
                holdout: splitMode === "holdout",
              },
            }),
          });
          const json = await res.json();
          if (res.ok) {
            toast.success(json.message || "Training job started");
            loadData(true);
          } else {
            toast.error(json.error || "Failed to start training");
          }
        } catch (err: any) {
          toast.error(err.message || "Start request failed");
        } finally {
          setStartBusy(false);
          setConfirmModal((prev) => ({ ...prev, open: false }));
        }
      },
    });
  };

  const handleResume = (card: AccountCard) => {
    const methodId = card.currentJob?.methodId;
    setConfirmModal({
      open: true,
      title: `Resume ${card.currentJob?.methodLabel || "Run"}`,
      description: `Resume on ${card.label}. Note: Training will continue from saved checkpoints.`,
      warnings: [
        "Resume is NOT automatic today: you must explicitly initiate resume once a job hits the time limit.",
      ],
      actionLabel: "Resume Run",
      onConfirm: async () => {
        try {
          const res = await fetch("/api/training-advanced/resume", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              platform: card.platform,
              targetId: card.id,
              methodId,
            }),
          });
          const json = await res.json();
          if (res.ok) {
            toast.success(json.message || "Resume initiated");
            loadData(true);
          } else {
            toast.error(json.error || "Resume failed");
          }
        } catch (err: any) {
          toast.error(err.message || "Resume request failed");
        } finally {
          setConfirmModal((prev) => ({ ...prev, open: false }));
        }
      },
    });
  };

  const handleCancel = (card: AccountCard) => {
    const jobId = card.currentJob?.slurmJobId || (card.currentJob?.pid ? String(card.currentJob.pid) : undefined);
    setConfirmModal({
      open: true,
      title: `Cancel Active Job on ${card.label}`,
      description: `Are you sure you want to cancel the running job (${card.currentJob?.methodLabel || "current job"})?`,
      warnings: [
        "Unsaved epochs since the last checkpoint will be lost.",
      ],
      actionLabel: "Cancel Job",
      onConfirm: async () => {
        try {
          const res = await fetch("/api/training-advanced/cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              platform: card.platform,
              targetId: card.id,
              jobId,
            }),
          });
          const json = await res.json();
          if (res.ok) {
            toast.success(json.message || "Job cancelled");
            loadData(true);
          } else {
            toast.error(json.error || "Cancel failed");
          }
        } catch (err: any) {
          toast.error(err.message || "Cancel request failed");
        } finally {
          setConfirmModal((prev) => ({ ...prev, open: false }));
        }
      },
    });
  };

  const handleSyncDataset = () => {
    const target = datasetTargets.find((t) => t.targetId === selectedSyncTarget);
    if (!target) return;

    if (target.runningJobBlocking) {
      toast.error(
        `Sync Refused: ${target.runningJobBlocking.method} is currently running on ${target.label}. Updating data while a run is in progress would corrupt it.`
      );
      return;
    }

    const executeSync = async (confirmed = false) => {
      setSyncBusy(true);
      try {
        const res = await fetch("/api/training-advanced/dataset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetId: target.targetId, confirmed }),
        });
        const json = await res.json();
        if (res.ok) {
          if (json.requiresConfirmation) {
            // Internet route requires confirmation
            const sizeStr = json.formattedSize || (target.bytesToSync ? `${(target.bytesToSync / (1024 * 1024)).toFixed(1)} MB` : "data");
            setConfirmModal({
              open: true,
              title: target.platform === "h200" ? "Confirm Internet Data Sync to H200" : "Confirm Kaggle Dataset Upload",
              description: `Target: ${target.label}`,
              warnings: [
                target.platform === "h200"
                  ? "H200 is connected through the Internet via jump host (pc-server-1)."
                  : "Uploading dataset to Kaggle over your internet connection.",
                `Data transfer size: ~${sizeStr}. This will consume your mobile / internet data!`,
                target.platform === "h200" ? "On direct college Wi-Fi / LAN, no internet data is used and no confirmation is needed." : "On metered connections, wait for high-speed Wi-Fi.",
              ],
              actionLabel: "Confirm & Proceed",
              onConfirm: async () => {
                setConfirmModal((prev) => ({ ...prev, open: false }));
                await executeSync(true);
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
        setSyncBusy(false);
      }
    };

    // 1. Direct local network H200:
    // Instruction: "So ,, if itsgetting connected Direct by local network itself then no need to have this Confirmation ,..."
    if (target.platform === "h200" && !target.isRemoteRoute) {
      toast.info("Syncing directly over local college network (no internet data used)...");
      executeSync(true);
      return;
    }

    // 2. Internet route H200:
    if (target.platform === "h200" && target.isRemoteRoute) {
      const sizeStr = target.bytesToSync ? `${(target.bytesToSync / (1024 * 1024)).toFixed(1)} MB` : "estimated data";
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
          await executeSync(true);
        },
      });
      return;
    }

    // 3. Kaggle target:
    if (target.platform === "kaggle") {
      const sizeStr = target.bytesToSync ? `${(target.bytesToSync / (1024 * 1024)).toFixed(1)} MB` : "dataset";
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
          await executeSync(true);
        },
      });
      return;
    }

    // Local
    executeSync(true);
  };

  if (loading) {
    return (
      <div className="flex h-[70vh] flex-col items-center justify-center space-y-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm font-medium text-muted-foreground">
          Loading compute accounts, runs, and platform states...
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
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-xs font-bold text-primary-foreground shadow-xs transition-all"
          >
            <Radio className="h-3.5 w-3.5" />
            Compute &amp; Training
          </Link>
          <Link
            href="/training/advanced/data"
            className="inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-accent hover:text-foreground transition-all"
          >
            <Database className="h-3.5 w-3.5 text-primary" />
            Dataset &amp; Sync Hub
            {tasks.some((t) => t.status === "running") && (
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

      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Training (Advanced)
            </h1>
            <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
              Local Mode
            </span>
            {isAnyJobActive && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Active Workload
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Visual control center for all compute accounts across College H200, Kaggle slots, and This PC.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/training/advanced/data"
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-semibold text-muted-foreground transition-all hover:bg-accent hover:text-foreground cursor-pointer"
          >
            <Database className="h-3.5 w-3.5 text-primary" />
            Dataset Sync Center
          </Link>
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

      {/* SECTION 1: COMPUTE ACCOUNTS & LIVE JOBS */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-bold tracking-tight">Compute Accounts &amp; Current Jobs</h2>
          </div>
          <div className="text-xs text-muted-foreground">
            {cards.length} account slot(s) configured in .env
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {cards.map((card) => {
            const job = card.currentJob;
            const isH200 = card.platform === "h200";
            const isKaggle = card.platform === "kaggle";
            const isLocal = card.platform === "local";
            const isExpanded = Boolean(expandedLogs[card.id]);

            return (
              <div
                key={card.id}
                className="flex flex-col rounded-2xl border border-border/70 bg-card p-5 shadow-sm transition-all hover:border-border"
              >
                {/* Card Top: Platform & Connection */}
                <div className="flex items-start justify-between gap-3 border-b border-border/50 pb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      {isH200 && <Server className="h-4 w-4 text-purple-500" />}
                      {isKaggle && <Cloud className="h-4 w-4 text-sky-500" />}
                      {isLocal && <Cpu className="h-4 w-4 text-amber-500" />}
                      <span className="font-bold text-foreground text-sm">{card.label}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground font-mono">
                      {card.accountName}
                    </p>
                  </div>

                  <div className="text-right">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        (card as { checking?: boolean }).checking
                          ? "bg-muted text-muted-foreground"
                          : card.connected
                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          : "bg-destructive/10 text-destructive"
                      }`}
                    >
                      {(card as { checking?: boolean }).checking ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Checking
                        </>
                      ) : card.connected ? (
                        <>
                          <CheckCircle2 className="h-3 w-3" />
                          Connected
                        </>
                      ) : (
                        <>
                          <XCircle className="h-3 w-3" />
                          Unreachable
                        </>
                      )}
                    </span>
                    {!card.connected && !(card as { checking?: boolean }).checking && (
                      <button
                        type="button"
                        onClick={() => { void loadData(); }}
                        disabled={refreshing}
                        className="mt-1.5 block w-full rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                      >
                        {refreshing ? "Checking..." : "Retry"}
                      </button>
                    )}
                  </div>
                </div>

                {/* Connection details / route */}
                <div className="mt-2.5 text-[11px] text-muted-foreground bg-muted/30 rounded-lg p-2 font-mono">
                  {card.connectionDetails}
                </div>

                {/* Job State & Details */}
                <div className="mt-4 flex-1 space-y-3">
                  {job && job.status !== "idle" ? (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Job: {job.methodLabel || job.methodId}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                            job.status === "running"
                              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                              : job.status === "stopped" || job.status === "incomplete"
                              ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                              : job.status === "finished"
                              ? "bg-primary/10 text-primary"
                              : "bg-destructive/10 text-destructive"
                          }`}
                        >
                          {job.status === "running" && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />}
                          {job.status === "stopped" ? "Stopped at 4h limit" : job.status}
                        </span>
                      </div>

                      {/* Explicit Notice on H200 resume */}
                      {isH200 && (
                        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-2.5 text-[11px] text-amber-700 dark:text-amber-300">
                          <p className="font-semibold">Notice on Resume:</p>
                          <p className="mt-0.5">
                            Today resume is <strong>NOT automatic</strong>; you must press Resume below (or run the same method again).
                          </p>
                        </div>
                      )}

                      {/* Run Metadata */}
                      <div className="grid grid-cols-2 gap-2 text-xs bg-muted/20 rounded-xl p-2.5">
                        <div>
                          <span className="text-[10px] uppercase font-semibold text-muted-foreground block">Started By</span>
                          <span className="font-medium text-foreground">
                            {job.startedBy?.name || job.startedBy?.usn || "Teammate"}
                          </span>
                        </div>
                        <div>
                          <span className="text-[10px] uppercase font-semibold text-muted-foreground block">Platform / Account</span>
                          <span className="font-medium text-foreground">
                            {card.platform.toUpperCase()} ({card.accountName})
                          </span>
                        </div>
                        <div>
                          <span className="text-[10px] uppercase font-semibold text-muted-foreground block">Started At</span>
                          <span className="font-medium text-foreground">
                            {job.startedAt ? new Date(job.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-"}
                          </span>
                        </div>
                        <div>
                          <span className="text-[10px] uppercase font-semibold text-muted-foreground block">Elapsed Time</span>
                          <span className="font-medium text-foreground">
                            {fmtDuration(job.elapsedSeconds)}
                          </span>
                        </div>
                      </div>

                      {/* Progress Bar & ETA */}
                      {job.progress && (
                        <div className="space-y-1.5 pt-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-semibold text-foreground">
                              {job.progress.percent}% done
                              {job.progress.currentFold !== undefined && (
                                <span className="text-muted-foreground font-normal ml-1.5">
                                  (Fold {job.progress.currentFold + 1}/{job.progress.totalFolds})
                                </span>
                              )}
                            </span>
                            <span className="text-muted-foreground tabular-nums">
                              {job.progress.etaSeconds ? `~${fmtDuration(job.progress.etaSeconds)} left` : "Estimating..."}
                            </span>
                          </div>
                          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-primary transition-all duration-500"
                              style={{ width: `${job.progress.percent}%` }}
                            />
                          </div>
                        </div>
                      )}

                      {/* Log Tail Box */}
                      {job.logTail && job.logTail.length > 0 && (
                        <div className="space-y-1 pt-1">
                          <button
                            onClick={() => toggleLog(card.id)}
                            className="flex w-full items-center justify-between text-[11px] font-semibold text-muted-foreground hover:text-foreground cursor-pointer"
                          >
                            <span className="inline-flex items-center gap-1">
                              <Terminal className="h-3 w-3" /> Live Log Tail
                            </span>
                            {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                          </button>
                          {isExpanded && (
                            <pre className="max-h-48 overflow-y-auto rounded-xl bg-muted/60 p-2.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
                              {job.logTail.join("\n")}
                            </pre>
                          )}
                        </div>
                      )}

                      {/* Action buttons on card: Resume / Cancel */}
                      <div className="flex items-center gap-2 pt-2 border-t border-border/40">
                        {job.resumePending && (
                          <button
                            onClick={() => handleResume(card)}
                            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-amber-500/20 px-3 py-2 text-xs font-bold text-amber-700 dark:text-amber-300 hover:bg-amber-500/30 transition-all cursor-pointer"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            {isKaggle ? "Continue (--continue-previous)" : "Resume"}
                          </button>
                        )}
                        {job.status === "running" && (
                          <button
                            onClick={() => handleCancel(card)}
                            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-bold text-destructive hover:bg-destructive/20 transition-all cursor-pointer"
                          >
                            <Square className="h-3.5 w-3.5" />
                            Cancel
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="flex h-32 flex-col items-center justify-center rounded-xl border border-dashed border-border/60 text-center p-4">
                      <p className="text-xs text-muted-foreground">No active training job on this account.</p>
                      <span className="mt-1 text-[11px] text-muted-foreground/60">
                        Use the Start section below to launch a job.
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* SECTION 2: RUNS TABLE */}
      <div className="space-y-4 rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-bold tracking-tight">Runs Table (All Platforms)</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Historical and active runs across College H200, Kaggle slots, and This PC with validation metrics.
            </p>
          </div>
          <span className="text-xs font-semibold text-muted-foreground">
            Showing {filteredRuns.length} of {runs.length} run(s)
          </span>
        </div>

        {/* Filters */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5 border-y border-border/50 py-3.5">
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground block mb-1">
              Platform
            </label>
            <select
              value={platformFilter}
              onChange={(e) => setPlatformFilter(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-medium cursor-pointer"
            >
              <option value="all">All Platforms</option>
              <option value="h200">College H200</option>
              <option value="kaggle">Kaggle</option>
              <option value="local">This PC</option>
            </select>
          </div>

          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground block mb-1">
              Person
            </label>
            <select
              value={personFilter}
              onChange={(e) => setPersonFilter(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-medium cursor-pointer"
            >
              <option value="all">All Teammates</option>
              {uniquePeople.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground block mb-1">
              Method
            </label>
            <select
              value={methodFilter}
              onChange={(e) => setMethodFilter(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-medium cursor-pointer"
            >
              <option value="all">All Methods</option>
              {METHODS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground block mb-1">
              Status
            </label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-medium cursor-pointer"
            >
              <option value="all">All Statuses</option>
              <option value="running">Running</option>
              <option value="finished">Finished</option>
              <option value="stopped">Stopped / Limit</option>
              <option value="incomplete">Incomplete</option>
              <option value="failed">Failed</option>
            </select>
          </div>

          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground block mb-1">
              Search
            </label>
            <input
              type="text"
              placeholder="Search method, account..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-medium"
            />
          </div>
        </div>

        {/* Table Container */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/40 text-[10px] uppercase tracking-wider font-bold text-muted-foreground border-b border-border">
              <tr>
                <th className="px-3.5 py-3">Method</th>
                <th className="px-3 py-3">Dataset Ver</th>
                <th className="px-3 py-3">Scans</th>
                <th className="px-3 py-3">Folds</th>
                <th className="px-3 py-3">Iteration</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Started</th>
                <th className="px-3 py-3">Started By</th>
                <th className="px-3 py-3">Where</th>
                <th className="px-3 py-3">Account</th>
                <th className="px-3 py-3 font-bold text-foreground">Edema Dice*</th>
                <th className="px-3 py-3">Bone Dice</th>
                <th className="px-3 py-3">Lesion Sens*</th>
                <th className="px-3 py-3">FP / case</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40 font-medium">
              {filteredRuns.length > 0 ? (
                filteredRuns.map((r) => (
                  <tr key={r.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-3.5 py-3 font-semibold text-foreground whitespace-nowrap">
                      {r.methodLabel}
                    </td>
                    <td className="px-3 py-3 font-mono text-[11px] text-muted-foreground">
                      {r.datasetVersion}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      {r.nCases}
                      {r.bmeCount != null && (
                        <span className="text-muted-foreground text-[10px] ml-1">
                          ({r.bmeCount} BME)
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-muted-foreground">
                      {r.folds}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <span className="rounded bg-muted px-2 py-0.5 text-[11px]">
                        {r.iteration}
                      </span>
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          r.status === "finished"
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : r.status === "running"
                            ? "bg-sky-500/10 text-sky-600 dark:text-sky-400"
                            : r.status === "stopped" || r.status === "incomplete"
                            ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                            : "bg-destructive/10 text-destructive"
                        }`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap tabular-nums" title={r.startedAt ? new Date(r.startedAt).toLocaleString() : undefined}>
                      {r.startedAt
                        ? new Date(r.startedAt).toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
                        : "-"}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      {r.startedBy?.name || r.startedBy?.usn || "-"}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <span className="rounded-md border border-border/60 bg-muted/30 px-2 py-0.5 text-[10px]">
                        {r.platformLabel}
                      </span>
                    </td>
                    <td className="px-3 py-3 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                      {r.account}
                    </td>
                    <td className="px-3 py-3 font-bold text-foreground tabular-nums whitespace-nowrap">
                      {fmtMetric(r.metrics?.bmeDicePos)}
                    </td>
                    <td className="px-3 py-3 tabular-nums text-muted-foreground whitespace-nowrap">
                      {fmtMetric(r.metrics?.boneDice)}
                    </td>
                    <td className="px-3 py-3 tabular-nums text-muted-foreground whitespace-nowrap">
                      {fmtMetric(r.metrics?.lesionSensitivityPos)}
                    </td>
                    <td className="px-3 py-3 tabular-nums text-muted-foreground whitespace-nowrap">
                      {fmtMetric(r.metrics?.fpPerCase)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={13} className="py-8 text-center text-xs text-muted-foreground">
                    No runs match the selected filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-muted-foreground pt-1">
          * on scans that have edema. Edema Dice over all scans looks higher because clean scans score 1.0. Compare runs within a platform: H200, Kaggle, and laptop setups use different configs.
        </p>
      </div>

      {/* SECTION 3: START A RUN & DATASET SYNC */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Start a Run Form */}
        <div className="lg:col-span-2 space-y-4 rounded-2xl border border-border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <Play className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-bold tracking-tight">Start a Run</h2>
          </div>
          <p className="text-xs text-muted-foreground">
            Configure and launch any of the 9 comparison methods across College H200, Kaggle, or This PC.
          </p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 pt-2">
            {/* Pick Method */}
            <div className="sm:col-span-2">
              <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
                1. Select Method (The 9 Methods)
              </label>
              <select
                value={selectedMethodId}
                onChange={(e) => setSelectedMethodId(e.target.value)}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold cursor-pointer"
              >
                {METHODS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.n}. {m.label} ({m.where.toUpperCase()})
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Tests: {currentSelectedMethod.tests}
              </p>
            </div>

            {/* Pick Target */}
            <div className="sm:col-span-2">
              <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
                2. Select Execution Target
              </label>
              <select
                value={selectedTargetId}
                onChange={(e) => setSelectedTargetId(e.target.value)}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold cursor-pointer"
              >
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} ({c.platform.toUpperCase()}) {c.connected ? "— Ready" : "— Unreachable"}
                  </option>
                ))}
              </select>
            </div>

            {/* Dataset selection for Kaggle / Server info for H200 */}
            {currentSelectedTarget?.platform === "kaggle" && (
              <div className="sm:col-span-2">
                <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
                  3. Kaggle Dataset Source (Account)
                </label>
                {kaggleDatasets.length === 0 ? (
                  <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                    <p className="font-bold">No Uploaded Dataset Found</p>
                    <p className="text-[11px] mt-0.5">
                      No Kaggle account has an uploaded, non-empty dataset yet. Upload or sync the dataset in the Dataset Sync box below first before launching training.
                    </p>
                  </div>
                ) : (
                  <select
                    value={selectedDatasetOwner}
                    onChange={(e) => setSelectedDatasetOwner(e.target.value)}
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold cursor-pointer"
                  >
                    {kaggleDatasets.map((kd) => (
                      <option key={kd.roll} value={kd.roll}>
                        {kd.label}{kd.isDefault ? " [Default Owner]" : ""} — {kd.caseCount} scans {kd.uploadedAt ? `(Updated: ${new Date(kd.uploadedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })})` : ""}
                      </option>
                    ))}
                  </select>
                )}
                {kaggleDatasets.length > 0 && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Select which teammate&apos;s uploaded private Kaggle dataset will be mounted into this training session.
                  </p>
                )}
              </div>
            )}

            {currentSelectedTarget?.platform === "h200" && (
              <div className="sm:col-span-2 rounded-xl border border-border/50 bg-muted/20 px-3.5 py-2.5 text-xs text-muted-foreground flex items-center justify-between">
                <div>
                  <span className="font-semibold text-foreground">H200 Dataset Source:</span>
                  <p className="text-[11px] mt-0.5">Uses server repository copy on this H200 student account.</p>
                </div>
                <span className="font-mono text-[11px] bg-background/80 px-2 py-0.5 rounded-md border border-border/60">
                  ~/bme/data
                </span>
              </div>
            )}

            {/* Augmentation Level */}
            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
                Augmentation Level
              </label>
              <select
                value={augLevel}
                onChange={(e) => setAugLevel(e.target.value as any)}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold cursor-pointer"
              >
                <option value="low">Low (mild gamma, +-15 deg, 10% patches)</option>
                <option value="med">Medium (nnU-Net strength, +-30 deg, 20% patches)</option>
                <option value="max">Max (same + noise, 30-50% patches)</option>
              </select>
            </div>

            {/* Validation Split */}
            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
                Validation Split
              </label>
              <select
                value={splitMode}
                onChange={(e) => setSplitMode(e.target.value as any)}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold cursor-pointer"
              >
                <option value="5folds">5-Fold Patient Cross-Validation</option>
                <option value="holdout">Fixed 80/20 Holdout Split</option>
              </select>
            </div>

            {/* Epochs */}
            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
                Epochs
              </label>
              <input
                type="number"
                min={1}
                max={200}
                value={epochs}
                onChange={(e) => setEpochs(Number(e.target.value))}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold"
              />
            </div>
          </div>

          {/* Confirmations & Start Button */}
          <div className="pt-3 border-t border-border/50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <Info className="h-4 w-4 shrink-0 text-primary" />
              <span>Full metadata (`startedBy`, `platform`, `account`, `host`, `startedAt`) recorded automatically.</span>
            </div>
            <button
              onClick={handleStartSubmit}
              disabled={startBusy || !currentSelectedTarget?.connected || (currentSelectedTarget?.platform === "kaggle" && kaggleDatasets.length === 0)}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-xs font-bold text-primary-foreground hover:bg-primary/90 transition-all cursor-pointer disabled:opacity-40"
            >
              {startBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Start Run
            </button>
          </div>
        </div>

        {/* Dataset Sync Box */}
        <div className="space-y-4 rounded-2xl border border-border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-bold tracking-tight">Dataset Sync</h2>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Sync training data to the latest de-identified export. Refuses automatically if any training run is active on the target.
          </p>

          <div className="space-y-3 pt-2">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground block">
                  Sync Target
                </label>
                {datasetTargets.some((t) => t.platform === "h200") && (
                  <button
                    type="button"
                    onClick={handleSyncAllFreeH200}
                    disabled={syncBusy || !datasetTargets.some((t) => t.platform === "h200" && !t.runningJobBlocking)}
                    className="text-[11px] font-semibold text-primary hover:underline inline-flex items-center gap-1 cursor-pointer disabled:opacity-40"
                  >
                    <RefreshCw className="h-3 w-3" />
                    Sync All Free H200 ({datasetTargets.filter((t) => t.platform === "h200" && !t.runningJobBlocking).length} idle)
                  </button>
                )}
              </div>
              <select
                value={selectedSyncTarget}
                onChange={(e) => setSelectedSyncTarget(e.target.value)}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold cursor-pointer"
              >
                {datasetTargets.map((t) => (
                  <option key={t.targetId} value={t.targetId}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Target Status Card */}
            {(() => {
              const currentT = datasetTargets.find((t) => t.targetId === selectedSyncTarget);
              if (!currentT) return null;

              const isKaggle = currentT.platform === "kaggle";
              const isH200 = currentT.platform === "h200";

              return (
                <div className="rounded-xl border border-border/70 bg-muted/20 p-3.5 space-y-2.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground font-semibold">Target Status:</span>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        currentT.isUpToDate
                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                      }`}
                    >
                      {currentT.isUpToDate ? "Up to date" : currentT.isEmpty ? "Not uploaded yet" : "Update available"}
                    </span>
                  </div>

                  {isH200 && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground font-semibold">Connection Route:</span>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          currentT.isRemoteRoute
                            ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                            : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        }`}
                      >
                        {currentT.isRemoteRoute ? "Internet Route (pc-server-1)" : "College Network (Direct)"}
                      </span>
                    </div>
                  )}

                  {isH200 && currentT.isRemoteRoute && (
                    <p className="text-[11px] text-amber-700 dark:text-amber-300">
                      Connected through pc-server-1. Copies use internet data (~{currentT.bytesToSync ? (currentT.bytesToSync / (1024 * 1024)).toFixed(1) + " MB" : "data"}) and prompt for confirmation.
                    </p>
                  )}

                  {isH200 && !currentT.isRemoteRoute && (
                    <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
                      Connected directly via local college network. Sync transfers without using internet data (no confirmation needed).
                    </p>
                  )}

                  {isKaggle && (
                    <div className="space-y-1 text-[11px] text-muted-foreground">
                      <div>
                        Last Uploaded:{" "}
                        <span className="font-semibold text-foreground">
                          {currentT.lastUpdated
                            ? new Date(currentT.lastUpdated).toLocaleDateString("en-IN", {
                                day: "numeric",
                                month: "short",
                                year: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "Never (Dataset is empty)"}
                        </span>
                      </div>
                      <div>
                        Status: <span className="text-foreground">{currentT.reason || "Checked"}</span>
                      </div>
                    </div>
                  )}

                  <div className="text-[11px] text-muted-foreground space-y-1">
                    <div>Local Export: <span className="font-mono text-foreground">{currentT.localExportVersion}</span></div>
                    {currentT.casesCount && (
                      <div>Cases: <span className="font-semibold text-foreground">{currentT.casesCount} scans</span> ({currentT.filesCount} files)</div>
                    )}
                  </div>

                  {currentT.runningJobBlocking && (
                    <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
                      <p className="font-bold">Sync Blocked:</p>
                      <p>
                        A training run ({currentT.runningJobBlocking.method}) is currently running on this target. Sync is disabled until it finishes to prevent data corruption.
                      </p>
                    </div>
                  )}

                  <button
                    onClick={handleSyncDataset}
                    disabled={
                      syncBusy ||
                      Boolean(currentT.runningJobBlocking) ||
                      (isKaggle && currentT.isUpToDate)
                    }
                    className="w-full mt-2 inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-3.5 py-2 text-xs font-bold text-primary-foreground hover:bg-primary/90 transition-all cursor-pointer disabled:opacity-40"
                  >
                    {syncBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <HardDrive className="h-3.5 w-3.5" />
                    )}
                    {isKaggle
                      ? currentT.isUpToDate
                        ? "Kaggle Dataset Up to Date"
                        : currentT.isEmpty
                        ? "Upload Dataset to Kaggle (First Time)"
                        : "Update Kaggle Dataset"
                      : isH200 && currentT.isRemoteRoute
                      ? "Sync Target Over Internet"
                      : "Sync Target to Latest"}
                  </button>
                </div>
              );
            })()}
          </div>
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
