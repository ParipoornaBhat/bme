import { NextRequest, NextResponse } from "next/server";
import zlib from "node:zlib";
import { eq, and, desc } from "drizzle-orm";
import { db, caseReview, reviewEdit, caseAnnotation } from "@bme/db";
import { isReviewMode } from "~/lib/app-mode";
import { getReviewUser, safeAnnotator } from "~/lib/review-auth";
import { logEvents } from "~/lib/annotation-events";

export const dynamic = "force-dynamic";

const CASE_ID_RE = /^(BME|NBME)-\d{3}$/;

export async function POST(req: NextRequest) {
  if (!isReviewMode()) {
    return NextResponse.json({ error: "Only available in review mode" }, { status: 404 });
  }

  const user = await getReviewUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if ((user.role as string) === "mentor") {
    return NextResponse.json({ error: "Forbidden: mentor role cannot mark cases" }, { status: 403 });
  }

  if (user.role === "team") {
    return NextResponse.json({ error: "Forbidden: team role cannot mark cases" }, { status: 403 });
  }

  if (user.role !== "radiologist" && user.role !== "reviewer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { caseId?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { caseId, action } = body;
  if (!caseId || typeof caseId !== "string" || !CASE_ID_RE.test(caseId)) {
    return NextResponse.json({ error: "Invalid case ID" }, { status: 400 });
  }

  if (action !== "mark" && action !== "unmark") {
    return NextResponse.json({ error: "Invalid action: must be 'mark' or 'unmark'" }, { status: 400 });
  }

  const safeMe = safeAnnotator(user.displayName) || safeAnnotator(user.username);
  const now = new Date();

  if (action === "mark") {
    // "With edits" rule: take reviewer's latest saved edit of any status
    const [latestEdit] = await db
      .select()
      .from(reviewEdit)
      .where(
        and(
          eq(reviewEdit.caseId, caseId),
          eq(reviewEdit.reviewer, safeMe),
        ),
      )
      .orderBy(desc(reviewEdit.updatedAt), desc(reviewEdit.createdAt))
      .limit(1);

    let status: "reviewed" | "reviewed_with_edits" = "reviewed";

    if (latestEdit && latestEdit.labelsGzB64) {
      try {
        const editBuf = zlib.gunzipSync(Buffer.from(latestEdit.labelsGzB64, "base64"));
        const baseName = latestEdit.baseAnnotator || "_main";

        const [baseRow] = await db
          .select()
          .from(caseAnnotation)
          .where(
            and(
              eq(caseAnnotation.caseId, caseId),
              eq(caseAnnotation.annotator, baseName),
            ),
          )
          .limit(1);

        if (baseRow && baseRow.labelsGzB64) {
          const baseBuf = zlib.gunzipSync(Buffer.from(baseRow.labelsGzB64, "base64"));
          if (editBuf.equals(baseBuf)) {
            status = "reviewed";
          } else {
            status = "reviewed_with_edits";
          }
        } else {
          status = "reviewed_with_edits";
        }
      } catch (err) {
        console.error("Failed to compare labels for review mark:", err);
        status = "reviewed_with_edits";
      }
    } else {
      status = "reviewed";
    }

    const [saved] = await db
      .insert(caseReview)
      .values({
        caseId,
        reviewer: safeMe,
        role: user.role,
        status,
        locked: true,
        markedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [caseReview.caseId, caseReview.reviewer],
        set: {
          role: user.role,
          status,
          locked: true,
          markedAt: now,
          updatedAt: now,
        },
      })
      .returning();

    await logEvents([
      {
        caseId,
        annotator: safeMe,
        actor: safeMe,
        action: "review-mark",
        details: { status },
        at: now,
      },
    ]);

    return NextResponse.json({
      ok: true,
      review: {
        reviewer: saved.reviewer,
        status: saved.status,
        locked: saved.locked,
        markedAt: (saved.markedAt instanceof Date ? saved.markedAt.toISOString() : String(saved.markedAt)),
      },
    });
  }

  // action === "unmark"
  const [existing] = await db
    .select()
    .from(caseReview)
    .where(
      and(
        eq(caseReview.caseId, caseId),
        eq(caseReview.reviewer, safeMe),
      ),
    )
    .limit(1);

  if (!existing) {
    return NextResponse.json({ error: "Review record not found" }, { status: 404 });
  }

  const [saved] = await db
    .update(caseReview)
    .set({
      locked: false,
      updatedAt: now,
    })
    .where(eq(caseReview.id, existing.id))
    .returning();

  await logEvents([
    {
      caseId,
      annotator: safeMe,
      actor: safeMe,
      action: "review-unmark",
      at: now,
    },
  ]);

  return NextResponse.json({
    ok: true,
    review: {
      reviewer: saved.reviewer,
      status: saved.status,
      locked: saved.locked,
      markedAt: (saved.markedAt instanceof Date ? saved.markedAt.toISOString() : String(saved.markedAt)),
    },
  });
}
