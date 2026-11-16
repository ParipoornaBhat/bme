"use client";

import {
  AlertTriangle,
  RefreshCw,
  CheckCircle2,
  Cloud,
  FileCode,
  HardDrive,
  Loader2,
  RotateCcw,
  Upload,
  XCircle,
} from "lucide-react";
import type { AccountCard, BackgroundTask, KaggleDatasetOption, TargetDatasetStatus } from "~/lib/training-advanced/types";
import { fmtBytes } from "./DatasetOverviewCard";

export interface KaggleDatasetCardProps {
  target: TargetDatasetStatus | null;
  cards: AccountCard[];
  kaggleDatasets: KaggleDatasetOption[];
  syncTasks: BackgroundTask[];
  syncBusyTarget: string | null;
  onUpload: (targetId?: string) => void;
  onFreshUpload: (targetId?: string) => void;
  onStopSync: (targetId: string) => void;
  onCheck?: () => void;
}

export function KaggleDatasetCard({
  target,
  cards,
  kaggleDatasets,
  syncTasks,
  syncBusyTarget,
  onUpload,
  onFreshUpload,
  onStopSync,
  onCheck,
}: KaggleDatasetCardProps) {
  if (!target) return null;

  const isBlocked = Boolean(target.runningJobBlocking);
  const isBusy = syncBusyTarget === target.targetId;
  const activeSync = syncTasks.find(
    (x) => x.status === "running" && x.target === target.targetId
  );

  return (
    <div className="space-y-4 rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border/50 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <Cloud className="h-5 w-5 text-sky-500" />
            <h2 className="text-lg font-bold tracking-tight">{target.label}</h2>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            This account's own private Kaggle dataset. Training on this account reads it.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onCheck?.()}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
            title="Re-read this account's dataset status"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Check
          </button>

          {/* Incremental Upload / Update Button */}
          <button
            type="button"
            onClick={() => onUpload(target.targetId)}
            disabled={isBlocked || isBusy || Boolean(activeSync)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-1.5 text-xs font-bold text-primary-foreground hover:bg-primary/90 transition-all cursor-pointer disabled:opacity-40 shadow-xs"
            title="Incremental update: updates Kaggle version with current de-identified export"
          >
            {isBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {target.hasUploaded ? "Update Dataset" : "Upload to Kaggle"}
          </button>

          {/* Fresh Re-upload Button */}
          <button
            type="button"
            onClick={() => onFreshUpload(target.targetId)}
            disabled={isBlocked || isBusy || Boolean(activeSync)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 transition-all cursor-pointer disabled:opacity-40"
            title="Fresh Re-upload: clears export cache, forces full re-export, re-verifies, and pushes fresh version"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Fresh Re-upload
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
        {/* Dataset Slug & Version */}
        <div className="rounded-xl border border-border/60 bg-muted/20 p-4 space-y-1.5">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="font-semibold uppercase text-[10px] tracking-wider">Remote Dataset</span>
            <FileCode className="h-4 w-4 text-sky-500/70" />
          </div>
          <div className="font-mono text-sm font-bold text-foreground">
            {target.datasetSlug || "bme-3d-dataset"}
          </div>
          <div className="text-[11px] text-muted-foreground">
            Status:{" "}
            <span className="font-semibold text-foreground">
              {target.hasUploaded ? "Published (Private)" : "Not uploaded yet"}
            </span>
          </div>
        </div>

        {/* Sync Status & Transfer Size */}
        <div className="rounded-xl border border-border/60 bg-muted/20 p-4 space-y-1.5">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="font-semibold uppercase text-[10px] tracking-wider">Version Status</span>
            <HardDrive className="h-4 w-4 text-emerald-500/70" />
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                target.isUpToDate
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
              }`}
            >
              {target.isUpToDate ? "Up to date" : "Needs sync / update"}
            </span>
          </div>
          <div className="text-[11px] text-muted-foreground">
            Estimated transfer:{" "}
            <span className="font-mono font-medium text-foreground">
              {target.bytesToSync ? fmtBytes(target.bytesToSync) : "0 B"}
            </span>
          </div>
        </div>

        {/* Node / Training Lock State */}
        <div className="rounded-xl border border-border/60 bg-muted/20 p-4 space-y-1.5">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="font-semibold uppercase text-[10px] tracking-wider">Target State</span>
            {isBlocked ? (
              <AlertTriangle className="h-4 w-4 text-amber-500" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            )}
          </div>
          <div className="font-semibold text-foreground">
            {isBlocked ? (
              <span className="text-amber-600 dark:text-amber-400">
                Busy: Training ({target.runningJobBlocking?.method})
              </span>
            ) : (
              <span className="text-emerald-600 dark:text-emerald-400">Ready for sync</span>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {isBlocked
              ? "Sync is locked until the current training job finishes"
              : "No conflicting training runs on Kaggle"}
          </div>
        </div>
      </div>

      {/* Active Sync Progress */}
      {activeSync && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300 font-semibold">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-500" />
              <span>Uploading dataset to Kaggle...</span>
            </div>
            <button
              type="button"
              onClick={() => onStopSync(target.targetId)}
              className="rounded-lg border border-destructive/40 px-2 py-0.5 text-[11px] text-destructive hover:bg-destructive/10 cursor-pointer"
            >
              Stop Sync
            </button>
          </div>
          <div className="text-xs text-muted-foreground truncate" title={activeSync.message}>
            {activeSync.message}
          </div>
        </div>
      )}
    </div>
  );
}
