import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { enqueue, queuePosition } from "~/lib/suggest-queue";
import { suggestOwner } from "~/lib/suggest-owner";

/**
 * Queue an AI suggestion run on one 3D scan. See lib/suggest-queue.ts.
 * Body: { caseId, series }. Returns the job; poll /api/suggest/<id>.
 */

export const dynamic = "force-dynamic";

const ID = /^(BME|NBME)-\d{3}$/;
const SERIES = /^[a-z0-9-]{1,32}$/;

function root() {
  return path.resolve(process.cwd(), "..", "..");
}

export async function POST(req: NextRequest) {
  const owner = suggestOwner(req);
  if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { caseId?: string; series?: string };
  const caseId = String(body.caseId ?? "");
  const series = String(body.series || "primary");
  if (!ID.test(caseId) || !SERIES.test(series)) {
    return NextResponse.json({ error: "bad case or series id" }, { status: 400 });
  }
  const r = root();
  if (!fs.existsSync(path.join(r, "data", "nifti", caseId, `${caseId}_${series}.nii.gz`))) {
    return NextResponse.json({ error: `no volume for ${caseId} ${series}` }, { status: 404 });
  }
  if (!fs.existsSync(path.join(r, "data", "results2dseg", "checkpoints", "manifest.json"))) {
    return NextResponse.json(
      { error: "No 2D segmentation weights. Put unet.pt and its manifest.json in data/results2dseg/checkpoints." },
      { status: 400 },
    );
  }

  const job = enqueue(owner, caseId, series);
  return NextResponse.json({ ...job, owner: undefined, position: queuePosition(job.id) });
}
