"use client";

import { useEffect, useState } from "react";
import { Info, Loader2, Play } from "lucide-react";
import type {
  AccountCard,
  BackgroundTask,
  KaggleDatasetOption,
  MethodSpec,
  TargetDatasetStatus,
} from "~/lib/training-advanced/types";
import { LogModal, TerminalBox, type LogTarget } from "./TerminalView";
import { methodIdFor, parseMethod, type Aug } from "~/lib/training-advanced/method-map";

type Where = "h200" | "kaggle";

// The model is one choice, the augmentation another, the validation split a third.
// `targets` lists the kinds of account that can run it; the account is a separate choice.
const ALL_AUGS: Aug[] = ["none", "low", "med", "max"];
const MODELS: { key: string; label: string; targets: Where[]; augs: Aug[]; holdout?: boolean }[] = [
  { key: "nnunet-3d", label: "nnU-Net ResEnc M, 3D", targets: ["h200"], augs: ["builtin", "none"] },
  { key: "nnunet-2d", label: "nnU-Net ResEnc M, 2D", targets: ["h200"], augs: ["builtin", "none"] },
  { key: "unet3d", label: "3D U-Net", targets: ["h200", "kaggle"], augs: ALL_AUGS, holdout: true },
  { key: "mednext", label: "MedNeXt", targets: ["h200", "kaggle"], augs: ALL_AUGS },
  { key: "orthogate", label: "OrthoGate-MedNeXt", targets: ["h200", "kaggle"], augs: ALL_AUGS },
  { key: "cnet", label: "C-Net dual U-Net", targets: ["h200", "kaggle"], augs: ALL_AUGS },
  { key: "selftest", label: "Self-test (2 minutes, checks start / stop / continue)", targets: ["h200"], augs: ["none", "max"] },
];

const AUG_LABEL: Record<Aug, string> = {
  builtin: "nnU-Net's own augmentation",
  none: "None",
  low: "Low (mild gamma, +-15 deg, 10% of patches)",
  med: "Medium (nnU-Net strength, +-30 deg, 20% of patches)",
  max: "Max (same + noise, 30-50% of patches)",
};

export interface StartTrainingFormProps {
  methods: MethodSpec[];
  cards: AccountCard[];
  datasetTargets: TargetDatasetStatus[];
  kaggleDatasets: KaggleDatasetOption[];
  tasks: BackgroundTask[];
  selectedMethodId: string;
  selectedTargetId: string;
  selectedDatasetOwner: string;
  augLevel: "none" | "low" | "med" | "max";
  splitMode: "5folds" | "holdout";
  epochs: number;
  startBusy: boolean;
  onMethodChange: (methodId: string) => void;
  onTargetChange: (targetId: string) => void;
  onDatasetOwnerChange: (ownerRoll: string) => void;
  onAugLevelChange: (level: "none" | "low" | "med" | "max") => void;
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
  const [openLog, setOpenLog] = useState<LogTarget | null>(null);
  const mid = selectedMethodId;
  const sel = parseMethod(mid);
  const model = MODELS.find((m) => m.key === sel.model) || MODELS[0];
  const currentSelectedMethod = methods.find((m) => m.id === mid);
  const currentSelectedTarget = cards.find((c) => c.id === selectedTargetId) || cards[0];

