import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { db, patient, study, series, annotation } from "@bme/db";
import { eq, desc } from "drizzle-orm";

/**
 * Shared record of who has annotated which case.
 *
 * The .seg.nrrd files themselves move between teammates by hand over a private
 * channel — they are patient data and are not going through this app. What the
 * shared database holds is the LEDGER: who annotated what, when, and how big
 * the segments were.
 *
 * That split is what makes the workflow work. Everyone pointing at the same
 * database sees the same completion status, so you can tell at a glance that a
 * case is done, who has the file, and therefore who to ask for it — without the
 * imaging ever leaving anyone's machine automatically.
 *
 * A case is "annotated by someone else" when a row exists here but the file is
 * absent locally. That is the cue to go and ask for it.
 */

export const dynamic = "force-dynamic";

function root() {
  return path.resolve(process.cwd(), "..", "..");
}

/** Ensure the patient -> study -> series chain exists for a case id. */
async function ensureSeries(caseId: string) {
  const cls = caseId.startsWith("BME") ? "bme" : "non_bme";

  let [p] = await db.select().from(patient).where(eq(patient.caseId, caseId)).limit(1);
  if (!p) {
    [p] = await db.insert(patient).values({ caseId, caseClass: cls }).returning();
  }

  let [st] = await db.select().from(study).where(eq(study.patientId, p.id)).limit(1);
  if (!st) {
    [st] = await db.insert(study).values({ patientId: p.id, bodyPart: "KNEE" }).returning();
  }

  let [se] = await db.select().from(series).where(eq(series.studyId, st.id)).limit(1);
  if (!se) {
    [se] = await db
      .insert(series)
      .values({ studyId: st.id, kind: "edema", isPrimary: true })
      .returning();
  }
  return se;
}

export async function GET() {
  try {
    const rows = await db
      .select({
        id: annotation.id,
        seriesId: annotation.seriesId,
        authorId: annotation.authorId,
        source: annotation.source,
        version: annotation.version,
        storageKey: annotation.storageKey,
        labelSchema: annotation.labelSchema,
        notes: annotation.notes,
        createdAt: annotation.createdAt,
      })
      .from(annotation)
      .orderBy(desc(annotation.createdAt))
      .limit(500);

    // storageKey is "data/annotations/<CASE>/<CASE>.seg.nrrd"; the case id is
    // recoverable from it without another join.
    const byCase: Record<string, {
      caseId: string; annotator: string | null; at: string;
      localFile: boolean; counts: unknown; notes: string | null;
    }> = {};

    for (const r of rows) {
      const m = /annotations\/([^/]+)\//.exec(r.storageKey ?? "");
      const caseId = m?.[1];
      if (!caseId || byCase[caseId]) continue; // newest wins
      byCase[caseId] = {
        caseId,
        annotator: r.notes ?? null,
        at: r.createdAt?.toISOString?.() ?? String(r.createdAt),
        localFile: fs.existsSync(path.join(root(), r.storageKey ?? "")),
        counts: r.labelSchema,
        notes: r.notes,
      };
    }

    const entries = Object.values(byCase);
    return NextResponse.json({
      available: true,
      entries,
      needFromTeammate: entries.filter((e) => !e.localFile).map((e) => e.caseId),
    });
  } catch (e) {
    // The database is optional for annotating — the editor still saves locally.
    return NextResponse.json({
      available: false,
      entries: [],
      needFromTeammate: [],
      error: e instanceof Error ? e.message : "database unreachable",
    });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const caseId = String(body.caseId ?? "");
  const who = String(body.annotator ?? "").slice(0, 120);
  const counts = body.counts ?? null;

  if (!/^(BME|NBME)-\d{3}$/.test(caseId)) {
    return NextResponse.json({ error: "bad case id" }, { status: 400 });
  }

  try {
    const se = await ensureSeries(caseId);
    const storageKey = `data/annotations/${caseId}/${caseId}.seg.nrrd`;

    const prior = await db
      .select({ v: annotation.version })
      .from(annotation)
      .where(eq(annotation.seriesId, se.id))
      .orderBy(desc(annotation.version))
      .limit(1);

    await db.insert(annotation).values({
      seriesId: se.id,
      source: "human",
      version: (prior[0]?.v ?? 0) + 1,
      format: "seg_nrrd",
      storageKey,
      labelSchema: counts,
      notes: who || null,
    });

    return NextResponse.json({ ok: true, caseId, version: (prior[0]?.v ?? 0) + 1 });
  } catch (e) {
    // Never fail the save because the ledger is down — the file is already on
    // disk by this point, and losing the annotation would be far worse than
    // losing the record of it.
    return NextResponse.json({
      ok: false,
      logged: false,
      error: e instanceof Error ? e.message : "database unreachable",
    });
  }
}
