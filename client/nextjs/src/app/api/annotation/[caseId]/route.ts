import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, and } from "drizzle-orm";
import { db, caseAnnotation } from "@bme/db";
import { isReviewMode } from "~/lib/app-mode";
import { getReviewUser, reviewEdit, safeAnnotator } from "~/lib/review-auth";
import { runAnnotationSync } from "~/lib/annotation-sync";

function safeAnnotatorLocal(name: string | null | undefined): string | null {
  if (!name) return null;
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  return safe || null;
}

/**
 * Save and load annotations for the web editor.
 *
 * POST takes the painted labelmap as a raw uint8 body and hands it to
 * ml/scripts/write_seg.py, which stamps on the source volume's geometry and
 * writes a Slicer-compatible .seg.nrrd. Writing NRRD in Node was the other
 * option; going through Python reuses the geometry conversion that was already
 * verified against a real Slicer export, rather than reimplementing it here and
 * hoping the two agree.
 */

export const dynamic = "force-dynamic";
const exec = promisify(execFile);
const ID = /^(BME|NBME)-\d{3}$/;

async function reviewGetHandler(
  req: NextRequest,
  caseId: string,
) {
  if (!ID.test(caseId)) return NextResponse.json({ error: "bad case id" }, { status: 400 });

  const rows = await db
    .select()
    .from(caseAnnotation)
    .where(eq(caseAnnotation.caseId, caseId));

  const mainRow = rows.find((r) => r.annotator === "_main");
  const personRows = rows.filter((r) => r.annotator !== "_main");

  personRows.sort((a, b) => {
    const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return timeA - timeB;
  });

  const mainSha = mainRow?.sha256;
  let matchedMain = false;
  const annotators = personRows.map((item) => {
    let isMain = false;
    if (mainSha && !matchedMain && item.sha256 === mainSha) {
      isMain = true;
      matchedMain = true;
    }
    return {
      name: item.annotator,
      savedAt: (item.updatedAt || item.createdAt || new Date()).toISOString(),
      isMain,
    };
  });

  let review: { status: string; updatedAt: string } | null = null;
  const user = await getReviewUser(req);
  if (user) {
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

    if (openEdit) {
      review = {
        status: openEdit.status,
        updatedAt: (openEdit.updatedAt || openEdit.createdAt || new Date()).toISOString(),
      };
    }
  }

  if (!mainRow) {
    return NextResponse.json({ exists: false, annotators, review });
  }

  return NextResponse.json({
    exists: true,
    savedAt: (mainRow.updatedAt || mainRow.createdAt || new Date()).toISOString(),
    bytes: mainRow.bytes,
    annotators,
    review,
  });
}

