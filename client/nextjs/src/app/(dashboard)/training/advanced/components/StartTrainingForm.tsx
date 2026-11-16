"use client";

import { useEffect } from "react";
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

  // Only targets this method can run on.
  const validCards = cards.filter(
    (c) => c.platform === currentSelectedMethod?.where || (c.platform === "local" && currentSelectedMethod?.localSupported),
  );
  useEffect(() => {
    if (validCards.length > 0 && !validCards.some((c) => c.id === selectedTargetId)) {
      onTargetChange(validCards[0].id);
    }
  }, [selectedMethodId, selectedTargetId, validCards.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const mid = currentSelectedMethod?.id || "";
  const methodRuns = mid.startsWith("selftest")
    ? "12 cases, 2 folds, at most 1.5 minutes of training per job. Press Continue next part once to check resume."
    : mid.startsWith("nnunet")
    ? "5 folds x 100 epochs with nnU-Net's own augmentation. Each job stops at 3 h 45 m; Resume continues it."
    : mid === "unet-holdout"
    ? "one round on the fixed 80/20 split, augmentation med."
    : mid === "unet-noaug"
    ? "patient-level cross-validation with no augmentation (the control)."
    : mid.startsWith("unet-aug-")
    ? `patient-level cross-validation, augmentation ${mid.replace("unet-aug-", "")}.`
    : "the Kaggle settings for this architecture, augmentation med.";

  const isH200Unet = mid.startsWith("unet-aug-") || mid === "unet-noaug";
  const augEditable = isH200Unet;
  const augValue = mid === "unet-noaug"
    ? "none"
    : mid.startsWith("unet-aug-")
    ? mid.replace("unet-aug-", "")
    : mid.startsWith("nnunet")
    ? "builtin"
    : "med";
  const splitEditable = mid === "unet-aug-med" || mid === "unet-holdout";
  const epochsText = mid.startsWith("selftest")
    ? "As many as fit in 1.5 minutes"
    : mid.startsWith("nnunet")
    ? "100 per fold (fixed by nnU-Net ResEnc M)"
    : currentSelectedMethod?.where === "h200"
    ? "Up to 400 per fold, limited by time: each part trains about 3.3 h, then saves and stops"
    : "Fixed by the Kaggle settings for this architecture";
  const needsNnunet = mid.startsWith("nnunet");
  const envMissing =
    currentSelectedTarget?.platform === "h200" &&
    (currentSelectedTarget.envReady === false || (needsNnunet && currentSelectedTarget.nnunetReady === false));

  const targetStatus = datasetTargets.find((t) => t.targetId === currentSelectedTarget?.id);
  const isSyncActive = tasks.some((t) => t.type === "sync" && t.status === "running" && t.target === currentSelectedTarget?.id);
  const isDataBehind = currentSelectedTarget?.platform === "h200" && targetStatus && !targetStatus.isUpToDate;
  const isBlocked = Boolean(currentSelectedTarget?.currentJob && (currentSelectedTarget.currentJob.status === "running" || currentSelectedTarget.currentJob.status === "queued"));
  const isKaggleNoDs = currentSelectedTarget?.platform === "kaggle" && kaggleDatasets.length === 0;
  const launching = tasks.some((t) => (t.type === "start" || t.type === "resume" || t.type === "setup") && t.status === "running" && t.target === currentSelectedTarget?.id);
  // Newest launch per account, so several launches can be followed side by side.
  const launches = Object.values(
    tasks
      .filter((t) => t.type === "start" || t.type === "resume" || t.type === "setup")
      .sort((a, b) => (a.startedAt || "").localeCompare(b.startedAt || ""))
      .reduce<Record<string, BackgroundTask>>((acc, t) => ({ ...acc, [t.target]: t }), {}),
  )
    .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))
    .slice(0, 6);

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
            1. Select Method
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
            {validCards.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} {c.checking ? "— checking" : c.connected ? "— Ready" : "— Unreachable"}
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

        {/* Augmentation level: picks the matching 3D U-Net run */}
        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
            Augmentation Level
          </label>
          <select
            value={augValue}
            disabled={!augEditable}
            onChange={(e) => onMethodChange(e.target.value === "none" ? "unet-noaug" : `unet-aug-${e.target.value}`)}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {!augEditable && mid.startsWith("nnunet") && <option value="builtin">nnU-Net built-in (fixed)</option>}
            <option value="none">None (control run)</option>
            <option value="low">Low (mild gamma, +-15 deg, 10% patches)</option>
            <option value="med">Medium (nnU-Net strength, +-30 deg, 20% patches)</option>
            <option value="max">Max (same + noise, 30-50% patches)</option>
          </select>
          {!augEditable && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              {mid.startsWith("nnunet")
                ? "nnU-Net applies its own augmentation."
                : mid === "unet-holdout"
                ? "The holdout run is defined at medium."
                : "Kaggle runs use the fixed medium level."}
            </p>
          )}
        </div>

        {/* Validation split */}
        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
            Validation Split
          </label>
          <select
            value={mid === "unet-holdout" ? "holdout" : "5folds"}
            disabled={!splitEditable}
            onChange={(e) => onMethodChange(e.target.value === "holdout" ? "unet-holdout" : "unet-aug-med")}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <option value="5folds">5-Fold Patient Cross-Validation</option>
            <option value="holdout">Fixed 80/20 Holdout Split</option>
          </select>
          {!splitEditable && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              The fixed 80/20 split exists only for the 3D U-Net at medium augmentation.
            </p>
          )}
        </div>

        {/* Epochs: fixed per method so runs stay comparable and inside the H200 job limit */}
        <div className="sm:col-span-2">
          <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
            Epochs
          </label>
          <div className="w-full rounded-xl border border-border bg-muted/30 px-3 py-2 text-xs font-semibold text-muted-foreground">
            {epochsText}
          </div>
        </div>

        {/* What this method runs (fixed by the method, not editable) */}
        <div className="sm:col-span-2 rounded-xl border border-border/60 bg-muted/20 p-3 text-[11px] text-muted-foreground">
          <span className="font-semibold text-foreground">This method runs: </span>
          {methodRuns}
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

      {launches.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {launches.map((l) => (
            <div key={l.id} className="rounded-xl border border-border bg-muted/30 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="font-semibold">
                  {cards.find((c) => c.id === l.target)?.label || l.target}:{" "}
                  <span
                    className={
                      l.status === "running"
                        ? "text-sky-500"
                        : l.status === "completed"
                        ? "text-emerald-500"
                        : "text-destructive"
                    }
                  >
                    {l.type === "setup"
                      ? l.status === "running" ? "installing Python..." : l.status === "completed" ? "Python ready" : "setup failed"
                      : l.status === "running" ? "launching..." : l.status === "completed" ? "submitted" : "not started"}
                  </span>
                </span>
                <span className="text-muted-foreground">{new Date(l.startedAt).toLocaleTimeString()}</span>
              </div>
              <pre className="max-h-40 overflow-auto rounded-lg bg-black/80 p-2 text-[10px] leading-relaxed text-green-300 font-mono whitespace-pre-wrap">
                {(l.log && l.log.length ? l.log.slice(-12) : [l.message || ""]).join(String.fromCharCode(10))}
              </pre>
            </div>
          ))}
        </div>
      )}

      {envMissing && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-[11px] text-destructive">
          <span className="font-bold">This account cannot train yet: </span>
          {currentSelectedTarget?.envReady === false
            ? "it has no Python environment on the H200."
            : "nnU-Net is not installed in its Python environment."}{" "}
          It is a one-time install of PyTorch and nnU-Net into ~/bme/env on the server (about 8 GB of the 50 GB home limit, 10 to 20 minutes).
          <button
            type="button"
            disabled={launching}
            onClick={async () => {
              const res = await fetch("/api/training-advanced/setup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetId: currentSelectedTarget?.id }),
              });
              const json = await res.json().catch(() => ({}));
              if (!res.ok) alert(json.message || json.error || "Could not start the setup");
            }}
            className="ml-2 inline-flex items-center rounded-lg bg-destructive px-2.5 py-1 text-[11px] font-bold text-white hover:bg-destructive/90 cursor-pointer disabled:opacity-50"
          >
            {launching ? "Working..." : "Set up Python on this account"}
          </button>
        </div>
      )}

      {/* Confirmations & Start Button */}
      <div className="pt-3 border-t border-border/50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
          <Info className="h-4 w-4 shrink-0 text-primary" />
          <span>Full metadata (`startedBy`, `platform`, `account`, `host`, `startedAt`) recorded automatically.</span>
        </div>

        <button
          type="button"
          onClick={onSubmit}
          disabled={startBusy || launching || envMissing || !currentSelectedTarget?.connected || isKaggleNoDs || isDataBehind || isSyncActive || isBlocked}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-xs font-bold text-primary-foreground hover:bg-primary/90 transition-all cursor-pointer disabled:opacity-40"
        >
          {startBusy || launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Start Run
        </button>
      </div>
    </div>
  );
}
