import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * The saved annotation for a case, as the raw uint8 labelmap the 3D editor
 * paints into (one byte per voxel of the primary scan, x fastest).
 *
 * Goes through ml/scripts/read_seg.py, which shares its placement code with
 * seg2nifti.py, so a file saved by 3D Slicer (cropped extent, overlapping
 * layers, drawn on another series) opens here exactly as training will see it.
 */

export const dynamic = "force-dynamic";
const exec = promisify(execFile);
const ID = /^(BME|NBME)-\d{3}$/;

function root() {
  return path.resolve(process.cwd(), "..", "..");
}

function pythonPath() {
  const r = root();
  const candidates =
    process.platform === "win32"
      ? [path.join(r, "ml", ".venv", "Scripts", "python.exe"), "python"]
      : [path.join(r, "ml", ".venv", "bin", "python"), "python3"];
  return candidates.find((p) => p === "python" || p === "python3" || fs.existsSync(p))!;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;
  if (!ID.test(caseId)) return NextResponse.json({ error: "bad case id" }, { status: 400 });

  const seg = path.join(root(), "data", "annotations", caseId, `${caseId}.seg.nrrd`);
  if (!fs.existsSync(seg)) return NextResponse.json({ exists: false }, { status: 404 });

  const tmp = path.join(os.tmpdir(), `bme-${caseId}-${Date.now()}.labels`);
  try {
    const { stdout } = await exec(
      pythonPath(),
      [path.join(root(), "ml", "scripts", "read_seg.py"), root(), caseId, seg, tmp],
      { cwd: root(), timeout: 120_000 },
    );
    const buf = fs.readFileSync(tmp);
    const info = stdout.trim().split(/\r?\n/).pop() ?? "{}";
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(buf.length),
        "Cache-Control": "no-store",
        "X-Annotation-Info": encodeURIComponent(info),
      },
    });
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    return NextResponse.json(
      { error: (err.stderr || err.message || "could not read annotation").trim() },
      { status: 500 },
    );
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never written */
    }
  }
}
