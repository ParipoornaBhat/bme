import { NextRequest, NextResponse } from "next/server";
import { isReviewMode } from "~/lib/app-mode";
import { resumeJob } from "~/lib/training-advanced/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  try {
    const body = await req.json();
    const { platform, targetId, methodId } = body;

    if (!platform || !targetId) {
      return NextResponse.json({ error: "Missing required parameters (platform, targetId)" }, { status: 400 });
    }

    const res = await resumeJob({
      platform,
      targetId,
      methodId,
    });

    return NextResponse.json(res);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to resume run" }, { status: 500 });
  }
}
