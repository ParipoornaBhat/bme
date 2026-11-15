import { NextRequest, NextResponse } from "next/server";
import { isReviewMode } from "~/lib/app-mode";
import { applyOrDismissReview } from "~/lib/review-apply";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  let body: { id?: string; action?: string; main?: boolean; actor?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = await applyOrDismissReview({
    id: body.id as string,
    action: body.action as "apply" | "dismiss",
    main: body.main,
    actor: body.actor,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.statusCode || 400 });
  }

  return NextResponse.json(result);
}
