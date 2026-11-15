import { NextRequest, NextResponse } from "next/server";
import { isReviewMode } from "~/lib/app-mode";
import { fetchDatasetStatus, syncDataset } from "~/lib/training-advanced/server";

export const dynamic = "force-dynamic";

export async function GET() {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  try {
    const data = await fetchDatasetStatus();
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to query dataset status" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  try {
    const body = await req.json();
    const { targetId, confirmed } = body;
    if (!targetId) {
      return NextResponse.json({ error: "Missing targetId" }, { status: 400 });
    }

    const res = await syncDataset(targetId, Boolean(confirmed));
    if (res.refused) {
      return NextResponse.json(res, { status: 409 });
    }
    if (res.requiresConfirmation) {
      return NextResponse.json(res, { status: 200 });
    }
    return NextResponse.json(res);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to execute dataset sync" }, { status: 500 });
  }
}
