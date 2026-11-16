"use client";

import { CheckCircle2, Clock, Filter, RotateCcw, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import type { MetricSummary, PlatformType, RunItem } from "~/lib/training-advanced/types";

export interface RunHistoryTableProps {
  runs: RunItem[];
  onResumeRun: (run: RunItem) => void;
  fmtDate: (iso?: string | null) => string;
}

const fmtMetric = (m?: MetricSummary | null): string => {
  if (!m || m.mean == null || isNaN(m.mean)) return "-";
  return m.std != null ? `${m.mean.toFixed(3)} +- ${m.std.toFixed(3)}` : m.mean.toFixed(3);
};

export function RunHistoryTable({ runs, onResumeRun, fmtDate }: RunHistoryTableProps) {
  const [platformFilter, setPlatformFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const filteredRuns = useMemo(() => {
    return runs.filter((r) => {
      if (platformFilter !== "all" && r.platform !== platformFilter) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const match =
          r.methodId.toLowerCase().includes(q) ||
          r.methodLabel.toLowerCase().includes(q) ||
          r.account.toLowerCase().includes(q) ||
          r.id.toLowerCase().includes(q) ||
          (r.startedBy?.name && r.startedBy.name.toLowerCase().includes(q));
        if (!match) return false;
      }
      return true;
    });
  }, [runs, platformFilter, statusFilter, searchQuery]);

  return (
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 border-y border-border/50 py-3.5">
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
            <option value="stopped">Stopped / 4h Limit</option>
            <option value="incomplete">Incomplete</option>
            <option value="failed">Failed</option>
          </select>
        </div>

        <div className="sm:col-span-2">
          <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground block mb-1">
            Search Runs
          </label>
          <input
            type="text"
            placeholder="Search by method, account, started by..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-medium"
          />
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-muted/40 text-[10px] uppercase tracking-wider font-bold text-muted-foreground border-b border-border">
            <tr>
              <th className="px-3.5 py-3">Run ID</th>
              <th className="px-3 py-3">Method</th>
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3">Platform</th>
              <th className="px-3 py-3">Account</th>
              <th className="px-3 py-3">Started</th>
              <th className="px-3 py-3">BME Dice (Pos)*</th>
              <th className="px-3 py-3">Bone Dice</th>
              <th className="px-3 py-3">Sensitivity</th>
              <th className="px-3 py-3">FP / Case</th>
              <th className="px-3.5 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40 font-medium">
            {filteredRuns.length > 0 ? (
              filteredRuns.map((r) => {
                let statusLabel = r.status === "finished" ? "Finished" : r.status;
                let statusClass = "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";

                if (r.status === "running") {
                  statusLabel = "Running";
                  statusClass = "bg-sky-500/10 text-sky-600 dark:text-sky-400";
                } else if (r.status === "stopped" || r.status === "incomplete") {
                  statusLabel = r.status === "stopped" ? "Stopped (4h limit)" : "Incomplete";
                  statusClass = "bg-amber-500/10 text-amber-600 dark:text-amber-400";
                } else if (r.status === "failed") {
                  statusLabel = "Failed";
                  statusClass = "bg-destructive/10 text-destructive";
                }

                return (
                  <tr key={r.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-3.5 py-3 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                      {r.id.length > 20 ? `${r.id.slice(0, 18)}...` : r.id}
                    </td>

                    <td className="px-3 py-3 font-semibold text-foreground whitespace-nowrap">
                      {r.methodLabel || r.methodId}
                    </td>

                    <td className="px-3 py-3 whitespace-nowrap">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${statusClass}`}>
                        {r.status === "running" && <span className="h-1.5 w-1.5 rounded-full bg-sky-500 animate-pulse" />}
                        {statusLabel}
                      </span>
                    </td>

                    <td className="px-3 py-3 whitespace-nowrap">
                      <span className="rounded-md border border-border/60 bg-muted/30 px-2 py-0.5 text-[10px]">
                        {r.platformLabel}
                      </span>
                    </td>

                    <td className="px-3 py-3 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                      {r.account}
                    </td>

                    <td className="px-3 py-3 text-[11px] text-muted-foreground whitespace-nowrap">
                      {fmtDate(r.startedAt)}
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

                    <td className="px-3.5 py-3 text-right whitespace-nowrap">
                      {(r.status === "stopped" || r.status === "incomplete") && (
                        <button
                          type="button"
                          onClick={() => onResumeRun(r)}
                          className="inline-flex items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 transition-all cursor-pointer"
                          title="Resume training from the last saved fold checkpoint"
                        >
                          <RotateCcw className="h-3 w-3" />
                          Resume
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={11} className="py-8 text-center text-xs text-muted-foreground">
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
  );
}
