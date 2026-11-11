"use client";

interface StatSummary {
  mean: number;
  std: number;
}

interface KaggleRunSummaryProps {
  runMetrics: any;
  runState?: {
    run_id?: string;
    mode?: string;
    dest_dir?: string;
  } | null;
}

function fmtMeanStd(s: StatSummary | null | undefined, digits = 3): string {
  if (!s || s.mean == null) return "N/A";
  return `${s.mean.toFixed(digits)} ± ${Number(s.std ?? 0).toFixed(digits)}`;
}

function formatMixLabel(mix: Record<string, number> | null | undefined): string {
  if (!mix) return "Lesion-Focus Mix";
  const parts: string[] = [];
  if (mix.lesion != null) parts.push(`${Math.round(mix.lesion * 100)}% BME`);
  if (mix.bone != null && mix.bone > 0) parts.push(`${Math.round(mix.bone * 100)}% Bone`);
  if (mix.random != null) parts.push(`${Math.round(mix.random * 100)}% Random`);
  return parts.length ? `Sampling Mix (${parts.join(" / ")})` : "Lesion-Focus Mix";
}

export function KaggleRunSummary({ runMetrics, runState }: KaggleRunSummaryProps) {
  if (!runMetrics) return null;

  const s = runMetrics.summary || {};
  const hasPosDice = s.bme_dice_pos?.mean != null;
  const hasPosSens = s.lesion_sensitivity_pos?.mean != null;
  const hasSpec = s.clean_scan_specificity?.mean != null;

  return (
    <div className="rounded-xl border border-border bg-gradient-to-b from-card to-background p-4 sm:p-5 shadow-sm space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border/60 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" />
            <h4 className="text-sm sm:text-base font-bold text-foreground">
              Kaggle Training Run Results ({runMetrics.epochs ?? 2} Epochs, {runMetrics.folds ?? 5} Folds)
            </h4>
            <span className="rounded bg-primary/10 border border-primary/20 px-2 py-0.5 text-[10px] font-mono text-primary font-semibold uppercase">
              {runState?.mode ?? "quick"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Run ID: <code className="font-mono text-foreground font-semibold">{runState?.run_id ?? "latest"}</code> · Device:{" "}
            <span className="uppercase">{runMetrics.device ?? "CUDA"}</span>
          </p>
        </div>
        {runState?.dest_dir && (
          <span className="text-[11px] text-muted-foreground font-mono truncate max-w-xs">
            Archived to: {runState.dest_dir.split(/[/\\]/).slice(-1)[0]}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-emerald-500 font-medium">
          ✓ 3D Augmentation (Flip, Intensity, Noise)
        </span>
        <span className="inline-flex items-center gap-1 rounded-md bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 text-blue-500 font-medium">
          ✓ Dynamic Epoch Resampling
        </span>
        <span className="inline-flex items-center gap-1 rounded-md bg-purple-500/10 border border-purple-500/20 px-2 py-0.5 text-purple-500 font-medium">
          ✓ {formatMixLabel(runMetrics.sampling_mix)}
        </span>
      </div>

      {/* Full Clinical Metrics Grid (Positives-Only + Cohort Overall + Specificity) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Bone Dice</span>
          <div className="text-base sm:text-lg font-bold text-foreground">{fmtMeanStd(s.bone_dice)}</div>
          <p className="text-[10px] text-muted-foreground">Overlap with bone cortex</p>
        </div>

        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">BME Dice (Positives)</span>
          <div className="text-base sm:text-lg font-bold text-emerald-400">
            {hasPosDice ? fmtMeanStd(s.bme_dice_pos) : fmtMeanStd(s.bme_dice)}
          </div>
          <p className="text-[10px] text-muted-foreground">
            {hasPosDice ? "Diseased knees only" : "Lesion overlap"}
          </p>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Overall BME Dice</span>
          <div className="text-base sm:text-lg font-bold text-foreground">{fmtMeanStd(s.bme_dice)}</div>
          <p className="text-[10px] text-muted-foreground">Pos + healthy combined</p>
        </div>

        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-amber-400">Lesion Sensitivity (Pos)</span>
          <div className="text-base sm:text-lg font-bold text-amber-400">
            {hasPosSens
              ? `${(s.lesion_sensitivity_pos.mean * 100).toFixed(1)}%`
              : s.lesion_sensitivity?.mean != null
              ? `${(s.lesion_sensitivity.mean * 100).toFixed(1)}%`
              : "N/A"}
          </div>
          <p className="text-[10px] text-muted-foreground">
            {hasPosSens && s.lesion_sensitivity?.mean != null
              ? `Overall cohort: ${(s.lesion_sensitivity.mean * 100).toFixed(1)}%`
              : "Lesions detected"}
          </p>
        </div>

        <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-sky-400">Control Specificity</span>
          <div className="text-base sm:text-lg font-bold text-sky-400">
            {hasSpec ? `${(s.clean_scan_specificity.mean * 100).toFixed(1)}%` : "N/A"}
          </div>
          <p className="text-[10px] text-muted-foreground">
            {s.fp_per_case?.mean != null ? `FP/case: ${s.fp_per_case.mean.toFixed(2)}` : "Healthy scans clean"}
          </p>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Presence Accuracy</span>
          <div className="text-base sm:text-lg font-bold text-foreground">
            {runMetrics.presence_correct != null && runMetrics.presence_n != null
              ? `${runMetrics.presence_correct}/${runMetrics.presence_n} (${((runMetrics.presence_correct / Math.max(1, runMetrics.presence_n)) * 100).toFixed(0)}%)`
              : "N/A"}
          </div>
          <p className="text-[10px] text-muted-foreground">TP + TN whole-scan match</p>
        </div>
      </div>

      {/* Per-Fold Detail Table */}
      {Array.isArray(runMetrics.per_fold) && runMetrics.per_fold.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="bg-muted/50 px-3 py-2 text-xs font-semibold text-muted-foreground flex items-center justify-between">
            <span>Per-Fold Cross-Validation Scores</span>
            <span className="text-[10px] font-mono">{runMetrics.per_fold.length} Folds Evaluated</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/20 text-muted-foreground text-left font-medium">
                  <th className="p-2.5">Fold</th>
                  <th className="p-2.5">Bone Dice</th>
                  <th className="p-2.5">BME Dice (Pos)</th>
                  <th className="p-2.5">Overall Dice</th>
                  <th className="p-2.5">Sens (Pos)</th>
                  <th className="p-2.5">TNR (Specificity)</th>
                  <th className="p-2.5">FP / Case</th>
                  <th className="p-2.5">Presence Match</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {runMetrics.per_fold.map((f: any, idx: number) => {
                  const sensPos = f.lesion_sensitivity_pos ?? f.lesion_sensitivity;
                  return (
                    <tr key={idx} className="hover:bg-muted/30">
                      <td className="p-2.5 font-semibold font-mono">Fold {f.fold ?? idx}</td>
                      <td className="p-2.5 font-mono">{f.bone_dice != null ? f.bone_dice.toFixed(3) : "—"}</td>
                      <td className="p-2.5 font-mono text-emerald-400 font-semibold">
                        {f.bme_dice_pos != null ? f.bme_dice_pos.toFixed(3) : f.bme_dice != null ? f.bme_dice.toFixed(3) : "—"}
                      </td>
                      <td className="p-2.5 font-mono text-muted-foreground">{f.bme_dice != null ? f.bme_dice.toFixed(3) : "—"}</td>
                      <td className="p-2.5 font-mono text-amber-400">
                        {sensPos != null ? `${(sensPos * 100).toFixed(1)}%` : "—"}
                      </td>
                      <td className="p-2.5 font-mono text-sky-400 font-medium">
                        {f.clean_scan_specificity != null ? `${(f.clean_scan_specificity * 100).toFixed(1)}%` : "—"}
                      </td>
                      <td className="p-2.5 font-mono">{f.fp_per_case != null ? f.fp_per_case.toFixed(2) : "—"}</td>
                      <td className="p-2.5 font-mono">{f.presence_correct != null ? `${f.presence_correct}/${f.presence_n}` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