async function reviewPostHandler(
  req: NextRequest,
  caseId: string,
) {
  if (!ID.test(caseId)) return NextResponse.json({ error: "bad case id" }, { status: 400 });

  const user = await getReviewUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = Buffer.from(await req.arrayBuffer());
  if (body.length === 0) {
    return NextResponse.json({ error: "empty labelmap" }, { status: 400 });
  }
  if (body.length > 40 * 1024 * 1024) {
    return NextResponse.json({ error: "payload exceeds 40MB limit" }, { status: 413 });
  }

  const note = req.nextUrl.searchParams.get("note") || null;
  const baseAnnotator = req.nextUrl.searchParams.get("base") || null;

  const safeMe = safeAnnotator(user.displayName) || safeAnnotator(user.username);
  const kind = user.role === "team" ? "team" : "review";
  const labelsGzB64 = zlib.gzipSync(body).toString("base64");
  const now = new Date();

  const [existing] = await db
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

  if (existing) {
    await db
      .update(reviewEdit)
      .set({
        labelsGzB64,
        note,
        baseAnnotator,
        kind,
        updatedAt: now,
      })
      .where(eq(reviewEdit.id, existing.id));
  } else {
    await db.insert(reviewEdit).values({
      caseId,
      reviewer: safeMe,
      baseAnnotator,
      labelsGzB64,
      note,
      status: "open",
      kind,
      createdAt: now,
      updatedAt: now,
    });
  }

  return NextResponse.json({
    ok: true,
    review: {
      status: "open",
      updatedAt: now.toISOString(),
    },
  });
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
  if (isReviewMode()) return reviewGetHandler(_req, caseId);

  if (!ID.test(caseId)) return NextResponse.json({ error: "bad case id" }, { status: 400 });

  const caseDir = path.join(root(), "data", "annotations", caseId);
  const seg = path.join(caseDir, `${caseId}.seg.nrrd`);
  const mainExists = fs.existsSync(seg);

  let mainStat: fs.Stats | null = null;
  if (mainExists) {
    try {
      mainStat = fs.statSync(seg);
    } catch {
      mainStat = null;
    }
  }

  const annotatorsList: {
    name: string;
    savedAt: string;
    mtimeMs: number;
    size: number;
  }[] = [];

  if (fs.existsSync(caseDir)) {
    try {
      const files = fs.readdirSync(caseDir, { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile()) continue;
        const m = f.name.match(new RegExp(`^${caseId}__([A-Za-z0-9_-]{1,40})\\.seg\\.nrrd$`));
        if (!m) continue;
        const filePath = path.join(caseDir, f.name);
        try {
          const st = fs.statSync(filePath);
          annotatorsList.push({
            name: m[1],
            savedAt: st.mtime.toISOString(),
            mtimeMs: st.mtimeMs,
            size: st.size,
          });
        } catch {
          // Skip unreadable file
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  // Sort by savedAt ascending
  annotatorsList.sort((a, b) => a.mtimeMs - b.mtimeMs);

  let matchedMain = false;
  const annotators = annotatorsList.map((item) => {
    let isMain = false;
    if (mainStat && !matchedMain && mainStat.size === item.size) {
      isMain = true;
      matchedMain = true;
    }
    return {
      name: item.name,
      savedAt: item.savedAt,
      isMain,
    };
  });

  if (!mainExists || !mainStat) {
    return NextResponse.json({ exists: false, annotators });
  }

  return NextResponse.json({
    exists: true,
    savedAt: mainStat.mtime.toISOString(),
    bytes: mainStat.size,
    annotators,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;
  if (isReviewMode()) return reviewPostHandler(req, caseId);

  if (!ID.test(caseId)) return NextResponse.json({ error: "bad case id" }, { status: 400 });

  const paramsUrl = new URL(req.url);
  const annotator = paramsUrl.searchParams.get("by") ?? "";
  const series = paramsUrl.searchParams.get("series") ?? "";
  const seriesArg = /^[a-z0-9-]{1,32}$/.test(series) ? ["--series", series] : [];
  const body = Buffer.from(await req.arrayBuffer());
  if (body.length === 0) {
    return NextResponse.json({ error: "empty labelmap" }, { status: 400 });
  }

  const tmp = path.join(os.tmpdir(), `bme-${caseId}-${Date.now()}.raw`);
  fs.writeFileSync(tmp, body);

  try {
    const { stdout } = await exec(
      pythonPath(),
      [path.join(root(), "ml", "scripts", "write_seg.py"), root(), caseId, tmp,
       ...seriesArg,
       ...(annotator ? [annotator] : [])],
      { cwd: root(), timeout: 120_000 },
    );

    const safeMe = annotator ? safeAnnotatorLocal(annotator) : null;
    runAnnotationSync({ me: safeMe, only: [caseId] }).catch(() => {
      // Swallowed: local save must never fail or slow down because of the database
    });

    return NextResponse.json({ ok: true, detail: stdout.trim(), cloud: "queued" });
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    return NextResponse.json(
      { error: (err.stderr || err.message || "write failed").trim() },
      { status: 500 },
    );
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp file already gone */
    }
  }
}

/**
 * Removes the canonical <CASE>.seg.nrrd, which is what training and the editor
 * read. Each annotator's own <CASE>__<name>.seg.nrrd copy is left in place, so
 * a mistaken delete can be recovered from it.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;
  if (!ID.test(caseId)) return NextResponse.json({ error: "bad case id" }, { status: 400 });
  const seg = path.join(root(), "data", "annotations", caseId, `${caseId}.seg.nrrd`);
  try {
    fs.rmSync(seg, { force: true });
  } catch (e) {
    return NextResponse.json({ error: `failed to delete mask: ${e}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, deleted: true });
}