  const platform = currentSelectedTarget?.platform;
  // Only accounts this model can run on.
  const validCards = cards.filter(
    (c) =>
      model.targets.includes(c.platform as Where) ||
      (c.platform === "local" && model.key === "unet3d" && !sel.holdout && sel.aug !== "none"),
  );
  useEffect(() => {
    if (validCards.length > 0 && !validCards.some((c) => c.id === selectedTargetId)) {
      onTargetChange(validCards[0].id);
    }
  }, [selectedMethodId, selectedTargetId, validCards.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // The fixed 80/20 split exists on the H200 only.
  useEffect(() => {
    if (platform === "kaggle" && sel.holdout) onMethodChange(methodIdFor(model.key, sel.aug, false));
  }, [platform, sel.holdout]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickModel = (key: string) => {
    const next = MODELS.find((m) => m.key === key) || MODELS[0];
    const aug: Aug = next.augs.includes(sel.aug) ? sel.aug : next.augs.includes("med") ? "med" : next.augs[0];
    onMethodChange(methodIdFor(next.key, aug, Boolean(next.holdout) && sel.holdout));
  };
  const pickAug = (aug: Aug) => {
    if (aug !== "builtin") onAugLevelChange(aug);
    onMethodChange(methodIdFor(model.key, aug, sel.holdout));
  };

  const augText = sel.aug === "builtin" ? "nnU-Net's own augmentation" : sel.aug === "none" ? "no augmentation" : `augmentation ${sel.aug}`;
  const methodRuns = model.key === "selftest"
    ? `12 cases, 2 folds, at most 1.5 minutes of training per job, ${augText}. Press Continue next part once to check resume.`
    : model.key.startsWith("nnunet")
    ? `5 folds x 100 epochs, ${augText}. Each job stops at 3 h 45 m; Continue carries on.`
    : platform === "kaggle"
    ? `${model.label} with the Kaggle settings for this architecture, ${augText}.`
    : model.key === "unet3d"
    ? sel.holdout
      ? `one round on the fixed 80/20 split, ${augText}. The split is made automatically the first time and never changes.`
      : `patient-level 5-fold cross-validation, ${augText}.`
    : `${model.label} on the H200 with the 3D U-Net settings (patch 160x160x16, batch 4), patient-level 5-fold cross-validation, ${augText}. Not run on the H200 before: if the 18 GB slice is too small the card shows the error.`;
  const showEpochInput = platform === "h200" && model.key !== "selftest" && !model.key.startsWith("nnunet");
  const epochsText = model.key === "selftest"
    ? "As many as fit in 1.5 minutes"
    : model.key.startsWith("nnunet")
    ? "100 per fold (fixed by nnU-Net ResEnc M)"
    : platform === "h200"
    ? `${epochs} per fold, over as many parts of at most 3 h 45 m as it takes`
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
      <LogModal target={openLog} onClose={() => setOpenLog(null)} />
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
            1. Select Model
          </label>
          <select
            value={model.key}
            onChange={(e) => pickModel(e.target.value)}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold cursor-pointer"
          >
            {MODELS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label} ({m.targets.map((t) => t.toUpperCase()).join(" or ")})
              </option>
            ))}
          </select>
          {currentSelectedMethod?.tests && (
            <p className="mt-1 text-[11px] text-muted-foreground">Tests: {currentSelectedMethod.tests}</p>
          )}
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

        {/* Augmentation: the user's choice for every model */}
        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
            Augmentation
          </label>
          <select
            value={sel.aug}
            onChange={(e) => pickAug(e.target.value as Aug)}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold cursor-pointer"
          >
            {model.augs.map((a) => (
              <option key={a} value={a}>
                {AUG_LABEL[a]}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {model.key.startsWith("nnunet")
              ? "nnU-Net has one built-in augmentation, so the choice is on or off. Each choice trains into its own folder."
              : model.key === "selftest"
              ? "The self-test checks the path with augmentation off or at max."
              : "Augmentation is applied live during training. Each level trains into its own folder, so runs can be compared."}
          </p>
        </div>

        {/* Validation split */}
        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
            Validation Split
          </label>
          <select
            value={sel.holdout ? "holdout" : "5folds"}
            disabled={!model.holdout || platform === "kaggle"}
            onChange={(e) => onMethodChange(methodIdFor(model.key, sel.aug, e.target.value === "holdout"))}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <option value="5folds">5-Fold Patient Cross-Validation</option>
            <option value="holdout">Fixed 80/20 Holdout Split</option>
          </select>
          {(!model.holdout || platform === "kaggle") && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              The fixed 80/20 split is wired for the 3D U-Net on the H200 only.
            </p>
          )}
        </div>

        {/* Epochs: fixed per method so runs stay comparable and inside the H200 job limit */}
        <div className="sm:col-span-2">
          <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
            Epochs
          </label>
          {showEpochInput ? (
            <div className="space-y-1">
              <input
                type="number"
                min={10}
                max={400}
                step={10}
                value={epochs}
                onChange={(e) => onEpochsChange(Math.max(10, Math.min(400, Math.round(Number(e.target.value) || 100))))}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold"
              />
              <p className="text-[10px] text-muted-foreground">
                Epochs per fold, 10 to 400. One epoch is about 2.3 min on the H200 slice, so 100 epochs x 5 folds is about 19 h, or 5 parts. A run keeps its count for every part. nnU-Net uses 100 per fold.
              </p>
            </div>
          ) : (
            <div className="w-full rounded-xl border border-border bg-muted/30 px-3 py-2 text-xs font-semibold text-muted-foreground">
              {epochsText}
            </div>
          )}
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
              <TerminalBox
                title={`${l.type} - ${l.target}`}
                prompt={`this-pc:bme$ pnpm h200 ${l.type === "setup" ? "setup" : "start"} --as ${l.target.replace("h200-", "")}`}
                lines={l.log && l.log.length ? l.log.slice(-40) : [l.message || ""]}
                live={l.status === "running"}
                onOpen={() =>
                  setOpenLog({
                    title: `${l.type} - ${cards.find((c) => c.id === l.target)?.label || l.target}`,
                    prompt: "this-pc:bme$",
                    lines: l.log && l.log.length ? l.log : [l.message || ""],
                    live: l.status === "running",
                  })
                }
              />
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
          <span>Recorded with each run: who started it (the person at this PC), the account used, this PC's name and the time.</span>
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
