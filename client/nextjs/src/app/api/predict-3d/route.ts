import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Test one uploaded NRRD with the trained 3D weights.
 * Returns edema present/absent, volume, and three orthogonal views.
 */

export const dynamic = "force-dynamic";
const exec = promisify(execFile);

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

export async function GET() {
  const dir = path.join(root(), "data", "results3d");
  const weights = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /^fold_\d+\.pt$/.test(f)).length
    : 0;
  let metrics: unknown = null;
  const mf = path.join(dir, "metrics.json");
  if (fs.existsSync(mf)) {
    try { metrics = JSON.parse(fs.readFileSync(mf, "utf8")); } catch { metrics = null; }
  }
  return NextResponse.json({ trained: weights > 0, folds: weights, metrics });
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Choose an NRRD scan." }, { status: 400 });
  }
  const name = file.name.toLowerCase();
  if (!name.endsWith(".nrrd")) {
    return NextResponse.json({ error: "Upload the scan as .nrrd, not a zip or a DICOM folder." }, { status: 400 });
  }
  if (name.includes(".seg.")) {
    return NextResponse.json({ error: "That is a segmentation. Upload the scan NRRD." }, { status: 400 });
  }

  const dir = path.join(root(), "data", "results3d");
  const weights = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /^fold_\d+\.pt$/.test(f));
  if (!weights) {
    return NextResponse.json(
      { error: "No 3D weights yet. Train the 3D model on the Training page first." },
      { status: 400 },
    );
  }

  const tmp = path.join(os.tmpdir(), `bme-test-${Date.now()}.nrrd`);
  const out = path.join(os.tmpdir(), `bme-test-${Date.now()}.json`);
  fs.writeFileSync(tmp, Buffer.from(await file.arrayBuffer()));
  try {
    await exec(
      python(),
      [path.join(root(), "ml", "scripts", "infer_3d.py"), root(), tmp, out],
      { cwd: root(), timeout: 180_000, maxBuffer: 32 * 1024 * 1024 },
    );
    const parsed = JSON.parse(fs.readFileSync(out, "utf8"));
    return NextResponse.json({ ...parsed, filename: file.name });
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    const text = (err.stderr || err.message || "inference failed").trim();
    return NextResponse.json({ error: text.split("\n").slice(-4).join(" ") }, { status: 500 });
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
    try { fs.unlinkSync(out); } catch { /* gone */ }
  }
}
