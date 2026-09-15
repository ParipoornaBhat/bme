import fs from "node:fs";
import path from "node:path";

/**
 * Which trained run is "the" model.
 *
 * Cross-validation leaves one folder per run under data/results2d/runs/, and
 * nothing in there says which one we stand behind. The training page and the
 * results page each showed whatever ran last, which is not the same question —
 * the last run is usually a throwaway sweep arm, not the one for the report.
 *
 * The choice lives in ONE file, data/results2d/selected.json, and every page
 * reads it through this module. That is the whole design: there is no second
 * copy to drift. Marking a run anywhere changes the same file, so every other
 * view agrees on its next load.
 *
 * A selection pointing at a deleted run resolves to null rather than throwing,
 * so clearing the history cannot strand the dashboard on metrics that are gone.
 */

// A run id is a directory name we wrote: <timestamp>_<arch>. Anything holding a
// separator is refused rather than sanitised — this value indexes into the
// filesystem and has no legitimate reason to contain a path.
const RUN_ID = /^[A-Za-z0-9._-]+$/;

export function projectRoot() {
  // client/nextjs -> repo root
  return path.resolve(process.cwd(), "..", "..");
}

export function selectionFile() {
  return path.join(projectRoot(), "data", "results2d", "selected.json");
}

export function runsDir() {
  return path.join(projectRoot(), "data", "results2d", "runs");
}

export function isRunId(id: string) {
  return RUN_ID.test(id);
}

export function runExists(id: string) {
  return isRunId(id) && fs.existsSync(path.join(runsDir(), id, "metrics.json"));
}

/** The explicitly selected run id, or null if unset or pointing at something gone. */
export function readSelected(): string | null {
  try {
    const f = selectionFile();
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const id = typeof j?.run === "string" ? j.run : null;
    return id && runExists(id) ? id : null;
  } catch {
    return null;
  }
}

export function writeSelected(run: string) {
  const f = selectionFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(
    f,
    JSON.stringify({ run, selectedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
}

export function clearSelected() {
  try {
    fs.rmSync(selectionFile(), { force: true });
  } catch {
    /* nothing to clear */
  }
}

/**
 * Metrics for the selected run, falling back to the most recent one.
 *
 * `explicit` distinguishes "somebody chose this" from "nothing is chosen, here
 * is the newest". The UI must not present the fallback as a decision.
 */
export function selectedMetrics(): {
  id: string | null;
  explicit: boolean;
  metrics: Record<string, unknown> | null;
} {
  const chosen = readSelected();
  let id = chosen;

  if (!id) {
    try {
      id =
        fs
          .readdirSync(runsDir())
          .filter((n) => fs.existsSync(path.join(runsDir(), n, "metrics.json")))
          .sort((a, b) => b.localeCompare(a))[0] ?? null;
    } catch {
      id = null;
    }
  }

  if (!id) return { id: null, explicit: false, metrics: null };
  try {
    const m = JSON.parse(
      fs.readFileSync(path.join(runsDir(), id, "metrics.json"), "utf8"),
    );
    return { id, explicit: Boolean(chosen), metrics: m };
  } catch {
    return { id: null, explicit: false, metrics: null };
  }
}
