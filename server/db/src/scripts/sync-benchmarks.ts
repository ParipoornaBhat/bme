import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";
import { db } from "../client.js";
import { modelBenchmarkRun } from "../schema/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../..");

dotenv.config({ path: path.resolve(repoRoot, ".env") });

interface BenchmarkFile {
  generated_at?: string;
  architectures?: Record<string, unknown>;
  runs: Array<{
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
    fp_per_neg_case: number | null;
    bone_precision: number | null;
    bone_recall: number | null;
    bone_f1: number | null;
    bone_iou: number | null;
    edema_precision: number | null;
    edema_recall: number | null;
    edema_f1: number | null;
    edema_iou: number | null;
    final_loss: number | null;
    amp_skipped_pct: number | null;
    patch_size: string | null;
    spacing_mm: string | null;
    norm_type: string | null;
    architecture_detail: unknown;
    hyperparams: unknown;
    per_fold_metrics: unknown;
    summary_note: string | null;
    trained_at: string | null;
  }>;
}

async function main() {
  const jsonPath = path.join(repoRoot, "docs", "benchmark_runs.json");
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`Missing benchmark report JSON at ${jsonPath}`);
  }
  const payload = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as BenchmarkFile;
  console.log(`Seeding ${payload.runs.length} benchmark runs into PostgreSQL model_benchmark_run...`);

  let upserted = 0;
  for (const r of payload.runs) {
    const row = {
      runKey: r.run_key,
      pipeline: r.pipeline,
      modelArch: r.model_arch,
      displayName: r.display_name,
      status: r.status ?? "completed",
      isActiveModel: Boolean(r.is_active_model),
      versionLabel: r.version_label ?? null,
      computeTarget: r.compute_target ?? null,
      nCases: r.n_cases ?? null,
      nBme: r.n_bme ?? null,
      nNegative: r.n_negative ?? null,
      folds: r.folds ?? null,
      epochs: r.epochs ?? null,
      presenceCorrect: r.presence_correct ?? null,
      presenceN: r.presence_n ?? null,
      boneDice: r.bone_dice ?? null,
      bmeDice: r.bme_dice ?? null,
      bmeDicePos: r.bme_dice_pos ?? null,
      lesionSensitivity: r.lesion_sensitivity ?? null,
      lesionSensitivityPos: r.lesion_sensitivity_pos ?? null,
      cleanScanSpecificity: r.clean_scan_specificity ?? null,
      fpPerCase: r.fp_per_case ?? null,
      fpPerNegCase: r.fp_per_neg_case ?? null,
      bonePrecision: r.bone_precision ?? null,
      boneRecall: r.bone_recall ?? null,
      boneF1: r.bone_f1 ?? null,
      boneIou: r.bone_iou ?? null,
      edemaPrecision: r.edema_precision ?? null,
      edemaRecall: r.edema_recall ?? null,
      edemaF1: r.edema_f1 ?? null,
      edemaIou: r.edema_iou ?? null,
      finalLoss: r.final_loss ?? null,
      ampSkippedPct: r.amp_skipped_pct ?? null,
      patchSize: r.patch_size ?? null,
      spacingMm: r.spacing_mm ?? null,
      normType: r.norm_type ?? null,
      architectureDetail: r.architecture_detail ?? null,
      hyperparams: r.hyperparams ?? null,
      perFoldMetrics: r.per_fold_metrics ?? null,
      summaryNote: r.summary_note ?? null,
      trainedAt: r.trained_at ? new Date(r.trained_at) : null,
    };

    await db
      .insert(modelBenchmarkRun)
      .values(row)
      .onConflictDoUpdate({
        target: modelBenchmarkRun.runKey,
        set: {
          ...row,
          updatedAt: new Date(),
        },
      });
    upserted += 1;
  }

  console.log(`✅ Successfully synced ${upserted} benchmark runs into PostgreSQL.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Benchmark sync failed:", err);
  process.exit(1);
});

