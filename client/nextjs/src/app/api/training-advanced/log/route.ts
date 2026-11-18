import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { isReviewMode } from "~/lib/app-mode";
import { fetchJobLog, root } from "~/lib/training-advanced/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  const { searchParams } = req.nextUrl;
  const platform = searchParams.get("platform");
  const targetId = searchParams.get("targetId") || "";
  const folder = searchParams.get("folder") || "";
  const linesCount = parseInt(searchParams.get("lines") || "50", 10);
  const jobId = searchParams.get("jobId") || "";

  try {
    let lines: string[] = [];

    if (platform === "h200") {
      return NextResponse.json(await fetchJobLog(targetId, linesCount, jobId));
    }
    if (platform === "local") {
      const dataDir = path.join(root, "data");
      // Find matching folder or default train.log
      const candidates = [
        path.join(dataDir, folder, "train.log"),
        path.join(dataDir, `results3d-${folder}-pc`, "train.log"),
        path.join(dataDir, "results3d", "train.log"),
        path.join(dataDir, "results2d", "train.log"),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          lines = fs.readFileSync(p, "utf8").trim().split(/\r?\n/).slice(-linesCount);
          break;
        }
      }
    } else if (platform === "kaggle") {
      // Look in staging for this account
      const roll = targetId.split("-")[1] || "";
      const stagingDir = path.resolve(root, "..", "bme_kaggle_staging", "accounts", roll);
      const logFile = path.join(stagingDir, "latest_kernel.log");
      if (fs.existsSync(logFile)) {
        lines = fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).slice(-linesCount);
      }
    }

    return NextResponse.json({
      targetId,
      platform,
      lines,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to fetch log" }, { status: 500 });
  }
}
