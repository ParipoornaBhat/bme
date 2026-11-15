import { NextRequest, NextResponse } from "next/server";
import { db, caseOwner } from "@bme/db";
import { isReviewMode } from "~/lib/app-mode";
import { logEvents } from "~/lib/annotation-events";
import { isValidCaseId, sanitizeAnnotator } from "~/lib/annotation-sync";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  let body: { caseId?: string; annotatedBy?: string | null; actor?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { caseId, annotatedBy, actor } = body;

  if (!caseId || !isValidCaseId(caseId)) {
    return NextResponse.json({ error: "Invalid case ID" }, { status: 400 });
  }

  const safeAnnotatedBy = annotatedBy ? sanitizeAnnotator(annotatedBy) : null;
  const userActor = actor || process.env.USER || process.env.USERNAME || "local";

  try {
    await db
      .insert(caseOwner)
      .values({
        caseId,
        annotatedBy: safeAnnotatedBy,
        source: "manual",
        setBy: userActor,
        setAt: new Date(),
      })
      .onConflictDoUpdate({
        target: caseOwner.caseId,
        set: {
          annotatedBy: safeAnnotatedBy,
          source: "manual",
          setBy: userActor,
          setAt: new Date(),
        },
      });

    await logEvents([
      {
        caseId,
        annotator: safeAnnotatedBy,
        actor: userActor,
        action: "owner-set",
        details: { source: "manual", annotatedBy: safeAnnotatedBy },
        at: new Date(),
      },
    ]);

    return NextResponse.json({ ok: true, caseId, annotatedBy: safeAnnotatedBy });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
