import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { desc } from "drizzle-orm";
import { db, modelBenchmarkRun } from "@bme/db";

export const dynamic = "force-dynamic";

function repoRoot() {
  return path.resolve(process.cwd(), "..", "..");
}

function readDocsJson() {
  try {
    const p = path.join(repoRoot(), "docs", "benchmark_runs.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function readDocsMarkdown() {
  try {
    const p = path.join(repoRoot(), "docs", "MODEL_BENCHMARKS_AND_ARCHITECTURES.md");
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function readLiveKaggleState() {
  try {
    const staging = process.env.KAGGLE_STAGING_DIR
      ? path.resolve(repoRoot(), process.env.KAGGLE_STAGING_DIR)
      : path.resolve(repoRoot(), "..", "bme_kaggle_staging");
    const stPath = path.join(staging, "run_state.json");
    if (!fs.existsSync(stPath)) return null;
    return JSON.parse(fs.readFileSync(stPath, "utf8"));
  } catch {
    return null;
  }
}

export async function GET() {
  const docsJson = readDocsJson();
  const markdown = readDocsMarkdown();
  const liveState = readLiveKaggleState();

  let source: "postgres" | "docs-fallback" = "postgres";
  let runs: any[] = [];

  try {
    const rows = await db
      .select()
      .from(modelBenchmarkRun)
      .orderBy(desc(modelBenchmarkRun.trainedAt), desc(modelBenchmarkRun.createdAt));

    runs = rows.map((r) => ({
      run_key: r.runKey,
      pipeline: r.pipeline,
      model_arch: r.modelArch,
      display_name: r.displayName,
      status: r.status,
      is_active_model: r.isActiveModel,
      version_label: r.versionLabel,
      compute_target: r.computeTarget,
      n_cases: r.nCases,
      n_bme: r.nBme,
      n_negative: r.nNegative,
      folds: r.folds,
      epochs: r.epochs,
      presence_correct: r.presenceCorrect,
      presence_n: r.presenceN,
      bone_dice: r.boneDice,
      bme_dice: r.bmeDice,
      bme_dice_pos: r.bmeDicePos,
      lesion_sensitivity: r.lesionSensitivity,
      lesion_sensitivity_pos: r.lesionSensitivityPos,
      clean_scan_specificity: r.cleanScanSpecificity,
      fp_per_case: r.fpPerCase,
      fp_per_neg_case: r.fpPerNegCase,
      bone_precision: r.bonePrecision,
      bone_recall: r.boneRecall,
      bone_f1: r.boneF1,
      bone_iou: r.boneIou,
      edema_precision: r.edemaPrecision,
      edema_recall: r.edemaRecall,
      edema_f1: r.edemaF1,
      edema_iou: r.edemaIou,
      final_loss: r.finalLoss,
      amp_skipped_pct: r.ampSkippedPct,
      patch_size: r.patchSize,
      spacing_mm: r.spacingMm,
      norm_type: r.normType,
      architecture_detail: r.architectureDetail,
      hyperparams: r.hyperparams,
      per_fold_metrics: r.perFoldMetrics,
      summary_note: r.summaryNote,
      trained_at: r.trainedAt ? r.trainedAt.toISOString() : null,
    }));
  } catch {
    source = "docs-fallback";
    runs = Array.isArray(docsJson?.runs) ? [...docsJson.runs].reverse() : [];
  }

  // Overlay live Kaggle run phase if matching
  if (liveState?.run_id) {
    const liveKey = `3d-${liveState.run_id}`;
    const idx = runs.findIndex((r) => r.run_key === liveKey);
    if (idx >= 0 && liveState.phase) {
      const ph = String(liveState.phase).toUpperCase();
      runs[idx] = {
        ...runs[idx],
        status: ph === "COMPLETED" ? "completed" : ph === "FAILED" ? "failed" : "running",
        live_phase: ph,
        live_message: liveState.status_message ?? null,
      };
    }
  }

  return NextResponse.json({
    source,
    total: runs.length,
    generated_at: docsJson?.generated_at ?? new Date().toISOString(),
    architectures: docsJson?.architectures ?? {},
    runs,
    markdown,
    liveState,
  });
}

