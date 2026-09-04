import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { torchDevice } from "~/lib/torchDevice";

/**
 * Segmentation training: annotations in, a model that marks edema out.
 *
 * Separate from /api/training because the two answer different questions and
 * have different prerequisites. The classifier needs no labels and can run at
 * any time; this one is blocked until cases have been annotated, and saying so
 * plainly is more useful than a training run that fails three steps in.
 *
 * POST runs ml/scripts/pipeline_seg.py, which chains convert -> build -> train
 * and stops at the first failure rather than training on labels a validator has
 * already rejected.
 */

export const dynamic = "force-dynamic";

function root() {
  return path.resolve(process.cwd(), "..", "..");
}

function python() {
  const r = root();
  const local =
    process.platform === "win32"
      ? path.join(r, "ml", ".venv", "Scripts", "python.exe")
      : path.join(r, "ml", ".venv", "bin", "python");
  return fs.existsSync(local) ? local : process.platform === "win32" ? "python" : "python3";
}

const LOG = () => path.join(root(), "data", "results2dseg", "train.log");
const PID = () => path.join(root(), "data", "results2dseg", "train.pid");
const METRICS = () => path.join(root(), "data", "results2dseg", "metrics.json");
const JOB = () => path.join(root(), "data", "results2dseg", "train.job.json");

/**
 * Progress for the segmentation pipeline.
 *
 * Unlike the classifier this is three programs, not one: convert and validate
 * the annotations, build the image/mask pairs, then train. The first two finish
 * quickly but they are not instant, and reporting 0% through them makes a
 * working run look hung.
 *
 * So the bar is split. The two preparation steps own a small fixed share and
 * the training step owns the rest, subdivided by fold and epoch exactly as the
 * classifier does — train_2d_seg.py prints the same "fold k:" and "epoch n/m"
 * lines, so the parsing is shared in spirit.
 *
 * The ETA is elapsed-per-epoch extrapolated forward. Early on it reads high,
 * because the preparation time is still folded into the average; it converges
 * within a couple of epochs. An ETA before the first epoch would be invented,
 * so none is offered.
 */
const PREP_SHARE = 0.08;

function segProgress(
  logText: string,
  startedAt: number | null,
  folds: number,
  epochs: number,
) {
  if (!folds || !epochs) return null;

  const step = logText.lastIndexOf("3/3");
  const training = step !== -1;
  const phase = training
    ? "Training"
    : logText.includes("2/3")
      ? "Building image/mask pairs"
      : logText.includes("1/3")
        ? "Converting and validating annotations"
        : "Starting";

  // Only count fold/epoch lines emitted by the training step. The earlier steps
  // never print them, but slicing at 3/3 keeps that guarantee explicit.
  const tail = training ? logText.slice(step) : "";
  const foldMatches = [...tail.matchAll(/fold (\d+):/g)];
  const epochMatches = [...tail.matchAll(/epoch (\d+)\/(\d+)/g)];

  const currentFold = foldMatches.length ? Number(foldMatches[foldMatches.length - 1][1]) : 0;
  const currentEpoch = epochMatches.length ? Number(epochMatches[epochMatches.length - 1][1]) : 0;
  const doneEpochs = training ? currentFold * epochs + currentEpoch : 0;
  const totalEpochs = folds * epochs;

  const prepDone = training ? PREP_SHARE : logText.includes("2/3") ? PREP_SHARE * 0.6 : 0;
  const fraction = Math.min(
    1,
    prepDone + (training ? (doneEpochs / totalEpochs) * (1 - PREP_SHARE) : 0),
  );

  let etaSeconds: number | null = null;
  if (startedAt && doneEpochs > 0 && doneEpochs < totalEpochs) {
    const elapsed = (Date.now() - startedAt) / 1000;
    etaSeconds = Math.round((elapsed / doneEpochs) * (totalEpochs - doneEpochs));
  }

  return {
    phase,
    fraction,
    doneEpochs,
    totalEpochs,
    currentFold,
    currentEpoch,
    folds,
    epochs,
    etaSeconds,
    elapsedSeconds: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null,
  };
}

