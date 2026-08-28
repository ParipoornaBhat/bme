import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * Grad-CAM heatmaps for the 2D classifier.
 *
 * GET  returns the generated set (thumbnails inline, so the page needs no
 *      second round trip per image).
 * POST regenerates them: trains on four folds and explains the held-out one, so
 *      every heatmap comes from a slice the model has never seen. Explaining
 *      training slices would show memorisation, not reasoning.
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

const JSON_PATH = () => path.join(root(), "data", "results2d", "gradcam.json");
const PID = () => path.join(root(), "data", "results2d", "gradcam.pid");
const LOG = () => path.join(root(), "data", "results2d", "gradcam.log");

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

export async function GET() {
  const p = JSON_PATH();
  let data: unknown = null;
  if (fs.existsSync(p)) {
    try {
      data = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      data = null;
    }
  }
  let log = "";
  if (fs.existsSync(LOG())) {
    log = fs
      .readFileSync(LOG(), "utf8")
      .split(/[\r\n]+/)
      .filter((l) => l.trim() && !/^[\d.]+%$/.test(l))
      .slice(-15)
      .join("\n");
  }
  return NextResponse.json({ available: data !== null, data, running: running(), log });
}

export async function POST(req: Request) {
  if (running()) {
    return NextResponse.json({ error: "already generating" }, { status: 409 });
  }
  const body = await req.json().catch(() => ({}));
  const epochs = Math.min(Math.max(Number(body.epochs ?? 3), 1), 15);
  const n = Math.min(Math.max(Number(body.n ?? 24), 4), 60);

  const r = root();
  fs.mkdirSync(path.join(r, "data", "results2d"), { recursive: true });
  const log = fs.openSync(LOG(), "w");

  const child = spawn(
    python(),
    ["-u", path.join(r, "ml", "scripts", "gradcam.py"), r,
     "--epochs", String(epochs), "--n", String(n)],
    { cwd: r, detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();
  if (child.pid) fs.writeFileSync(PID(), String(child.pid));

  return NextResponse.json({ ok: true, pid: child.pid, epochs, n });
}
