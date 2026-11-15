import { NextResponse } from "next/server";
import { isReviewMode } from "~/lib/app-mode";
import { getTasks, clearTasks } from "~/lib/training-advanced/server";

export const dynamic = "force-dynamic";

export async function GET() {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  const tasks = getTasks();
  return NextResponse.json({ tasks });
}

export async function DELETE() {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  clearTasks();
  return NextResponse.json({ success: true, tasks: [] });
}
