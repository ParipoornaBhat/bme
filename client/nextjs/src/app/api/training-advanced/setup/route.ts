import { NextRequest, NextResponse } from "next/server";
import { isReviewMode } from "~/lib/app-mode";
import { setupEnv } from "~/lib/training-advanced/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }
  const { targetId } = await req.json().catch(() => ({}));
  if (!targetId || !String(targetId).startsWith("h200-")) {
    return NextResponse.json({ error: "Missing or invalid targetId" }, { status: 400 });
  }
  const res = setupEnv(String(targetId));
  return NextResponse.json(res, { status: res.success ? 200 : 409 });
}
