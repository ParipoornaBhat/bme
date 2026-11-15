import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, and, isNotNull, desc } from "drizzle-orm";
import { db, caseAnnotation, reviewEdit } from "@bme/db";
import { isReviewMode } from "~/lib/app-mode";
import { getReviewUser, safeAnnotator } from "~/lib/review-auth";

/**
 * The saved annotation for a case, as the raw uint8 labelmap the 3D editor
 * paints into (one byte per voxel of the primary scan, x fastest).
 *
 * Goes through ml/scripts/read_seg.py, which shares its placement code with
 * seg2nifti.py, so a file saved by 3D Slicer (cropped extent, overlapping
 * layers, drawn on another series) opens here exactly as training will see it.
 */

export const dynamic = "force-dynamic";
const exec = promisify(execFile);
const ID = /^(BME|NBME)-\d{3}$/;
const ANNOTATOR_RE = /^[A-Za-z0-9_-]{1,40}$/;

async function reviewHandler(
  req: NextRequest,
  caseId: string,
) {
  if (!ID.test(caseId)) return NextResponse.json({ error: "bad case id" }, { status: 400 });

  const by = req.nextUrl.searchParams.get("by");

  if (by?.toLowerCase() === "mentor") {
    const [mentorEdit] = await db
      .select({ labelsGzB64: reviewEdit.labelsGzB64 })
      .from(reviewEdit)
      .where(
        and(
          eq(reviewEdit.caseId, caseId),
          eq(reviewEdit.kind, "mentor"),
        ),
      )
      .orderBy(desc(reviewEdit.updatedAt), desc(reviewEdit.createdAt))
      .limit(1);

    if (!mentorEdit || !mentorEdit.labelsGzB64) {
      return NextResponse.json({ exists: false, error: "mentor annotation not found" }, { status: 404 });
    }

    try {
      const rawBuf = zlib.gunzipSync(Buffer.from(mentorEdit.labelsGzB64, "base64"));
      return new NextResponse(new Uint8Array(rawBuf), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(rawBuf.length),
          "Cache-Control": "no-store",
        },
      });
    } catch {
      return NextResponse.json({ error: "failed to decompress labelmap" }, { status: 500 });
    }
  }

  if (by === "_review" || by === "_mine") {
    const user = await getReviewUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const safeMe = safeAnnotator(user.displayName) || safeAnnotator(user.username);
    const [openEdit] = await db
      .select()
      .from(reviewEdit)
      .where(
        and(
          eq(reviewEdit.caseId, caseId),
          eq(reviewEdit.reviewer, safeMe),
          eq(reviewEdit.status, "open"),
        ),
      )
      .limit(1);

    if (!openEdit || !openEdit.labelsGzB64) {
      return NextResponse.json({ exists: false, error: "no open review edit" }, { status: 404 });
    }

    try {
      const rawBuf = zlib.gunzipSync(Buffer.from(openEdit.labelsGzB64, "base64"));
      return new NextResponse(new Uint8Array(rawBuf), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(rawBuf.length),
          "Cache-Control": "no-store",
        },
      });
    } catch {
      return NextResponse.json({ error: "failed to decompress labelmap" }, { status: 500 });
    }
  }

  let annotatorToFind = "_main";
  if (by !== null && by !== "") {
    if (!ANNOTATOR_RE.test(by)) {
      return NextResponse.json({ error: "bad annotator name" }, { status: 400 });
    }
    annotatorToFind = by;
  }

  const [row] = await db
    .select()
    .from(caseAnnotation)
    .where(
      and(
        eq(caseAnnotation.caseId, caseId),
        eq(caseAnnotation.annotator, annotatorToFind),
      ),
    )
    .limit(1);

  if (!row || !(row as any).labelsGzB64) {
    return NextResponse.json({ exists: false, error: "annotation labels not found" }, { status: 404 });
  }

  try {
    const rawBuf = zlib.gunzipSync(Buffer.from((row as any).labelsGzB64, "base64"));
    return new NextResponse(new Uint8Array(rawBuf), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(rawBuf.length),
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "failed to decompress labelmap" }, { status: 500 });
  }
}

function root() {
  return path.resolve(process.cwd(), "..", "..");
}

