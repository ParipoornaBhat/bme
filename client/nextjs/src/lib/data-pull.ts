import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { db } from "@bme/db";
import { reviewScan } from "~/lib/review-auth";

/**
 * New scans for this PC: every case the shared database knows (review_scan, filled by
 * `pnpm review:scans:finish` after the Drive upload) whose scan is not in data/nifti here.
 * Downloads come from the same Drive files the hosted site streams. Only pseudonymous
 * case IDs are handled; nothing else is read from Drive.
 */

const ID = /^(BME|NBME)-\d{3}$/;
/** A primary scan is about 16 MB; used only for the estimate shown before downloading. */
const TYPICAL_BYTES = 16 * 1024 * 1024;

export function repoRoot() {
  return path.resolve(process.cwd(), "..", "..");
}

const scanPath = (root: string, id: string) => path.join(root, "data", "nifti", id, `${id}_primary.nii.gz`);

function driveFolderId(root: string): string | null {
  try {
    const env = fs.readFileSync(path.join(root, ".env"), "utf8");
    const line = env.split(/\r?\n/).find((l) => /^\s*REVIEW_DRIVE_FOLDER_URL\s*=/.test(l));
    const val = (line || "").split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
    return (val.match(/\/folders\/([a-zA-Z0-9_-]+)/) || [])[1] || null;
  } catch {
    return null;
  }
}

const unescapeHtml = (t: string) =>
  t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** case ID -> Drive file ID, from the public folder listing (same parsing as pnpm review:scans:finish). */
