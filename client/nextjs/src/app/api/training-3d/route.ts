import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { conflictingJob } from "~/lib/jobs";
import { MODELS_3D, model3d, model3dInfo, type Model3DId } from "~/lib/models3d";

/**
 * 3D bone and edema training. Separate from the 2D classifier and the 2D U-Net.
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

function dirOf(model: Model3DId) {
  return path.join(root(), "data", model3dInfo(model).out);
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidFile(model: Model3DId) {
  return path.join(dirOf(model), "train.pid");
}

function running(model: Model3DId) {
  const f = pidFile(model);
  if (!fs.existsSync(f)) return false;
  const pid = Number(fs.readFileSync(f, "utf8").trim());
  if (!pid || !alive(pid)) {
    try { fs.unlinkSync(f); } catch { /* gone */ }
    return false;
  }
  return true;
}

function runningModel(): Model3DId | null {
  for (const spec of MODELS_3D) {
    if (running(spec.id)) return spec.id;
  }
  return null;
}

function annotated() {
  const dir = path.join(root(), "data", "annotations");
  const wl = path.join(root(), "data", "worklist.csv");
  const cls = new Map<string, string>();
  if (fs.existsSync(wl)) {
    const lines = fs.readFileSync(wl, "utf8").split(/\r?\n/);
    const head = (lines[0] ?? "").split(",");
    const idCol = head.indexOf("case_id");
    const classCol = head.indexOf("class");
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const c = line.split(",");
      if (idCol >= 0) cls.set(c[idCol], classCol >= 0 ? c[classCol] : "");
    }
  }
  if (!fs.existsSync(dir)) return { cases: [] as { id: string; cls: string }[], bme: 0, nonBme: 0 };
  const cases = fs.readdirSync(dir)
    .filter((id) => fs.existsSync(path.join(dir, id, `${id}.seg.nrrd`)))
    .sort()
    .map((id) => ({ id, cls: cls.get(id) || "" }));
  return {
    cases,
    bme: cases.filter((c) => c.cls === "bme").length,
    nonBme: cases.filter((c) => c.cls === "non_bme").length,
  };
}

function progress(logText: string, startedAt: number | null, folds: number, epochs: number) {
  if (!folds || !epochs) return null;
  const foldMatches = [...logText.matchAll(/fold (\d+):/g)];
  const epochMatches = [...logText.matchAll(/epoch (\d+)\/(\d+)/g)];
  const training = foldMatches.length > 0;
  const currentFold = training ? Number(foldMatches[foldMatches.length - 1][1]) : 0;
  const currentEpoch = epochMatches.length ? Number(epochMatches[epochMatches.length - 1][1]) : 0;
  const doneEpochs = training ? currentFold * epochs + currentEpoch : 0;
  const totalEpochs = folds * epochs;
  const fraction = Math.min(1, training ? doneEpochs / totalEpochs : 0.04);
  let etaSeconds: number | null = null;
  if (startedAt && doneEpochs > 0 && doneEpochs < totalEpochs) {
    const elapsed = (Date.now() - startedAt) / 1000;
    etaSeconds = Math.round((elapsed / doneEpochs) * (totalEpochs - doneEpochs));
  }
  return {
    phase: training ? "Training" : "Loading volumes",
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

export async function GET(req: NextRequest) {
  const model = model3d(new URL(req.url).searchParams.get("model"));
  const dir = dirOf(model);
  const info = annotated();
  let metrics: unknown = null;
  const metricsPath = path.join(dir, "metrics.json");
  if (fs.existsSync(metricsPath)) {
    try { metrics = JSON.parse(fs.readFileSync(metricsPath, "utf8")); } catch { metrics = null; }
  }
  const logPath = path.join(dir, "train.log");
  const rawLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  let job: { startedAt?: number; folds?: number; epochs?: number } = {};
  const jobPath = path.join(dir, "train.job.json");
  try {
    if (fs.existsSync(jobPath)) job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  } catch { /* partial */ }
  const isRunning = running(model);
  const log = rawLog.length > 8000 ? rawLog.slice(-8000) : rawLog;
  return NextResponse.json({
    model,
    out: model3dInfo(model).out,
    annotated: info.cases.length,
    bme: info.bme,
    nonBme: info.nonBme,
    cases: info.cases.map((c) => c.id),
    running: isRunning,
    runningModel: runningModel(),
    metrics,
    log,
    progress: isRunning
      ? progress(rawLog, job.startedAt ?? null, job.folds ?? 0, job.epochs ?? 0)
      : null,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const model = model3d(body.model);
  const spec = model3dInfo(model);
  const live = runningModel();
  if (live) {
    return NextResponse.json({ error: "already training" }, { status: 409 });
  }
  const clash = conflictingJob(spec.kind);
  if (clash) return NextResponse.json({ error: clash.message }, { status: 409 });
  const info = annotated();
  if (info.cases.length < 2) {
    return NextResponse.json(
      { error: "Need at least 2 saved 3D annotations. Paint a case and save it first." },
      { status: 400 },
    );
  }
  const epochs = Math.min(Math.max(Number(body.epochs ?? 40), 1), 200);
  const folds = Math.min(Math.max(Number(body.folds ?? 5), 2), info.cases.length);
  const device = ["auto", "cuda", "cpu"].includes(body.device) ? body.device : "auto";

  const dir = dirOf(model);
  fs.mkdirSync(dir, { recursive: true });
  const log = fs.openSync(path.join(dir, "train.log"), "w");
  const r = root();
  const child = spawn(
    python(),
    ["-u", path.join(r, "ml", "scripts", "train_3d.py"), r,
      "--model", model,
      "--out", spec.out,
      "--epochs", String(epochs),
      "--folds", String(folds),
      "--device", device],
    {
      cwd: r,
      detached: true,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        OMP_NUM_THREADS: "1",
        MKL_NUM_THREADS: "1",
        OPENBLAS_NUM_THREADS: "1",
        NUMEXPR_NUM_THREADS: "1",
        PYTORCH_CUDA_ALLOC_CONF: "max_split_size_mb:128",
      },
    },
  );
  child.unref();
  if (child.pid) fs.writeFileSync(path.join(dir, "train.pid"), String(child.pid));
  fs.writeFileSync(
    path.join(dir, "train.job.json"),
    JSON.stringify({ startedAt: Date.now(), folds, epochs, device, model }, null, 2),
  );
  return NextResponse.json({
    ok: true, pid: child.pid, epochs, folds, cases: info.cases.length, model, out: spec.out,
  });
}

export async function DELETE(req: NextRequest) {
  const asked = new URL(req.url).searchParams.get("model");
  const model = asked ? model3d(asked) : runningModel();
  if (!model) return NextResponse.json({ ok: true, note: "nothing running" });
  const f = pidFile(model);
  if (!fs.existsSync(f)) return NextResponse.json({ ok: true, note: "nothing running" });
  const pid = Number(fs.readFileSync(f, "utf8").trim());
  try { process.kill(pid); } catch { /* already exited */ }
  try { fs.unlinkSync(f); } catch { /* gone */ }
  return NextResponse.json({ ok: true, stopped: pid, model });
}
