import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { readSelected } from "~/lib/selectedModel";
import { torchDevice } from "~/lib/torchDevice";
import { spawn } from "node:child_process";

/**
 * Training control: list past runs, and launch a new one.
 *
 * ARCHITECTURE CHOICE IS A FIXED LIST, not free text. Every entry ships inside
 * torchvision, so switching model needs no installation. Accepting an arbitrary
 * package name here and pip-installing it would be remote code execution on
 * four teammates' machines — to add a model, add it to ARCHS in train_2d.py.
 *
 * Runs are spawned detached and write into data/results2d/runs/<stamp>_<arch>/.
 * Progress is polled from the log file rather than streamed, which keeps this
 * route stateless and survives a page reload mid-training.
 */

export const dynamic = "force-dynamic";

const ARCHS = [
  "resnet18", "resnet34", "resnet50",
  "efficientnet_b0", "densenet121", "convnext_tiny", "mobilenet_v3_small",
] as const;

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

function listRuns() {
  const dir = path.join(root(), "data", "results2d", "runs");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((name) => {
      const f = path.join(dir, name, "metrics.json");
      if (!fs.existsSync(f)) return null;
      try {
        const m = JSON.parse(fs.readFileSync(f, "utf8"));
        return {
          id: name,
          arch: m.arch ?? "unknown",
          folds: m.folds,
          epochs: m.epochs,
          finishedAt: m.finished_at ?? null,
          nSlices: m.n_slices,
          nCases: m.n_cases,
          case: m.case_level,
          slice: m.slice_level,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b!.id).localeCompare(String(a!.id)));
}

const LOG = () => path.join(root(), "data", "results2d", "train.log");
const PID = () => path.join(root(), "data", "results2d", "train.pid");

function running() {
  const pidFile = PID();
  if (!fs.existsSync(pidFile)) return null;
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  if (!pid) return null;
  try {
    process.kill(pid, 0); // signal 0 = existence check, does not kill
    return pid;
  } catch {
    try { fs.unlinkSync(pidFile); } catch { /* already gone */ }
    return null;
  }
}

const JOB = () => path.join(root(), "data", "results2d", "train.job.json");

/**
 * Progress from the log text.
 *
 * train_2d.py prints "fold N:" then "epoch X/Y" per fold, so total work is
 * folds x epochs and completed work is countable. ETA comes from elapsed time
 * per finished epoch — crude, but epochs here are near-identical in cost, so it
 * lands within a minute or so and is far better than no estimate at all.
 */
function progressFrom(logText: string, startedAt: number | null, folds: number, epochs: number) {
  const foldMatches = [...logText.matchAll(/fold (\d+):/g)];
  const epochMatches = [...logText.matchAll(/epoch (\d+)\/(\d+)/g)];
  if (!folds || !epochs) return null;

  const currentFold = foldMatches.length ? Number(foldMatches[foldMatches.length - 1][1]) : 0;
  const currentEpoch = epochMatches.length ? Number(epochMatches[epochMatches.length - 1][1]) : 0;
  const doneEpochs = currentFold * epochs + currentEpoch;
  const totalEpochs = folds * epochs;
  const fraction = Math.min(1, doneEpochs / totalEpochs);

  let etaSeconds: number | null = null;
  if (startedAt && doneEpochs > 0 && fraction < 1) {
    const elapsed = (Date.now() - startedAt) / 1000;
    etaSeconds = Math.round((elapsed / doneEpochs) * (totalEpochs - doneEpochs));
  }
  return {
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

export async function GET() {
  const log = LOG();
  let tail = "";
  if (fs.existsSync(log)) {
    // Split on \r as well as \n: the torchvision weight download writes its
    // progress with carriage returns, so a \n-only split leaves one enormous
    // line of "17.8%19.1%20.3%…" that hides the actual training output.
    const txt = fs.readFileSync(log, "utf8");
    tail = txt
      .split(/[\r\n]+/)
      .map((l) => l.trimEnd())
      .filter((l) => l && !/^[\d.]+%$/.test(l) && !/^Downloading:/.test(l))
      .slice(-40)
      .join("\n");
  }
  let job: { arch?: string; folds?: number; epochs?: number; startedAt?: number } = {};
  try {
    if (fs.existsSync(JOB())) job = JSON.parse(fs.readFileSync(JOB(), "utf8"));
  } catch { /* stale or partial job file */ }

  const isRunning = running() !== null;
  const rawLog = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";

  return NextResponse.json({
    archs: ARCHS,
    runs: listRuns(),
    selected: readSelected(),
    torch: torchDevice(),
    running: isRunning,
    log: tail,
    job: isRunning ? job : null,
    progress: isRunning
      ? progressFrom(rawLog, job.startedAt ?? null, job.folds ?? 0, job.epochs ?? 0)
      : null,
  });
}

export async function POST(req: NextRequest) {
  if (running() !== null) {
    return NextResponse.json({ error: "a training run is already in progress" }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const arch = String(body.arch ?? "resnet18");
  const folds = Math.min(Math.max(Number(body.folds ?? 5), 2), 10);
  const epochs = Math.min(Math.max(Number(body.epochs ?? 6), 1), 50);
  const him = Boolean(body.him);
  const tta = Boolean(body.tta);

  const freeze = body.freeze !== undefined && body.freeze !== null && body.freeze !== "" ? Math.max(0, Number(body.freeze)) : null;
  const device = ["auto", "cuda", "cpu"].includes(body.device) ? body.device : "auto";
  const patience = body.patience !== undefined && body.patience !== null && body.patience !== "" ? Math.max(1, Number(body.patience)) : null;

  if (!ARCHS.includes(arch as (typeof ARCHS)[number])) {
    return NextResponse.json({ error: `unsupported arch: ${arch}` }, { status: 400 });
  }

  const r = root();
  const outDir = path.join(r, "data", "results2d");
  fs.mkdirSync(outDir, { recursive: true });
  const log = fs.openSync(LOG(), "w");

  const child = spawn(
    python(),
    // -u is load-bearing: without unbuffered output Python holds every print
    // until the process exits, so the live log stays empty for the whole run
    // and the progress view is useless exactly when it is wanted.
    ["-u", path.join(r, "ml", "scripts", "train_2d.py"), r,
     "--arch", arch, "--folds", String(folds), "--epochs", String(epochs),
     ...(freeze !== null ? ["--freeze", String(freeze)] : []),
     ...(patience !== null ? ["--patience", String(patience)] : []),
     "--device", device,
     ...(him ? ["--dataset", "slices2d_him"] : []),
     ...(tta ? ["--tta"] : [])],
    { cwd: r, detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();
  if (child.pid) fs.writeFileSync(PID(), String(child.pid));
  fs.writeFileSync(
    JOB(),
    JSON.stringify({ arch, folds, epochs, him, tta, freeze, patience, device, startedAt: Date.now(), pid: child.pid }),
  );

  return NextResponse.json({ ok: true, pid: child.pid, arch, folds, epochs, him, tta, freeze, patience, device });
}

/**
 * DELETE with ?run=<id> removes one archived run; ?run=all clears the history.
 * Without a run parameter it stops the training process instead.
 *
 * Deleting a run removes only its metrics folder under data/results2d/runs/.
 * The dataset, annotations and slice images are never touched.
 */
export async function DELETE(req: NextRequest) {
  const target = new URL(req.url).searchParams.get("run");

  if (target) {
    const runsDir = path.join(root(), "data", "results2d", "runs");
    if (!fs.existsSync(runsDir)) return NextResponse.json({ ok: true, deleted: 0 });

    if (target === "all") {
      const names = fs.readdirSync(runsDir);
      for (const n of names) fs.rmSync(path.join(runsDir, n), { recursive: true, force: true });
      return NextResponse.json({ ok: true, deleted: names.length });
    }
    // Guard the path: only a name that is actually a direct child of runs/.
    if (target.includes("/") || target.includes("\\") || target.includes("..")) {
      return NextResponse.json({ error: "bad run id" }, { status: 400 });
    }
    const dir = path.join(runsDir, target);
    if (!fs.existsSync(dir)) return NextResponse.json({ error: "no such run" }, { status: 404 });
    fs.rmSync(dir, { recursive: true, force: true });
    return NextResponse.json({ ok: true, deleted: 1 });
  }

  const pid = running();
  if (pid === null) return NextResponse.json({ ok: true, note: "nothing running" });
  try {
    process.kill(pid);
  } catch { /* already exited */ }
  try { fs.unlinkSync(PID()); } catch { /* already gone */ }
  return NextResponse.json({ ok: true, stopped: pid });
}
