import { NextRequest, NextResponse } from "next/server";
import { readFlags, writeFlag } from "~/lib/flag-store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ flags: readFlags("annotations2d_flags.json") });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { caseId, stem, flagged, reason, note } = body;
    if (!caseId || !stem) {
      return NextResponse.json({ error: "caseId and stem are required" }, { status: 400 });
    }
    const flag = writeFlag("annotations2d_flags.json", `${caseId}/${stem}`, { flagged, reason, note });
    return NextResponse.json({ ok: true, flag });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
