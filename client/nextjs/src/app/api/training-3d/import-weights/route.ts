import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const dynamic = "force-dynamic";
const exec = promisify(execFile);

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_NAMES = /^(fold_\d+\.pt|metrics\.json)$/i;

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

export async function POST(req: NextRequest) {
  const r = root();
  const destDir = path.join(r, "data", "results3d");
  const verifierScript = path.join(r, "ml", "scripts", "verify_and_import_weights.py");

  if (!fs.existsSync(verifierScript)) {
    return NextResponse.json({ error: "verify_and_import_weights.py not found" }, { status: 500 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "bme_weights_"));
  try {
    const files: File[] = [];
    for (const [_, value] of formData.entries()) {
      if (value instanceof File) {
        files.push(value);
      }
    }

    if (files.length === 0) {
      return NextResponse.json({ error: "No files uploaded" }, { status: 400 });
    }

    let totalSize = 0;
    for (const file of files) {
      totalSize += file.size;
    }
    if (totalSize > MAX_BYTES) {
      return NextResponse.json(
        { error: `Upload exceeds maximum allowed size of ${MAX_BYTES / (1024 * 1024)} MB` },
        { status: 400 }
      );
    }

    let targetInputPath = "";

    // If a single zip file is uploaded:
    if (files.length === 1 && files[0].name.toLowerCase().endsWith(".zip")) {
      const zipFile = files[0];
      const zipPath = path.join(tmpBase, "upload.zip");
      const buffer = Buffer.from(await zipFile.arrayBuffer());
      fs.writeFileSync(zipPath, buffer);
      targetInputPath = zipPath;
    } else {
      // Multiple or single .pt / .json files
      const stagingDir = path.join(tmpBase, "files");
      fs.mkdirSync(stagingDir, { recursive: true });

      for (const file of files) {
        const name = path.basename(file.name);
        if (!ALLOWED_NAMES.test(name)) {
          return NextResponse.json(
            { error: `Disallowed file: ${name}. Only fold_*.pt and metrics.json are permitted.` },
            { status: 400 }
          );
        }
        const filePath = path.join(stagingDir, name);
        const buffer = Buffer.from(await file.arrayBuffer());
        fs.writeFileSync(filePath, buffer);
      }
      targetInputPath = stagingDir;
    }

    // Run verification and import subprocess
    try {
      const { stdout } = await exec(
        python(),
        [verifierScript, targetInputPath, destDir],
        { cwd: r }
      );
      const result = JSON.parse(stdout);
      return NextResponse.json(result, { status: result.success ? 200 : 400 });
    } catch (execErr: unknown) {
      let resultJson = null;
      const e = execErr as { stdout?: string; message?: string };
      if (e.stdout) {
        try {
          resultJson = JSON.parse(e.stdout);
        } catch { /* ignore */ }
      }
      if (resultJson) {
        return NextResponse.json(resultJson, { status: 400 });
      }
      return NextResponse.json(
        { error: `Verification script failed: ${e.message || String(execErr)}` },
        { status: 400 }
      );
    }
  } finally {
    // Clean up temporary staging directory
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch { /* gone */ }
  }
}
