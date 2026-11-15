import { NextResponse } from "next/server";
import { isReviewMode } from "~/lib/app-mode";
import { getTasks } from "~/lib/training-advanced/server";

export const dynamic = "force-dynamic";

export async function GET() {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  const tasks = getTasks();
  return NextResponse.json({ tasks });
}
