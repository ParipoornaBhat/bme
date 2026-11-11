"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  Download,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";

interface ArchSpec {
  name: string;
  pipeline: string;
  backbone: string;
  blocks: string;
  input_spec: string;
  outputs: string;
  loss: string;
  normalization: string;
  gatekeeper: string;
  postprocessing: string;
  params_approx: string;
  limitations: string;
}

interface BenchmarkRun {
  run_key: string;
  pipeline: string;
  model_arch: string;
  display_name: string;
  status: string;
  is_active_model: boolean;
  version_label: string | null;
  compute_target: string | null;
  n_cases: number | null;
  n_bme: number | null;
  n_negative: number | null;
  folds: number | null;
  epochs: number | null;
  presence_correct: number | null;
  presence_n: number | null;
  bone_dice: number | null;
  bme_dice: number | null;
  bme_dice_pos: number | null;
  lesion_sensitivity: number | null;
  lesion_sensitivity_pos: number | null;
  clean_scan_specificity: number | null;
  fp_per_case: number | null;
  final_loss: number | null;
  amp_skipped_pct: number | null;
  patch_size: string | null;
  spacing_mm: string | null;
  norm_type: string | null;
  hyperparams: Record<string, unknown> | null;
  per_fold_metrics: Array<Record<string, any>> | null;
  summary_note: string | null;
  trained_at: string | null;
  live_phase?: string;
  live_message?: string | null;
}

interface BenchmarksPayload {
  source: "postgres" | "docs-fallback";
  total: number;
  generated_at: string;
  architectures: Record<string, ArchSpec>;
  runs: BenchmarkRun[];
  markdown: string | null;
}

