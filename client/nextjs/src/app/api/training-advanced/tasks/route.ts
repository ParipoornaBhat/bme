import { NextResponse } from "next/server";
import { isReviewMode } from "~/lib/app-mode";
import { getTasks, clearTasks, deleteTask } from "~/lib/training-advanced/server";

export const dynamic = "force-dynamic";

export async function GET() {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  const tasks = getTasks();
  return NextResponse.json({ tasks });
}

export async function DELETE(req: Request) {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const removed = deleteTask(id);
    return NextResponse.json({ success: removed, id }, { status: removed ? 200 : 409 });
  }

  clearTasks();
  return NextResponse.json({ success: true, tasks: [] });
}
