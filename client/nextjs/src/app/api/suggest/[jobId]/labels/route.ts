import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getJob, jobDir } from "~/lib/suggest-queue";
import { suggestOwner } from "~/lib/suggest-owner";

/**
 * A finished job's suggestion volume: gzip of one uint8 per voxel
 * (0 none, 1 bone, 2 edema), i fastest. Only the session that asked gets it.
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const job = getJob(jobId, suggestOwner(req) ?? "");
  if (!job || job.state !== "done") return NextResponse.json({ error: "no such result" }, { status: 404 });
  const f = path.join(jobDir(job.id), "labels.bin.gz");
  if (!fs.existsSync(f)) return NextResponse.json({ error: "result expired" }, { status: 404 });
  const buf = fs.readFileSync(f);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Length": String(buf.length),
      "Cache-Control": "no-store",
    },
  });
}
