import { NextRequest, NextResponse } from "next/server";
import { isReviewMode } from "~/lib/app-mode";
import { cancelJob } from "~/lib/training-advanced/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  try {
    const body = await req.json();
    // The page sends the Slurm job id as slurmJobId; accept jobId too.
    const { platform, targetId } = body;
    const jobId = String(body.slurmJobId || body.jobId || "").trim();

    if (!platform || !targetId) {
      return NextResponse.json({ error: "Missing required parameters (platform, targetId)" }, { status: 400 });
    }
    // Without a job id the H200 would cancel every job on the account. Refuse.
    if (platform === "h200" && !/^\d+$/.test(jobId)) {
      return NextResponse.json({ error: "No job id for this run, so nothing was cancelled. Refresh the status and try again." }, { status: 400 });
    }

    const res = await cancelJob(platform, targetId, jobId);
    return NextResponse.json(res);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to cancel run" }, { status: 500 });
  }
}
