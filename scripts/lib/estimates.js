import fs from "node:fs";
import path from "node:path";
import { root } from "./accounts.js";

/** Earlier Kaggle runs from docs/benchmark_runs.json: start is in the run key, end is trained_at. */
export function pastKaggleRuns(arch = "") {
  let runs = [];
  try {
    runs = JSON.parse(fs.readFileSync(path.join(root, "docs", "benchmark_runs.json"), "utf8")).runs || [];
  } catch {
    return [];
  }
  const rows = [];
  for (const r of runs) {
    const m = String(r.run_key).match(/run_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/);
    if (!m || r.status !== "completed" || !r.trained_at) continue;
    const start = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const h = (Date.parse(r.trained_at) - start) / 3.6e6;
    if (!(h > 0.1 && h < 12)) continue;
    rows.push({ arch: r.model_arch, hours: h, text: `${r.model_arch}, ${r.n_cases} scans, ${r.epochs} epochs x ${r.folds} folds: about ${h.toFixed(1)} h` });
  }
  const same = rows.filter((r) => r.arch === arch);
  return (same.length ? same : rows).slice(-3);
}

/** How long a finished run in data/<out> took, if its metrics.json is on this PC. */
export function localRunHours(out) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, "data", out, "metrics.json"), "utf8"));
    return m.hours_taken ?? null;
  } catch {
    return null;
  }
}
