import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { cancel, getJob, jobDir, queuePosition } from "~/lib/suggest-queue";
import { suggestOwner } from "~/lib/suggest-owner";

/** Status of one suggestion job (with its result once done), or DELETE to cancel it. */

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ jobId: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const { jobId } = await params;
  const job = getJob(jobId, suggestOwner(req) ?? "");
  if (!job) return NextResponse.json({ error: "no such job" }, { status: 404 });

  let result: unknown = null;
  if (job.state === "done") {
    try {
      result = JSON.parse(fs.readFileSync(path.join(jobDir(job.id), "result.json"), "utf8"));
    } catch {
      result = null;
    }
  }
  return NextResponse.json({ ...job, owner: undefined, position: queuePosition(job.id), result });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { jobId } = await params;
  if (!cancel(jobId, suggestOwner(req) ?? "")) {
    return NextResponse.json({ error: "no such job" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
