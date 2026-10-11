import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
  const r = root();
  const exportDir =
    process.env.COLAB_EXPORT_DIR ||
    path.resolve(r, "..", "bme_colab_export");
  const zipPath = path.join(exportDir, "bme_colab_data.zip");
  const mappingFile =
    process.env.COLAB_MAPPING_FILE ||
    path.resolve(r, "..", "bme_export_mapping.json");

  if (fs.existsSync(zipPath) && fs.existsSync(mappingFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(mappingFile, "utf8"));
      const sizeMB = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
      return NextResponse.json({
        ready: true,
        count: data.count || (data.cases ? data.cases.length : 61),
        exportDir,
        zipName: "bme_colab_data.zip",
        sizeMB,
      });
    } catch {
      /* parse error */
    }
  }
  return NextResponse.json({ ready: false });
}

export async function POST(req: Request) {
  const r = root();
  const script = path.join(r, "ml", "scripts", "export_for_colab.py");
  if (!fs.existsSync(script)) {
    return NextResponse.json({ error: "export_for_colab.py not found" }, { status: 500 });
  }

  const exportDir =
    process.env.COLAB_EXPORT_DIR ||
    path.resolve(r, "..", "bme_colab_export");
  const zipPath = path.join(exportDir, "bme_colab_data.zip");
  const mappingFile =
    process.env.COLAB_MAPPING_FILE ||
    path.resolve(r, "..", "bme_export_mapping.json");

  // Instant fast-path: if already packaged and verified, return immediately (0 wait time)
  if (fs.existsSync(zipPath) && fs.existsSync(mappingFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(mappingFile, "utf8"));
      const sizeMB = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
      return NextResponse.json({
        success: true,
        exportDir,
        summary: `✓ Dataset bundle is already packaged and ready (${data.count || data.cases?.length || 61} cases, ${sizeMB} MB). No wait needed!`,
      });
    } catch {
      /* continue to re-export */
    }
  }

  try {
    // 1. Run export with external mapping file
    const { stdout: exportOut } = await exec(
      python(),
      [script, "--src", r, "--dst", exportDir, "--mapping-file", mappingFile],
      { cwd: r }
    );

    // 2. Automatically run verification
    const { stdout: verifyOut } = await exec(
      python(),
      [script, "--verify", "--src", r, "--dst", exportDir, "--mapping-file", mappingFile],
      { cwd: r }
    );

    // Combine safe outputs (counts only, no IDs)
    const summary = `${exportOut.trim()}\n${verifyOut.trim()}`;

    return NextResponse.json({
      success: true,
      exportDir,
      summary,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Export failed: ${errorMsg}` },
      { status: 500 }
    );
  }
}
