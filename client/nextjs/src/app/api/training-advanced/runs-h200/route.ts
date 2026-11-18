import { NextResponse } from "next/server";
import { isReviewMode } from "~/lib/app-mode";
import { fetchRunsH200 } from "~/lib/training-advanced/server";

export const dynamic = "force-dynamic";

export async function GET() {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  try {
    const data = await fetchRunsH200();
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to load H200 runs" }, { status: 500 });
  }
}
