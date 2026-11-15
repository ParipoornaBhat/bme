import { NextRequest, NextResponse } from "next/server";
import { isReviewMode } from "~/lib/app-mode";
import { startJob } from "~/lib/training-advanced/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  try {
    const body = await req.json();
    const { platform, targetId, methodId, settings = {} } = body;

    if (!platform || !targetId || !methodId) {
      return NextResponse.json({ error: "Missing required parameters (platform, targetId, methodId)" }, { status: 400 });
    }

    const res = await startJob({
      platform,
      targetId,
      methodId,
      settings,
    });

    return NextResponse.json(res);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to start run" }, { status: 500 });
  }
}
