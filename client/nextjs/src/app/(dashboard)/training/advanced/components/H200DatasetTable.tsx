"use client";

import {
  AlertTriangle,
  CheckCircle2,
  HardDrive,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  XCircle,
} from "lucide-react";
import type { AccountCard, BackgroundTask, TargetDatasetStatus } from "~/lib/training-advanced/types";
import { fmtBytes } from "./DatasetOverviewCard";

export interface H200DatasetTableProps {
  targets: TargetDatasetStatus[];
  cards: AccountCard[];
  localExportHash?: string;
  localExportVersion?: string;
  syncTasks: BackgroundTask[];
  syncBusyTarget: string | null;
  checkingTarget: string | null;
  onCheck: (targetId: string) => void;
  onSync: (target: TargetDatasetStatus) => void;
  onFreshUpload: (target: TargetDatasetStatus) => void;
  onSyncAllFree: () => void;
  onStopSync: (targetId: string) => void;
  getLastSyncDate: (targetId: string) => string;
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

export function H200DatasetTable({
  targets,
  cards,
  localExportHash,
  localExportVersion,
  syncTasks,
  syncBusyTarget,
  checkingTarget,
  onCheck,
  onSync,
  onFreshUpload,
  onSyncAllFree,
  onStopSync,
  getLastSyncDate,
}: H200DatasetTableProps) {
  const idleTargets = targets.filter((t) => !t.runningJobBlocking);

  return (
    <div className="space-y-4 rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border/50 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5 text-purple-500" />
            <h2 className="text-lg font-bold tracking-tight">H200 Cluster Accounts</h2>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Dataset synchronization status and cluster account storage for College H200 GPU nodes.
          </p>
        </div>

        {targets.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onSyncAllFree}
              disabled={syncBusyTarget === "batch-h200" || idleTargets.length === 0}
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-muted/40 px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted transition-all cursor-pointer disabled:opacity-40"
              title={
                idleTargets.length === 0
                  ? "All accounts are currently running training jobs"
                  : "Sync all idle H200 nodes (runs in parallel on College LAN, sequentially over Remote Jump)"
              }
            >
              <RefreshCw
                className={`h-3 w-3 ${syncBusyTarget === "batch-h200" ? "animate-spin" : ""}`}
              />
              Sync All Idle ({idleTargets.length})
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
            {targets.length > 0 ? (
              targets.map((t) => {
                const card = cards.find((c) => c.id === t.targetId);
                const isConnected = card ? card.connected : true;
                const isBlocked = Boolean(t.runningJobBlocking);
                const isBusy = syncBusyTarget === t.targetId;
                const activeSync = syncTasks.find(
                  (x) => x.status === "running" && x.target === t.targetId
                );
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
                        {t.isRemoteRoute ? "Remote (Jump)" : "College LAN"}
                      </span>
                    </td>

                    <td className="px-3 py-3 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                      {t.datasetVersion || "server-synced"}
                    </td>

                    <td className="px-3 py-3 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                      {localExportHash ? localExportHash.slice(0, 12) : localExportVersion || "-"}
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
                      <div>
                        <span>
                          {t.filesCount ?? 0} files ({t.bytesToSync ? fmtBytes(t.bytesToSync) : "0 B"}) to send
                        </span>
                        {t.filesSame != null && (
                          <div className="text-[10px] text-emerald-600 dark:text-emerald-400 font-sans">
                            {t.filesSame} already on server
                          </div>
                        )}
                        {t.checkedAt && (
                          <div className="text-[9px] text-muted-foreground font-sans">
                            Checked {new Date(t.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </div>
                        )}
                      </div>
                    </td>

                    <td className="px-3 py-3 whitespace-nowrap text-muted-foreground text-[11px]">
                      {getLastSyncDate(t.targetId)}
                    </td>

                    <td className="px-3 py-3 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${stateClass}`}
                      >
                        {isConnected && !isBlocked && <CheckCircle2 className="h-3 w-3 shrink-0" />}
                        {!isConnected && <XCircle className="h-3 w-3 shrink-0" />}
                        {isConnected && isBlocked && <AlertTriangle className="h-3 w-3 shrink-0" />}
                        {stateLabel}
                      </span>
                    </td>

                    <td className="px-3.5 py-3 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        {/* Check Sync Plan Button */}
                        <button
                          type="button"
                          onClick={() => onCheck(t.targetId)}
                          disabled={
                            isBlocked ||
                            !isConnected ||
                            isBusy ||
                            Boolean(activeSync) ||
                            checkingTarget === t.targetId
                          }
                          className="inline-flex items-center gap-1 rounded-xl border border-border bg-muted/40 px-2 py-1.5 text-xs font-semibold text-foreground hover:bg-muted transition-all cursor-pointer disabled:opacity-40"
                          title="Check remote H200: see how many files are missing without transferring anything"
                        >
                          {checkingTarget === t.targetId ? (
                            <Loader2 className="h-3 w-3 animate-spin text-primary" />
                          ) : (
                            <Search className="h-3 w-3 text-muted-foreground" />
                          )}
                          Check
                        </button>

                        {/* Incremental Sync Button */}
                        <button
                          type="button"
                          onClick={() => onSync(t)}
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
                          type="button"
                          onClick={() => onFreshUpload(t)}
                          disabled={isBlocked || !isConnected || isBusy || Boolean(activeSync)}
                          className="inline-flex items-center gap-1 rounded-xl border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 transition-all cursor-pointer disabled:opacity-40"
                          title="Fresh Re-upload: deletes old remote scans/annotations, then uploads fresh clean copy from this PC"
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
                            onClick={() => onStopSync(t.targetId)}
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
  );
}
