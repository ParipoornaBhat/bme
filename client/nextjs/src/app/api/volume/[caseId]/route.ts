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
  const file = path.join(root, "data", "nifti", caseId, `${caseId}_primary.nii.gz`);

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
