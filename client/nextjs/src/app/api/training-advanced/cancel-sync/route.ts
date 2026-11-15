import { NextResponse } from "next/server";
import { isReviewMode } from "~/lib/app-mode";
import { cancelSync } from "~/lib/training-advanced/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }
  const body = await req.json().catch(() => ({}));
  const targetId = typeof body.targetId === "string" ? body.targetId : "";
  if (!targetId) {
    return NextResponse.json({ success: false, message: "targetId is required" }, { status: 400 });
  }
  return NextResponse.json(cancelSync(targetId));
}
