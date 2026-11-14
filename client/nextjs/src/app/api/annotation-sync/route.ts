import { NextRequest, NextResponse } from "next/server";
import {
  runAnnotationSync,
  backfillLabels,
  sanitizeAnnotator,
  getLastSyncReport,
} from "~/lib/annotation-sync";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const by = searchParams.get("by");
  const me = sanitizeAnnotator(by);

  if (searchParams.get("backfill") === "1") {
    const res = await backfillLabels({ me });
    return NextResponse.json(res);
  }

  const dryRun = searchParams.get("dry") === "1";
  const report = await runAnnotationSync({ me, dryRun });
  return NextResponse.json(report);
}

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  if (searchParams.get("backfill") === "1") {
    const by = searchParams.get("by");
    const me = sanitizeAnnotator(by);
    const res = await backfillLabels({ me });
    return NextResponse.json(res);
  }

  const report = getLastSyncReport();
  if (!report) {
    return NextResponse.json({ ok: false, reason: "not run yet" });
  }
  return NextResponse.json(report);
}
