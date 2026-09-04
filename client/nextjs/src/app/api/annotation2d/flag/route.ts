import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

function projectRoot() {
  return path.resolve(process.cwd(), "..", "..");
}

function getFlagsPath() {
  return path.join(projectRoot(), "data", "annotations2d_flags.json");
}

function readFlags(): Record<string, { flagged: boolean; reason?: string; note?: string; flaggedAt?: string }> {
  try {
    const p = getFlagsPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function writeFlags(flags: Record<string, unknown>) {
  const p = getFlagsPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(flags, null, 2), "utf8");
}

export async function GET() {
  const flags = readFlags();
  return NextResponse.json({ flags });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { caseId, stem, flagged, reason, note } = body;
    if (!caseId || !stem) {
      return NextResponse.json({ error: "caseId and stem are required" }, { status: 400 });
    }

    const key = `${caseId}/${stem}`;
    const flags = readFlags();

    if (flagged === false) {
      delete flags[key];
    } else {
      flags[key] = {
        flagged: true,
        reason: reason || "Not Sure",
        note: note || "",
        flaggedAt: new Date().toISOString(),
      };
    }

    writeFlags(flags);
    return NextResponse.json({ ok: true, flag: flags[key] || null });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
