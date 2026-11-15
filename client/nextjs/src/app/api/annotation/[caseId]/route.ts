import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, and, isNull, isNotNull, inArray, asc } from "drizzle-orm";
import { db, caseAnnotation, reviewEdit, reviewEditVersion, caseOwner, ownerForCase, caseReview } from "@bme/db";
import { isReviewMode } from "~/lib/app-mode";
import { getReviewUser, safeAnnotator } from "~/lib/review-auth";
import { runAnnotationSync } from "~/lib/annotation-sync";
import { logEvents } from "~/lib/annotation-events";

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

  const activeRows = rows.filter((r) => !r.deletedAt);
  const tombstonedRows = rows.filter((r) => Boolean(r.deletedAt));

  const mainRow = activeRows.find((r) => r.annotator === "_main");
  const personRows = activeRows.filter((r) => r.annotator !== "_main");

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

  const deleted = tombstonedRows.map((r) => ({
    name: r.annotator,
    deletedAt: (r.deletedAt || new Date()).toISOString(),
    reason: r.deletedReason ?? null,
    supersededBy: r.supersededBy ?? null,
  }));

  let annotatedBy: string | null = null;
  try {
    const [ownerRow] = await db
      .select()
      .from(caseOwner)
      .where(eq(caseOwner.caseId, caseId))
      .limit(1);
    if (ownerRow) {
      annotatedBy = ownerRow.annotatedBy ?? null;
    } else if (typeof ownerForCase === "function") {
      annotatedBy = ownerForCase(caseId) ?? null;
    }
  } catch {
    if (typeof ownerForCase === "function") {
      annotatedBy = ownerForCase(caseId) ?? null;
    }
  }

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

  const annotatedByAll: string[] = [];
  const seenAnnotators = new Set<string>();
  if (annotatedBy) {
    annotatedByAll.push(annotatedBy);
    seenAnnotators.add(annotatedBy);
  }
  for (const item of personRows) {
    if (item.annotator && item.annotator !== "_main" && !seenAnnotators.has(item.annotator)) {
      annotatedByAll.push(item.annotator);
      seenAnnotators.add(item.annotator);
    }
  }

  const reviewRows = await db
    .select()
    .from(caseReview)
    .where(eq(caseReview.caseId, caseId))
    .orderBy(asc(caseReview.markedAt));

  const reviews = reviewRows.map((r) => ({
    reviewer: r.reviewer,
    role: r.role,
    status: r.status,
    locked: r.locked,
    markedAt: (r.markedAt || r.updatedAt || new Date()).toISOString(),
  }));

  let myReview: {
    reviewer: string;
    role: string;
    status: string;
    locked: boolean;
    markedAt: string;
  } | null = null;

  if (user) {
    const safeMe = safeAnnotator(user.displayName) || safeAnnotator(user.username);
    const found = reviews.find((r) => r.reviewer === safeMe);
    if (found) {
      myReview = found;
    }
  }

  if (!mainRow) {
    return NextResponse.json({
      exists: false,
      annotators,
      review,
      reviews,
      myReview,
      annotatedBy,
      annotatedByAll,
      deleted,
    });
  }

  return NextResponse.json({
    exists: true,
    savedAt: (mainRow.updatedAt || mainRow.createdAt || new Date()).toISOString(),
    bytes: mainRow.bytes,
    annotators,
    review,
    reviews,
    myReview,
    annotatedBy,
    annotatedByAll,
    deleted,
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

  const [myReviewRow] = await db
    .select()
    .from(caseReview)
    .where(
      and(
        eq(caseReview.caseId, caseId),
        eq(caseReview.reviewer, safeMe),
      ),
    )
    .limit(1);

  if (myReviewRow?.locked) {
    return NextResponse.json(
      { error: "You marked this case as reviewed. Unmark it to edit." },
      { status: 423 },
    );
  }

  const base = baseAnnotator || "_main";
  const [earlierEdit] = await db
    .select()
    .from(reviewEdit)
    .where(
      and(
        eq(reviewEdit.caseId, caseId),
        eq(reviewEdit.reviewer, safeMe),
      ),
    )
    .limit(1);

  if (!earlierEdit) {
    const [baseRow] = await db
      .select()
      .from(caseAnnotation)
      .where(
        and(
          eq(caseAnnotation.caseId, caseId),
          eq(caseAnnotation.annotator, base),
        ),
      )
      .limit(1);

    if (baseRow?.labelsGzB64) {
      try {
        const baseBuf = zlib.gunzipSync(Buffer.from(baseRow.labelsGzB64, "base64"));
        if (body.equals(baseBuf)) {
          return NextResponse.json({ ok: true, unchanged: true });
        }
      } catch {
        // ignore decompression failure and continue save
      }
    }
  }

  const kind = user.role === "team" ? "team" : "review";
  const labelsGzB64 = zlib.gzipSync(body).toString("base64");
  const now = new Date();

  await db.transaction(async (tx) => {
    const [existing] = await tx
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

    let editId: string;
    if (existing) {
      editId = existing.id;
      await tx
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
      const [inserted] = await tx
        .insert(reviewEdit)
        .values({
          caseId,
          reviewer: safeMe,
          baseAnnotator,
          labelsGzB64,
          note,
          status: "open",
          kind,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: reviewEdit.id });
      editId = inserted.id;
    }

    await tx.insert(reviewEditVersion).values({
      reviewEditId: editId,
      labelsGzB64,
      note,
      savedAt: now,
    });

    if (user.role === "radiologist") {
      const base = baseAnnotator || "_main";
      const targets = base === "_main" ? ["_main"] : [base, "_main"];
      await tx
        .update(caseAnnotation)
        .set({
          deletedAt: now,
          deletedBy: safeMe,
          deletedReason: "superseded",
          supersededBy: safeMe,
        })
        .where(
          and(
            eq(caseAnnotation.caseId, caseId),
            inArray(caseAnnotation.annotator, targets),
            isNull(caseAnnotation.deletedAt),
          ),
        );
    }
  });

  try {
    if (user.role === "radiologist") {
      await logEvents([
        {
          caseId,
          annotator: safeMe,
          actor: safeMe,
          action: "review-submit",
        },
        {
          caseId,
          annotator: safeMe,
          actor: safeMe,
          action: "supersede",
          details: { base },
        },
      ]);
    } else if (user.role === "team") {
      await logEvents([
        {
          caseId,
          annotator: safeMe,
          actor: safeMe,
          action: "team-submit",
        },
      ]);
    } else {
      await logEvents([
        {
          caseId,
          annotator: safeMe,
          actor: safeMe,
          action: "review-submit",
        },
      ]);
    }
  } catch (err) {
    console.error("failed to log review event:", err);
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

  let deleted: { name: string; deletedAt: string; reason: string | null; supersededBy: string | null }[] = [];
  try {
    const tombstonedRows = await db
      .select()
      .from(caseAnnotation)
      .where(
        and(
          eq(caseAnnotation.caseId, caseId),
          isNotNull(caseAnnotation.deletedAt),
        ),
      );
    deleted = tombstonedRows.map((r) => ({
      name: r.annotator,
      deletedAt: (r.deletedAt || new Date()).toISOString(),
      reason: r.deletedReason ?? null,
      supersededBy: r.supersededBy ?? null,
    }));
  } catch {
    deleted = [];
  }
  const tombstonedNames = new Set(deleted.map((d) => d.name));

  let annotatedBy: string | null = null;
  try {
    const [ownerRow] = await db
      .select()
      .from(caseOwner)
      .where(eq(caseOwner.caseId, caseId))
      .limit(1);
    if (ownerRow) {
      annotatedBy = ownerRow.annotatedBy ?? null;
    } else if (typeof ownerForCase === "function") {
      annotatedBy = ownerForCase(caseId) ?? null;
    }
  } catch {
    if (typeof ownerForCase === "function") {
      annotatedBy = ownerForCase(caseId) ?? null;
    }
  }

  const caseDir = path.join(root(), "data", "annotations", caseId);
  const seg = path.join(caseDir, `${caseId}.seg.nrrd`);
  const mainIsTombstoned = tombstonedNames.has("_main");
  const mainExists = !mainIsTombstoned && fs.existsSync(seg);

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
        const name = m[1];
        if (tombstonedNames.has(name)) continue;
        const filePath = path.join(caseDir, f.name);
        try {
          const st = fs.statSync(filePath);
          annotatorsList.push({
            name,
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

  type SlicesHelperData = Record<
    string,
    {
      marked: number | null;
      total: number | null;
      identical_to: string | null;
      error?: string;
    }
  >;
  let helperData: SlicesHelperData | null = null;
  try {
    const py = pythonPath();
    const script = path.join(root(), "ml", "scripts", "annotation_slices.py");
    const { stdout } = await exec(py, [script, root(), caseId], {
      cwd: root(),
      timeout: 15_000,
    });
    const parsed = JSON.parse(stdout.trim());
    if (parsed && typeof parsed === "object") {
      helperData = parsed as SlicesHelperData;
    }
  } catch {
    helperData = null;
  }

  const mainFileName = `${caseId}.seg.nrrd`;
  const mainFileInfo = helperData?.[mainFileName];
  const mainIdenticalMatch = mainFileInfo?.identical_to?.match(
    new RegExp(`^${caseId}__([A-Za-z0-9_-]{1,40})\\.seg\\.nrrd$`),
  );
  const mainIdenticalName = mainIdenticalMatch ? mainIdenticalMatch[1] : null;

  let matchedMain = false;
  const annotators = annotatorsList.map((item) => {
    let isMain = false;
    if (mainIdenticalName) {
      if (!matchedMain && item.name === mainIdenticalName) {
        isMain = true;
        matchedMain = true;
      }
    } else if (mainStat && !matchedMain && mainStat.size === item.size) {
      isMain = true;
      matchedMain = true;
    }

    const itemFileName = `${caseId}__${item.name}.seg.nrrd`;
    const fileInfo = helperData?.[itemFileName];

    let slices: { marked: number; total: number } | null = null;
    if (fileInfo && typeof fileInfo.marked === "number" && typeof fileInfo.total === "number") {
      slices = { marked: fileInfo.marked, total: fileInfo.total };
    }

    const idMatch = fileInfo?.identical_to?.match(
      new RegExp(`^${caseId}__([A-Za-z0-9_-]{1,40})\\.seg\\.nrrd$`),
    );
    const idName = idMatch ? idMatch[1] : null;
    const identicalTo = isMain ? (mainIdenticalName ?? idName ?? null) : idName;

    const entry: {
      name: string;
      savedAt: string;
      isMain: boolean;
      slices?: { marked: number; total: number } | null;
      identicalTo?: string | null;
    } = {
      name: item.name,
      savedAt: item.savedAt,
      isMain,
    };

    if (helperData !== null) {
      entry.slices = slices;
      entry.identicalTo = identicalTo;
    }

    return entry;
  });

  let reviews: {
    reviewer: string;
    role: string;
    status: string;
    locked: boolean;
    markedAt: string;
  }[] = [];
  try {
    const reviewRows = await db
      .select()
      .from(caseReview)
      .where(eq(caseReview.caseId, caseId))
      .orderBy(asc(caseReview.markedAt));

    reviews = reviewRows.map((r) => ({
      reviewer: r.reviewer,
      role: r.role,
      status: r.status,
      locked: r.locked,
      markedAt: (r.markedAt || r.updatedAt || new Date()).toISOString(),
    }));
  } catch {
    reviews = [];
  }

  const annotatedByAll: string[] = [];
  const seenAnnotators = new Set<string>();
  if (annotatedBy) {
    annotatedByAll.push(annotatedBy);
    seenAnnotators.add(annotatedBy);
  }

  let personCopyNames: string[] = [];
  try {
    const dbActive = await db
      .select({ annotator: caseAnnotation.annotator, createdAt: caseAnnotation.createdAt })
      .from(caseAnnotation)
      .where(
        and(
          eq(caseAnnotation.caseId, caseId),
          isNull(caseAnnotation.deletedAt),
        ),
      );
    const dbPersons = dbActive.filter((r) => r.annotator !== "_main");
    dbPersons.sort((a, b) => {
      const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return timeA - timeB;
    });
    personCopyNames = dbPersons.map((p) => p.annotator);
  } catch {
    personCopyNames = [];
  }
  if (personCopyNames.length === 0) {
    personCopyNames = annotatorsList.map((a) => a.name);
  }
  for (const name of personCopyNames) {
    if (name && name !== "_main" && !seenAnnotators.has(name)) {
      annotatedByAll.push(name);
      seenAnnotators.add(name);
    }
  }

  if (!mainExists || !mainStat) {
    return NextResponse.json({
      exists: false,
      annotators,
      annotatedBy,
      annotatedByAll,
      reviews,
      deleted,
    });
  }

  return NextResponse.json({
    exists: true,
    savedAt: mainStat.mtime.toISOString(),
    bytes: mainStat.size,
    annotators,
    annotatedBy,
    annotatedByAll,
    reviews,
    deleted,
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

    logEvents([
      {
        caseId,
        annotator: safeMe ?? undefined,
        actor: safeMe ?? undefined,
        action: "save",
      },
    ]).catch(() => {
      // fire and forget
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
