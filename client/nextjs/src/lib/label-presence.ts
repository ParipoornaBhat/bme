import fs from "node:fs";
import zlib from "node:zlib";
import { getNrrdFileStats } from "./annotation-stats";

/**
 * Which labels an annotation actually contains: bone marrow, edema, or both.
 * Read from the labels themselves (segment extents in the header are not reliable),
 * once per file version, then cached.
 */
export interface LabelPresence {
  bone: boolean;
  edema: boolean;
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
function canonical(name: string) {
  const key = name.trim().toLowerCase().replace(/-/g, "_");
  return ALIASES[key] || ALIASES[key.replace(/_/g, " ")] || null;
}

export function union(list: (LabelPresence | null | undefined)[]): LabelPresence | null {
  const known = list.filter(Boolean) as LabelPresence[];
  if (!known.length) return null;
  return { bone: known.some((p) => p.bone), edema: known.some((p) => p.edema) };
}

const shaCache = new Map<string, LabelPresence | null>();

/** A raw labelmap in the canonical values (1 = bone_marrow, 2 = bme). */
export function rawPresence(raw: Uint8Array): LabelPresence {
  const b = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  return { bone: b.indexOf(1) !== -1, edema: b.indexOf(2) !== -1 };
}

/** From the database copy (gzip of the raw labelmap), cached by its sha256. */
export function gzPresence(sha: string | null, labelsGzB64: string | null): LabelPresence | null {
  if (sha && shaCache.has(sha)) return shaCache.get(sha) ?? null;
  let res: LabelPresence | null = null;
  try {
    if (labelsGzB64) res = rawPresence(zlib.gunzipSync(Buffer.from(labelsGzB64, "base64")));
  } catch {
    res = null;
  }
  if (sha) shaCache.set(sha, res);
  return res;
}

export function knownShaPresence(sha: string | null): LabelPresence | null | undefined {
  return sha ? shaCache.get(sha) : undefined;
}

/** From a .seg.nrrd on disk: label presence derived from parsed slice counts. */
export function nrrdPresence(file: string): LabelPresence | null {
  const stats = getNrrdFileStats(file);
  if (!stats) return null;
  return { bone: stats.bone > 0, edema: stats.edema > 0 };
}

