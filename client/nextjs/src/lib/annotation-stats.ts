import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { db, caseAnnotation, caseOwner, ownerForCase, reviewAccount } from "@bme/db";
import { inArray, isNull } from "drizzle-orm";
import { decodeMaskPng } from "./mask-png";

export interface SegNrrdStats {
  bone: number;
  edema: number;
  uncertain: number;
  marked: number;
}

export type AnnotationStatus =
  | "complete"
  | "needs_bone"
  | "needs_edema"
  | "too_few_slices"
  | "not_started"
  | "unreadable";

export interface AnnotationVersion {
  annotator: string;
  isMain: boolean;
  bone: number;
  edema: number;
  uncertain: number;
  marked: number;
  savedAt: string | null;
}

export interface Case3DSummary {
  id: string;
  cls: "bme" | "non_bme";
  owner: string;
  versions: AnnotationVersion[];
  mainReason: string;
  status: AnnotationStatus;
  completeElsewhere: string | null;
}

export interface Case2DSummary {
  id: string;
  totalSlices: number;
  slicesWithMask: number;
  slicesWithBone: number;
  slicesWithEdema: number;
  flagged: boolean;
  lastSaved: string | null;
}

export interface SummaryTotals3D {
  total: number;
  complete: number;
  pending: number;
  completeElsewhere: number;
  byStatus: Record<AnnotationStatus, number>;
  byOwner: Record<string, { total: number; complete: number; pending: number }>;
  byClass: Record<string, { total: number; complete: number; pending: number }>;
}

export interface ThreeDSummary {
  cases: Case3DSummary[];
  totals: SummaryTotals3D;
}

export interface TwoDSummary {
  available: boolean;
  cases?: Case2DSummary[];
  totals?: {
    totalCases: number;
    totalSlices: number;
    annotatedSlices: number;
    edemaSlices: number;
    boneSlices: number;
    flaggedSlices: number;
  };
}

export interface AnnotationSummaryResponse {
  generatedAt: string;
  threeD: ThreeDSummary;
  twoD: TwoDSummary;
}

// Same names as ml/scripts/seg2nifti.py (LABELS + ALIASES), so the list agrees with training.
const ALIASES: Record<string, "bone_marrow" | "bme" | "uncertain"> = {
  bone_marrow: "bone_marrow",
  bme: "bme",
  uncertain: "uncertain",
  bonemarrow: "bone_marrow",
  "bone marrow": "bone_marrow",
  marrow: "bone_marrow",
  edema: "bme",
  oedema: "bme",
  bme_lesion: "bme",
  lesion: "bme",
  segment_1: "bme",
  segment_2: "bme",
  segment_3: "bme",
  unsure: "uncertain",
  uncertain_region: "uncertain",
};

export function canonicalSegment(name: string): "bone_marrow" | "bme" | "uncertain" | null {
  const key = name.trim().toLowerCase().replace(/-/g, "_");
  return ALIASES[key] || ALIASES[key.replace(/_/g, " ")] || null;
}

/**
 * Parse an NRRD segmentation buffer (gzip or raw, 3D or 4D layered, uint8)
 * and count slices holding each label along the shortest spatial axis.
 */
