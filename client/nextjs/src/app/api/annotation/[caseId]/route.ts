import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Save and load annotations for the web editor.
 *
 * POST takes the painted labelmap as a raw uint8 body and hands it to
 * ml/scripts/write_seg.py, which stamps on the source volume's geometry and
 * writes a Slicer-compatible .seg.nrrd. Writing NRRD in Node was the other
 * option; going through Python reuses the geometry conversion that was already
 * verified against a real Slicer export, rather than reimplementing it here and
 * hoping the two agree.
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
  if (!fs.existsSync(seg)) {
    return NextResponse.json({ exists: false });
  }
  const st = fs.statSync(seg);
  return NextResponse.json({
    exists: true,
    savedAt: st.mtime.toISOString(),
    bytes: st.size,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;
  if (!ID.test(caseId)) return NextResponse.json({ error: "bad case id" }, { status: 400 });

  const annotator = new URL(req.url).searchParams.get("by") ?? "";
  const body = Buffer.from(await req.arrayBuffer());
  if (body.length === 0) {
    return NextResponse.json({ error: "empty labelmap" }, { status: 400 });
  }

  const tmp = path.join(os.tmpdir(), `bme-${caseId}-${Date.now()}.raw`);
  fs.writeFileSync(tmp, body);

  try {
    const { stdout } = await exec(
      pythonPath(),
      [path.join(root(), "ml", "scripts", "write_seg.py"), root(), caseId, tmp,
       ...(annotator ? [annotator] : [])],
      { cwd: root(), timeout: 120_000 },
    );
    return NextResponse.json({ ok: true, detail: stdout.trim() });
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    return NextResponse.json(
      { error: (err.stderr || err.message || "write failed").trim() },
      { status: 500 },
    );
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp file already gone */
    }
  }
}
