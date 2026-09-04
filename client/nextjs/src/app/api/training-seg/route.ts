import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

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
  let log = "";
  if (fs.existsSync(LOG())) {
    log = fs
      .readFileSync(LOG(), "utf8")
      .split(/[\r\n]+/)
      .map((l) => l.trimEnd())
      .filter((l) => l && !/^[\d.]+%$/.test(l))
      .slice(-45)
      .join("\n");
  }
  return NextResponse.json({
    annotated: cases.length,
    cases,
    running: running(),
    metrics,
    log,
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

  const r = root();
  fs.mkdirSync(path.join(r, "data", "results2dseg"), { recursive: true });
  const log = fs.openSync(LOG(), "w");

  const child = spawn(
    python(),
    ["-u", path.join(r, "ml", "scripts", "pipeline_seg.py"), r,
     "--epochs", String(epochs), "--folds", String(folds), "--batch", String(batch)],
    { cwd: r, detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();
  if (child.pid) fs.writeFileSync(PID(), String(child.pid));

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
