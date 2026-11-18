"use client";

import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Flame,
  Layers,
  Maximize2,
  RefreshCw,
  Search,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";
import { TrainingTabs } from "../components/TrainingTabs";
import { LogModal, TerminalBox, type LogTarget } from "../components/TerminalView";

import type {
  H200Run,
  H200RunPart,
  H200RunResult,
  H200RunsResponse,
  MetricSummary,
} from "~/lib/training-advanced/types";

interface AccountError {
  roll: string;
  error: string;
}

// Module-level cache so returning to this tab displays cached runs instantly
const runsCache: {
  runs: H200Run[];
  errors: AccountError[];
  loaded: boolean;
  lastFetched: number;
} = {
  runs: [],
  errors: [],
  loaded: false,
  lastFetched: 0,
};

function parseToIST(str?: string | null): Date | null {
  if (!str) return null;
  const s = str.trim();
  if (!s || s === "Unknown" || s === "N/A") return null;
  if (/Z|[+-]\d{2}:?\d{2}$/i.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const norm = s.replace(" ", "T");
  const d = new Date(`${norm}+05:30`);
  return isNaN(d.getTime()) ? new Date(s) : d;
}

function formatDate(isoStr?: string | null): string {
  if (!isoStr) return "-";
  try {
    const d = parseToIST(isoStr);
    if (!d || isNaN(d.getTime())) return isoStr;
    const day = d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric" });
    const month = d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", month: "short" });
    const timeStr = d
      .toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
      .toLowerCase();
    return `${day} ${month}, ${timeStr}`;
  } catch {
    return isoStr;
  }
}

function fmtMetric(summary?: MetricSummary | null, decimals = 3): string {
  if (!summary || summary.mean == null) return "-";
  const m = summary.mean.toFixed(decimals);
  if (summary.std != null) {
    return `${m} ± ${summary.std.toFixed(decimals)}`;
  }
  return m;
}

function statusPillClasses(status: string) {
  const s = status.toLowerCase();
  if (s === "running") {
    return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  }
  if (s === "queued" || s === "pending") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  if (s === "finished" || s === "completed") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (s === "part ended" || s === "stopped" || s === "incomplete") {
    return "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300";
  }
  if (s === "failed") {
    return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  }
  return "border-border bg-muted/30 text-muted-foreground";
}

function statusDotClass(status: string) {
  const s = status.toLowerCase();
  if (s === "running") return "bg-sky-500";
  if (s === "queued" || s === "pending") return "bg-amber-500";
  if (s === "finished" || s === "completed") return "bg-emerald-500";
  if (s === "part ended" || s === "stopped" || s === "incomplete") return "bg-amber-500";
  if (s === "failed") return "bg-red-500";
  return "bg-muted-foreground";
}

function slurmStateBadge(state?: string) {
  const s = (state || "").toUpperCase();
  if (s === "COMPLETED") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (s === "RUNNING") {
    return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  }
  if (s === "PENDING") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  if (s.includes("TIMEOUT")) {
    return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  if (s.includes("CANCELLED")) {
    return "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300";
  }
  if (s.includes("FAIL")) {
    return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  }
  return "border-border bg-muted/40 text-muted-foreground";
}

type FilterType = "all" | "running" | "part ended" | "finished";

function RunsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlRunId = searchParams.get("run");

  const [runs, setRuns] = useState<H200Run[]>(runsCache.runs);
  const [errors, setErrors] = useState<AccountError[]>(runsCache.errors);
  const [loading, setLoading] = useState(!runsCache.loaded);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [secondsAgo, setSecondsAgo] = useState<number>(0);

  const [filter, setFilter] = useState<FilterType>("all");
  const [search, setSearch] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(urlRunId || null);

  // Per-part log viewer states
  const [selectedPartIndex, setSelectedPartIndex] = useState<number>(0);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logFile, setLogFile] = useState<string>("");
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [linesToFetch, setLinesToFetch] = useState<number>(50);
  const [loadingMoreLogs, setLoadingMoreLogs] = useState(false);

  // Full Log Modal target
  const [fullLogTarget, setFullLogTarget] = useState<LogTarget | null>(null);

  // Clipboard copy tracker
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Terminal scroll preservation
  const terminalRef = useRef<HTMLDivElement>(null);
  const prevScrollHeightRef = useRef<number>(0);
  const prevScrollTopRef = useRef<number>(0);

  const fetchRuns = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    setFetchError(null);
    try {
      const res = await fetch("/api/training-advanced/runs-h200", { cache: "no-store" });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Failed to fetch runs (${res.status})`);
      }
      const data = await res.json();
      const fetchedRuns: H200Run[] = Array.isArray(data.runs) ? data.runs : [];
      const fetchedErrors: AccountError[] = Array.isArray(data.errors) ? data.errors : [];

      runsCache.runs = fetchedRuns;
      runsCache.errors = fetchedErrors;
      runsCache.loaded = true;
      runsCache.lastFetched = Date.now();

      setRuns(fetchedRuns);
      setErrors(fetchedErrors);
      setSecondsAgo(0);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load runs";
      setFetchError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    void fetchRuns(runsCache.loaded);
  }, [fetchRuns]);

  // Live "Updated N s ago" counter
  useEffect(() => {
    const timer = setInterval(() => {
      if (runsCache.lastFetched > 0) {
        setSecondsAgo(Math.floor((Date.now() - runsCache.lastFetched) / 1000));
      } else {
        setSecondsAgo((s) => s + 1);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Filter and search
  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      const s = (run.status || "").toLowerCase();
      if (filter === "running" && !(s === "running" || s === "queued" || s === "pending")) {
        return false;
      }
      if (filter === "part ended" && !(s === "part ended" || s === "stopped" || s === "incomplete")) {
        return false;
      }
      if (filter === "finished" && !(s === "finished" || s === "completed")) {
        return false;
      }

      if (search.trim()) {
        const query = search.toLowerCase();
        const matchLabel = (run.label || "").toLowerCase().includes(query);
        const matchAccount = (run.accountLabel || "").toLowerCase().includes(query);
        const matchRoll = (run.roll || "").toLowerCase().includes(query);
        const matchMethod = (run.methodId || "").toLowerCase().includes(query);
        const matchStartedBy = (run.startedBy?.name || "").toLowerCase().includes(query);
        if (!matchLabel && !matchAccount && !matchRoll && !matchMethod && !matchStartedBy) {
          return false;
        }
      }

      return true;
    });
  }, [runs, filter, search]);

  // Sync selectedRunId with URL parameter and default selection
  useEffect(() => {
    if (urlRunId) {
      if (selectedRunId !== urlRunId) {
        setSelectedRunId(urlRunId);
      }
    } else if (filteredRuns.length > 0 && !selectedRunId) {
      setSelectedRunId(filteredRuns[0].id);
    }
  }, [urlRunId, filteredRuns, selectedRunId]);

  const activeRun = useMemo(() => {
    return runs.find((r) => r.id === selectedRunId) || filteredRuns[0] || null;
  }, [runs, selectedRunId, filteredRuns]);

  // When active run changes, default to its latest part and reset log pagination
  useEffect(() => {
    if (activeRun && activeRun.parts.length > 0) {
      setSelectedPartIndex(activeRun.parts.length - 1);
      setLinesToFetch(50);
      setLogLines([]);
      setLogFile("");
      setLogError(null);
    }
  }, [activeRun?.id]);

  const activePart: H200RunPart | null = useMemo(() => {
    if (!activeRun || activeRun.parts.length === 0) return null;
    return activeRun.parts[selectedPartIndex] ?? activeRun.parts[activeRun.parts.length - 1] ?? null;
  }, [activeRun, selectedPartIndex]);

  // Fetch per-part log
  const fetchPartLog = useCallback(
    async (roll: string, jobId: string, linesCount: number, isPaging = false) => {
      if (!jobId) return;
      if (isPaging) {
        setLoadingMoreLogs(true);
      } else {
        setLogLoading(true);
      }
      setLogError(null);

      try {
        const res = await fetch(
          `/api/training-advanced/log?platform=h200&targetId=h200-${roll}&jobId=${encodeURIComponent(jobId)}&lines=${linesCount}`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Failed to load log");
        }
        setLogFile(data.file || "");
        setLogLines(Array.isArray(data.lines) ? data.lines : []);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to load log";
        setLogError(msg);
      } finally {
        setLogLoading(false);
        setLoadingMoreLogs(false);
      }
    },
    [],
  );

  // Trigger log fetch when active part or linesToFetch changes
  useEffect(() => {
    if (!activeRun || !activePart) {
      setLogLines([]);
      return;
    }
    const jobId = activePart.jobId || activePart.slurmJobId;
    if (jobId) {
      const isPaging = linesToFetch > 50;
      void fetchPartLog(activeRun.roll, jobId, linesToFetch, isPaging);
    } else {
      setLogLines(["# No Slurm Job ID recorded for this part yet."]);
    }
  }, [activeRun?.roll, activePart?.jobId, activePart?.slurmJobId, linesToFetch, fetchPartLog]);

  // Maintain scroll position when paging lines up
  useLayoutEffect(() => {
    if (loadingMoreLogs && terminalRef.current) {
      const el = terminalRef.current;
      const heightDiff = el.scrollHeight - prevScrollHeightRef.current;
      el.scrollTop = heightDiff + prevScrollTopRef.current;
      setLoadingMoreLogs(false);
    }
  }, [logLines, loadingMoreLogs]);

  // Handle scroll inside terminal for paging up
  const handleTerminalScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop <= 20 && !logLoading && !loadingMoreLogs && logLines.length >= linesToFetch) {
      prevScrollHeightRef.current = el.scrollHeight;
      prevScrollTopRef.current = el.scrollTop;
      setLinesToFetch((prev) => prev + 50);
    }
  };

  const selectRun = (run: H200Run) => {
    setSelectedRunId(run.id);
    router.replace(`/training/advanced/runs?run=${encodeURIComponent(run.id)}`, { scroll: false });
  };

  const copyToClipboard = async (text: string, key: string, label = "Copied") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      toast.success(label);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  return (
    <div className="space-y-6 pb-12">
      {/* 1. Unified Tab Bar */}
      <TrainingTabs
        right={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void fetchRuns(false)}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent transition-colors disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </button>
            <span className="text-[11px] text-muted-foreground whitespace-nowrap tabular-nums">
              {secondsAgo < 5 ? "just now" : `${secondsAgo}s ago`}
            </span>
          </div>
        }
      />

      {/* 2. Unreachable Accounts Banner */}
      {errors.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-800 dark:text-amber-200 space-y-1">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>Unreachable Cluster Node Notice</span>
          </div>
          <div className="pl-6 space-y-0.5">
            {errors.map((err) => (
              <p key={err.roll}>
                Account <span className="font-mono font-semibold">{err.roll}</span> is currently unreachable via SSH (
                {err.error}). Existing runs on reachable nodes remain visible below.
              </p>
            ))}
          </div>
        </div>
      )}

      {/* 3. Fetch Error Banner */}
      {fetchError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3.5 text-xs text-red-800 dark:text-red-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{fetchError}</span>
          </div>
          <button
            type="button"
            onClick={() => void fetchRuns(false)}
            className="rounded border border-red-500/40 bg-red-500/20 px-2.5 py-1 text-[11px] font-semibold hover:bg-red-500/30 cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* 4. Master / Detail Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Master List */}
        <div
          className={`lg:col-span-5 space-y-3 ${
            activeRun && "max-lg:hidden" // On small screens when a run is active, show detail (back button returns to list)
          }`}
        >
          {/* Search & Filter Bar */}
          <div className="rounded-2xl border border-border bg-card p-3 space-y-3 shadow-xs">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search model, account, roll..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-xl border border-border bg-background/50 pl-8.5 pr-3 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-hidden focus:ring-1 focus:ring-primary"
              />
            </div>

            {/* Filter Pills */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
              {(["all", "running", "part ended", "finished"] as FilterType[]).map((pill) => (
                <button
                  key={pill}
                  type="button"
                  onClick={() => setFilter(pill)}
                  className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold capitalize transition-all cursor-pointer whitespace-nowrap ${
                    filter === pill
                      ? "bg-primary text-primary-foreground shadow-xs"
                      : "bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {pill}
                  {pill === "all" && ` (${runs.length})`}
                  {pill === "running" &&
                    ` (${runs.filter((r) => ["running", "queued", "pending"].includes((r.status || "").toLowerCase())).length})`}
                  {pill === "part ended" &&
                    ` (${runs.filter((r) => ["part ended", "stopped", "incomplete"].includes((r.status || "").toLowerCase())).length})`}
                  {pill === "finished" &&
                    ` (${runs.filter((r) => ["finished", "completed"].includes((r.status || "").toLowerCase())).length})`}
                </button>
              ))}
            </div>
          </div>

          {/* Runs List Items */}
          <div className="space-y-2">
            {loading ? (
              // Skeletons
              Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="rounded-xl border border-border bg-card p-4 space-y-2.5 animate-pulse"
                >
                  <div className="flex items-center justify-between">
                    <div className="h-4 w-32 bg-muted rounded" />
                    <div className="h-4 w-16 bg-muted rounded-full" />
                  </div>
                  <div className="h-3 w-48 bg-muted rounded" />
                  <div className="flex items-center justify-between pt-1">
                    <div className="h-3 w-20 bg-muted rounded" />
                    <div className="h-3 w-24 bg-muted rounded" />
                  </div>
                </div>
              ))
            ) : filteredRuns.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border bg-card/40 p-8 text-center space-y-2">
                <Flame className="h-8 w-8 text-muted-foreground mx-auto stroke-1" />
                <p className="text-xs font-semibold text-foreground">No training runs match the filter</p>
                <p className="text-[11px] text-muted-foreground">
                  Try clearing the search query or selecting a different status filter.
                </p>
              </div>
            ) : (
              filteredRuns.map((run) => {
                const isSelected = activeRun?.id === run.id;
                const statusBadge = statusPillClasses(run.status);
                const dotColor = statusDotClass(run.status);
                const diceScore = run.result?.bme_dice;

                return (
                  <div
                    key={run.id}
                    onClick={() => selectRun(run)}
                    className={`group relative rounded-xl border p-3.5 transition-all cursor-pointer ${
                      isSelected
                        ? "border-primary bg-primary/5 shadow-xs ring-1 ring-primary/20"
                        : "border-border bg-card hover:border-primary/40 hover:bg-muted/30"
                    }`}
                  >
                    {/* Top Row: Label & Status Badge */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={`h-2 w-2 rounded-full shrink-0 ${dotColor}`} />
                          <h3 className="text-xs font-bold text-foreground truncate group-hover:text-primary transition-colors">
                            {run.label}
                          </h3>
                        </div>
                        <p className="mt-0.5 text-[11px] text-muted-foreground truncate">
                          {run.accountLabel || `H200 - ${run.roll}`}
                          {run.startedBy?.name && ` · ${run.startedBy.name}`}
                        </p>
                      </div>

                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold capitalize shrink-0 ${statusBadge}`}
                      >
                        {run.status}
                      </span>
                    </div>

                    {/* Middle Row: Progress or Metric */}
                    <div className="mt-2.5 pt-2 border-t border-border/50 flex items-center justify-between text-[11px]">
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Clock className="h-3 w-3 shrink-0" />
                        <span className="tabular-nums">{formatDate(run.startedAt)}</span>
                      </div>

                      <div className="flex items-center gap-2 font-mono">
                        <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground font-sans">
                          {run.parts.length} {run.parts.length === 1 ? "part" : "parts"}
                        </span>

                        {diceScore ? (
                          <span className="font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
                            Dice {diceScore.mean.toFixed(3)}
                          </span>
                        ) : run.partial?.foldsDone != null ? (
                          <span className="text-sky-600 dark:text-sky-400 tabular-nums font-sans">
                            {run.partial.foldsDone}/5 folds
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Detail Pane */}
        <div className={`lg:col-span-7 space-y-4 ${!activeRun && "max-lg:hidden"}`}>
          {/* Mobile Back Button */}
          <div className="lg:hidden">
            <button
              type="button"
              onClick={() => {
                setSelectedRunId(null);
                router.replace("/training/advanced/runs", { scroll: false });
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent cursor-pointer"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to runs list
            </button>
          </div>

          {!activeRun ? (
            <div className="rounded-2xl border border-dashed border-border bg-card/40 p-12 text-center space-y-3">
              <Layers className="h-10 w-10 text-muted-foreground mx-auto stroke-1" />
              <h3 className="text-sm font-semibold text-foreground">Select a training run</h3>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                Select any training run from the left pane to view its results, parts timeline, and live SSH Slurm
                execution logs.
              </p>
            </div>
          ) : (
            <>
              {/* Detail Header Card */}
              <div className="rounded-2xl border border-border bg-card p-5 space-y-4 shadow-xs">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`h-2.5 w-2.5 rounded-full ${statusDotClass(activeRun.status)}`} />
                      <h2 className="text-lg font-bold tracking-tight text-foreground">{activeRun.label}</h2>
                      <span
                        className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold capitalize ${statusPillClasses(
                          activeRun.status,
                        )}`}
                      >
                        {activeRun.status}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Method: <span className="font-mono text-foreground">{activeRun.methodId}</span> · Folder:{" "}
                      <span className="font-mono text-foreground">{activeRun.id.split(":")[1] || activeRun.id}</span>
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        copyToClipboard(
                          `pnpm h200 get --as ${activeRun.roll}`,
                          `get-${activeRun.id}`,
                          "Copied pull command",
                        )
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/60 px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent cursor-pointer transition-colors"
                      title="Copy pull command for this run"
                    >
                      {copiedKey === `get-${activeRun.id}` ? (
                        <Check className="h-3 w-3 text-emerald-500" />
                      ) : (
                        <Copy className="h-3 w-3 text-muted-foreground" />
                      )}
                      <span>pnpm h200 get</span>
                    </button>
                  </div>
                </div>

                {/* Metadata Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-border/60 text-xs">
                  <div>
                    <span className="text-[10.5px] text-muted-foreground uppercase tracking-wider font-semibold">
                      Account / Node
                    </span>
                    <p className="font-medium text-foreground mt-0.5">{activeRun.accountLabel || activeRun.roll}</p>
                  </div>
                  <div>
                    <span className="text-[10.5px] text-muted-foreground uppercase tracking-wider font-semibold">
                      Started By
                    </span>
                    <p className="font-medium text-foreground mt-0.5">
                      {activeRun.startedBy?.name || activeRun.startedBy?.usn || "System"}
                    </p>
                  </div>
                  <div>
                    <span className="text-[10.5px] text-muted-foreground uppercase tracking-wider font-semibold">
                      First Started
                    </span>
                    <p className="font-medium text-foreground mt-0.5 tabular-nums">{formatDate(activeRun.startedAt)}</p>
                  </div>
                  <div>
                    <span className="text-[10.5px] text-muted-foreground uppercase tracking-wider font-semibold">
                      Epochs Per Fold
                    </span>
                    <p className="font-medium text-foreground mt-0.5 tabular-nums">
                      {activeRun.epochsPerFold || activeRun.result?.epochs || 100} epochs
                    </p>
                  </div>
                </div>

                {/* Dataset Counts if available */}
                {activeRun.dataset && (
                  <div className="rounded-xl bg-muted/40 p-2.5 text-[11px] flex items-center gap-4 flex-wrap">
                    <span className="font-semibold text-muted-foreground">Dataset manifest:</span>
                    <span>
                      Used:{" "}
                      <strong className="text-foreground tabular-nums">
                        {activeRun.dataset.counts?.used ?? activeRun.dataset.used ?? "-"}
                      </strong>{" "}
                      cases
                    </span>
                    <span>
                      Annotated:{" "}
                      <strong className="text-foreground tabular-nums">
                        {activeRun.dataset.counts?.annotated ?? activeRun.dataset.annotated ?? "-"}
                      </strong>
                    </span>
                    {(activeRun.dataset.counts?.left_out != null || activeRun.dataset.left_out != null) && (
                      <span>
                        Left out:{" "}
                        <strong className="text-foreground tabular-nums">
                          {activeRun.dataset.counts?.left_out ?? activeRun.dataset.left_out}
                        </strong>
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Results Card */}
              {activeRun.result && (
                <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-5 space-y-4 shadow-xs">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-emerald-500" />
                      <h3 className="text-sm font-bold text-foreground">Validation Results (Cross-Fold Mean ± Std)</h3>
                    </div>
                    {activeRun.result.trained_at && (
                      <span className="text-[11px] text-muted-foreground tabular-nums">
                        Finished {formatDate(activeRun.result.trained_at)}
                      </span>
                    )}
                  </div>

                  {/* Primary Scores Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="rounded-xl border border-emerald-500/20 bg-background/80 p-3">
                      <span className="text-[11px] font-semibold text-muted-foreground">Edema Dice</span>
                      <p className="mt-1 text-xl font-bold font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
                        {fmtMetric(activeRun.result.bme_dice)}
                      </p>
                    </div>
                    <div className="rounded-xl border border-border bg-background/80 p-3">
                      <span className="text-[11px] font-semibold text-muted-foreground">Bone Dice</span>
                      <p className="mt-1 text-xl font-bold font-mono tabular-nums text-foreground">
                        {fmtMetric(activeRun.result.bone_dice)}
                      </p>
                    </div>
                    <div className="rounded-xl border border-border bg-background/80 p-3">
                      <span className="text-[11px] font-semibold text-muted-foreground">FP / Case</span>
                      <p className="mt-1 text-xl font-bold font-mono tabular-nums text-foreground">
                        {fmtMetric(activeRun.result.fp_per_case, 2)}
                      </p>
                    </div>
                  </div>

                  {/* Secondary Specs & Download Banner */}
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2 text-xs text-muted-foreground">
                    <div className="flex items-center gap-4">
                      {activeRun.result.n_cases && (
                        <span>
                          Cases: <strong className="text-foreground tabular-nums">{activeRun.result.n_cases}</strong>
                        </span>
                      )}
                      {activeRun.result.folds && (
                        <span>
                          Folds: <strong className="text-foreground tabular-nums">{activeRun.result.folds}</strong>
                        </span>
                      )}
                      {activeRun.result.hours_taken != null && (
                        <span>
                          Compute:{" "}
                          <strong className="text-foreground tabular-nums">
                            {activeRun.result.hours_taken.toFixed(1)} h
                          </strong>
                        </span>
                      )}
                    </div>

                    <div className="rounded-lg border border-border bg-background/70 px-2.5 py-1 font-mono text-[11px] text-foreground flex items-center gap-2">
                      <span>pnpm h200 get --as {activeRun.roll}</span>
                      <button
                        type="button"
                        onClick={() =>
                          copyToClipboard(
                            `pnpm h200 get --as ${activeRun.roll}`,
                            "res-pull",
                            "Copied pull command",
                          )
                        }
                        className="text-muted-foreground hover:text-foreground cursor-pointer"
                        title="Copy command to pull results to this PC"
                      >
                        {copiedKey === "res-pull" ? (
                          <Check className="h-3 w-3 text-emerald-500" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Intermediate/Partial Progress Card (if not fully finished) */}
              {!activeRun.result && activeRun.partial && (
                <div className="rounded-2xl border border-sky-500/30 bg-sky-500/5 p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-sky-500 animate-pulse" />
                    <h3 className="text-xs font-bold text-foreground">Intermediate Progress</h3>
                  </div>
                  <div className="text-xs text-muted-foreground flex items-center gap-4 flex-wrap">
                    {activeRun.partial.foldsDone != null && (
                      <span>
                        Folds completed:{" "}
                        <strong className="text-foreground font-mono tabular-nums">
                          {activeRun.partial.foldsDone} / 5
                        </strong>
                      </span>
                    )}
                    {activeRun.partial.currentFold != null && (
                      <span>
                        Active Fold:{" "}
                        <strong className="text-foreground font-mono tabular-nums">
                          {activeRun.partial.currentFold}
                        </strong>
                      </span>
                    )}
                    {activeRun.partial.currentEpoch != null && (
                      <span>
                        Epoch:{" "}
                        <strong className="text-foreground font-mono tabular-nums">
                          {activeRun.partial.currentEpoch}
                        </strong>
                      </span>
                    )}
                    {activeRun.partial.pseudoDice != null && (
                      <span>
                        Latest Pseudo Dice:{" "}
                        <strong className="text-emerald-600 dark:text-emerald-400 font-mono tabular-nums">
                          {typeof activeRun.partial.pseudoDice === "number"
                            ? activeRun.partial.pseudoDice.toFixed(3)
                            : activeRun.partial.pseudoDice}
                        </strong>
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Timeline of Parts */}
              <div className="rounded-2xl border border-border bg-card p-5 space-y-3 shadow-xs">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Layers className="h-4 w-4 text-primary" />
                    <h3 className="text-sm font-bold text-foreground">Timeline of Execution Parts</h3>
                  </div>
                  <span className="text-[11px] text-muted-foreground">Click a part to view its log</span>
                </div>

                <div className="divide-y divide-border/60 rounded-xl border border-border/80 overflow-hidden bg-background/50">
                  {activeRun.parts.length === 0 ? (
                    <div className="p-4 text-center text-xs text-muted-foreground">
                      No part logs recorded yet for this run.
                    </div>
                  ) : (
                    activeRun.parts.map((part, idx) => {
                      const isPartSelected = selectedPartIndex === idx;
                      const jobId = part.jobId || part.slurmJobId;
                      const stateBadge = slurmStateBadge(part.state);

                      return (
                        <div
                          key={part.part ?? idx}
                          onClick={() => setSelectedPartIndex(idx)}
                          className={`flex flex-col sm:flex-row sm:items-center sm:justify-between p-3 gap-2 transition-colors cursor-pointer text-xs ${
                            isPartSelected ? "bg-primary/10 border-l-4 border-l-primary" : "hover:bg-muted/40"
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <span className="font-bold text-foreground font-mono">Part {part.part}</span>

                            {jobId ? (
                              <div
                                className="inline-flex items-center gap-1 rounded bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-foreground"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void copyToClipboard(jobId, `job-${jobId}`, `Copied Job ${jobId}`);
                                }}
                                title="Click to copy Slurm Job ID"
                              >
                                <span>job #{jobId}</span>
                                {copiedKey === `job-${jobId}` ? (
                                  <Check className="h-3 w-3 text-emerald-500" />
                                ) : (
                                  <Copy className="h-2.5 w-2.5 text-muted-foreground hover:text-foreground" />
                                )}
                              </div>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">no job id</span>
                            )}

                            {part.state && (
                              <span
                                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${stateBadge}`}
                              >
                                {part.state}
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-3 text-[11px] text-muted-foreground font-mono">
                            {part.start && <span className="tabular-nums">Start: {formatDate(part.start)}</span>}
                            {part.elapsed && (
                              <span className="rounded bg-muted/40 px-1.5 py-0.5 text-foreground tabular-nums">
                                {part.elapsed}
                              </span>
                            )}
                            <ChevronRight
                              className={`h-3.5 w-3.5 transition-transform ${
                                isPartSelected ? "rotate-90 text-primary" : "text-muted-foreground"
                              }`}
                            />
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Per-Part Log Viewer */}
              {activePart && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between px-1">
                    <div className="flex items-center gap-2">
                      <Terminal className="h-3.5 w-3.5 text-primary" />
                      <span className="text-xs font-bold text-foreground">
                        Part {activePart.part} Log{" "}
                        {activePart.jobId && (
                          <span className="font-mono font-normal text-muted-foreground">
                            (job #{activePart.jobId})
                          </span>
                        )}
                      </span>
                      {logLines.length > 0 && (
                        <span className="text-[10px] text-muted-foreground font-mono">
                          showing latest {logLines.length} lines (scroll up to load 50 more)
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          const jobId = activePart.jobId || activePart.slurmJobId;
                          setFullLogTarget({
                            title: `${activeRun.label} - Part ${activePart.part} (job #${jobId || "unknown"})`,
                            platform: "h200",
                            targetId: `h200-${activeRun.roll}`,
                            jobId: jobId,
                            live: (activePart.state || "").toUpperCase() === "RUNNING",
                          });
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent cursor-pointer transition-colors"
                      >
                        <Maximize2 className="h-3 w-3 text-muted-foreground" />
                        Open full log
                      </button>
                    </div>
                  </div>

                  {logLoading && logLines.length === 0 ? (
                    <div className="h-56 rounded-xl border border-zinc-800 bg-black p-4 flex items-center justify-center font-mono text-xs text-zinc-400">
                      <div className="flex items-center gap-2">
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        <span>Connecting to H200 and streaming log...</span>
                      </div>
                    </div>
                  ) : logError ? (
                    <div className="h-44 rounded-xl border border-red-500/30 bg-red-500/10 p-4 font-mono text-xs text-red-400 flex items-center justify-between">
                      <span>{logError}</span>
                      <button
                        type="button"
                        onClick={() => {
                          const jobId = activePart.jobId || activePart.slurmJobId;
                          if (jobId) void fetchPartLog(activeRun.roll, jobId, linesToFetch);
                        }}
                        className="rounded border border-red-500/40 px-2 py-1 text-[11px] hover:bg-red-500/20 cursor-pointer"
                      >
                        Retry
                      </button>
                    </div>
                  ) : (
                    <TerminalBox
                      containerRef={terminalRef}
                      title={`${activeRun.roll}:~/bme/logs/${logFile || `job_${activePart.jobId || "unknown"}.out`}`}
                      prompt={logFile ? `h200-${activeRun.roll}:~/bme$ tail -n ${linesToFetch} ${logFile}` : undefined}
                      lines={logLines}
                      live={(activePart.state || "").toUpperCase() === "RUNNING"}
                      heightClass="h-72"
                      clickToOpen={false}
                      autoScroll={!loadingMoreLogs && linesToFetch === 50}
                      onScroll={handleTerminalScroll}
                      onOpen={() => {
                        const jobId = activePart.jobId || activePart.slurmJobId;
                        setFullLogTarget({
                          title: `${activeRun.label} - Part ${activePart.part} (job #${jobId || "unknown"})`,
                          platform: "h200",
                          targetId: `h200-${activeRun.roll}`,
                          jobId: jobId,
                          live: (activePart.state || "").toUpperCase() === "RUNNING",
                        });
                      }}
                    />
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Full-Screen Log Modal */}
      <LogModal target={fullLogTarget} onClose={() => setFullLogTarget(null)} />
    </div>
  );
}

export default function RunsPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-6 pb-12 animate-pulse">
          <div className="h-12 w-full bg-muted/60 rounded-2xl" />
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-5 space-y-3">
              <div className="h-20 bg-muted/50 rounded-xl" />
              <div className="h-24 bg-muted/50 rounded-xl" />
              <div className="h-24 bg-muted/50 rounded-xl" />
            </div>
            <div className="lg:col-span-7 h-96 bg-muted/50 rounded-2xl" />
          </div>
        </div>
      }
    >
      <RunsPageContent />
    </Suspense>
  );
}
