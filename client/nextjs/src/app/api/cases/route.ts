import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { eq, and, inArray, isNull, isNotNull } from "drizzle-orm";
import { db, caseAnnotation, caseOwner, ownerForCase, caseReview } from "@bme/db";
import { isReviewMode } from "~/lib/app-mode";
import { reviewAccount, reviewScan } from "~/lib/review-auth";
import { readFlags } from "~/lib/flag-store";

/**
 * Case list for the annotation workspace.
 *
 * PHI NOTE — read before changing this.
 * The original archive filenames are patient names ("--MOHAMMED-FAIZ.zip"). They
 * are returned ONLY when SHOW_SOURCE_NAMES=true is set in the local .env, which
 * is gitignored and off by default. Without it the API returns pseudonymous IDs
 * and nothing else, so a screenshot, a deployed build, or a shared browser
 * session cannot leak identities. Do not remove the flag to "make it simpler".
 */

export const dynamic = "force-dynamic";

const SHOW_NAMES = process.env.SHOW_SOURCE_NAMES === "true";

type CaseOrId = string | { id: string; cls?: string };

function compareCaseIds(a: CaseOrId, b: CaseOrId): number {
  const idA = typeof a === "string" ? a : a.id;
  const idB = typeof b === "string" ? b : b.id;
  const clsA = typeof a === "string" ? undefined : a.cls;
  const clsB = typeof b === "string" ? undefined : b.cls;

  const isBme = (id: string, cls?: string) => {
    if (cls === "bme") return true;
    if (cls === "non_bme") return false;
    return id.startsWith("BME-");
  };

  const bmeA = isBme(idA, clsA);
  const bmeB = isBme(idB, clsB);
  if (bmeA !== bmeB) {
    return bmeA ? -1 : 1;
  }

  const numA = parseInt(idA.replace(/\D+/g, ""), 10) || 0;
  const numB = parseInt(idB.replace(/\D+/g, ""), 10) || 0;
  return numA !== numB ? numA - numB : idA.localeCompare(idB);
}

/**
 * For a case with no owner set: the person behind its earliest team copy (never a
 * reviewer or mentor), in the short form the owner table uses ("Aditi_H_Nayak" -> "Aditi").
 * Same rule the viewer uses for "Annotated by", so the list and the viewer agree.
 */
async function firstCopyOwners(): Promise<Map<string, string>> {
  try {
    const rev = await db
      .select({ u: reviewAccount.username, d: reviewAccount.displayName })
      .from(reviewAccount)
      .where(inArray(reviewAccount.role, ["radiologist", "reviewer", "mentor"]));
    const reviewers = new Set<string>(
      rev.flatMap((r: { u: string; d: string }) => [r.u, r.d].filter(Boolean).map((x) => String(x).toLowerCase())),
    );
    const rows = await db
      .select({ caseId: caseAnnotation.caseId, annotator: caseAnnotation.annotator, createdAt: caseAnnotation.createdAt })
      .from(caseAnnotation)
      .where(isNull(caseAnnotation.deletedAt));
    rows.sort(
      (a: { createdAt: Date | null }, b: { createdAt: Date | null }) =>
        (a.createdAt ? new Date(a.createdAt).getTime() : 0) - (b.createdAt ? new Date(b.createdAt).getTime() : 0),
    );
    const out = new Map<string, string>();
    for (const r of rows as { caseId: string; annotator: string }[]) {
      if (r.annotator === "_main" || reviewers.has(r.annotator.toLowerCase()) || out.has(r.caseId)) continue;
      out.set(r.caseId, r.annotator.split("_")[0]);
    }
    return out;
  } catch {
    return new Map();
  }
}

async function reviewHandler() {
  const scans = await db.select().from(reviewScan);
  // Only the columns the list needs; the annotation itself is large.
  const mainAnnotations = await db
    .select({ caseId: caseAnnotation.caseId, updatedAt: caseAnnotation.updatedAt, createdAt: caseAnnotation.createdAt })
    .from(caseAnnotation)
    .where(
      and(
        eq(caseAnnotation.annotator, "_main"),
        isNull(caseAnnotation.deletedAt),
      ),
    );

  const mainMap = new Map(mainAnnotations.map((m) => [m.caseId, m]));

  // A radiologist's save replaces the team annotation: the old one is marked
  // superseded and hers is the current one. The case is still annotated.
  const supersededMap = new Map<string, Date | null>();
  try {
    const superseded = await db
      .select({ caseId: caseAnnotation.caseId, deletedAt: caseAnnotation.deletedAt })
      .from(caseAnnotation)
      .where(
        and(
          eq(caseAnnotation.annotator, "_main"),
          isNotNull(caseAnnotation.deletedAt),
          eq(caseAnnotation.deletedReason, "superseded"),
        ),
      );
    for (const r of superseded) supersededMap.set(r.caseId, r.deletedAt);
  } catch {
    /* older database without these columns */
  }

  let ownerMap = new Map<string, string | null>();
  try {
    const owners = await db
      .select({ caseId: caseOwner.caseId, annotatedBy: caseOwner.annotatedBy })
      .from(caseOwner);
    ownerMap = new Map(owners.map((o) => [o.caseId, o.annotatedBy]));
    for (const [k, v] of await firstCopyOwners()) if (!ownerMap.get(k)) ownerMap.set(k, v);
  } catch {
    ownerMap = new Map();
  }

  let reviewsMap = new Map<string, { reviewer: string; status: string; locked: boolean }[]>();
  try {
    const lockedReviews = await db
      .select({
        caseId: caseReview.caseId,
        reviewer: caseReview.reviewer,
        status: caseReview.status,
        locked: caseReview.locked,
      })
      .from(caseReview)
      .where(eq(caseReview.locked, true));

    for (const r of lockedReviews) {
      const list = reviewsMap.get(r.caseId) || [];
      list.push({
        reviewer: r.reviewer,
        status: r.status,
        locked: r.locked,
      });
      reviewsMap.set(r.caseId, list);
    }
  } catch {
    reviewsMap = new Map();
  }

  const cases = scans.map((s) => {
    const id = s.caseId;
    const isBme = id.startsWith("BME-");
    const main = mainMap.get(id);
    const annotated = Boolean(main) || supersededMap.has(id);
    const savedAt = main
      ? (main.updatedAt || main.createdAt || new Date()).toISOString()
      : supersededMap.has(id)
      ? (supersededMap.get(id) || new Date()).toISOString()
      : null;

    let owner: string | null = null;
    if (ownerMap.has(id)) {
      owner = ownerMap.get(id) ?? null;
    } else if (typeof ownerForCase === "function") {
      owner = ownerForCase(id) ?? null;
    }

    return {
      id,
      cls: isBme ? "bme" : "non_bme",
      assignedTo: owner ?? "",
      annotatedBy: owner ?? null,
      isOverlap: false,
      isotropic: false,
      slices: 0,
      thickness: 0,
      plane: "",
      hasT1: false,
      annotated,
      savedAt,
      flag: null,
      sourceName: null,
      reviewedBy: reviewsMap.get(id) || [],
    };
  });

  cases.sort(compareCaseIds);

  return NextResponse.json({
    cases,
    showSourceNames: false,
    annotators: [...new Set(cases.map((c) => c.assignedTo).filter(Boolean))].sort(),
    counts: {
      total: cases.length,
      annotated: cases.filter((c) => c.annotated).length,
      bme: cases.filter((c) => c.cls === "bme").length,
    },
  });
}