export default function BenchmarksReport() {
  const [data, setData] = useState<BenchmarksPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "3d_seg" | "2d_seg">("all");
  const [expandedRun, setExpandedRun] = useState<string | null>("3d-run_20261110_135412");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/benchmarks", { cache: "no-store" });
      if (res.ok) {
        setData(await res.json());
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const copyMarkdown = async () => {
    if (!data?.markdown) return;
    await navigator.clipboard.writeText(data.markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadFile = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading && !data) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading benchmark ledger from PostgreSQL...
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-sm text-muted-foreground">
        Could not load benchmark report data.
      </div>
    );
  }

  const runs = data.runs.filter((r) => filter === "all" || r.pipeline === filter);
  const liveRun = data.runs.find((r) => r.status === "running");
  const fmtF = (v: number | null, d = 3) => (v != null ? v.toFixed(d) : "—");
  const fmtPct = (v: number | null) => (v != null ? `${(v * 100).toFixed(1)}%` : "—");

  return (
    <div className="space-y-6">
      {/* Header + Export Controls */}
      <div className="rounded-xl border border-border bg-card p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-bold text-foreground">
              Shareable Model Benchmark &amp; Architecture Report
            </h2>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-mono text-primary">
              {data.source === "postgres" ? `PostgreSQL (${data.total} runs)` : `Docs fallback (${data.total} runs)`}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            De-identified historical metrics across all 2D &amp; 3D training experiments, backed by PostgreSQL (<code>model_benchmark_run</code>) and <code>docs/MODEL_BENCHMARKS_AND_ARCHITECTURES.md</code>.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={copyMarkdown}
            disabled={!data.markdown}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-40"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied Markdown" : "Copy Report (.md)"}
          </button>
          <button
            onClick={() => data.markdown && downloadFile(data.markdown, "BME_MODEL_BENCHMARKS_AND_ARCHITECTURES.md", "text/markdown")}
            disabled={!data.markdown}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            Export .md
          </button>
          <button
            onClick={() => downloadFile(JSON.stringify({ architectures: data.architectures, runs: data.runs }, null, 2), "bme_benchmark_runs.json", "application/json")}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent"
          >
            <Download className="h-3.5 w-3.5" />
            Export .json
          </button>
          <button
            onClick={load}
            title="Refresh from DB"
            className="inline-flex items-center gap-1 rounded-md border border-border p-1.5 text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Live Training Status Banner */}
      {liveRun && (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-4 space-y-2 border-l-4 border-l-emerald-500">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-emerald-500 animate-pulse" />
              <span className="text-sm font-bold text-foreground">
                Currently Training: {liveRun.display_name} ({liveRun.version_label ?? liveRun.run_key})
              </span>
              <span className="rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                {liveRun.live_phase ?? liveRun.status.toUpperCase()}
              </span>
            </div>
            <span className="text-xs font-mono text-muted-foreground">
              {liveRun.n_cases} scans ({liveRun.n_bme} pos / {liveRun.n_negative} neg) · {liveRun.folds} folds × {liveRun.epochs} epochs
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{liveRun.summary_note}</p>
        </div>
      )}

      {/* Architecture Catalog */}
      <div className="space-y-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Model Architectures Used Across Project
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {["orthogate_mednext", "cnet_dual_unet", "mednext", "3d-unet", "unet2d", "2d_classifier"]
            .filter((k) => data.architectures[k])
            .map((k) => {
              const a = data.architectures[k];
              const isNew = k === "orthogate_mednext";
              return (
                <div
                  key={k}
                  className={`rounded-lg border p-4 space-y-2 bg-card ${
                    isNew ? "border-emerald-500/40 border-l-4 border-l-emerald-500" : "border-border"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-bold text-sm text-foreground flex items-center gap-1.5">
                      {isNew && <Sparkles className="h-3.5 w-3.5 text-emerald-500" />}
                      {a.name}
                    </div>
                    <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-mono text-muted-foreground">
                      {a.pipeline} · {a.params_approx}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-1 text-xs text-muted-foreground">
                    <div><strong className="text-foreground">Backbone:</strong> {a.backbone}</div>
                    <div><strong className="text-foreground">Blocks:</strong> {a.blocks}</div>
                    <div><strong className="text-foreground">Input / Outputs:</strong> {a.input_spec} → {a.outputs}</div>
                    <div><strong className="text-foreground">Norm / Loss:</strong> {a.normalization} · {a.loss}</div>
                    <div><strong className="text-foreground">Gatekeeper &amp; Post:</strong> {a.gatekeeper} · {a.postprocessing}</div>
                    <div className="text-amber-700 dark:text-amber-300/90"><strong>Limits:</strong> {a.limitations}</div>
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      {/* Run History Table */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            All Verified Training Runs ({runs.length})
          </div>
          <div className="flex gap-1 text-xs">
            {(
              [
                ["all", "All Pipelines"],
                ["3d_seg", "3D Segmentation"],
                ["2d_seg", "2D Segmentation"],
              ] as const
            ).map(([k, lbl]) => (
              <button
                key={k}
                onClick={() => setFilter(k)}
                className={`rounded px-2.5 py-1 font-medium transition ${
                  filter === k
                    ? "bg-primary text-primary-foreground"
                    : "border border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="p-2">Run / Version</th>
                <th className="p-2">Arch</th>
                <th className="p-2">Cohort (Pos/Neg)</th>
                <th className="p-2">Patch / Norm</th>
                <th className="p-2 text-right">Ep</th>
                <th className="p-2 text-right">Bone</th>
                <th className="p-2 text-right">Pos BME</th>
                <th className="p-2 text-right">All BME</th>
                <th className="p-2 text-right">Sens (Pos)</th>
                <th className="p-2 text-right">Control TNR</th>
                <th className="p-2 text-right">FP/Case</th>
                <th className="p-2 text-right">Presence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50 tabular-nums">
              {runs.map((r) => {
                const isOpen = expandedRun === r.run_key;
                const hasDetails = Boolean((r.per_fold_metrics && r.per_fold_metrics.length > 0) || r.summary_note || r.hyperparams);
                return (
                  <Fragment key={r.run_key}>
                    <tr
                      onClick={() => hasDetails && setExpandedRun(isOpen ? null : r.run_key)}
                      className={`cursor-pointer hover:bg-muted/25 ${
                        r.is_active_model ? "bg-emerald-500/5" : r.status === "running" ? "bg-primary/5" : ""
                      }`}
                    >
                      <td className="p-2 font-medium">
                        <div className="flex items-center gap-1.5">
                          {hasDetails && (isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />)}
                          <div>
                            <div className="font-mono text-[11px]">{r.run_key}</div>
                            {r.version_label && (
                              <span
                                className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                  r.is_active_model
                                    ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400"
                                    : r.status === "running"
                                    ? "bg-primary/20 text-primary"
                                    : "bg-muted text-muted-foreground"
                                }`}
                              >
                                {r.version_label}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="p-2 font-mono text-[11px]">{r.model_arch}</td>
                      <td className="p-2">{r.n_cases ?? "—"} ({r.n_bme ?? "?"}/{r.n_negative ?? "?"})</td>
                      <td className="p-2 font-mono text-[11px]">{r.patch_size ?? "—"} / {r.norm_type ?? "—"}</td>
                      <td className="p-2 text-right">{r.epochs ?? "—"}</td>
                      <td className="p-2 text-right">{fmtF(r.bone_dice)}</td>
                      <td className="p-2 text-right font-semibold text-emerald-600 dark:text-emerald-400">{fmtF(r.bme_dice_pos)}</td>
                      <td className="p-2 text-right">{fmtF(r.bme_dice)}</td>
                      <td className="p-2 text-right">{fmtPct(r.lesion_sensitivity_pos ?? r.lesion_sensitivity)}</td>
                      <td className="p-2 text-right">{fmtPct(r.clean_scan_specificity)}</td>
                      <td className="p-2 text-right">{fmtF(r.fp_per_case, 1)}</td>
                      <td className="p-2 text-right font-semibold">
                        {r.presence_n ? `${r.presence_correct}/${r.presence_n}` : r.status === "running" ? "RUNNING" : "—"}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr key={`${r.run_key}-detail`} className="bg-muted/20">
                        <td colSpan={12} className="p-3 space-y-3">
                          {r.summary_note && (
                            <p className="text-xs text-foreground">{r.summary_note}</p>
                          )}
                          {Array.isArray(r.per_fold_metrics) && r.per_fold_metrics.length > 0 && (
                            <div className="overflow-x-auto rounded border border-border bg-card">
                              <table className="w-full text-[11px]">
                                <thead>
                                  <tr className="border-b border-border bg-muted/40 text-left text-[10px] uppercase text-muted-foreground">
                                    <th className="p-1.5">Fold</th>
                                    <th className="p-1.5 text-right">Final Loss</th>
                                    <th className="p-1.5 text-right">Bone Dice</th>
                                    <th className="p-1.5 text-right">Pos BME</th>
                                    <th className="p-1.5 text-right">All BME</th>
                                    <th className="p-1.5 text-right">Sens (Pos)</th>
                                    <th className="p-1.5 text-right">TNR</th>
                                    <th className="p-1.5 text-right">FP/Case</th>
                                    <th className="p-1.5 text-right">AMP Skip</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-border/40 tabular-nums">
                                  {r.per_fold_metrics.map((pf, idx) => (
                                    <tr key={pf.fold ?? idx}>
                                      <td className="p-1.5 font-medium">Fold {pf.fold ?? idx}</td>
                                      <td className="p-1.5 text-right">{pf.final_loss != null ? Number(pf.final_loss).toFixed(4) : "—"}</td>
                                      <td className="p-1.5 text-right">{pf.bone_dice != null ? Number(pf.bone_dice).toFixed(3) : "—"}</td>
                                      <td className="p-1.5 text-right font-semibold">{(pf.bme_dice_pos ?? pf.bme_dice) != null ? Number(pf.bme_dice_pos ?? pf.bme_dice).toFixed(3) : "—"}</td>
                                      <td className="p-1.5 text-right">{(pf.bme_dice ?? pf.lesion_dice) != null ? Number(pf.bme_dice ?? pf.lesion_dice).toFixed(3) : "—"}</td>
                                      <td className="p-1.5 text-right">{(pf.lesion_sensitivity_pos ?? pf.lesion_sensitivity) != null ? `${(Number(pf.lesion_sensitivity_pos ?? pf.lesion_sensitivity) * 100).toFixed(1)}%` : "—"}</td>
                                      <td className="p-1.5 text-right">{pf.clean_scan_specificity != null ? `${(Number(pf.clean_scan_specificity) * 100).toFixed(1)}%` : "—"}</td>
                                      <td className="p-1.5 text-right">{pf.fp_per_case != null ? Number(pf.fp_per_case).toFixed(2) : "—"}</td>
                                      <td className="p-1.5 text-right">{pf.amp_skipped_steps ?? "—"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                          {r.hyperparams && (
                            <details className="text-[11px]">
                              <summary className="cursor-pointer font-semibold text-muted-foreground hover:text-foreground">
                                Hyperparameters &amp; Configuration
                              </summary>
                              <pre className="mt-1.5 overflow-x-auto rounded bg-card border border-border p-2 font-mono text-[10px]">
                                {JSON.stringify(r.hyperparams, null, 2)}
                              </pre>
                            </details>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
