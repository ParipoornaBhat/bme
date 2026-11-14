import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@bme/db";
import { isReviewMode } from "~/lib/app-mode";
import { reviewScan } from "~/lib/review-auth";

/**
 * Streams a case's primary NIfTI volume to the browser viewer.
 *
 * Volumes live under the gitignored data/ directory and are never copied into
 * public/ — serving them through an API route keeps them off the static file
 * tree, so a production build cannot accidentally publish patient imaging.
 */

export const dynamic = "force-dynamic";

const ID = /^(BME|NBME)-\d{3}$/;

async function reviewHandler(req: NextRequest, caseId: string) {
  if (!ID.test(caseId)) {
    return NextResponse.json({ error: "bad case id" }, { status: 400 });
  }

  const listOnly = req.nextUrl.searchParams.get("list") === "1";
  if (listOnly) {
    return NextResponse.json({
      annotated: "primary",
      series: [{ id: "primary", label: caseId }],
    });
  }

  const [scan] = await db
    .select()
    .from(reviewScan)
    .where(eq(reviewScan.caseId, caseId))
    .limit(1);

  if (!scan) {
    return NextResponse.json({ error: `no volume for ${caseId}` }, { status: 404 });
  }

  const driveUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(scan.driveFileId)}&export=download&confirm=t`;
  try {
    const upstream = await fetch(driveUrl, {
      redirect: "follow",
    });

    if (!upstream.ok || !upstream.body) {
      return NextResponse.json(
        { error: `failed to load volume for ${caseId}` },
        { status: upstream.status >= 400 && upstream.status < 500 ? 404 : 502 },
      );
    }

    const headers = new Headers();
    headers.set("Content-Type", "application/gzip");
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) {
      headers.set("Content-Length", contentLength);
    }
    headers.set("Cache-Control", "private, max-age=3600");

    return new NextResponse(upstream.body, {
      status: 200,
      headers,
    });
  } catch {
    return NextResponse.json(
      { error: "failed to stream volume from storage" },
      { status: 502 },
    );
  }
}

function seriesList(dir: string, caseId: string) {
  const primary = path.join(dir, `${caseId}_primary.nii.gz`);
  let annotated = "";
  let series: { id: string; label: string }[] = [];
  const meta = path.join(dir, "series.json");
  if (fs.existsSync(meta)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(meta, "utf8")) as {
        annotated?: string;
        series?: { id: string; label: string }[];
      };
      annotated = parsed.annotated ?? "";
      series = (parsed.series ?? []).filter((s) =>
        fs.existsSync(path.join(dir, `${caseId}_${s.id}.nii.gz`)),
      );
    } catch {
      series = [];
    }
  }
  if (!series.length && fs.existsSync(primary)) {
    series = [{ id: "primary", label: caseId }];
    annotated = "primary";
  }
  return { annotated, series };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;
  if (isReviewMode()) return reviewHandler(_req, caseId);

  // Path traversal guard: only our own generated IDs are ever valid.
  if (!ID.test(caseId)) {
    return NextResponse.json({ error: "bad case id" }, { status: 400 });
  }

  const root = path.resolve(process.cwd(), "..", "..");
  const dir = path.join(root, "data", "nifti", caseId);
  const listOnly = _req.nextUrl.searchParams.get("list") === "1";
  if (listOnly) {
    return NextResponse.json(seriesList(dir, caseId));
  }

  const asked = _req.nextUrl.searchParams.get("series") ?? "";
  const series = /^[a-z0-9-]{1,32}$/.test(asked) ? asked : "";
  const named = series ? path.join(dir, `${caseId}_${series}.nii.gz`) : "";
  const file = named && fs.existsSync(named)
    ? named
    : path.join(dir, `${caseId}_primary.nii.gz`);

  if (!fs.existsSync(file)) {
    return NextResponse.json(
      { error: `no volume for ${caseId} — run ml/scripts/convert.py` },
      { status: 404 },
    );
  }

  const buf = fs.readFileSync(file);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Length": String(buf.length),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
