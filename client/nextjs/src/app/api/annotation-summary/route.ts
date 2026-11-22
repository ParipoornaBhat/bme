import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { and, inArray, isNull } from "drizzle-orm";
import { db, caseAnnotation, reviewScan } from "@bme/db";
import { isReviewMode } from "~/lib/app-mode";
import {
  deriveStatus,
  getNrrdFileStats,
  getNrrdShaStats,
  hasCachedShaStats,
  incompleteReason,
  parseAndCacheNrrdSha,
  resolveCaseOwners,
  getOwnerForCase,
  compareCaseIds,
  get2DMaskStats,
  type AnnotationStatus,
  type AnnotationSummaryResponse,
  type AnnotationVersion,
  type Case2DSummary,
  type Case3DSummary,
  type SummaryTotals3D,
  type ThreeDSummary,
  type TwoDSummary,
} from "~/lib/annotation-stats";

export const dynamic = "force-dynamic";

function projectRoot() {
  let curr = process.cwd();
  if (fs.existsSync(path.join(curr, "data", "worklist.csv")) || fs.existsSync(path.join(curr, "pnpm-workspace.yaml"))) {
    return curr;
  }
  while (curr !== path.dirname(curr)) {
    if (fs.existsSync(path.join(curr, "data", "worklist.csv")) || fs.existsSync(path.join(curr, "pnpm-workspace.yaml"))) {
      return curr;
    }
    curr = path.dirname(curr);
  }
  return path.resolve(process.cwd(), "..", "..");
}

function parseCsv(rel: string): Record<string, string>[] {
  const p = path.join(projectRoot(), rel);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const head = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    head.forEach((h, i) => (row[h.trim()] = (cells[i] ?? "").trim()));
    return row;
  });
}

async function reviewSummaryHandler(): Promise<NextResponse<AnnotationSummaryResponse>> {
  const scans = await db.select().from(reviewScan);
  const ownerMap = await resolveCaseOwners();

  const rows = await db
    .select({
      id: caseAnnotation.id,
      caseId: caseAnnotation.caseId,
      annotator: caseAnnotation.annotator,
      sha256: caseAnnotation.sha256,
      createdAt: caseAnnotation.createdAt,
      updatedAt: caseAnnotation.updatedAt,
    })
    .from(caseAnnotation)
    .where(isNull(caseAnnotation.deletedAt));

  const unknownRows = rows.filter((r) => !hasCachedShaStats(r.sha256));
  if (unknownRows.length > 0) {
    const unknownIds = unknownRows.map((r) => r.id);
    const blobs = await db
      .select({
        id: caseAnnotation.id,
        sha256: caseAnnotation.sha256,
        contentB64: caseAnnotation.contentB64,
      })
      .from(caseAnnotation)
      .where(inArray(caseAnnotation.id, unknownIds));
    for (const b of blobs) {
      if (b.contentB64) {
        parseAndCacheNrrdSha(b.sha256, b.contentB64);
      }
    }
  }

  const rowsByCase = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = rowsByCase.get(r.caseId) || [];
    list.push(r);
    rowsByCase.set(r.caseId, list);
  }

  const cases: Case3DSummary[] = scans.map((s) => {
    const id = s.caseId;
    const cls: "bme" | "non_bme" = id.startsWith("BME-") ? "bme" : "non_bme";
    const owner = getOwnerForCase(id, ownerMap);
    const caseRows = rowsByCase.get(id) || [];

    const versions: AnnotationVersion[] = caseRows.map((r) => {
      const isMain = r.annotator === "_main";
      const annotator = isMain ? "main" : r.annotator;
      const stats = getNrrdShaStats(r.sha256);
      const savedAt = (r.updatedAt || r.createdAt || new Date()).toISOString();
      return {
        annotator,
        isMain,
        bone: stats?.bone ?? 0,
        edema: stats?.edema ?? 0,
        uncertain: stats?.uncertain ?? 0,
        marked: stats?.marked ?? 0,
        savedAt,
      };
    });

    versions.sort((a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0));

    const mainVersion = versions.find((v) => v.isMain);
    const { status, mainReason } = deriveStatus(mainVersion, Boolean(mainVersion), cls);

    let completeElsewhere: string | null = null;
    if (status !== "complete") {
      const alt = versions.find((v) => !v.isMain && incompleteReason(v, cls) === "");
      if (alt) completeElsewhere = alt.annotator;
    }

    return {
      id,
      cls,
      owner,
      versions,
      mainReason,
      status,
      completeElsewhere,
    };
  });

  cases.sort(compareCaseIds);

  const totals: SummaryTotals3D = {
    total: cases.length,
    complete: 0,
    pending: 0,
    completeElsewhere: 0,
    byStatus: {
      complete: 0,
      needs_bone: 0,
      needs_edema: 0,
      too_few_slices: 0,
      not_started: 0,
      unreadable: 0,
    },
    byOwner: {},
    byClass: {
      bme: { total: 0, complete: 0, pending: 0 },
      non_bme: { total: 0, complete: 0, pending: 0 },
    },
  };

  for (const c of cases) {
    const isComp = c.status === "complete";
    if (isComp) totals.complete++;
    else totals.pending++;

    if (c.completeElsewhere) totals.completeElsewhere++;
    totals.byStatus[c.status] = (totals.byStatus[c.status] || 0) + 1;

    const owner = c.owner || "Unassigned";
    if (!totals.byOwner[owner]) {
      totals.byOwner[owner] = { total: 0, complete: 0, pending: 0 };
    }
    totals.byOwner[owner].total++;
    if (isComp) totals.byOwner[owner].complete++;
    else totals.byOwner[owner].pending++;

    totals.byClass[c.cls].total++;
    if (isComp) totals.byClass[c.cls].complete++;
    else totals.byClass[c.cls].pending++;
  }

  const threeD: ThreeDSummary = { cases, totals };
  const twoD: TwoDSummary = { available: false };

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    threeD,
    twoD,
  });
}

