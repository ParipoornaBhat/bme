import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import { db, annotationEvent } from "@bme/db";
import { isReviewMode } from "~/lib/app-mode";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  const { searchParams } = req.nextUrl;
  const caseId = searchParams.get("case")?.trim();
  const person = searchParams.get("person")?.trim();
  const action = searchParams.get("action")?.trim();
  const before = searchParams.get("before")?.trim();
  const limitParam = searchParams.get("limit");

  let limit = 200;
  if (limitParam) {
    const parsed = parseInt(limitParam, 10);
    if (!isNaN(parsed) && parsed > 0) {
      limit = Math.min(parsed, 500);
    }
  }

  try {
    const conditions: SQL[] = [];

    if (caseId) {
      conditions.push(eq(annotationEvent.caseId, caseId));
    }
    if (person) {
      conditions.push(
        or(
          eq(annotationEvent.annotator, person),
          eq(annotationEvent.actor, person),
        )!,
      );
    }
    if (action) {
      conditions.push(eq(annotationEvent.action, action));
    }
    if (before) {
      const beforeDate = new Date(before);
      if (!isNaN(beforeDate.getTime())) {
        conditions.push(lt(annotationEvent.at, beforeDate));
      }
    }

    const baseQuery = db
      .select({
        id: annotationEvent.id,
        at: annotationEvent.at,
        caseId: annotationEvent.caseId,
        annotator: annotationEvent.annotator,
        actor: annotationEvent.actor,
        action: annotationEvent.action,
        sha256: annotationEvent.sha256,
        details: annotationEvent.details,
      })
      .from(annotationEvent);

    const query = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
    const events = await query.orderBy(desc(annotationEvent.at)).limit(limit);

    return NextResponse.json({ ok: true, events });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg, events: [] }, { status: 500 });
  }
}
