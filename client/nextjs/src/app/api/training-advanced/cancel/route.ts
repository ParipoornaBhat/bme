import { NextRequest, NextResponse } from "next/server";
import { isReviewMode } from "~/lib/app-mode";
import { cancelJob } from "~/lib/training-advanced/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  try {
    const body = await req.json();
    const { platform, targetId, jobId } = body;

    if (!platform || !targetId) {
      return NextResponse.json({ error: "Missing required parameters (platform, targetId)" }, { status: 400 });
    }

    const res = await cancelJob(platform, targetId, jobId);
    return NextResponse.json(res);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to cancel run" }, { status: 500 });
  }
}