export async function GET(): Promise<NextResponse<AnnotationSummaryResponse>> {
  if (isReviewMode()) {
    return reviewSummaryHandler();
  }

  const root = projectRoot();
  const worklist = parseCsv("data/worklist.csv");
  const ownerMap = await resolveCaseOwners();

  const cases: Case3DSummary[] = worklist.map((r) => {
    const id = r.case_id;
    const cls: "bme" | "non_bme" = r.class === "bme" ? "bme" : "non_bme";
    const owner = getOwnerForCase(id, ownerMap);
    const annDir = path.join(root, "data", "annotations", id);

    const versions: AnnotationVersion[] = [];
    if (fs.existsSync(annDir)) {
      try {
        const files = fs.readdirSync(annDir).filter((f) => f.endsWith(".seg.nrrd"));
        for (const f of files) {
          const filePath = path.join(annDir, f);
          let isMain = false;
          let annotator = "";

          if (f === `${id}.seg.nrrd`) {
            isMain = true;
            annotator = "main";
          } else if (f.startsWith(`${id}__`) && f.endsWith(".seg.nrrd")) {
            isMain = false;
            annotator = f.slice(id.length + 2, -".seg.nrrd".length);
          } else {
            isMain = false;
            annotator = f.replace(/\.seg\.nrrd$/, "");
          }

          let savedAt: string | null = null;
          try {
            savedAt = fs.statSync(filePath).mtime.toISOString();
          } catch {
            savedAt = null;
          }

          const stats = getNrrdFileStats(filePath);
          versions.push({
            annotator,
            isMain,
            bone: stats?.bone ?? 0,
            edema: stats?.edema ?? 0,
            uncertain: stats?.uncertain ?? 0,
            marked: stats?.marked ?? 0,
            savedAt,
          });
        }
      } catch {
        // failed reading directory
      }
    }

    versions.sort((a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0));

    const mainVersion = versions.find((v) => v.isMain);
    const { status, mainReason } = deriveStatus(mainVersion, Boolean(mainVersion), cls);

    let completeElsewhere: string | null = null;
    if (status !== "complete") {
      const alt = versions.find((v) => !v.isMain && incompleteReason(v, cls) === "");
      if (alt) completeElsewhere = alt.annotator;
    }

    return {
      id,
      cls,
      owner,
      versions,
      mainReason,
      status,
      completeElsewhere,
    };
  });

  cases.sort(compareCaseIds);

  const totals: SummaryTotals3D = {
    total: cases.length,
    complete: 0,
    pending: 0,
    completeElsewhere: 0,
    byStatus: {
      complete: 0,
      needs_bone: 0,
      needs_edema: 0,
      too_few_slices: 0,
      not_started: 0,
      unreadable: 0,
    },
    byOwner: {},
    byClass: {
      bme: { total: 0, complete: 0, pending: 0 },
      non_bme: { total: 0, complete: 0, pending: 0 },
    },
  };

  for (const c of cases) {
    const isComp = c.status === "complete";
    if (isComp) totals.complete++;
    else totals.pending++;

    if (c.completeElsewhere) totals.completeElsewhere++;
    totals.byStatus[c.status] = (totals.byStatus[c.status] || 0) + 1;

    const owner = c.owner || "Unassigned";
    if (!totals.byOwner[owner]) {
      totals.byOwner[owner] = { total: 0, complete: 0, pending: 0 };
    }
    totals.byOwner[owner].total++;
    if (isComp) totals.byOwner[owner].complete++;
    else totals.byOwner[owner].pending++;

    totals.byClass[c.cls].total++;
    if (isComp) totals.byClass[c.cls].complete++;
    else totals.byClass[c.cls].pending++;
  }

  const threeD: ThreeDSummary = { cases, totals };

  // 2D summary calculation
  const idxPath = path.join(root, "data", "slices2d", "index.csv");
  const ann2dDir = path.join(root, "data", "annotations2d");
  let twoD: TwoDSummary = { available: false };

  if (fs.existsSync(idxPath) && fs.existsSync(ann2dDir)) {
    const lines = fs.readFileSync(idxPath, "utf8").trim().split(/\r?\n/);
    if (lines.length >= 2) {
      const flagsPath = path.join(root, "data", "annotations2d_flags.json");
      let flagsMap: Record<string, { flagged?: boolean }> = {};
      if (fs.existsSync(flagsPath)) {
        try {
          flagsMap = JSON.parse(fs.readFileSync(flagsPath, "utf8"));
        } catch {
          flagsMap = {};
        }
      }

      type SliceEntry = { caseId: string; stem: string };
      const slicesByCase = new Map<string, SliceEntry[]>();
      for (let i = 1; i < lines.length; i++) {
        const [cId, , rel] = lines[i].split(",").map((s) => s.trim());
        if (!cId || !rel) continue;
        const stem = path.basename(rel, path.extname(rel));
        const list = slicesByCase.get(cId) || [];
        list.push({ caseId: cId, stem });
        slicesByCase.set(cId, list);
      }

      const case2DList: Case2DSummary[] = [];
      let totalSlices = 0;
      let annotatedSlices = 0;
      let edemaSlices = 0;
      let boneSlices = 0;
      let flaggedSlices = 0;

      for (const [caseId, slices] of slicesByCase) {
        let caseWithMask = 0;
        let caseWithBone = 0;
        let caseWithEdema = 0;
        let caseFlagged = false;
        let latestSavedMs = 0;

        for (const sl of slices) {
          totalSlices++;
          const flagKey = `${caseId}/${sl.stem}`;
          if (flagsMap[flagKey]?.flagged) {
            flaggedSlices++;
            caseFlagged = true;
          }

          const maskPath = path.join(ann2dDir, caseId, `${sl.stem}.mask.png`);
          const st = get2DMaskStats(maskPath);
          if (st?.hasMask) {
            caseWithMask++;
            annotatedSlices++;
            if (st.hasBone) {
              caseWithBone++;
              boneSlices++;
            }
            if (st.hasEdema) {
              caseWithEdema++;
              edemaSlices++;
            }
            const timeMs = new Date(st.savedAt).getTime();
            if (timeMs > latestSavedMs) latestSavedMs = timeMs;
          }
        }

        case2DList.push({
          id: caseId,
          totalSlices: slices.length,
          slicesWithMask: caseWithMask,
          slicesWithBone: caseWithBone,
          slicesWithEdema: caseWithEdema,
          flagged: caseFlagged,
          lastSaved: latestSavedMs > 0 ? new Date(latestSavedMs).toISOString() : null,
        });
      }

      case2DList.sort(compareCaseIds);

      twoD = {
        available: true,
        cases: case2DList,
        totals: {
          totalCases: case2DList.length,
          totalSlices,
          annotatedSlices,
          edemaSlices,
          boneSlices,
          flaggedSlices,
        },
      };
    }
  }

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    threeD,
    twoD,
  });
}
