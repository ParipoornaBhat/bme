import { NextResponse } from "next/server";
import { desc, isNotNull } from "drizzle-orm";
import { db, caseAnnotation } from "@bme/db";
import { isReviewMode } from "~/lib/app-mode";

export const dynamic = "force-dynamic";

export async function GET() {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  try {
    const deleted = await db
      .select({
        caseId: caseAnnotation.caseId,
        annotator: caseAnnotation.annotator,
        deletedAt: caseAnnotation.deletedAt,
        deletedBy: caseAnnotation.deletedBy,
        deletedReason: caseAnnotation.deletedReason,
        supersededBy: caseAnnotation.supersededBy,
        createdAt: caseAnnotation.createdAt,
        updatedAt: caseAnnotation.updatedAt,
      })
      .from(caseAnnotation)
      .where(isNotNull(caseAnnotation.deletedAt))
      .orderBy(desc(caseAnnotation.deletedAt));

    return NextResponse.json({ ok: true, deleted });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg, deleted: [] }, { status: 500 });
  }
}
