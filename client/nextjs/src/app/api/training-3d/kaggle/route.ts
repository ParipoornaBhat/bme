import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

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

const DIR = () => path.join(root(), "data", "results3d");
const KAGGLE_LOG = () => path.join(DIR(), "kaggle.log");
const KAGGLE_PID = () => path.join(DIR(), "kaggle.pid");
const KAGGLE_STATE = () => path.join(DIR(), "kaggle.state.json");
const METRICS = () => path.join(DIR(), "metrics.json");

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isRunning() {
  const f = KAGGLE_PID();
  if (!fs.existsSync(f)) return false;
  const pid = Number(fs.readFileSync(f, "utf8").trim());
  if (!pid || !alive(pid)) {
    try { fs.unlinkSync(f); } catch { /* gone */ }
    return false;
  }
  return true;
}

export async function GET() {
  fs.mkdirSync(DIR(), { recursive: true });
  const running = isRunning();
  const rawLog = fs.existsSync(KAGGLE_LOG()) ? fs.readFileSync(KAGGLE_LOG(), "utf8") : "";
  const log = rawLog.length > 10000 ? rawLog.slice(-10000) : rawLog;

  let savedState: Record<string, unknown> = {};
  if (fs.existsSync(KAGGLE_STATE())) {
    try {
      savedState = JSON.parse(fs.readFileSync(KAGGLE_STATE(), "utf8"));
    } catch { /* partial */ }
  }

  let metrics: unknown = null;
  if (fs.existsSync(METRICS())) {
    try { metrics = JSON.parse(fs.readFileSync(METRICS(), "utf8")); } catch { metrics = null; }
  }

  return NextResponse.json({
    running,
    log,
    state: savedState,
    metrics,
  });
}

export async function POST(req: NextRequest) {
  if (isRunning()) {
    return NextResponse.json({ error: "Kaggle training watcher is already running" }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const action = body.action || "start"; // "start" or "download"

  fs.mkdirSync(DIR(), { recursive: true });
  const logFd = fs.openSync(KAGGLE_LOG(), "w");
  const r = root();
  const scriptPath = path.join(r, "ml", "scripts", "kaggle_pipeline.py");

  const flag = action === "download" ? "--download" : "--watch";

  const child = spawn(
    python(),
    ["-u", scriptPath, flag],
    {
      cwd: r,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
      },
    }
  );

  child.unref();

  if (child.pid) {
    fs.writeFileSync(KAGGLE_PID(), String(child.pid));
  }

  fs.writeFileSync(
    KAGGLE_STATE(),
    JSON.stringify({ startedAt: Date.now(), action, pid: child.pid }, null, 2)
  );

  return NextResponse.json({ ok: true, action, pid: child.pid });
}

export async function DELETE() {
  const f = KAGGLE_PID();
  if (!fs.existsSync(f)) {
    return NextResponse.json({ ok: true, note: "nothing running" });
  }
  const pid = Number(fs.readFileSync(f, "utf8").trim());
  try { process.kill(pid); } catch { /* ignore */ }
  try { fs.unlinkSync(f); } catch { /* ignore */ }
  return NextResponse.json({ ok: true, stopped: pid });
}

