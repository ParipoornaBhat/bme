import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

/**
 * Streams a case's primary NIfTI volume to the browser viewer.
 *
 * Volumes live under the gitignored data/ directory and are never copied into
 * public/ — serving them through an API route keeps them off the static file
 * tree, so a production build cannot accidentally publish patient imaging.
 */

export const dynamic = "force-dynamic";

const ID = /^(BME|NBME)-\d{3}$/;

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
