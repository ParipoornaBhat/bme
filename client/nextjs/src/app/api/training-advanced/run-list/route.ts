import { NextResponse } from "next/server";
import { isReviewMode } from "~/lib/app-mode";
import { fetchRuns } from "~/lib/training-advanced/server";

export const dynamic = "force-dynamic";

export async function GET() {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  try {
    const runs = await fetchRuns();
    return NextResponse.json({ runs });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to load runs" }, { status: 500 });
  }
}
