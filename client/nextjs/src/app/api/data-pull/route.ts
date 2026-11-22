import { NextRequest, NextResponse } from "next/server";
import { isReviewMode } from "~/lib/app-mode";
import { planPull, runPull } from "~/lib/data-pull";

export const dynamic = "force-dynamic";
export const maxDuration = 900;

/** GET: which scans the database knows that this PC does not have (nothing is downloaded). */
export async function GET() {
  if (isReviewMode()) return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  try {
    return NextResponse.json(await planPull());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "database unreachable" }, { status: 502 });
  }
}

/** POST { confirmed: true }: download them from Drive into data/nifti and add them to the worklist. */
export async function POST(req: NextRequest) {
  if (isReviewMode()) return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  if (!body.confirmed) return NextResponse.json({ error: "Confirm first" }, { status: 400 });
  const only = Array.isArray(body.cases) ? body.cases.filter((c: unknown) => typeof c === "string") : undefined;
  try {
    return NextResponse.json(await runPull(only));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "download failed" }, { status: 502 });
  }
}
