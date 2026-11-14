import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { db, reviewEdit } from "@bme/db";

const exec = promisify(execFile);

export const dynamic = "force-dynamic";

function isReviewMode(): boolean {
  return process.env.APP_MODE === "review";
}

function getRepoRoot(): string {
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, "..", ".."),
    cwd,
    path.resolve(cwd, ".."),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "data"))) return c;
  }
  return path.resolve(cwd, "..", "..");
}

function getPythonPath(r: string): string {
  const candidates =
    process.platform === "win32"
      ? [path.join(r, "ml", ".venv", "Scripts", "python.exe"), "python"]
      : [path.join(r, "ml", ".venv", "bin", "python"), "python3"];
  return candidates.find((p) => p === "python" || p === "python3" || fs.existsSync(p))!;
}

export async function GET() {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  try {
    const edits = await db
      .select({
        id: reviewEdit.id,
        caseId: reviewEdit.caseId,
        reviewer: reviewEdit.reviewer,
        baseAnnotator: reviewEdit.baseAnnotator,
        note: reviewEdit.note,
        status: reviewEdit.status,
        createdAt: reviewEdit.createdAt,
        updatedAt: reviewEdit.updatedAt,
        appliedAt: reviewEdit.appliedAt,
      })
      .from(reviewEdit)
      .where(
        and(
          eq(reviewEdit.kind, "review"),
          eq(reviewEdit.status, "open"),
        ),
      );

    return NextResponse.json({ ok: true, edits });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  let body: { id?: string; action?: string; main?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { id, action, main } = body;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "Missing or invalid id" }, { status: 400 });
  }

  if (action !== "apply" && action !== "dismiss") {
    return NextResponse.json({ error: "action must be 'apply' or 'dismiss'" }, { status: 400 });
  }

  if (action === "dismiss") {
    const res = await db
      .update(reviewEdit)
      .set({
        status: "dismissed",
        updatedAt: new Date(),
      })
      .where(eq(reviewEdit.id, id))
      .returning({ id: reviewEdit.id });

    if (res.length === 0) {
      return NextResponse.json({ error: "Edit not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, id, status: "dismissed" });
  }

  // action === "apply"
  const rows = await db
    .select()
    .from(reviewEdit)
    .where(eq(reviewEdit.id, id))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: "Edit not found" }, { status: 404 });
  }

  const edit = rows[0];
  const repoRoot = getRepoRoot();

  const scanPath = path.join(
    repoRoot,
    "data",
    "nifti",
    edit.caseId,
    `${edit.caseId}_primary.nii.gz`,
  );
  if (!fs.existsSync(scanPath)) {
    return NextResponse.json(
      { error: `Primary scan for case ${edit.caseId} not found locally` },
      { status: 400 },
    );
  }

  let rawBuf: Buffer;
  try {
    const gzBuf = Buffer.from(edit.labelsGzB64, "base64");
    rawBuf = zlib.gunzipSync(gzBuf);
  } catch (e: unknown) {
    return NextResponse.json(
      { error: `Failed to decompress labels: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  const tmpRawPath = path.join(
    os.tmpdir(),
    `bme-review-${edit.caseId}-${process.pid}-${Date.now()}.raw`,
  );

  let details = "";
  try {
    fs.writeFileSync(tmpRawPath, rawBuf);
    const pythonExe = getPythonPath(repoRoot);
    const writeSegScript = path.join(repoRoot, "ml", "scripts", "write_seg.py");

    const execArgs = [writeSegScript, repoRoot, edit.caseId, tmpRawPath];
    if (main) {
      execArgs.push("--main");
    }
    execArgs.push(edit.reviewer);

    const { stdout } = await exec(pythonExe, execArgs, {
      cwd: repoRoot,
      timeout: 120_000,
    });
    details = stdout.trim();

    await db
      .update(reviewEdit)
      .set({
        status: "applied",
        appliedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(reviewEdit.id, id));

    return NextResponse.json({
      ok: true,
      id,
      status: "applied",
      caseId: edit.caseId,
      main: Boolean(main),
      details,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `write_seg failed: ${msg}` }, { status: 500 });
  } finally {
    try {
      if (fs.existsSync(tmpRawPath)) fs.unlinkSync(tmpRawPath);
    } catch {
      // ignore
    }
  }
}
