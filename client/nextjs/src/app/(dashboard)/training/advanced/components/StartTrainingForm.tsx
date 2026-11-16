"use client";

import { Info, Loader2, Play } from "lucide-react";
import type {
  AccountCard,
  BackgroundTask,
  KaggleDatasetOption,
  MethodSpec,
  TargetDatasetStatus,
} from "~/lib/training-advanced/types";

export interface StartTrainingFormProps {
  methods: MethodSpec[];
  cards: AccountCard[];
  datasetTargets: TargetDatasetStatus[];
  kaggleDatasets: KaggleDatasetOption[];
  tasks: BackgroundTask[];
  selectedMethodId: string;
  selectedTargetId: string;
  selectedDatasetOwner: string;
  augLevel: "low" | "med" | "max";
  splitMode: "5folds" | "holdout";
  epochs: number;
  startBusy: boolean;
  onMethodChange: (methodId: string) => void;
  onTargetChange: (targetId: string) => void;
  onDatasetOwnerChange: (ownerRoll: string) => void;
  onAugLevelChange: (level: "low" | "med" | "max") => void;
  onSplitModeChange: (mode: "5folds" | "holdout") => void;
  onEpochsChange: (epochs: number) => void;
  onSubmit: () => void;
}

export function StartTrainingForm({
  methods,
  cards,
  datasetTargets,
  kaggleDatasets,
  tasks,
  selectedMethodId,
  selectedTargetId,
  selectedDatasetOwner,
  augLevel,
  splitMode,
  epochs,
  startBusy,
  onMethodChange,
  onTargetChange,
  onDatasetOwnerChange,
  onAugLevelChange,
  onSplitModeChange,
  onEpochsChange,
  onSubmit,
}: StartTrainingFormProps) {
  const currentSelectedMethod = methods.find((m) => m.id === selectedMethodId) || methods[0];
  const currentSelectedTarget = cards.find((c) => c.id === selectedTargetId) || cards[0];

  const targetStatus = datasetTargets.find((t) => t.targetId === currentSelectedTarget?.id);
  const isSyncActive = tasks.some((t) => t.status === "running" && t.target === currentSelectedTarget?.id);
  const isDataBehind = currentSelectedTarget?.platform === "h200" && targetStatus && !targetStatus.isUpToDate;
  const isBlocked = Boolean(currentSelectedTarget?.currentJob && currentSelectedTarget.currentJob.status === "running");
  const isKaggleNoDs = currentSelectedTarget?.platform === "kaggle" && kaggleDatasets.length === 0;

  return (
    <div className="space-y-4 rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="flex items-center gap-2">
        <Play className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-bold tracking-tight">Start a Run</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Configure and launch any of the benchmark comparison methods across College H200, Kaggle, or This PC.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 pt-2">
        {/* Pick Method */}
        <div className="sm:col-span-2">
          <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
            1. Select Method (The 9 Methods)
          </label>
          <select
            value={selectedMethodId}
            onChange={(e) => onMethodChange(e.target.value)}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold cursor-pointer"
          >
            {methods.map((m) => (
              <option key={m.id} value={m.id}>
                {m.n}. {m.label} ({m.where.toUpperCase()})
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Tests: {currentSelectedMethod?.tests}
          </p>
        </div>

        {/* Pick Target */}
        <div className="sm:col-span-2">
          <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
            2. Select Execution Target
          </label>
          <select
            value={selectedTargetId}
            onChange={(e) => onTargetChange(e.target.value)}
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
                  No Kaggle account has an uploaded, non-empty dataset yet. Upload or sync the dataset in Dataset &amp; Sync Hub first before launching training.
                </p>
              </div>
            ) : (
              <select
                value={selectedDatasetOwner}
                onChange={(e) => onDatasetOwnerChange(e.target.value)}
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
            onChange={(e) => onAugLevelChange(e.target.value as "low" | "med" | "max")}
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
            onChange={(e) => onSplitModeChange(e.target.value as "5folds" | "holdout")}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold cursor-pointer"
          >
            <option value="5folds">5-Fold Patient Cross-Validation</option>
            <option value="holdout">Fixed 80/20 Holdout Split</option>
          </select>
        </div>

        {/* Epochs */}
        <div className="sm:col-span-2">
          <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
            Epochs
          </label>
          <input
            type="number"
            min={1}
            max={200}
            value={epochs}
            onChange={(e) => onEpochsChange(Number(e.target.value))}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold"
          />
        </div>

        {/* Target Hardware & Sync Status Summary */}
        <div className="sm:col-span-2 rounded-xl border border-border/60 bg-muted/20 p-3 text-xs space-y-2">
          <div className="flex items-center justify-between font-semibold">
            <span className="text-foreground">Execution Summary &amp; Resource Allocation</span>
            <span className="font-mono text-[10px] text-muted-foreground uppercase">
              {currentSelectedTarget?.platform}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-muted-foreground">
            <div>
              <span className="font-semibold text-foreground">Hardware: </span>
              {currentSelectedTarget?.platform === "h200" && "GPU slice 1g.18gb, 4 CPU, 24 GB RAM, 3h 45m job limit"}
              {currentSelectedTarget?.platform === "kaggle" && "Tesla T4/P100 (16GB VRAM), 30h/wk quota, 12h session"}
              {currentSelectedTarget?.platform === "local" && "This PC (Local hardware)"}
            </div>

            <div>
              <span className="font-semibold text-foreground">Dataset: </span>
              {targetStatus?.isUpToDate
                ? "Up to date with local export"
                : targetStatus?.checkedAt
                ? `Checked at ${new Date(targetStatus.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                : "Requires sync check"}
            </div>
          </div>

          {(isDataBehind || isSyncActive || isBlocked) && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300 space-y-0.5">
              {isBlocked && <p>• A training job is already active on this target.</p>}
              {isSyncActive && <p>• A dataset sync is currently running for this target. Wait for it to finish.</p>}
              {isDataBehind && <p>• Target data is behind the latest local export. Sync dataset before launching training.</p>}
            </div>
          )}
        </div>
      </div>

      {/* Confirmations & Start Button */}
      <div className="pt-3 border-t border-border/50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
          <Info className="h-4 w-4 shrink-0 text-primary" />
          <span>Full metadata (`startedBy`, `platform`, `account`, `host`, `startedAt`) recorded automatically.</span>
        </div>

        <button
          type="button"
          onClick={onSubmit}
          disabled={startBusy || !currentSelectedTarget?.connected || isKaggleNoDs || isDataBehind || isSyncActive || isBlocked}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-xs font-bold text-primary-foreground hover:bg-primary/90 transition-all cursor-pointer disabled:opacity-40"
        >
          {startBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Start Run
        </button>
      </div>
    </div>
  );
}