function running() {
  const f = PID();
  if (!fs.existsSync(f)) return false;
  const pid = Number(fs.readFileSync(f, "utf8").trim());
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    try { fs.unlinkSync(f); } catch { /* gone */ }
    return false;
  }
}

/** Cases with a saved annotation — the prerequisite for training at all. */
function annotatedCases(): string[] {
  const dir = path.join(root(), "data", "annotations");
  const cases3d = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((c) => fs.existsSync(path.join(dir, c, `${c}.seg.nrrd`)))
    : [];

  const dir2d = path.join(root(), "data", "annotations2d");
  const cases2d = fs.existsSync(dir2d)
    ? fs.readdirSync(dir2d).filter((c) => {
        const sub = path.join(dir2d, c);
        try {
          return fs.statSync(sub).isDirectory() && fs.readdirSync(sub).some((f) => f.endsWith(".png"));
        } catch {
          return false;
        }
      })
    : [];

  return Array.from(new Set([...cases3d, ...cases2d])).sort();
}

export async function GET() {
  const cases = annotatedCases();
  let metrics: unknown = null;
  if (fs.existsSync(METRICS())) {
    try {
      metrics = JSON.parse(fs.readFileSync(METRICS(), "utf8"));
    } catch {
      metrics = null;
    }
  }
  const rawLog = fs.existsSync(LOG()) ? fs.readFileSync(LOG(), "utf8") : "";
  let job: { startedAt?: number; folds?: number; epochs?: number } = {};
  try {
    if (fs.existsSync(JOB())) job = JSON.parse(fs.readFileSync(JOB(), "utf8"));
  } catch { /* stale or partial job file */ }

  let log = "";
  if (fs.existsSync(LOG())) {
    log = rawLog
      .split(/[\r\n]+/)
      .map((l) => l.trimEnd())
      .filter((l) => l && !/^[\d.]+%$/.test(l))
      .slice(-45)
      .join("\n");
  }
  const isRunning = running();
  return NextResponse.json({
    torch: torchDevice(),
    annotated: cases.length,
    cases,
    running: isRunning,
    metrics,
    log,
    progress: isRunning
      ? segProgress(rawLog, job.startedAt ?? null, job.folds ?? 0, job.epochs ?? 0)
      : null,
  });
}

export async function POST(req: NextRequest) {
  if (running()) {
    return NextResponse.json({ error: "already training" }, { status: 409 });
  }
  const cases = annotatedCases();
  if (cases.length === 0) {
    return NextResponse.json(
      { error: "No annotations yet. Annotate a case on the Annotate page first." },
      { status: 400 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const epochs = Math.min(Math.max(Number(body.epochs ?? 40), 1), 200);
  const folds = Math.min(Math.max(Number(body.folds ?? 5), 2), 10);
  const batch = Math.min(Math.max(Number(body.batch ?? 8), 1), 64);
  const device = ["auto", "cuda", "cpu"].includes(body.device) ? body.device : "auto";

  const r = root();
  fs.mkdirSync(path.join(r, "data", "results2dseg"), { recursive: true });
  const log = fs.openSync(LOG(), "w");

  const child = spawn(
    python(),
    ["-u", path.join(r, "ml", "scripts", "pipeline_seg.py"), r,
     "--epochs", String(epochs), "--folds", String(folds), "--batch", String(batch),
     "--device", device],
    { cwd: r, detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();
  if (child.pid) fs.writeFileSync(PID(), String(child.pid));
  fs.writeFileSync(
    JOB(),
    JSON.stringify({ startedAt: Date.now(), folds, epochs, batch, device }, null, 2),
  );

  return NextResponse.json({ ok: true, pid: child.pid, epochs, folds, batch, cases: cases.length });
}

export async function DELETE() {
  const f = PID();
  if (!fs.existsSync(f)) return NextResponse.json({ ok: true, note: "nothing running" });
  const pid = Number(fs.readFileSync(f, "utf8").trim());
  try { process.kill(pid); } catch { /* already exited */ }
  try { fs.unlinkSync(f); } catch { /* gone */ }
  return NextResponse.json({ ok: true, stopped: pid });
}
