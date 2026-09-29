import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Import a .seg.nrrd saved in 3D Slicer as this case's annotation.
 *
 * The upload is placed on the case's primary scan by read_seg.py, then written
 * back through write_seg.py, so what lands on disk is the same full-grid file
 * the web editor saves — canonical <CASE>.seg.nrrd plus the importer's own
 * <CASE>__<annotator>.seg.nrrd copy. Unknown segment names are refused, not
 * guessed.
 */

export const dynamic = "force-dynamic";
const exec = promisify(execFile);
const ID = /^(BME|NBME)-\d{3}$/;
const MAX_BYTES = 200 * 1024 * 1024;

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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;
  if (!ID.test(caseId)) return NextResponse.json({ error: "bad case id" }, { status: 400 });

  const annotator = new URL(req.url).searchParams.get("by") ?? "";
  const body = Buffer.from(await req.arrayBuffer());
  if (body.length === 0) return NextResponse.json({ error: "empty upload" }, { status: 400 });
  if (body.length > MAX_BYTES) return NextResponse.json({ error: "file too large" }, { status: 413 });

  const stamp = `${caseId}-${Date.now()}`;
  const upload = path.join(os.tmpdir(), `bme-${stamp}.seg.nrrd`);
  const raw = path.join(os.tmpdir(), `bme-${stamp}.raw`);
  fs.writeFileSync(upload, body);

  const py = pythonPath();
  const scripts = path.join(root(), "ml", "scripts");
  try {
    const read = await exec(py, [path.join(scripts, "read_seg.py"), root(), caseId, upload, raw], {
      cwd: root(),
      timeout: 120_000,
    });
    const info = JSON.parse(read.stdout.trim().split(/\r?\n/).pop() ?? "{}") as {
      counts?: Record<string, number>;
      warnings?: string[];
    };

    await exec(
      py,
      [path.join(scripts, "write_seg.py"), root(), caseId, raw, ...(annotator ? [annotator] : [])],
      { cwd: root(), timeout: 120_000 },
    );

    return NextResponse.json({ ok: true, counts: info.counts ?? {}, warnings: info.warnings ?? [] });
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    return NextResponse.json(
      { error: (err.stderr || err.message || "import failed").trim() },
      { status: 422 },
    );
  } finally {
    for (const f of [upload, raw]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* never written */
      }
    }
  }
}