function pythonPath() {
  const r = root();
  const candidates =
    process.platform === "win32"
      ? [path.join(r, "ml", ".venv", "Scripts", "python.exe"), "python"]
      : [path.join(r, "ml", ".venv", "bin", "python"), "python3"];
  return candidates.find((p) => p === "python" || p === "python3" || fs.existsSync(p))!;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;
  if (isReviewMode()) return reviewHandler(_req, caseId);

  if (!ID.test(caseId)) return NextResponse.json({ error: "bad case id" }, { status: 400 });

  const isDeleted = _req.nextUrl.searchParams.get("deleted") === "1";
  const by = _req.nextUrl.searchParams.get("by");

  if (by?.toLowerCase() === "mentor") {
    try {
      const [mentorEdit] = await db
        .select({ labelsGzB64: reviewEdit.labelsGzB64 })
        .from(reviewEdit)
        .where(
          and(
            eq(reviewEdit.caseId, caseId),
            eq(reviewEdit.kind, "mentor"),
          ),
        )
        .orderBy(desc(reviewEdit.updatedAt), desc(reviewEdit.createdAt))
        .limit(1);

      if (!mentorEdit || !mentorEdit.labelsGzB64) {
        return NextResponse.json({ exists: false, error: "mentor annotation not found" }, { status: 404 });
      }

      const rawBuf = zlib.gunzipSync(Buffer.from(mentorEdit.labelsGzB64, "base64"));
      return new NextResponse(new Uint8Array(rawBuf), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(rawBuf.length),
          "Cache-Control": "no-store",
        },
      });
    } catch {
      return NextResponse.json({ exists: false, error: "mentor annotation not found" }, { status: 404 });
    }
  }

  if (isDeleted) {
    let annotatorToFind = "_main";
    if (by !== null && by !== "") {
      if (!ANNOTATOR_RE.test(by)) {
        return NextResponse.json({ error: "bad annotator name" }, { status: 400 });
      }
      annotatorToFind = by;
    }

    try {
      const [row] = await db
        .select()
        .from(caseAnnotation)
        .where(
          and(
            eq(caseAnnotation.caseId, caseId),
            eq(caseAnnotation.annotator, annotatorToFind),
            isNotNull(caseAnnotation.deletedAt),
          ),
        )
        .limit(1);

      if (!row || !row.labelsGzB64) {
        return NextResponse.json({ exists: false, error: "deleted annotation labels not found" }, { status: 404 });
      }

      const rawBuf = zlib.gunzipSync(Buffer.from(row.labelsGzB64, "base64"));
      return new NextResponse(new Uint8Array(rawBuf), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(rawBuf.length),
          "Cache-Control": "no-store",
        },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: `failed to load deleted annotation: ${msg}` }, { status: 500 });
    }
  }

  const series = _req.nextUrl.searchParams.get("series") ?? "";
  const seriesArg = /^[a-z0-9-]{1,32}$/.test(series) ? [series] : [];

  let seg = path.join(root(), "data", "annotations", caseId, `${caseId}.seg.nrrd`);

  if (by !== null) {
    if (!ANNOTATOR_RE.test(by)) {
      return NextResponse.json({ error: "bad annotator name" }, { status: 400 });
    }
    seg = path.join(root(), "data", "annotations", caseId, `${caseId}__${by}.seg.nrrd`);
    if (!fs.existsSync(seg)) {
      return NextResponse.json({ exists: false, error: "annotator copy not found" }, { status: 404 });
    }
  } else {
    if (!fs.existsSync(seg)) return NextResponse.json({ exists: false }, { status: 404 });
  }

  const tmp = path.join(os.tmpdir(), `bme-${caseId}-${Date.now()}.labels`);
  try {
    const { stdout } = await exec(
      pythonPath(),
      [path.join(root(), "ml", "scripts", "read_seg.py"), root(), caseId, seg, tmp, ...seriesArg],
      { cwd: root(), timeout: 120_000 },
    );
    const buf = fs.readFileSync(tmp);
    const info = stdout.trim().split(/\r?\n/).pop() ?? "{}";
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(buf.length),
        "Cache-Control": "no-store",
        "X-Annotation-Info": encodeURIComponent(info),
      },
    });
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    return NextResponse.json(
      { error: (err.stderr || err.message || "could not read annotation").trim() },
      { status: 500 },
    );
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never written */
    }
  }
}
