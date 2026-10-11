import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const dynamic = "force-dynamic";

const ALLOWED_ACTIONS = [
  "preflight",
  "upload",
  "launch",
  "status",
  "download",
  "import",
] as const;

type ActionType = (typeof ALLOWED_ACTIONS)[number];

const API =
  process.env.EXPO_PUBLIC_SERVER_URL ||
  process.env.NEXT_PUBLIC_SERVER_URL ||
  "http://localhost:4000";

async function verifyAdminAuth(req?: NextRequest | Request): Promise<boolean> {
  if (!req) return false;
  const cookie = req.headers.get("cookie") ?? "";
  if (!cookie.includes("session_token")) return false;

  try {
    const res = await fetch(`${API}/api/users/profile`, {
      headers: { cookie },
      cache: "no-store",
    });
    if (res.ok) {
      const profile = (await res.json()) as { activeRole?: { name?: string } | null };
      return profile.activeRole?.name === "admin";
    }
  } catch {
    return false;
  }
  return false;
}

function root(): string {
  return path.resolve(process.cwd(), "..", "..");
}

function python(): string {
  const r = root();
  const local =
    process.platform === "win32"
      ? path.join(r, "ml", ".venv", "Scripts", "python.exe")
      : path.join(r, "ml", ".venv", "bin", "python");
  return fs.existsSync(local) ? local : process.platform === "win32" ? "python" : "python3";
}

function getStagingDir(): string {
  const r = root();
  const raw = process.env.KAGGLE_STAGING_DIR;
  const staging = raw ? path.resolve(raw) : path.resolve(r, "..", "bme_kaggle_staging");

  // Refuse if staging dir is inside repository or data/
  const dataDir = path.join(r, "data");
  if (staging === r || staging.startsWith(r + path.sep) || staging === dataDir || staging.startsWith(dataDir + path.sep)) {
    throw new Error("KAGGLE_STAGING_DIR must be strictly outside repository and data/ directory");
  }
  return staging;
}

function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const error = err as { code?: string };
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    return false;
  }
}

interface LockInfo {
  pid: number;
  action: ActionType;
  startedAt: number;
}

function getActiveLock(stagingDir: string): LockInfo | null {
  const lockFile = path.join(stagingDir, "kaggle.lock.json");
  if (!fs.existsSync(lockFile)) return null;

  try {
    const content = JSON.parse(fs.readFileSync(lockFile, "utf8")) as LockInfo;
    if (content.pid && isPidAlive(content.pid)) {
      return content;
    }
    // Stale lock: remove it
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // ignore
    }
  } catch {
    // Malformed lock
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // ignore
    }
  }
  return null;
}

export async function GET(req: NextRequest) {
  if (!(await verifyAdminAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let stagingDir: string;
  try {
    stagingDir = getStagingDir();
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  const lock = getActiveLock(stagingDir);
  const logFile = path.join(stagingDir, "kaggle.log");
  const rawLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
  const log = rawLog.length > 10000 ? rawLog.slice(-10000) : rawLog;

  return NextResponse.json({
    running: lock !== null,
    action: lock?.action ?? null,
    startedAt: lock?.startedAt ?? null,
    pid: lock?.pid ?? null,
    log,
    stagingDir,
  });
}

export async function POST(req: NextRequest) {
  if (!(await verifyAdminAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let stagingDir: string;
  try {
    stagingDir = getStagingDir();
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  const active = getActiveLock(stagingDir);
  if (active) {
    return NextResponse.json(
      { error: `Another Kaggle task (${active.action}) is already running (PID ${active.pid})` },
      { status: 409 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const action = body.action as ActionType;

  if (!ALLOWED_ACTIONS.includes(action)) {
    return NextResponse.json(
      { error: `Invalid action. Must be one of: ${ALLOWED_ACTIONS.join(", ")}` },
      { status: 400 }
    );
  }

  const r = root();
  const scriptPath = path.join(r, "ml", "scripts", "kaggle_pipeline.py");
  if (!fs.existsSync(scriptPath)) {
    return NextResponse.json({ error: "kaggle_pipeline.py script not found" }, { status: 500 });
  }

  // Construct CLI argument array strictly (no shell execution)
  const cliArgs: string[] = ["-u", scriptPath, action, "--src", r];

  if (action === "preflight" || action === "upload") {
    if (typeof body.exportDir === "string" && body.exportDir.trim()) {
      cliArgs.push("--export-dir", body.exportDir.trim());
    }
    if (typeof body.mappingFile === "string" && body.mappingFile.trim()) {
      cliArgs.push("--mapping-file", body.mappingFile.trim());
    }
    if (action === "upload" && body.confirmUpload === true) {
      cliArgs.push("--confirm-upload");
    }
  }

  if (action === "launch") {
    if (body.confirmLaunch === true) {
      cliArgs.push("--confirm-launch");
    }
    if (body.full === true) {
      cliArgs.push("--full");
    }
  }

  if (action === "download" || action === "import") {
    cliArgs.push("--staging-dir", stagingDir);
  }

  fs.mkdirSync(stagingDir, { recursive: true });
  const logFile = path.join(stagingDir, "kaggle.log");
  const logFd = fs.openSync(logFile, action === "status" ? "a" : "w");

  const child = spawn(python(), cliArgs, {
    cwd: r,
    shell: false,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      KAGGLE_STAGING_DIR: stagingDir,
    },
  });

  child.unref();

  if (child.pid) {
    const lockFile = path.join(stagingDir, "kaggle.lock.json");
    fs.writeFileSync(
      lockFile,
      JSON.stringify(
        {
          pid: child.pid,
          action,
          startedAt: Date.now(),
        },
        null,
        2
      )
    );
  }

  return NextResponse.json({
    ok: true,
    action,
    pid: child.pid,
  });
}

export async function DELETE(req: NextRequest) {
  if (!(await verifyAdminAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let stagingDir: string;
  try {
    stagingDir = getStagingDir();
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  const lock = getActiveLock(stagingDir);
  const lockFile = path.join(stagingDir, "kaggle.lock.json");

  if (!lock) {
    return NextResponse.json({ ok: true, note: "nothing running" });
  }

  try {
    process.kill(lock.pid);
  } catch {
    // already dead
  }

  try {
    fs.unlinkSync(lockFile);
  } catch {
    // ignore
  }

  return NextResponse.json({ ok: true, stopped: lock.pid, action: lock.action });
}