export function parseSegNrrd(buf: Buffer): SegNrrdStats {
  let sep = buf.indexOf("\n\n");
  let skip = 2;
  const crlf = buf.indexOf("\r\n\r\n");
  if (crlf !== -1 && (sep === -1 || crlf < sep)) {
    sep = crlf;
    skip = 4;
  }
  if (sep === -1) throw new Error("no header end");
  const header = buf.subarray(0, sep).toString("latin1");
  const field = (k: string) => (header.match(new RegExp(`^${k}:\\s*(.+)$`, "mi")) || [])[1]?.trim() || "";
  if (field("data file")) throw new Error("detached data");
  const type = field("type").toLowerCase();
  if (!/^(uint8|uchar|unsigned char|uint8_t)$/.test(type)) throw new Error(`type ${type}`);
  const sizes = field("sizes").split(/\s+/).map(Number);
  if (!sizes.length || sizes.some((n) => isNaN(n) || n <= 0)) throw new Error("invalid sizes");

  const layers = sizes.length === 4 ? sizes[0] : 1;
  const spatialSizes = sizes.length === 4 ? sizes.slice(1) : sizes;
  if (spatialSizes.length !== 3) throw new Error(`expected 3 spatial dimensions, got ${spatialSizes.length}`);

  const [d0, d1, d2] = spatialSizes;
  const totalSpatial = d0 * d1 * d2;

  const payload = buf.subarray(sep + skip);
  const raw = /gz/.test(field("encoding").toLowerCase()) ? zlib.gunzipSync(payload) : payload;
  if (raw.length < layers * totalSpatial) throw new Error("truncated NRRD payload");

  const segs: { name: "bone_marrow" | "bme" | "uncertain"; value: number; layer: number; labelVal: number }[] = [];
  for (const m of header.matchAll(/^Segment(\d+)_Name:=(.+)$/gm)) {
    const i = m[1];
    const canon = canonicalSegment(m[2]);
    if (!canon) continue;
    const value = Number((header.match(new RegExp(`^Segment${i}_LabelValue:=(\\d+)`, "m")) || [])[1] || 0);
    const layer = Number((header.match(new RegExp(`^Segment${i}_Layer:=(\\d+)`, "m")) || [])[1] || 0);
    const labelVal = canon === "bone_marrow" ? 1 : canon === "bme" ? 2 : 3;
    segs.push({ name: canon, value, layer, labelVal });
  }

  // Slicer's "overwrite none" mode keeps bme and bone_marrow overlapping in
  // separate layers, so higher labels overwrite lower ones in the labelmap.
  segs.sort((a, b) => a.labelVal - b.labelVal);

  // Slice axis is the shortest of the 3 spatial sizes (same as np.argmin in dataset_manifest.py).
  let axis = 0;
  if (spatialSizes[1] < spatialSizes[axis]) axis = 1;
  if (spatialSizes[2] < spatialSizes[axis]) axis = 2;
  const numSlices = spatialSizes[axis];

  const out = new Uint8Array(totalSpatial);
  for (const s of segs) {
    if (!s.value) continue;
    if (layers === 1) {
      for (let v = 0; v < totalSpatial; v++) {
        if (raw[v] === s.value) {
          out[v] = s.labelVal;
        }
      }
    } else {
      const l = s.layer;
      for (let v = 0; v < totalSpatial; v++) {
        if (raw[v * layers + l] === s.value) {
          out[v] = s.labelVal;
        }
      }
    }
  }

  const hasBone = new Uint8Array(numSlices);
  const hasEdema = new Uint8Array(numSlices);
  const hasUncertain = new Uint8Array(numSlices);
  const hasMarked = new Uint8Array(numSlices);

  let v = 0;
  for (let i2 = 0; i2 < d2; i2++) {
    for (let i1 = 0; i1 < d1; i1++) {
      for (let i0 = 0; i0 < d0; i0++, v++) {
        const val = out[v];
        if (val === 0) continue;
        const s = axis === 0 ? i0 : axis === 1 ? i1 : i2;
        hasMarked[s] = 1;
        if (val === 1) hasBone[s] = 1;
        else if (val === 2) hasEdema[s] = 1;
        else if (val === 3) hasUncertain[s] = 1;
      }
    }
  }

  let bone = 0;
  let edema = 0;
  let uncertain = 0;
  let marked = 0;
  for (let s = 0; s < numSlices; s++) {
    if (hasBone[s]) bone++;
    if (hasEdema[s]) edema++;
    if (hasUncertain[s]) uncertain++;
    if (hasMarked[s]) marked++;
  }

  return { bone, edema, uncertain, marked };
}

const fileStatsCache = new Map<string, { mtimeMs: number; size: number; stats: SegNrrdStats | null }>();
const shaStatsCache = new Map<string, SegNrrdStats | null>();

export function getNrrdFileStats(filePath: string): SegNrrdStats | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return null;
  }
  const hit = fileStatsCache.get(filePath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return hit.stats;
  }
  let stats: SegNrrdStats | null = null;
  try {
    const buf = fs.readFileSync(filePath);
    stats = parseSegNrrd(buf);
  } catch {
    stats = null;
  }
  fileStatsCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, stats });
  return stats;
}

export function getNrrdShaStats(sha: string | null): SegNrrdStats | null | undefined {
  if (!sha) return undefined;
  return shaStatsCache.get(sha);
}

