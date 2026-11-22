import fs from "node:fs";
import zlib from "node:zlib";

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

const fileCache = new Map<string, { mtimeMs: number; size: number; res: LabelPresence | null }>();
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

/** From a .seg.nrrd on disk: label values come from its Segment<i>_Name / _LabelValue / _Layer lines. */
export function nrrdPresence(file: string): LabelPresence | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.res;
  let res: LabelPresence | null = null;
  try {
    const buf = fs.readFileSync(file);
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
    const layers = sizes.length === 4 ? sizes[0] : 1;
    const payload = buf.subarray(sep + skip);
    const raw = /gz/.test(field("encoding").toLowerCase()) ? zlib.gunzipSync(payload) : payload;

    const segs: { name: string; value: number; layer: number }[] = [];
    for (const m of header.matchAll(/^Segment(\d+)_Name:=(.+)$/gm)) {
      const i = m[1];
      const name = canonical(m[2]);
      if (!name) continue;
      const value = Number((header.match(new RegExp(`^Segment${i}_LabelValue:=(\\d+)`, "m")) || [])[1] || 0);
      const layer = Number((header.match(new RegExp(`^Segment${i}_Layer:=(\\d+)`, "m")) || [])[1] || 0);
      segs.push({ name, value, layer });
    }
    const has = (name: string) =>
      segs.some((s) => {
        if (s.name !== name || !s.value) return false;
        if (layers === 1) return raw.indexOf(s.value) !== -1;
        for (let i = s.layer; i < raw.length; i += layers) if (raw[i] === s.value) return true;
        return false;
      });
    res = { bone: has("bone_marrow"), edema: has("bme") };
  } catch {
    res = null;
  }
  fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, res });
  return res;
}
