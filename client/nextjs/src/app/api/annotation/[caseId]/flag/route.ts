import { NextRequest, NextResponse } from "next/server";
import { readFlags, writeFlag } from "~/lib/flag-store";

/** Review flag for a whole 3D case. Stored in data/annotations3d_flags.json. */

export const dynamic = "force-dynamic";

const ID = /^(BME|NBME)-\d{3}$/;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;
  if (!ID.test(caseId)) return NextResponse.json({ error: "bad case id" }, { status: 400 });
  return NextResponse.json({ flag: readFlags("annotations3d_flags.json")[caseId] ?? null });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;
  if (!ID.test(caseId)) return NextResponse.json({ error: "bad case id" }, { status: 400 });
  try {
    const { flagged, reason, note, where } = (await req.json()) as {
      flagged?: boolean; reason?: string; note?: string; where?: string;
    };
    const flag = writeFlag("annotations3d_flags.json", caseId, {
      flagged: flagged !== false,
      reason: typeof reason === "string" ? reason.slice(0, 80) : undefined,
      note: typeof note === "string" ? note.slice(0, 2000) : undefined,
      where: typeof where === "string" ? where.slice(0, 80) : undefined,
    });
    return NextResponse.json({ ok: true, flag });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
