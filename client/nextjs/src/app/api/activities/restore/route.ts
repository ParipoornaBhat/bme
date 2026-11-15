import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db, caseAnnotation } from "@bme/db";
import { isReviewMode } from "~/lib/app-mode";
import { logEvents } from "~/lib/annotation-events";
import { isValidCaseId, isValidAnnotator } from "~/lib/annotation-sync";

export const dynamic = "force-dynamic";

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

function formatBackupTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

export async function POST(req: NextRequest) {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  let body: { caseId?: string; annotator?: string; actor?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { caseId, annotator, actor } = body;

  if (!caseId || !isValidCaseId(caseId)) {
    return NextResponse.json({ error: "Invalid case ID" }, { status: 400 });
  }
  if (!annotator || !isValidAnnotator(annotator)) {
    return NextResponse.json({ error: "Invalid annotator" }, { status: 400 });
  }

  const userActor = actor || process.env.USER || process.env.USERNAME || "local";

  try {
    const rows = await db
      .select({
        id: caseAnnotation.id,
        contentB64: caseAnnotation.contentB64,
        sha256: caseAnnotation.sha256,
      })
      .from(caseAnnotation)
      .where(
        and(
          eq(caseAnnotation.caseId, caseId),
          eq(caseAnnotation.annotator, annotator),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json({ error: "Annotation not found in database" }, { status: 404 });
    }

    const row = rows[0];

    // Clear tombstone in DB
    await db
      .update(caseAnnotation)
      .set({
        deletedAt: null,
        deletedBy: null,
        deletedReason: null,
        supersededBy: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(caseAnnotation.caseId, caseId),
          eq(caseAnnotation.annotator, annotator),
        ),
      );

    // Write DB content back to local file (backing up anything in the way)
    const repoRoot = getRepoRoot();
    const caseDir = path.join(repoRoot, "data", "annotations", caseId);
    fs.mkdirSync(caseDir, { recursive: true });

    const fileName =
      annotator === "_main" ? `${caseId}.seg.nrrd` : `${caseId}__${annotator}.seg.nrrd`;
    const localFilePath = path.join(caseDir, fileName);

    if (fs.existsSync(localFilePath)) {
      const stamp = formatBackupTimestamp(new Date());
      const backupDir = path.join(
        repoRoot,
        "data",
        "annotations_backup",
        `${stamp}-restore-conflict`,
        caseId,
      );
      fs.mkdirSync(backupDir, { recursive: true });
      const backupTarget = path.join(backupDir, fileName);
      fs.renameSync(localFilePath, backupTarget);
      console.log(`[restore] Backing up existing file: ${localFilePath} -> ${backupTarget}`);
    }

    const fileBuf = Buffer.from(row.contentB64, "base64");
    const tmpFilePath = path.join(
      caseDir,
      `.tmp_restore_${fileName}_${process.pid}_${Date.now()}`,
    );
    fs.writeFileSync(tmpFilePath, fileBuf);
    fs.renameSync(tmpFilePath, localFilePath);

    // Update local .sync_state.json
    const statePath = path.join(repoRoot, "data", "annotations", ".sync_state.json");
    try {
      let syncState: Record<string, { sha: string; at: string }> = {};
      if (fs.existsSync(statePath)) {
        syncState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      }
      syncState[`${caseId}/${annotator}`] = {
        sha: row.sha256,
        at: new Date().toISOString(),
      };
      fs.writeFileSync(statePath, JSON.stringify(syncState, null, 2), "utf8");
    } catch {
      // ignore state read/write error
    }

    // Log event
    await logEvents([
      {
        caseId,
        annotator,
        actor: userActor,
        action: "restore",
        sha256: row.sha256,
        details: { restoredFrom: "db" },
        at: new Date(),
      },
    ]);

    return NextResponse.json({ ok: true, caseId, annotator });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
