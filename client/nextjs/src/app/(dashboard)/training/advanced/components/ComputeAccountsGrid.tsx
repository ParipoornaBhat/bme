"use client";

import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cloud,
  Cpu,
  Loader2,
  RotateCcw,
  Server,
  Square,
  Terminal,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import type { AccountCard } from "~/lib/training-advanced/types";

export interface ComputeAccountsGridProps {
  cards: AccountCard[];
  refreshing: boolean;
  onRetryConnection: () => void;
  onResume: (card: AccountCard) => void;
  onCancel: (card: AccountCard) => void;
  fmtDuration: (sec: number | null | undefined) => string;
}

export function ComputeAccountsGrid({
  cards,
  refreshing,
  onRetryConnection,
  onResume,
  onCancel,
  fmtDuration,
}: ComputeAccountsGridProps) {
  const [expandedLogs, setExpandedLogs] = useState<Record<string, boolean>>({});

  const toggleLog = (cardId: string) => {
    setExpandedLogs((prev) => ({ ...prev, [cardId]: !prev[cardId] }));
  };

  return (
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
                    card.checking
                      ? "bg-muted text-muted-foreground"
                      : card.connected
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "bg-destructive/10 text-destructive"
                  }`}
                >
                  {card.checking ? (
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
                {!card.connected && !card.checking && (
                  <button
                    type="button"
                    onClick={onRetryConnection}
                    disabled={refreshing}
                    className="mt-1.5 block w-full rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50 cursor-pointer"
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
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Job: {job.methodLabel || job.methodId}
                      </span>
                      {job.isCached && job.cachedAt && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground font-mono">
                          Cached {new Date(job.cachedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      )}
                    </div>
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
                        type="button"
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
                        type="button"
                        onClick={() => onResume(card)}
                        className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-amber-500/20 px-3 py-2 text-xs font-bold text-amber-700 dark:text-amber-300 hover:bg-amber-500/30 transition-all cursor-pointer"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        {isKaggle ? "Continue (--continue-previous)" : "Resume"}
                      </button>
                    )}
                    {job.status === "running" && (
                      <button
                        type="button"
                        onClick={() => onCancel(card)}
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
                    Ready to execute runs.
                  </span>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
