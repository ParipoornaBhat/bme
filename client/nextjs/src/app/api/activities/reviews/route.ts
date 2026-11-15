import { NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { db, reviewEdit, reviewAccount, reviewEditVersion } from "@bme/db";
import { isReviewMode } from "~/lib/app-mode";

export const dynamic = "force-dynamic";

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
        kind: reviewEdit.kind,
        createdAt: reviewEdit.createdAt,
        updatedAt: reviewEdit.updatedAt,
        appliedAt: reviewEdit.appliedAt,
        appliedBy: reviewEdit.appliedBy,
        role: reviewAccount.role,
      })
      .from(reviewEdit)
      .leftJoin(reviewAccount, eq(reviewEdit.reviewer, reviewAccount.username))
      .orderBy(desc(reviewEdit.updatedAt));

    const versionCounts = new Map<string, number>();
    try {
      const vRows = await db
        .select({
          reviewEditId: reviewEditVersion.reviewEditId,
          count: sql<number>`count(*)::int`,
        })
        .from(reviewEditVersion)
        .groupBy(reviewEditVersion.reviewEditId);

      for (const v of vRows) {
        versionCounts.set(v.reviewEditId, Number(v.count));
      }
    } catch {
      // If reviewEditVersion table query fails or is empty, versions default to 1
    }

    const reviews = edits.map((e) => ({
      ...e,
      role: e.role ?? "reviewer",
      versionsCount: versionCounts.get(e.id) ?? 1,
    }));

    return NextResponse.json({ ok: true, reviews, edits: reviews });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