function projectRoot() {
  return path.resolve(process.cwd(), "..", "..");
}

function parseCsv(rel: string): Record<string, string>[] {
  const p = path.join(projectRoot(), rel);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const head = lines[0].split(",");
  return lines.slice(1).map((line) => {
    // naive split is fine: these files are written by our own scripts and
    // contain no quoted commas in the columns we read
    const cells = line.split(",");
    const row: Record<string, string> = {};
    head.forEach((h, i) => (row[h.trim()] = (cells[i] ?? "").trim()));
    return row;
  });
}

export async function GET() {
  if (isReviewMode()) return reviewHandler();

  const root = projectRoot();
  const worklist = parseCsv("data/worklist.csv");
  const deid = SHOW_NAMES ? parseCsv("data/deid_map.csv") : [];
  const nameFor = new Map(
    deid.map((r) => [r.case_id, (r.source_archive ?? "").split("/").pop() ?? ""]),
  );

  let ownerMap = new Map<string, string | null>();
  let dbAvailable = false;
  try {
    const owners = await db
      .select({ caseId: caseOwner.caseId, annotatedBy: caseOwner.annotatedBy })
      .from(caseOwner);
    ownerMap = new Map(owners.map((o) => [o.caseId, o.annotatedBy]));
    for (const [k, v] of await firstCopyOwners()) if (!ownerMap.get(k)) ownerMap.set(k, v);
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }

  let reviewsMap = new Map<string, { reviewer: string; status: string; locked: boolean }[]>();
  try {
    const lockedReviews = await db
      .select({
        caseId: caseReview.caseId,
        reviewer: caseReview.reviewer,
        status: caseReview.status,
        locked: caseReview.locked,
      })
      .from(caseReview)
      .where(eq(caseReview.locked, true));

    for (const r of lockedReviews) {
      const list = reviewsMap.get(r.caseId) || [];
      list.push({
        reviewer: r.reviewer,
        status: r.status,
        locked: r.locked,
      });
      reviewsMap.set(r.caseId, list);
    }
  } catch {
    reviewsMap = new Map();
  }

  const flags = readFlags("annotations3d_flags.json");
  const cases = worklist.map((r) => {
    const id = r.case_id;
    const annDir = path.join(root, "data", "annotations", id);
    const segPath = path.join(annDir, `${id}.seg.nrrd`);
    const hasSeg = fs.existsSync(segPath);
    let savedAt: string | null = null;
    if (hasSeg) {
      try {
        savedAt = fs.statSync(segPath).mtime.toISOString();
      } catch {
        savedAt = null;
      }
    }

    let owner: string | null = null;
    if (dbAvailable && ownerMap.has(id)) {
      owner = ownerMap.get(id) ?? null;
    } else if (typeof ownerForCase === "function") {
      owner = ownerForCase(id) ?? null;
    }

    return {
      id,
      cls: r.class,                       // "bme" | "non_bme"
      assignedTo: owner ?? "",
      annotatedBy: owner ?? null,
      isOverlap: r.is_overlap === "True",
      isotropic: r.isotropic === "True",
      slices: Number(r.n_slices || 0),
      thickness: Number(r.slice_thickness || 0),
      plane: r.plane || "",
      hasT1: r.has_t1 === "True",
      annotated: hasSeg,
      savedAt,
      flag: flags[id] ?? null,
      // null unless the local flag is on
      sourceName: SHOW_NAMES ? nameFor.get(id) ?? null : null,
      reviewedBy: reviewsMap.get(id) || [],
    };
  });

  cases.sort(compareCaseIds);

  return NextResponse.json({
    cases,
    showSourceNames: SHOW_NAMES,
    annotators: [...new Set(cases.map((c) => c.assignedTo).filter(Boolean))].sort(),
    counts: {
      total: cases.length,
      annotated: cases.filter((c) => c.annotated).length,
      bme: cases.filter((c) => c.cls === "bme").length,
    },
  });
}