async function driveListing(folderId: string): Promise<Map<string, string>> {
  const res = await fetch(`https://drive.google.com/embeddedfolderview?id=${folderId}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) throw new Error(`Drive folder answered ${res.status}`);
  const html = await res.text();
  const re = /https:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)\/view(?:(?!https:\/\/drive\.google\.com\/file\/d\/)[\s\S])*?flip-entry-title">([^<]+)</g;
  const ids = new Map<string, Set<string>>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const name = unescapeHtml(m[2]).trim();
    const nm = name.match(/^((?:N)?BME-\d{3})_primary\.nii\.gz$/);
    if (!nm) continue;
    if (!ids.has(nm[1])) ids.set(nm[1], new Set());
    ids.get(nm[1])!.add(m[1]);
  }
  const out = new Map<string, string>();
  for (const [id, set] of ids) if (set.size === 1) out.set(id, [...set][0]); // a name twice on Drive is left alone
  return out;
}

/**
 * Cases whose scan is on this PC but which have no Drive link in the database yet
 * (just imported, then uploaded to Drive): find them in the Drive folder and record
 * the link, so teammates can download them. Existing links are never changed.
 */
export async function mapDrive(): Promise<{ added: string[]; notOnDrive: string[]; error?: string }> {
  const root = repoRoot();
  const niftiDir = path.join(root, "data", "nifti");
  const local = fs.existsSync(niftiDir)
    ? fs.readdirSync(niftiDir).filter((id) => ID.test(id) && fs.existsSync(scanPath(root, id)))
    : [];
  const known = new Set((await db.select({ caseId: reviewScan.caseId }).from(reviewScan)).map((r: { caseId: string }) => r.caseId));
  const need = local.filter((id) => !known.has(id)).sort();
  if (!need.length) return { added: [], notOnDrive: [] };
  const folderId = driveFolderId(root);
  if (!folderId) return { added: [], notOnDrive: need, error: "REVIEW_DRIVE_FOLDER_URL is not set in .env" };
  let listing: Map<string, string>;
  try {
    listing = await driveListing(folderId);
  } catch (e) {
    return { added: [], notOnDrive: need, error: e instanceof Error ? e.message : "could not read the Drive folder" };
  }
  const added: string[] = [];
  const notOnDrive: string[] = [];
  for (const id of need) {
    const fileId = listing.get(id);
    if (!fileId) {
      notOnDrive.push(id);
      continue;
    }
    await db.insert(reviewScan).values({ caseId: id, driveFileId: fileId, updatedAt: new Date() }).onConflictDoNothing();
    added.push(id);
  }
  // Keep the local mapping file in step, so pnpm review:setup does not drop these links.
  if (added.length) {
    const file = path.join(root, "data", "review_scan_ids.json");
    let cur: Record<string, string> = {};
    try {
      cur = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      /* first time */
    }
    for (const id of added) if (!(id in cur)) cur[id] = listing.get(id)!;
    const sorted = Object.fromEntries(Object.keys(cur).sort().map((k) => [k, cur[k]]));
    const tmp = `${file}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(sorted, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
  }
  return { added, notOnDrive };
}

export interface PullPlan {
  missing: string[];
  estimateBytes: number;
  inDatabase: number;
}

export async function planPull(): Promise<PullPlan> {
  const root = repoRoot();
  const rows = await db.select({ caseId: reviewScan.caseId }).from(reviewScan);
  const missing = rows
    .map((r: { caseId: string }) => r.caseId)
    .filter((id: string) => ID.test(id) && !fs.existsSync(scanPath(root, id)))
    .sort();
  return { missing, estimateBytes: missing.length * TYPICAL_BYTES, inDatabase: rows.length };
}

/** Slices and slice thickness from the NIfTI-1 header, for the worklist row. */
function headerInfo(gz: Buffer): { slices: number; thickness: string } {
  try {
    const h = zlib.gunzipSync(gz).subarray(0, 348);
    const le = h.readInt32LE(0) === 348;
    const slices = le ? h.readInt16LE(46) : h.readInt16BE(46);
    const thick = le ? h.readFloatLE(88) : h.readFloatBE(88);
    return { slices: slices > 0 ? slices : 0, thickness: thick > 0 ? thick.toFixed(4) : "" };
  } catch {
    return { slices: 0, thickness: "" };
  }
}

function addWorklistRows(root: string, added: { id: string; slices: number; thickness: string }[]) {
  const file = path.join(root, "data", "worklist.csv");
  if (!fs.existsSync(file) || !added.length) return 0;
  const text = fs.readFileSync(file, "utf8");
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const have = new Set(text.split(/\r?\n/).map((l) => l.split(",")[0]));
  const rows = added
    .filter((a) => !have.has(a.id))
    .map(
      (a) =>
        `${a.id},${a.id.startsWith("BME-") ? "bme" : "non_bme"},,,,axial,${a.slices || ""},${a.thickness},,,False,,,` +
        `data/nifti/${a.id}/${a.id}_primary.nii.gz,ok,ALL,False`,
    );
  if (!rows.length) return 0;
  fs.writeFileSync(file, text.replace(/(\r?\n)*$/, "") + nl + rows.join(nl) + nl, "utf8");
  return rows.length;
}

export async function runPull(only?: string[]): Promise<{
  downloaded: string[];
  failed: { id: string; why: string }[];
  worklistRows: number;
  bytes: number;
}> {
  const root = repoRoot();
  const rows = await db.select({ caseId: reviewScan.caseId, driveFileId: reviewScan.driveFileId }).from(reviewScan);
  const wanted = rows.filter(
    (r: { caseId: string }) => ID.test(r.caseId) && !fs.existsSync(scanPath(root, r.caseId)) && (!only || only.includes(r.caseId)),
  );
  const downloaded: string[] = [];
  const failed: { id: string; why: string }[] = [];
  const added: { id: string; slices: number; thickness: string }[] = [];
  let bytes = 0;
  for (const r of wanted as { caseId: string; driveFileId: string }[]) {
    const id = r.caseId;
    try {
      const url = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(r.driveFileId)}&export=download&confirm=t`;
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`Drive answered ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // A real scan is gzip and well over 100 KB; Drive's error and warning pages are HTML.
      if (buf.length < 100 * 1024 || buf[0] !== 0x1f || buf[1] !== 0x8b) throw new Error("Drive did not return the scan file");
      const dest = scanPath(root, id);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const part = `${dest}.part`;
      fs.writeFileSync(part, buf);
      fs.renameSync(part, dest);
      bytes += buf.length;
      downloaded.push(id);
      added.push({ id, ...headerInfo(buf) });
    } catch (e) {
      failed.push({ id, why: e instanceof Error ? e.message : String(e) });
    }
  }
  const worklistRows = addWorklistRows(root, added);
  return { downloaded, failed, worklistRows, bytes };
}
