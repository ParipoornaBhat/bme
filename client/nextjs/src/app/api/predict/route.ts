import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

/**
 * Run the trained 2D models on one uploaded image.
 *
 * GET  reports which models exist, so the page can say "no classifier trained
 *      yet" before the user picks a file rather than after.
 * POST takes multipart form-data with an `image` field and returns detection,
 *      Grad-CAM and segmentation in one response.
 *
 * The upload lands in data/tmp-infer/ (gitignored, like everything under
 * data/) and is deleted as soon as Python exits. It is patient imaging: it does
 * not go to the system temp directory and it does not outlive the request.
 *
 * Nothing is trained here. If a checkpoint is missing, that section comes back
 * unavailable with the reason — inventing a mask or a heatmap to fill the gap
 * would be worse than an empty panel.
 */

export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 180_000;

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

function manifest(rel: string) {
  try {
    const p = path.join(root(), rel, "checkpoints", "manifest.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export async function GET() {
  const cls = manifest("data/results2d");
  const seg = manifest("data/results2dseg");
  return NextResponse.json({
    detection: cls
      ? {
          available: true,
          arch: cls.arch,
          folds: cls.folds?.length ?? 0,
          trainedAt: cls.created_at ?? null,
          nCases: cls.n_cases ?? null,
          nSlices: cls.n_slices ?? null,
          caseLevelAuc: cls.case_level_auc ?? null,
        }
      : { available: false },
    segmentation: seg
      ? {
          available: true,
          folds: seg.folds?.length ?? 0,
          trainedAt: seg.created_at ?? null,
          nCases: seg.n_cases ?? null,
          nSlices: seg.n_slices ?? null,
          summary: seg.summary ?? null,
        }
      : { available: false },
  });
}

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart form-data" }, { status: 400 });
  }

  const file = form.get("image");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "no image uploaded" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `image is ${(file.size / 1e6).toFixed(1)} MB; the limit is 25 MB` },
      { status: 413 },
    );
  }

  const r = root();
  const tmpDir = path.join(r, "data", "tmp-infer");
  fs.mkdirSync(tmpDir, { recursive: true });
  // The uploaded filename is never used on disk: it is attacker-controlled, and
  // in this project it is also frequently a patient name.
  const tmp = path.join(tmpDir, `${randomUUID()}.upload`);
  fs.writeFileSync(tmp, Buffer.from(await file.arrayBuffer()));

  try {
    const out = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(
        python(),
        ["-u", path.join(r, "ml", "scripts", "infer_2d.py"), r, "--image", tmp],
        { cwd: r },
      );
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: String(e) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });

    // The script prints one JSON object as its last line; torch and torchvision
    // are free to write warnings before it.
    const line = out.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }

    if (!parsed) {
      return NextResponse.json(
        {
          error: "inference failed",
          detail: (out.stderr || out.stdout).split(/\r?\n/).slice(-12).join("\n"),
        },
        { status: 500 },
      );
    }
    return NextResponse.json(parsed);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
  }
}
