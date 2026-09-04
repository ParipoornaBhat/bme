import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

function projectRoot() {
  return path.resolve(process.cwd(), "..", "..");
}

export type Case2DSlice = {
  caseId: string;
  label: "bme" | "non_bme";
  relPath: string;
  stem: string;
  hasMask: boolean;
  maskSavedAt: string | null;
};

export async function GET(req: NextRequest) {
  const root = projectRoot();
  const searchParams = req.nextUrl.searchParams;
  const imageRel = searchParams.get("image");

  // Serve image file if requested
  if (imageRel) {
    const safeRel = path.normalize(imageRel).replace(/^(\.\.(\/|\\|$))+/, "");
    const imgPath = path.join(root, "data", "slices2d", safeRel);
    if (!fs.existsSync(imgPath)) {
      return NextResponse.json({ error: "image not found" }, { status: 404 });
    }
    const buf = fs.readFileSync(imgPath);
    return new NextResponse(buf, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  const idxPath = path.join(root, "data", "slices2d", "index.csv");
  if (!fs.existsSync(idxPath)) {
    return NextResponse.json({ slices: [], total: 0 });
  }

  const lines = fs.readFileSync(idxPath, "utf8").trim().split(/\r?\n/);
  if (lines.length < 2) {
    return NextResponse.json({ slices: [], total: 0 });
  }

  const ann2dDir = path.join(root, "data", "annotations2d");
  const slices: Case2DSlice[] = [];

  for (let i = 1; i < lines.length; i++) {
    const [caseId, label, relPath] = lines[i].split(",").map((s) => s.trim());
    if (!caseId || !relPath) continue;

    const stem = path.basename(relPath, path.extname(relPath));
    const maskPath = path.join(ann2dDir, caseId, `${stem}.mask.png`);
    const hasMask = fs.existsSync(maskPath);
    let maskSavedAt: string | null = null;
    if (hasMask) {
      try {
        maskSavedAt = fs.statSync(maskPath).mtime.toISOString();
      } catch {
        maskSavedAt = null;
      }
    }

    slices.push({
      caseId,
      label: label as "bme" | "non_bme",
      relPath,
      stem,
      hasMask,
      maskSavedAt,
    });
  }

  return NextResponse.json({
    slices,
    total: slices.length,
    annotated: slices.filter((s) => s.hasMask).length,
  });
}