export function hasCachedShaStats(sha: string | null): boolean {
  if (!sha) return false;
  return shaStatsCache.has(sha);
}

export function setNrrdShaStats(sha: string, stats: SegNrrdStats | null): void {
  shaStatsCache.set(sha, stats);
}

export function parseAndCacheNrrdSha(sha: string, contentB64: string): SegNrrdStats | null {
  if (shaStatsCache.has(sha)) return shaStatsCache.get(sha) ?? null;
  let stats: SegNrrdStats | null = null;
  try {
    const buf = Buffer.from(contentB64, "base64");
    stats = parseSegNrrd(buf);
  } catch {
    stats = null;
  }
  shaStatsCache.set(sha, stats);
  return stats;
}

export const MIN_MARKED_SLICES = 5;

// Source of truth: incomplete_reason in ml/scripts/dataset_manifest.py
export function incompleteReason(
  stats: { bone: number; edema: number; marked: number },
  cls: string,
): string {
  if (stats.bone < 1) {
    return "no bone_marrow drawn yet";
  }
  if (cls === "bme" && stats.edema < 1) {
    return "BME scan with no edema drawn yet";
  }
  if (stats.marked < MIN_MARKED_SLICES) {
    return `marked on only ${stats.marked} slice(s)`;
  }
  return "";
}

export function deriveStatus(
  mainStats: SegNrrdStats | null | undefined,
  hasMainVersion: boolean,
  cls: string,
): { status: AnnotationStatus; mainReason: string } {
  if (!hasMainVersion) {
    return { status: "not_started", mainReason: "not started" };
  }
  if (!mainStats) {
    return { status: "unreadable", mainReason: "annotation unreadable" };
  }
  const reason = incompleteReason(mainStats, cls);
  if (!reason) {
    return { status: "complete", mainReason: "" };
  }
  if (reason === "no bone_marrow drawn yet") {
    return { status: "needs_bone", mainReason: reason };
  }
  if (reason === "BME scan with no edema drawn yet") {
    return { status: "needs_edema", mainReason: reason };
  }
  if (reason.startsWith("marked on only")) {
    return { status: "too_few_slices", mainReason: reason };
  }
  return { status: "unreadable", mainReason: reason };
}

export async function firstCopyOwners(): Promise<Map<string, string>> {
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

export async function resolveCaseOwners(): Promise<Map<string, string>> {
  const ownerMap = new Map<string, string>();
  try {
    const owners = await db
      .select({ caseId: caseOwner.caseId, annotatedBy: caseOwner.annotatedBy })
      .from(caseOwner);
    for (const o of owners) {
      if (o.annotatedBy) ownerMap.set(o.caseId, o.annotatedBy);
    }
    const fallbacks = await firstCopyOwners();
    for (const [k, v] of fallbacks) {
      if (!ownerMap.has(k) && v) ownerMap.set(k, v);
    }
  } catch {
    // database fallback
  }
  return ownerMap;
}

export function getOwnerForCase(id: string, ownerMap: Map<string, string>): string {
  if (ownerMap.has(id)) {
    return ownerMap.get(id) || "";
  }
  if (typeof ownerForCase === "function") {
    return ownerForCase(id) || "";
  }
  return "";
}

export function compareCaseIds(
  a: string | { id: string; cls?: string },
  b: string | { id: string; cls?: string },
): number {
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

const mask2DCache = new Map<string, { mtimeMs: number; size: number; hasBone: boolean; hasEdema: boolean }>();

export function get2DMaskStats(filePath: string): { hasMask: boolean; hasBone: boolean; hasEdema: boolean; savedAt: string } | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return null;
  }
  const hit = mask2DCache.get(filePath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return { hasMask: true, hasBone: hit.hasBone, hasEdema: hit.hasEdema, savedAt: st.mtime.toISOString() };
  }
  let hasBone = false;
  let hasEdema = false;
  try {
    const buf = fs.readFileSync(filePath);
    const { labels } = decodeMaskPng(buf);
    hasBone = labels.includes(1);
    hasEdema = labels.includes(2);
  } catch {
    // Decoding failed or unexpected format
  }
  mask2DCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, hasBone, hasEdema });
  return { hasMask: true, hasBone, hasEdema, savedAt: st.mtime.toISOString() };
}
