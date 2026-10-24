import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { BUILD_STAMP } from "./buildStamp";

export const dynamic = "force-dynamic";

const ALLOWED_ACTIONS = [
  "doctor",
  "preflight",
  "approve",
  "upload",
  "run",
  "onetap",
  "status",
  "cancel-watch",
  "fetch-results",
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
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "ml"))) {
    return cwd;
  }
  return path.resolve(cwd, "..", "..");
}

function python(): string {
  const r = root();
  const venvPy =
    process.platform === "win32"
      ? path.join(r, "ml", ".venv", "Scripts", "python.exe")
      : path.join(r, "ml", ".venv", "bin", "python");

  if (!fs.existsSync(venvPy)) {
    throw new Error(
      `Python virtual environment not found at ${venvPy}. Run 'python -m venv ml/.venv' and install dependencies.`
    );
  }
  return venvPy;
}

function getStagingDir(): string {
  const r = root();
  const raw = process.env.KAGGLE_STAGING_DIR;
  const staging = raw ? path.resolve(raw) : path.resolve(r, "..", "bme_kaggle_staging");

  // Refuse if staging dir is inside repository or data/
  const dataDir = path.join(r, "data");
  if (
    staging === r ||
    staging.startsWith(r + path.sep) ||
    staging === dataDir ||
    staging.startsWith(dataDir + path.sep)
  ) {
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
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // gone
    }
  } catch {
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // gone
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

  let log = "";
  if (fs.existsSync(logFile)) {
    try {
      const rawLog = fs.readFileSync(logFile, "utf8");
      const lines = rawLog.split(/\r?\n/);
      const tailLines = lines.length > 200 ? lines.slice(-200) : lines;
      log = tailLines.join("\n");
      if (log.length > 10000) {
        log = log.slice(-10000);
      }
    } catch {
      log = "";
    }
  }

  // Read approval record
  let approval: unknown = null;
  const approvalFile = path.join(stagingDir, "dataset_approval.json");
  if (fs.existsSync(approvalFile)) {
    try {
      approval = JSON.parse(fs.readFileSync(approvalFile, "utf8"));
    } catch {
      approval = null;
    }
  }

  // Read run state and metrics
  let runState: any = null;
  let runMetrics: any = null;
  const runStateFile = path.join(stagingDir, "run_state.json");
  if (fs.existsSync(runStateFile)) {
    try {
      runState = JSON.parse(fs.readFileSync(runStateFile, "utf8"));
      if (runState?.run_id) {
        const r = root();
        const candidatePaths = [
          runState.dest_dir ? path.join(runState.dest_dir, "metrics.json") : null,
          path.join(r, "data", "results3d_experiments", runState.run_id, "metrics.json"),
          path.join(stagingDir, "download", runState.run_id, "metrics.json"),
          path.join(stagingDir, "download", runState.run_id, "results3d", "metrics.json"),
        ].filter(Boolean) as string[];

        for (const p of candidatePaths) {
          if (fs.existsSync(p)) {
            try {
              runMetrics = JSON.parse(fs.readFileSync(p, "utf8"));
              break;
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      runState = null;
    }
  }

  return NextResponse.json({
    running: lock !== null,
    action: lock?.action ?? null,
    startedAt: lock?.startedAt ?? null,
    pid: lock?.pid ?? null,
    log,
    stagingDir,
    approval,
    runState,
    runMetrics,
    buildStamp: BUILD_STAMP,
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
  const body = await req.json().catch(() => ({}));
  const action = body.action as ActionType;

  if (!action || !ALLOWED_ACTIONS.includes(action)) {
    return NextResponse.json(
      { error: `Invalid action. Must be one of: ${ALLOWED_ACTIONS.join(", ")}` },
      { status: 400 }
    );
  }

  // Handle cancel-watch
  if (action === "cancel-watch") {
    if (active) {
      try {
        process.kill(active.pid);
      } catch {
        // already stopped
      }
      try {
        fs.unlinkSync(path.join(stagingDir, "kaggle.lock.json"));
      } catch {
        // ignore
      }
      return NextResponse.json({ ok: true, stopped: active.pid });
    }
    return NextResponse.json({ ok: true, note: "nothing running" });
  }

  // Check single-job lock
  if (active) {
    return NextResponse.json(
      { error: `Another Kaggle task (${active.action}) is already running (PID ${active.pid})` },
      { status: 409 }
    );
  }

  // Explicit confirmation checks
  if (action === "approve" && body.confirmApprove !== true) {
    return NextResponse.json(
      { error: "Confirmation required for dataset approval: 'confirmApprove' must be true." },
      { status: 400 }
    );
  }

  if (action === "upload" && body.confirmUpload !== true) {
    return NextResponse.json(
      { error: "Confirmation required for dataset upload: 'confirmUpload' must be true." },
      { status: 400 }
    );
  }

  if (action === "run" && body.confirmLaunch !== true && body.resume !== true) {
    return NextResponse.json(
      { error: "Confirmation required for launching GPU kernel: 'confirmLaunch' must be true." },
      { status: 400 }
    );
  }

  if (action === "onetap" && body.resume !== true) {
    const approvalFile = path.join(stagingDir, "dataset_approval.json");
    const hasApproval = fs.existsSync(approvalFile);
    if (!hasApproval && body.confirmApprove !== true) {
      return NextResponse.json(
        { error: "First-time approval confirmation required: 'confirmApprove' must be true." },
        { status: 400 }
      );
    }
    if (body.confirmLaunch !== true) {
      return NextResponse.json(
        { error: "Confirmation required for launching GPU training: 'confirmLaunch' must be true." },
        { status: 400 }
      );
    }
  }

  const r = root();
  const scriptPath = path.join(r, "ml", "scripts", "kaggle_pipeline.py");
  if (!fs.existsSync(scriptPath)) {
    return NextResponse.json({ error: "kaggle_pipeline.py script not found" }, { status: 500 });
  }

  let pythonPath: string;
  try {
    pythonPath = python();
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  // Build CLI argument array strictly: python -u <script> --src <repo> <subcommand> ...flags
  const cliArgs: string[] = ["-u", scriptPath, "--src", r];

  if (action === "doctor") {
    cliArgs.push("doctor");
    if (body.remote === true) {
      cliArgs.push("--remote");
    }
  } else if (action === "preflight") {
    cliArgs.push("preflight");
    if (typeof body.exportDir === "string" && body.exportDir.trim()) {
      cliArgs.push("--export-dir", body.exportDir.trim());
    }
    if (typeof body.mappingFile === "string" && body.mappingFile.trim()) {
      cliArgs.push("--mapping-file", body.mappingFile.trim());
    }
  } else if (action === "approve") {
    cliArgs.push("approve-dataset", "--confirm-approve");
    if (typeof body.exportDir === "string" && body.exportDir.trim()) {
      cliArgs.push("--export-dir", body.exportDir.trim());
    }
    if (typeof body.mappingFile === "string" && body.mappingFile.trim()) {
      cliArgs.push("--mapping-file", body.mappingFile.trim());
    }
    if (typeof body.datasetSlug === "string" && body.datasetSlug.trim()) {
      cliArgs.push("--dataset-slug", body.datasetSlug.trim());
    }
  } else if (action === "upload") {
    cliArgs.push("upload", "--confirm-upload");
    if (typeof body.exportDir === "string" && body.exportDir.trim()) {
      cliArgs.push("--export-dir", body.exportDir.trim());
    }
    if (typeof body.mappingFile === "string" && body.mappingFile.trim()) {
      cliArgs.push("--mapping-file", body.mappingFile.trim());
    }
    if (typeof body.datasetSlug === "string" && body.datasetSlug.trim()) {
      cliArgs.push("--dataset-slug", body.datasetSlug.trim());
    }
  } else if (action === "run") {
    cliArgs.push("run");
    if (body.resume === true) {
      cliArgs.push("--resume");
    } else {
      cliArgs.push("--confirm-launch");
    }
    const mode = ["quick", "bench", "fold0", "full", "eval_suite"].includes(body.mode)
      ? body.mode
      : "quick";
    cliArgs.push("--mode", mode);
    if (typeof body.exportDir === "string" && body.exportDir.trim()) {
      cliArgs.push("--export-dir", body.exportDir.trim());
    }
    if (typeof body.datasetSlug === "string" && body.datasetSlug.trim()) {
      cliArgs.push("--dataset-slug", body.datasetSlug.trim());
    }
    if (typeof body.kernelSlug === "string" && body.kernelSlug.trim()) {
      cliArgs.push("--kernel-slug", body.kernelSlug.trim());
    }
  } else if (action === "onetap") {
    cliArgs.push("onetap");
    if (body.confirmApprove === true) {
      cliArgs.push("--confirm-approve");
    }
    if (body.confirmLaunch === true) {
      cliArgs.push("--confirm-launch");
    }
    if (body.resume === true) {
      cliArgs.push("--resume");
    }
    const mode = ["quick", "bench", "fold0", "full", "eval_suite"].includes(body.mode)
      ? body.mode
      : "quick";
    cliArgs.push("--mode", mode);
    if (typeof body.exportDir === "string" && body.exportDir.trim()) {
      cliArgs.push("--export-dir", body.exportDir.trim());
    }
    if (typeof body.mappingFile === "string" && body.mappingFile.trim()) {
      cliArgs.push("--mapping-file", body.mappingFile.trim());
    }
    if (typeof body.datasetSlug === "string" && body.datasetSlug.trim()) {
      cliArgs.push("--dataset-slug", body.datasetSlug.trim());
    }
    if (typeof body.kernelSlug === "string" && body.kernelSlug.trim()) {
      cliArgs.push("--kernel-slug", body.kernelSlug.trim());
    }
  } else if (action === "status") {
    cliArgs.push("status", "--json");
  } else if (action === "fetch-results" || action === "download") {
    cliArgs.push("download", "--staging-dir", stagingDir);
  } else if (action === "import") {
    cliArgs.push("import", "--staging-dir", stagingDir);
  }

  fs.mkdirSync(stagingDir, { recursive: true });
  const logFile = path.join(stagingDir, "kaggle.log");

  // Cap log file size if it exceeds 1 MB
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) {
    try {
      const content = fs.readFileSync(logFile, "utf8");
      fs.writeFileSync(logFile, content.slice(-500 * 1024));
    } catch {
      // ignore
    }
  }

  const logFd = fs.openSync(logFile, action === "status" ? "a" : "w");

  const child = spawn(pythonPath, cliArgs, {
    cwd: r,
    shell: false,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
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
    // already stopped
  }

  try {
    fs.unlinkSync(lockFile);
  } catch {
    // gone
  }

  return NextResponse.json({ ok: true, stopped: lock.pid, action: lock.action });
}
