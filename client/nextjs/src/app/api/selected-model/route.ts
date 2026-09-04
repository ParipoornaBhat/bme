import { NextRequest, NextResponse } from "next/server";
import {
  clearSelected,
  isRunId,
  readSelected,
  runExists,
  selectedMetrics,
  writeSelected,
} from "~/lib/selectedModel";

/**
 * Read and set which trained run the dashboard stands behind.
 *
 * All the reasoning, and the single-source-of-truth file, live in
 * src/lib/selectedModel.ts — a route file may only export HTTP handlers, and
 * the results and training routes need the same helpers.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const { id, explicit, metrics } = selectedMetrics();
  return NextResponse.json({
    selected: readSelected(),
    resolved: id,
    explicit,
    metrics,
  });
}

export async function POST(req: NextRequest) {
  let body: { run?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }

  const run = body.run;

  // null or "" clears the selection and returns every page to "latest run".
  if (run === null || run === undefined || run === "") {
    clearSelected();
    return NextResponse.json({ ok: true, selected: null });
  }

  if (typeof run !== "string" || !isRunId(run)) {
    return NextResponse.json({ error: "bad run id" }, { status: 400 });
  }
  if (!runExists(run)) {
    return NextResponse.json({ error: "no such run" }, { status: 404 });
  }

  writeSelected(run);
  return NextResponse.json({ ok: true, selected: run });
}
