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
  flagged?: boolean;
  flagReason?: string;
  flagNote?: string;
  flaggedAt?: string;
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
  const flagsPath = path.join(root, "data", "annotations2d_flags.json");
  let flagsMap: Record<string, { flagged: boolean; reason?: string; note?: string; flaggedAt?: string }> = {};
  if (fs.existsSync(flagsPath)) {
    try {
      flagsMap = JSON.parse(fs.readFileSync(flagsPath, "utf8"));
    } catch {
      flagsMap = {};
    }
  }

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

    const flagKey = `${caseId}/${stem}`;
    const flagData = flagsMap[flagKey];

    slices.push({
      caseId,
      label: label as "bme" | "non_bme",
      relPath,
      stem,
      hasMask,
      maskSavedAt,
      flagged: Boolean(flagData?.flagged),
      flagReason: flagData?.reason,
      flagNote: flagData?.note,
      flaggedAt: flagData?.flaggedAt,
    });
  }

  return NextResponse.json({
    slices,
    total: slices.length,
    annotated: slices.filter((s) => s.hasMask).length,
    flagged: slices.filter((s) => s.flagged).length,
  });
}

export async function POST(req: NextRequest) {
  try {
    const root = projectRoot();
    const body = await req.json();
    const { imageData, maskData, label = "bme" } = body;

    if (!imageData) {
      return NextResponse.json({ error: "missing imageData" }, { status: 400 });
    }

    const safeLabel = label === "non_bme" ? "non_bme" : "bme";
    const rawCaseId = (body.caseId || "").trim() || `TEST-${Date.now().toString().slice(-4)}`;
    const caseId = rawCaseId.replace(/[^a-zA-Z0-9_-]/g, "_");

    // Read index.csv to find existing slices for this case
    const idxPath = path.join(root, "data", "slices2d", "index.csv");
    let existingLines: string[] = [];
    if (fs.existsSync(idxPath)) {
      existingLines = fs.readFileSync(idxPath, "utf8").trim().split(/\r?\n/);
    } else {
      fs.mkdirSync(path.dirname(idxPath), { recursive: true });
      existingLines = ["case_id,class,path"];
    }

    let nextIndex = 0;
    for (let i = 1; i < existingLines.length; i++) {
      const [cId] = existingLines[i].split(",").map((s) => s.trim());
      if (cId === caseId) {
        nextIndex++;
      }
    }

    const stem = (body.stem || "").trim() || `${caseId}_s${String(nextIndex).padStart(3, "0")}`;
    const imgDir = path.join(root, "data", "slices2d", safeLabel);
    fs.mkdirSync(imgDir, { recursive: true });

    const imgRelPath = `${safeLabel}/${stem}.png`;
    const imgFullPath = path.join(imgDir, `${stem}.png`);
    const imgBuf = Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ""), "base64");
    fs.writeFileSync(imgFullPath, imgBuf);

    // If mask is provided, write it to data/annotations2d/<caseId>/<stem>.mask.png
    let savedMask = false;
    if (maskData) {
      const annDir = path.join(root, "data", "annotations2d", caseId);
      fs.mkdirSync(annDir, { recursive: true });
      const maskFullPath = path.join(annDir, `${stem}.mask.png`);
      const maskBuf = Buffer.from(maskData.replace(/^data:image\/\w+;base64,/, ""), "base64");
      fs.writeFileSync(maskFullPath, maskBuf);
      savedMask = true;
    }

    // Append to index.csv if not already present
    const newLine = `${caseId},${safeLabel},${imgRelPath}`;
    const existsInIndex = existingLines.slice(1).some((l) => l.trim() === newLine);
    if (!existsInIndex) {
      const content = fs.existsSync(idxPath) ? fs.readFileSync(idxPath, "utf8") : "case_id,class,path\n";
      const endsWithNewline = content.endsWith("\n") || content.endsWith("\r\n");
      fs.appendFileSync(idxPath, `${endsWithNewline ? "" : "\n"}${newLine}\n`, "utf8");
    }

    return NextResponse.json({
      ok: true,
      caseId,
      stem,
      label: safeLabel,
      relPath: imgRelPath,
      hasMask: savedMask,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: "Failed to add slice to dataset", detail: String(err) },
      { status: 500 },
    );
  }
}
