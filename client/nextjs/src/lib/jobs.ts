import fs from "node:fs";
import path from "node:path";

/**
 * Is a training job already running — either of them.
 *
 * The classifier and the segmenter each kept their own PID file and each
 * checked only its own, so starting one while the other ran was allowed. On a
 * 6 GB laptop GPU that is a real failure: the second process asks for VRAM the
 * first already holds, CUDA refuses, and the run dies with an out-of-memory
 * error partway through. Nothing is corrupted, but an hour of a teammate's
 * afternoon is.
 *
 * Even when both do fit, they time-slice the same device and finish slower
 * together than one after the other. There is no throughput to win here.
 *
 * A stale PID file — the machine was rebooted, the process was killed — is
 * cleaned up rather than treated as a running job, otherwise training would
 * be permanently blocked by a file nobody remembers writing.
 */

export type JobKind = "classifier" | "segmentation";

const PID_FILES: Record<JobKind, string[]> = {
  classifier: ["data", "results2d", "train.pid"],
  segmentation: ["data", "results2dseg", "train.pid"],
};

function projectRoot() {
  return path.resolve(process.cwd(), "..", "..");
}

/** The live PID for one job kind, or null. Clears the file if it is stale. */
export function jobPid(kind: JobKind): number | null {
  const f = path.join(projectRoot(), ...PID_FILES[kind]);
  if (!fs.existsSync(f)) return null;
  const pid = Number(fs.readFileSync(f, "utf8").trim());
  if (!pid) return null;
  try {
    // Signal 0 tests for existence without touching the process.
    process.kill(pid, 0);
    return pid;
  } catch {
    try {
      fs.unlinkSync(f);
    } catch {
      /* already gone */
    }
    return null;
  }
}

/**
 * The other job kind, if it is running. Call before starting a run.
 *
 * Returns a message written for the person who clicked the button, not a
 * status code — they need to know which job is holding the GPU and why that
 * matters.
 */
export function conflictingJob(starting: JobKind): { kind: JobKind; message: string } | null {
  const other: JobKind = starting === "classifier" ? "segmentation" : "classifier";
  if (jobPid(other) === null) return null;
  const name = other === "classifier" ? "Detection" : "Segmentation";
  return {
    kind: other,
    message:
      `${name} training is already running. Both jobs share one GPU, and starting a ` +
      `second can exhaust its memory and kill the run partway through. Wait for it to ` +
      `finish, or stop it first.`,
  };
}
