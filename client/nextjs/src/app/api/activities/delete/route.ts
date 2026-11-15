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

  let body: { caseId?: string; annotator?: string; force?: boolean; actor?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { caseId, annotator, force, actor } = body;

  if (!caseId || !isValidCaseId(caseId)) {
    return NextResponse.json({ error: "Invalid case ID" }, { status: 400 });
  }
  if (!annotator || !isValidAnnotator(annotator)) {
    return NextResponse.json({ error: "Invalid annotator" }, { status: 400 });
  }

  if (annotator === "_main" && !force) {
    return NextResponse.json(
      { error: "Refusing to delete _main without { force: true }" },
      { status: 400 },
    );
  }

  const userActor = actor || process.env.USER || process.env.USERNAME || "local";

  try {
    const existing = await db
      .select({
        id: caseAnnotation.id,
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

    // Soft delete (tombstone) in DB
    await db
      .update(caseAnnotation)
      .set({
        deletedAt: new Date(),
        deletedBy: userActor,
        deletedReason: "manual",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(caseAnnotation.caseId, caseId),
          eq(caseAnnotation.annotator, annotator),
        ),
      );

    // Move local file to backup (never unlink)
    const repoRoot = getRepoRoot();
    const fileName =
      annotator === "_main" ? `${caseId}.seg.nrrd` : `${caseId}__${annotator}.seg.nrrd`;
    const localFilePath = path.join(repoRoot, "data", "annotations", caseId, fileName);

    let backupTarget: string | null = null;
    if (fs.existsSync(localFilePath)) {
      const stamp = formatBackupTimestamp(new Date());
      const backupDir = path.join(
        repoRoot,
        "data",
        "annotations_backup",
        `${stamp}-manual`,
        caseId,
      );
      fs.mkdirSync(backupDir, { recursive: true });
      backupTarget = path.join(backupDir, fileName);
      fs.renameSync(localFilePath, backupTarget);
      console.log(`[delete] Moved ${localFilePath} -> ${backupTarget}`);
    }

    // Remove from local .sync_state.json
    const statePath = path.join(repoRoot, "data", "annotations", ".sync_state.json");
    if (fs.existsSync(statePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
        const key = `${caseId}/${annotator}`;
        if (state[key]) {
          delete state[key];
          fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
        }
      } catch {
        // ignore state read/write error
      }
    }

    // Log event
    await logEvents([
      {
        caseId,
        annotator,
        actor: userActor,
        action: "delete",
        sha256: existing[0]?.sha256 ?? null,
        details: { reason: "manual", force: Boolean(force), backupTarget },
        at: new Date(),
      },
    ]);

    return NextResponse.json({ ok: true, caseId, annotator });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
