"use client";

import {
  ChevronDown,
  ChevronUp,
  Clock,
  RefreshCw,
  RotateCcw,
  Terminal,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { BackgroundTask } from "~/lib/training-advanced/types";

export interface SyncTasksHistoryProps {
  tasks: BackgroundTask[];
  refreshing: boolean;
  onRefresh: () => void;
  onClearHistory: () => void;
  onDeleteTask?: (id: string) => void;
  onResumeSync: (targetId: string) => void;
  fmtDate: (iso?: string | null) => string;
}

function parseProgressPercent(msg?: string): number | null {
  if (!msg) return null;
  const pct = /(\d{1,3})%/.exec(msg);
  if (pct) return parseInt(pct[1], 10);
  const m = /(\d+(?:\.\d+)?)\s*(MB|KB)\s*\/\s*(\d+(?:\.\d+)?)\s*(MB|KB)/i.exec(msg);
  if (!m) return null;
  const toMb = (val: number, u: string) => (u.toUpperCase() === "KB" ? val / 1024 : val);
  const currentMb = toMb(parseFloat(m[1]), m[2]);
  const totalMb = toMb(parseFloat(m[3]), m[4]);
  if (totalMb > 0) {
    return Math.min(100, Math.max(0, Math.round((currentMb / totalMb) * 100)));
  }
  return null;
}

export function SyncTasksHistory({
  tasks,
  refreshing,
  onRefresh,
  onClearHistory,
  onDeleteTask,
  onResumeSync,
  fmtDate,
}: SyncTasksHistoryProps) {
  const [historyTargetFilter, setHistoryTargetFilter] = useState<string>("all");
  const [historyStatusFilter, setHistoryStatusFilter] = useState<string>("all");
  const [expandedLogs, setExpandedLogs] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState(false);

  const toggleLog = (id: string) => {
    setExpandedLogs((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const uniqueTargets = useMemo(() => {
    const set = new Set<string>();
    tasks.forEach((t) => {
      if (t.target) set.add(t.target);
    });
    return Array.from(set).sort();
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    return tasks
      .filter((t) => {
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
      })
      .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  }, [tasks, historyTargetFilter, historyStatusFilter]);

  return (
    <div className="space-y-4 rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border/50 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-bold tracking-tight">Sync &amp; Upload History</h2>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Historical log of dataset synchronization across H200 and Kaggle with live console output.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {tasks.length > 0 && (
            <button
              type="button"
              onClick={onClearHistory}
              className="inline-flex items-center gap-1.5 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10 transition-all cursor-pointer"
              title="Clear all completed and failed sync logs"
            >
              <Trash2 className="h-3 w-3" />
              Clear History
            </button>
          )}
          <button
            type="button"
            onClick={onRefresh}
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
            {uniqueTargets.map((tgt) => (
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
      {filteredTasks.length > 8 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-[11px] font-semibold text-primary hover:underline cursor-pointer"
        >
          {showAll ? "Show only the newest 8" : `Show all ${filteredTasks.length} entries`}
        </button>
      )}
      <div className="space-y-3 pt-2">
        {filteredTasks.length > 0 ? (
          (showAll ? filteredTasks : filteredTasks.slice(0, 8)).map((task) => {
            const isExpanded = Boolean(expandedLogs[task.id]);
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

                <div className="flex items-center gap-3 pt-1">
                  {(task.status === "failed" || isCancelled) && task.target && (
                    <button
                      type="button"
                      onClick={() => onResumeSync(task.target)}
                      className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-[11px] font-semibold text-foreground hover:bg-accent transition-all cursor-pointer"
                      title="Resume sync: re-checks and sends only missing files"
                    >
                      <RotateCcw className="h-3 w-3 text-primary" />
                      Resume Sync
                    </button>
                  )}

                  {task.status !== "running" && onDeleteTask && (
                    <button
                      type="button"
                      onClick={() => onDeleteTask(task.id)}
                      className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-destructive/80 hover:text-destructive cursor-pointer"
                      title="Delete this entry from history"
                    >
                      <Trash2 className="h-3 w-3" />
                      Delete
                    </button>
                  )}

                  {task.log && task.log.length > 0 && (
                    <button
                      type="button"
                      onClick={() => toggleLog(task.id)}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground cursor-pointer"
                    >
                      <Terminal className="h-3 w-3" />
                      {isExpanded ? "Hide Logs" : `View Logs (${task.log.length} lines)`}
                      {isExpanded ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )}
                    </button>
                  )}
                </div>

                {isExpanded && task.log && (
                  <div className="mt-2 rounded-xl bg-zinc-950 p-3 font-mono text-[11px] text-zinc-300 overflow-x-auto max-h-64 border border-zinc-800">
                    {task.log.map((line, idx) => (
                      <div key={idx} className="whitespace-pre leading-relaxed">
                        {line}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <div className="py-8 text-center text-xs text-muted-foreground">
            No synchronization tasks found for the selected filter.
          </div>
        )}
      </div>
    </div>
  );
}
