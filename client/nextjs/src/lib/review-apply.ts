import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db, reviewEdit } from "@bme/db";
import { logEvents } from "~/lib/annotation-events";

const exec = promisify(execFile);

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

export interface ReviewActionInput {
  id: string;
  action: "apply" | "dismiss";
  main?: boolean;
  actor?: string;
}

export interface ReviewActionResult {
  ok: boolean;
  id?: string;
  status?: string;
  caseId?: string;
  main?: boolean;
  details?: string;
  error?: string;
  statusCode?: number;
}

/**
 * Shared apply / dismiss logic between /api/activities/review and /api/review-inbox.
 */
export async function applyOrDismissReview(input: ReviewActionInput): Promise<ReviewActionResult> {
  const { id, action, main, actor } = input;

  if (!id || typeof id !== "string") {
    return { ok: false, error: "Missing or invalid id", statusCode: 400 };
  }

  if (action !== "apply" && action !== "dismiss") {
    return { ok: false, error: "action must be 'apply' or 'dismiss'", statusCode: 400 };
  }

  if (action === "dismiss") {
    const rows = await db
      .select()
      .from(reviewEdit)
      .where(eq(reviewEdit.id, id))
      .limit(1);

    if (rows.length === 0) {
      return { ok: false, error: "Edit not found", statusCode: 404 };
    }

    const edit = rows[0];

    await db
      .update(reviewEdit)
      .set({
        status: "dismissed",
        updatedAt: new Date(),
      })
      .where(eq(reviewEdit.id, id));

    await logEvents([
      {
        caseId: edit.caseId,
        annotator: edit.reviewer,
        actor: actor || "local",
        action: "review-dismiss",
        details: { id: edit.id, baseAnnotator: edit.baseAnnotator },
        at: new Date(),
      },
    ]);

    return { ok: true, id, status: "dismissed" };
  }

  // action === "apply"
  const rows = await db
    .select()
    .from(reviewEdit)
    .where(eq(reviewEdit.id, id))
    .limit(1);

  if (rows.length === 0) {
    return { ok: false, error: "Edit not found", statusCode: 404 };
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
    return {
      ok: false,
      error: `Primary scan for case ${edit.caseId} not found locally`,
      statusCode: 400,
    };
  }

  let rawBuf: Buffer;
  try {
    const gzBuf = Buffer.from(edit.labelsGzB64, "base64");
    rawBuf = zlib.gunzipSync(gzBuf);
  } catch (e: unknown) {
    return {
      ok: false,
      error: `Failed to decompress labels: ${e instanceof Error ? e.message : String(e)}`,
      statusCode: 500,
    };
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

    await logEvents([
      {
        caseId: edit.caseId,
        annotator: edit.reviewer,
        actor: actor || "local",
        action: "review-apply",
        details: { id: edit.id, main: Boolean(main), details },
        at: new Date(),
      },
    ]);

    return {
      ok: true,
      id,
      status: "applied",
      caseId: edit.caseId,
      main: Boolean(main),
      details,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `write_seg failed: ${msg}`, statusCode: 500 };
  } finally {
    try {
      if (fs.existsSync(tmpRawPath)) fs.unlinkSync(tmpRawPath);
    } catch {
      // ignore
    }
  }
}
