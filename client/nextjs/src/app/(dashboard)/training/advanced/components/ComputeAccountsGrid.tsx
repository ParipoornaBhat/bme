"use client";

import {
  CheckCircle2,
  Cloud,
  Cpu,
  Loader2,
  RotateCcw,
  Server,
  Square,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import type { AccountCard } from "~/lib/training-advanced/types";
import { LogModal, TerminalBox, type LogTarget } from "./TerminalView";

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
  const [openLog, setOpenLog] = useState<LogTarget | null>(null);

  return (
    <>
    <LogModal target={openLog} onClose={() => setOpenLog(null)} />
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {cards.map((card) => {
        const job = card.currentJob;
        const isH200 = card.platform === "h200";
        const isKaggle = card.platform === "kaggle";
        const isLocal = card.platform === "local";
        const shell = `${card.accountName}@${card.platform}:~/bme$`;
        const logTarget: LogTarget = {
          title: `${card.label} - ${job?.methodLabel || "log"}`,
          prompt: shell,
          platform: card.platform,
          targetId: card.id,
          lines: job?.logTail || [],
          live: job?.status === "running",
        };

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
                {card.platform === "h200" && card.envReady === false && (
                  <span className="mt-1.5 block rounded bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive">
                    No Python env
                  </span>
                )}
                {!card.checking && (
                  <button
                    type="button"
                    onClick={onRetryConnection}
                    disabled={refreshing}
                    title="Re-read this account's connection and job status from the H200 / Kaggle"
                    className="mt-1.5 block w-full rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50 cursor-pointer"
                  >
                    {refreshing ? "Checking..." : card.connected ? "Refresh status" : "Retry"}
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
                      {job.status === "stopped" ? "Part ended" : job.status}
                    </span>
                  </div>

                  {job.iteration && (
                    <p className="rounded-md bg-primary/10 px-2 py-1 text-[11px] font-semibold text-primary">{job.iteration}</p>
                  )}

                  {isH200 && (() => {
                    const auto = (card.autoRuns || []).find((r) => r.methodId === job.methodId);
                    if (!auto) return null;
                    return (
                      <p className="text-[10px] text-muted-foreground">
                        Auto-continue: {auto.state === "active" ? `tracked, ${auto.continues} part(s) continued so far` : `${auto.state}${auto.note ? ` (${auto.note})` : ""}`}
                      </p>
                    );
                  })()}

                  {/* Explicit Notice on H200 resume */}
                  {isH200 && (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-2.5 text-[11px] text-amber-700 dark:text-amber-300">
                      <p className="font-semibold">Notice on Resume:</p>
                      <p className="mt-0.5">
                        Each H200 job is one part of at most 3 h 45 m, then it saves and stops. Press Continue for the next part, or leave it to auto-continue (<span className="font-mono">pnpm h200:auto on</span>). It carries on from the last saved checkpoint.
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
                      <span className="text-[10px] uppercase font-semibold text-muted-foreground block">Original Start</span>
                      <span className="font-medium text-foreground" title={job.startedAt || undefined}>
                        {job.startedAt ? new Date(job.startedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "-"}
                      </span>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase font-semibold text-muted-foreground block">
                        {job.partStartedAt && job.partStartedAt !== job.startedAt ? "Resumed Part At" : "Elapsed Time"}
                      </span>
                      <span className="font-medium text-foreground">
                        {job.partStartedAt && job.partStartedAt !== job.startedAt
                          ? new Date(job.partStartedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                          : fmtDuration(job.elapsedSeconds)}
                      </span>
                    </div>
                    {job.dataset && (
                      <div className="col-span-2">
                        <span className="text-[10px] uppercase font-semibold text-muted-foreground block">Dataset (fixed at start)</span>
                        <span className="font-medium text-foreground">{job.dataset}</span>
                      </div>
                    )}
                  </div>

                  {/* Intermediate Results & Checkpoints */}
                  {(job.intermediateResults || (job.partLog && job.partLog.length > 0)) && (
                    <div className="rounded-xl border border-primary/20 bg-primary/5 p-2.5 text-xs space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-primary text-[11px] uppercase tracking-wider">
                          Intermediate Checkpoints & Results
                        </span>
                        {job.intermediateResults?.foldsDone !== undefined && (
                          <span className="font-mono text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                            {job.intermediateResults.foldsDone}/5 Folds Done
                          </span>
                        )}
                      </div>
                      {job.intermediateResults?.summaryText && (
                        <p className="text-[11px] font-medium text-foreground">
                          {job.intermediateResults.summaryText}
                        </p>
                      )}
                      {job.partLog && job.partLog.length > 0 && (
                        <div className="mt-1 space-y-1 pt-1 border-t border-primary/10 text-[10px] text-muted-foreground font-mono">
                          {job.partLog.map((p) => (
                            <div key={p.part} className="flex items-center justify-between">
                              <span>Part {p.part} {p.slurmJobId ? `(Job ${p.slurmJobId})` : ""}</span>
                              <span>
                                {new Date(p.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                {p.endedAt ? ` → ${new Date(p.endedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

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

                  {/* Terminal: the last lines; click for the full log */}
                  {job.logTail && job.logTail.length > 0 && (
                    <TerminalBox
                      title={`${shell.split("$")[0]} - job ${job.slurmJobId || ""}`}
                      prompt={`${shell} tail -f logs/job.out`}
                      lines={job.logTail}
                      live={job.status === "running"}
                      onOpen={() => setOpenLog(logTarget)}
                    />
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
                        {isKaggle ? "Continue (--continue-previous)" : "Continue next part"}
                      </button>
                    )}
                    {isH200 && (
                      <button
                        type="button"
                        onClick={() => setOpenLog(logTarget)}
                        className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-bold text-foreground hover:bg-accent transition-all cursor-pointer"
                      >
                        Full log
                      </button>
                    )}
                    {(job.status === "running" || job.status === "queued") && (
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
    </>
  );
}
