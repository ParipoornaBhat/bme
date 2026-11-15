import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  db,
  caseAnnotation,
  reviewEdit,
  reviewAccount,
  caseOwner,
  ownerForCase,
  decide,
  type DecideInput,
  type SyncAction,
} from "@bme/db";
import { logEvents, type NewAnnotationEvent } from "./annotation-events";

const exec = promisify(execFile);

export const CASE_ID_REGEX = /^(BME|NBME)-\d{3}$/;
export const ANNOTATOR_REGEX = /^[A-Za-z0-9_-]{1,40}$/;

export function isValidCaseId(id: string): boolean {
  return CASE_ID_REGEX.test(id);
}

export function isValidAnnotator(annotator: string): boolean {
  return annotator === "_main" || ANNOTATOR_REGEX.test(annotator);
}

export function sanitizeAnnotator(name: string | null | undefined): string | null {
  if (!name) return null;
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  return safe || null;
}

export type SyncSkippedReason =
  | "scan-mismatch"
  | "no-scan"
  | "not-owner"
  | "bad-row"
  | "hash-mismatch"
  | "changed-remotely";

export type SyncReport = {
  ok: boolean;
  reason?: string;
  dryRun: boolean;
  at: string;
  me: string | null;
  pushed: number;
  pulled: number;
  recorded: number;
  retired?: number;
  appliedOnline: number;
  conflicts: { caseId: string; annotator: string }[];
  skipped: { caseId: string; annotator: string; why: SyncSkippedReason }[];
  changedCases: string[];
  actions?: { caseId: string; annotator: string; action: string }[];
};

export interface AnnotationSyncOptions {
  me?: string | null;
  dryRun?: boolean;
  only?: string[];
}

function getRepoRoot(): string {
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, "..", ".."),
    cwd,
    path.resolve(cwd, ".."),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "data"))) return c;
  }
  return path.resolve(cwd, "..", "..");
}

function getPythonPath(r: string): string {
  const candidates =
    process.platform === "win32"
      ? [path.join(r, "ml", ".venv", "Scripts", "python.exe"), "python"]
      : [path.join(r, "ml", ".venv", "bin", "python"), "python3"];
  return candidates.find((p) => p === "python" || p === "python3" || fs.existsSync(p))!;
}

function formatBackupTimestamp(d: Date, reason?: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  const stamp = `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
  return reason ? `${stamp}-${reason}` : `${stamp}-cloud`;
}

interface LocalFileInfo {
  caseId: string;
  annotator: string;
  filePath: string;
  fileName: string;
  sha256: string;
  mtimeMs: number;
}

interface RemoteIndexEntry {
  caseId: string;
  annotator: string;
  sha256: string;
  hasBone: boolean;
  updatedAt: Date;
  scanFingerprint: string | null;
  createdAt: Date;
  deletedAt: Date | null;
  deletedReason: string | null;
  supersededBy: string | null;
}

const GLOBAL_LOCK_KEY = Symbol.for("bme.annotationSync.lock");
type GlobalWithSyncLock = typeof globalThis & {
  [GLOBAL_LOCK_KEY]?: Promise<SyncReport> | null;
};

const LAST_REPORT_KEY = Symbol.for("bme.annotationSync.lastReport");
type GlobalWithLastReport = typeof globalThis & {
  [LAST_REPORT_KEY]?: SyncReport | null;
};

export function getLastSyncReport(): SyncReport | null {
  return (globalThis as GlobalWithLastReport)[LAST_REPORT_KEY] ?? null;
}

export function setLastSyncReport(report: SyncReport): void {
  (globalThis as GlobalWithLastReport)[LAST_REPORT_KEY] = report;
}

export async function runAnnotationSync(
  options: AnnotationSyncOptions = {},
): Promise<SyncReport> {
  const g = globalThis as GlobalWithSyncLock;
  if (g[GLOBAL_LOCK_KEY]) {
    return g[GLOBAL_LOCK_KEY]!;
  }

  const syncPromise = (async () => {
    try {
      const res = await executeSync(options);
      setLastSyncReport(res);
      return res;
    } finally {
      g[GLOBAL_LOCK_KEY] = null;
    }
  })();

  g[GLOBAL_LOCK_KEY] = syncPromise;
  return syncPromise;
}

type PyCaseInfo = {
  scan: string | null;
  files: Record<string, { has_bone: boolean; labels_gz_b64?: string; error?: string }>;
};

async function executeSync(options: AnnotationSyncOptions): Promise<SyncReport> {
  const now = new Date().toISOString();
  const dryRun = Boolean(options.dryRun);
  const me = options.me ? sanitizeAnnotator(options.me) : null;
  const repoRoot = getRepoRoot();
  const annotationsDir = path.join(repoRoot, "data", "annotations");

  const conflicts: { caseId: string; annotator: string }[] = [];
  const skipped: { caseId: string; annotator: string; why: SyncSkippedReason }[] = [];
  const changedCases: string[] = [];
  const dryRunActions: { caseId: string; annotator: string; action: string }[] = [];
  const eventRows: NewAnnotationEvent[] = [];

  let pushed = 0;
  let pulled = 0;
  let recorded = 0;
  let retired = 0;
  let appliedOnline = 0;

  try {
    const onlyCases = options.only
      ? options.only.filter(isValidCaseId)
      : null;
    const onlySet = onlyCases ? new Set(onlyCases) : null;

    // Step A: read the remote index with deletedAt, deletedReason, supersededBy
    let remoteRows: {
      caseId: string;
      annotator: string;
      sha256: string;
      hasBone: boolean;
      updatedAt: Date;
      scanFingerprint: string | null;
      createdAt: Date;
      deletedAt: Date | null;
      deletedReason: string | null;
      supersededBy: string | null;
    }[] = [];

    const baseQuery = db
      .select({
        caseId: caseAnnotation.caseId,
        annotator: caseAnnotation.annotator,
        sha256: caseAnnotation.sha256,
        hasBone: caseAnnotation.hasBone,
        updatedAt: caseAnnotation.updatedAt,
        scanFingerprint: caseAnnotation.scanFingerprint,
        createdAt: caseAnnotation.createdAt,
        deletedAt: caseAnnotation.deletedAt,
        deletedReason: caseAnnotation.deletedReason,
        supersededBy: caseAnnotation.supersededBy,
      })
      .from(caseAnnotation);

    if (onlySet) {
      if (onlySet.size > 0) {
        remoteRows = await baseQuery.where(inArray(caseAnnotation.caseId, Array.from(onlySet)));
      } else {
        remoteRows = [];
      }
    } else {
      remoteRows = await baseQuery;
    }

    const remoteMap = new Map<string, RemoteIndexEntry>();
    for (const row of remoteRows) {
      if (!isValidCaseId(row.caseId) || !isValidAnnotator(row.annotator)) {
        skipped.push({ caseId: row.caseId, annotator: row.annotator, why: "bad-row" });
        continue;
      }
      remoteMap.set(`${row.caseId}/${row.annotator}`, {
        caseId: row.caseId,
        annotator: row.annotator,
        sha256: row.sha256,
        hasBone: Boolean(row.hasBone),
        updatedAt: row.updatedAt,
        scanFingerprint: row.scanFingerprint,
        createdAt: row.createdAt,
        deletedAt: row.deletedAt,
        deletedReason: row.deletedReason,
        supersededBy: row.supersededBy,
      });
    }

    // Step B: list local files with sha256 and mtime. Load state from data/annotations/.sync_state.json
    const statePath = path.join(annotationsDir, ".sync_state.json");
    let syncState: Record<string, { sha: string; at: string }> = {};
    if (fs.existsSync(statePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
        if (typeof parsed === "object" && parsed !== null) {
          syncState = parsed;
        }
      } catch {
        syncState = {};
      }
    }

    const localMap = new Map<string, LocalFileInfo>();
    if (fs.existsSync(annotationsDir)) {
      try {
        const caseDirs = fs.readdirSync(annotationsDir, { withFileTypes: true });
        for (const cd of caseDirs) {
          if (!cd.isDirectory() || !isValidCaseId(cd.name)) continue;
          if (onlySet && !onlySet.has(cd.name)) continue;

          const casePath = path.join(annotationsDir, cd.name);
          const files = fs.readdirSync(casePath, { withFileTypes: true });
          for (const file of files) {
            if (!file.isFile()) continue;
            let annotator: string | null = null;
            if (file.name === `${cd.name}.seg.nrrd`) {
              annotator = "_main";
            } else {
              const m = file.name.match(new RegExp(`^${cd.name}__([A-Za-z0-9_-]{1,40})\\.seg\\.nrrd$`));
              if (m) {
                annotator = m[1];
              }
            }
            if (!annotator || !isValidAnnotator(annotator)) {
              continue;
            }

            const fullFilePath = path.join(casePath, file.name);
            try {
              const buf = fs.readFileSync(fullFilePath);
              const sha = crypto.createHash("sha256").update(buf).digest("hex");
              const st = fs.statSync(fullFilePath);
              localMap.set(`${cd.name}/${annotator}`, {
                caseId: cd.name,
                annotator,
                filePath: fullFilePath,
                fileName: file.name,
                sha256: sha,
                mtimeMs: st.mtimeMs,
              });
            } catch {
              // Unreadable local file is skipped
            }
          }
        }
      } catch {
        // Directory read error
      }
    }

    // Step C: call the Python helper only for cases where local and remote differ
    const allCaseIds = new Set<string>();
    for (const loc of localMap.values()) allCaseIds.add(loc.caseId);
    for (const rem of remoteMap.values()) allCaseIds.add(rem.caseId);

    const differingCaseIds: string[] = [];
    for (const cid of allCaseIds) {
      if (onlySet && !onlySet.has(cid)) continue;
      let differs = false;
      for (const [key, loc] of localMap.entries()) {
        if (loc.caseId !== cid) continue;
        const rem = remoteMap.get(key);
        if (!rem || rem.sha256 !== loc.sha256) {
          differs = true;
          break;
        }
      }
      if (!differs) {
        for (const [key, rem] of remoteMap.entries()) {
          if (rem.caseId !== cid) continue;
          const loc = localMap.get(key);
          if (!loc || loc.sha256 !== rem.sha256) {
            differs = true;
            break;
          }
        }
      }
      if (differs) {
        differingCaseIds.push(cid);
      }
    }

    const pyInfoByCase = new Map<string, PyCaseInfo>();

    for (let i = 0; i < differingCaseIds.length; i += 12) {
      const batch = differingCaseIds.slice(i, i + 12);
      const pythonExe = getPythonPath(repoRoot);
      const scriptPath = path.join(repoRoot, "ml", "scripts", "annotation_sync_info.py");

      try {
        const { stdout } = await exec(pythonExe, [scriptPath, repoRoot, "--labels", ...batch], {
          cwd: repoRoot,
          timeout: 600_000,
          maxBuffer: 32 * 1024 * 1024,
        });
        const parsed = JSON.parse(stdout.trim()) as Record<string, PyCaseInfo>;
        for (const [cid, info] of Object.entries(parsed)) {
          pyInfoByCase.set(cid, info);
        }
      } catch {
        // Python helper failed or skipped for this batch
      }
    }

    // Step D: decide() each key, then apply (skipped entirely when dryRun)
    const allKeys = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);
    let successCount = 0;

    function persistSyncState() {
      try {
        fs.mkdirSync(annotationsDir, { recursive: true });
        const finalPath = path.join(annotationsDir, ".sync_state.json");
        const tmpPath = path.join(
          annotationsDir,
          `.tmp_sync_state_${process.pid}_${Date.now()}.json`,
        );
        fs.writeFileSync(tmpPath, JSON.stringify(syncState, null, 2), "utf8");
        fs.renameSync(tmpPath, finalPath);
      } catch {
        // Failed to write state
      }
    }

    for (const key of allKeys) {
      const loc = localMap.get(key);
      const rem = remoteMap.get(key);
      const caseId = loc?.caseId ?? rem!.caseId;
      const annotator = loc?.annotator ?? rem!.annotator;

      if (onlySet && !onlySet.has(caseId)) {
        continue;
      }

      const pyCase = pyInfoByCase.get(caseId);
      const localScanFingerprint = pyCase ? pyCase.scan : null;

      const localInfo = loc
        ? {
            sha: loc.sha256,
            hasBone: Boolean(pyCase?.files?.[loc.fileName]?.has_bone),
            mtimeMs: loc.mtimeMs,
          }
        : null;

      const remoteInfo = rem
        ? {
            sha: rem.sha256,
            hasBone: rem.hasBone,
            updatedAtMs: rem.updatedAt.getTime(),
            scanFingerprint: rem.scanFingerprint,
          }
        : null;

      const stateEntry = syncState[key] ? { sha: syncState[key].sha } : null;

      const decideInput: DecideInput = {
        caseId,
        annotator,
        local: localInfo,
        remote: remoteInfo,
        state: stateEntry,
        me,
        localScanFingerprint,
      };

      // Rule for tombstoned remote row:
      // - local file exists and sha == rem.sha or state.sha == loc.sha -> retire-local
      // - local file exists, differs, and state.sha != loc.sha -> conflict
      // - no local file -> none
      let action: SyncAction;
      if (rem?.deletedAt) {
        if (loc) {
          if (loc.sha256 === rem.sha256 || (stateEntry && stateEntry.sha === loc.sha256)) {
            action = "retire-local" as SyncAction;
          } else {
            action = "conflict";
          }
        } else {
          action = "none";
        }
      } else {
        action = decide(decideInput);
      }

      if (action === "push-insert" || action === "push-update") {
        const fileEntry = loc ? pyCase?.files?.[loc.fileName] : undefined;
        if (!pyCase || !pyCase.scan || !fileEntry || Boolean(fileEntry.error)) {
          skipped.push({ caseId, annotator, why: "no-scan" });
          if (dryRun) {
            dryRunActions.push({ caseId, annotator, action: "skip-no-scan" });
          }
          continue;
        }
      }

      if (dryRun) {
        if (action !== "none") {
          dryRunActions.push({ caseId, annotator, action: action as string });
        }
        if (action === "push-insert" || action === "push-update") {
          pushed++;
        } else if (action === "pull-new" || action === "pull-update") {
          pulled++;
        } else if (action === "record") {
          recorded++;
        } else if ((action as string) === "retire-local") {
          retired++;
        } else if (action === "conflict") {
          conflicts.push({ caseId, annotator });
        } else if (action === "skip-scan-mismatch") {
          skipped.push({ caseId, annotator, why: "scan-mismatch" });
        } else if (action === "skip-no-scan") {
          skipped.push({ caseId, annotator, why: "no-scan" });
        } else if (action === "skip-not-owner") {
          skipped.push({ caseId, annotator, why: "not-owner" });
        }
        continue;
      }

      // Applying actions in non-dry-run mode
      if (action === "none") {
        continue;
      }

      if ((action as string) === "retire-local") {
        if (loc) {
          const reason = rem?.deletedReason || "deleted";
          const backupDirName = formatBackupTimestamp(new Date(), reason);
          const backupCaseDir = path.join(
            repoRoot,
            "data",
            "annotations_backup",
            backupDirName,
            caseId,
          );
          fs.mkdirSync(backupCaseDir, { recursive: true });
          const targetPath = path.join(backupCaseDir, loc.fileName);
          try {
            fs.renameSync(loc.filePath, targetPath);
            console.log(`[retire-local] Moved ${loc.filePath} -> ${targetPath}`);
            syncState[key] = { sha: loc.sha256, at: new Date().toISOString() };
            retired++;
            if (!changedCases.includes(caseId)) {
              changedCases.push(caseId);
            }
            eventRows.push({
              caseId,
              annotator,
              actor: me || "sync",
              action: "retire-local",
              sha256: loc.sha256,
              details: { reason, backupPath: targetPath },
              at: new Date(),
            });
            successCount++;
            if (successCount % 25 === 0) persistSyncState();
          } catch (moveErr) {
            console.error(`Failed to move file to backup during retire-local:`, moveErr);
          }
        }
        continue;
      }

      if (action === "conflict") {
        conflicts.push({ caseId, annotator });
        continue;
      }

      if (action === "skip-scan-mismatch") {
        skipped.push({ caseId, annotator, why: "scan-mismatch" });
        continue;
      }

      if (action === "skip-no-scan") {
        skipped.push({ caseId, annotator, why: "no-scan" });
        continue;
      }

      if (action === "skip-not-owner") {
        skipped.push({ caseId, annotator, why: "not-owner" });
        continue;
      }

      if (action === "record") {
        if (loc) {
          syncState[key] = { sha: loc.sha256, at: new Date().toISOString() };
          recorded++;
          successCount++;
          if (successCount % 25 === 0) persistSyncState();
        }
        continue;
      }

      if (action === "push-insert") {
        if (!loc) continue;
        try {
          const fileBuffer = fs.readFileSync(loc.filePath);
          const contentB64 = fileBuffer.toString("base64");
          const scanFp = localScanFingerprint;
          const fileEntry = pyCase?.files?.[loc.fileName];
          const bone = Boolean(fileEntry?.has_bone);
          const labelsGzB64 = fileEntry?.labels_gz_b64 ?? null;

          const insertRes = await db
            .insert(caseAnnotation)
            .values({
              caseId,
              annotator,
              contentB64,
              labelsGzB64,
              sha256: loc.sha256,
              bytes: fileBuffer.length,
              scanFingerprint: scanFp,
              hasBone: bone,
              savedBy: me,
              createdAt: new Date(loc.mtimeMs),
              updatedAt: new Date(),
            })
            .onConflictDoNothing({
              target: [caseAnnotation.caseId, caseAnnotation.annotator],
            })
            .returning({ id: caseAnnotation.id });

          if (insertRes.length === 0) {
            skipped.push({ caseId, annotator, why: "changed-remotely" });
          } else {
            pushed++;
            syncState[key] = { sha: loc.sha256, at: new Date().toISOString() };
            eventRows.push({
              caseId,
              annotator,
              actor: me || "sync",
              action: "push",
              sha256: loc.sha256,
              details: { type: "insert" },
              at: new Date(),
            });
            successCount++;
            if (successCount % 25 === 0) persistSyncState();
          }
        } catch {
          skipped.push({ caseId, annotator, why: "changed-remotely" });
        }
        continue;
      }

      if (action === "push-update") {
        if (!loc || !rem) continue;
        try {
          const fileBuffer = fs.readFileSync(loc.filePath);
          const contentB64 = fileBuffer.toString("base64");
          const scanFp = localScanFingerprint;
          const fileEntry = pyCase?.files?.[loc.fileName];
          const bone = Boolean(fileEntry?.has_bone);
          const labelsGzB64 = fileEntry?.labels_gz_b64 ?? null;

          const updateRes = await db
            .update(caseAnnotation)
            .set({
              contentB64,
              labelsGzB64,
              sha256: loc.sha256,
              bytes: fileBuffer.length,
              scanFingerprint: scanFp,
              hasBone: bone,
              savedBy: me,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(caseAnnotation.caseId, caseId),
                eq(caseAnnotation.annotator, annotator),
                eq(caseAnnotation.sha256, rem.sha256),
              ),
            )
            .returning({ id: caseAnnotation.id });

          if (updateRes.length === 0) {
            skipped.push({ caseId, annotator, why: "changed-remotely" });
          } else {
            pushed++;
            syncState[key] = { sha: loc.sha256, at: new Date().toISOString() };
            eventRows.push({
              caseId,
              annotator,
              actor: me || "sync",
              action: "push",
              sha256: loc.sha256,
              details: { type: "update" },
              at: new Date(),
            });
            successCount++;
            if (successCount % 25 === 0) persistSyncState();
          }
        } catch {
          skipped.push({ caseId, annotator, why: "changed-remotely" });
        }
        continue;
      }

      if (action === "pull-new" || action === "pull-update") {
        try {
          const rows = await db
            .select({
              contentB64: caseAnnotation.contentB64,
              sha256: caseAnnotation.sha256,
            })
            .from(caseAnnotation)
            .where(
              and(
                eq(caseAnnotation.caseId, caseId),
                eq(caseAnnotation.annotator, annotator),
              ),
            )
            .limit(1);

          if (rows.length === 0) {
            skipped.push({ caseId, annotator, why: "changed-remotely" });
            continue;
          }

          const row = rows[0];
          const fileBuffer = Buffer.from(row.contentB64, "base64");
          const computedSha = crypto.createHash("sha256").update(fileBuffer).digest("hex");

          if (computedSha !== row.sha256) {
            skipped.push({ caseId, annotator, why: "hash-mismatch" });
            continue;
          }

          const targetFileName =
            annotator === "_main" ? `${caseId}.seg.nrrd` : `${caseId}__${annotator}.seg.nrrd`;
          const caseDir = path.join(annotationsDir, caseId);
          fs.mkdirSync(caseDir, { recursive: true });
          const targetPath = path.join(caseDir, targetFileName);

          if (action === "pull-update" && fs.existsSync(targetPath)) {
            const backupCaseDir = path.join(
              repoRoot,
              "data",
              "annotations_backup",
              formatBackupTimestamp(new Date(), "cloud"),
              caseId,
            );
            fs.mkdirSync(backupCaseDir, { recursive: true });
            fs.copyFileSync(targetPath, path.join(backupCaseDir, targetFileName));
          }

          const tmpFilePath = path.join(
            caseDir,
            `.tmp_${targetFileName}_${process.pid}_${Date.now()}`,
          );
          fs.writeFileSync(tmpFilePath, fileBuffer);
          fs.renameSync(tmpFilePath, targetPath);

          pulled++;
          if (!changedCases.includes(caseId)) {
            changedCases.push(caseId);
          }
          syncState[key] = { sha: row.sha256, at: new Date().toISOString() };
          eventRows.push({
            caseId,
            annotator,
            actor: me || "sync",
            action: "pull",
            sha256: row.sha256,
            details: { type: action },
            at: new Date(),
          });
          successCount++;
          if (successCount % 25 === 0) persistSyncState();
        } catch {
          skipped.push({ caseId, annotator, why: "changed-remotely" });
        }
        continue;
      }
    }

    // Apply open review edits for radiologists (any laptop, safely once)
    if (!dryRun) {
      try {
        const openRadEdits = await db
          .select({
            id: reviewEdit.id,
            caseId: reviewEdit.caseId,
            reviewer: reviewEdit.reviewer,
            labelsGzB64: reviewEdit.labelsGzB64,
            baseAnnotator: reviewEdit.baseAnnotator,
          })
          .from(reviewEdit)
          .innerJoin(reviewAccount, eq(reviewEdit.reviewer, reviewAccount.username))
          .where(
            and(
              eq(reviewEdit.kind, "review"),
              eq(reviewEdit.status, "open"),
              inArray(reviewAccount.role, ["radiologist", "reviewer"]),
            ),
          );

        for (const edit of openRadEdits) {
          if (onlySet && !onlySet.has(edit.caseId)) continue;
          if (!isValidCaseId(edit.caseId)) continue;

          const scanPath = path.join(
            repoRoot,
            "data",
            "nifti",
            edit.caseId,
            `${edit.caseId}_primary.nii.gz`,
          );
          if (!fs.existsSync(scanPath)) continue;

          const claimToken = crypto.randomUUID();
          const claimer = me || process.env.USER || process.env.USERNAME || "sync";

          const claimed = await db
            .update(reviewEdit)
            .set({
              status: "applying",
              claimToken,
              appliedBy: claimer,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(reviewEdit.id, edit.id),
                eq(reviewEdit.status, "open"),
              ),
            )
            .returning({ id: reviewEdit.id });

          if (claimed.length === 0) {
            continue;
          }

          let rawBuf: Buffer;
          try {
            const gzBuf = Buffer.from(edit.labelsGzB64, "base64");
            rawBuf = zlib.gunzipSync(gzBuf);
          } catch (e) {
            console.error(`Decompress error on radiologist edit ${edit.id}:`, e);
            await db
              .update(reviewEdit)
              .set({
                status: "open",
                claimToken: null,
                appliedBy: null,
                updatedAt: new Date(),
              })
              .where(eq(reviewEdit.id, edit.id));
            continue;
          }

          const tmpRawPath = path.join(
            os.tmpdir(),
            `bme-rad-${edit.caseId}-${process.pid}-${Date.now()}.raw`,
          );

          try {
            fs.writeFileSync(tmpRawPath, rawBuf);
            const pythonExe = getPythonPath(repoRoot);
            const writeSegScript = path.join(repoRoot, "ml", "scripts", "write_seg.py");

            await exec(
              pythonExe,
              [writeSegScript, repoRoot, edit.caseId, tmpRawPath, "--main", edit.reviewer],
              {
                cwd: repoRoot,
                timeout: 120_000,
              },
            );

            const caseDir = path.join(annotationsDir, edit.caseId);
            const radFileName = `${edit.caseId}__${edit.reviewer}.seg.nrrd`;
            const mainFileName = `${edit.caseId}.seg.nrrd`;
            const radFilePath = path.join(caseDir, radFileName);
            const mainFilePath = path.join(caseDir, mainFileName);

            if (!fs.existsSync(radFilePath) || !fs.existsSync(mainFilePath)) {
              throw new Error("write_seg completed but output files were missing");
            }

            const radBuf = fs.readFileSync(radFilePath);
            const radSha = crypto.createHash("sha256").update(radBuf).digest("hex");
            const mainBuf = fs.readFileSync(mainFilePath);
            const mainSha = crypto.createHash("sha256").update(mainBuf).digest("hex");
            const hasBone = rawBuf.includes(1);

            // Push radiologist row
            await db
              .insert(caseAnnotation)
              .values({
                caseId: edit.caseId,
                annotator: edit.reviewer,
                contentB64: radBuf.toString("base64"),
                labelsGzB64: edit.labelsGzB64,
                sha256: radSha,
                bytes: radBuf.length,
                scanFingerprint: null,
                hasBone,
                savedBy: edit.reviewer,
                deletedAt: null,
                deletedBy: null,
                deletedReason: null,
                supersededBy: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: [caseAnnotation.caseId, caseAnnotation.annotator],
                set: {
                  contentB64: radBuf.toString("base64"),
                  labelsGzB64: edit.labelsGzB64,
                  sha256: radSha,
                  bytes: radBuf.length,
                  hasBone,
                  savedBy: edit.reviewer,
                  deletedAt: null,
                  deletedBy: null,
                  deletedReason: null,
                  supersededBy: null,
                  updatedAt: new Date(),
                },
              });

            // Push _main row, clearing any tombstone on _main because it is new content
            await db
              .insert(caseAnnotation)
              .values({
                caseId: edit.caseId,
                annotator: "_main",
                contentB64: mainBuf.toString("base64"),
                labelsGzB64: edit.labelsGzB64,
                sha256: mainSha,
                bytes: mainBuf.length,
                scanFingerprint: null,
                hasBone,
                savedBy: edit.reviewer,
                deletedAt: null,
                deletedBy: null,
                deletedReason: null,
                supersededBy: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: [caseAnnotation.caseId, caseAnnotation.annotator],
                set: {
                  contentB64: mainBuf.toString("base64"),
                  labelsGzB64: edit.labelsGzB64,
                  sha256: mainSha,
                  bytes: mainBuf.length,
                  hasBone,
                  savedBy: edit.reviewer,
                  deletedAt: null,
                  deletedBy: null,
                  deletedReason: null,
                  supersededBy: null,
                  updatedAt: new Date(),
                },
              });

            syncState[`${edit.caseId}/${edit.reviewer}`] = { sha: radSha, at: new Date().toISOString() };
            syncState[`${edit.caseId}/_main`] = { sha: mainSha, at: new Date().toISOString() };

            await db
              .update(reviewEdit)
              .set({
                status: "applied",
                appliedAt: new Date(),
                claimToken: null,
                updatedAt: new Date(),
              })
              .where(eq(reviewEdit.id, edit.id));

            appliedOnline++;
            if (!changedCases.includes(edit.caseId)) {
              changedCases.push(edit.caseId);
            }

            eventRows.push({
              caseId: edit.caseId,
              annotator: edit.reviewer,
              actor: claimer,
              action: "review-apply",
              sha256: radSha,
              details: { role: "radiologist", main: true },
              at: new Date(),
            });
          } catch (applyErr) {
            console.error(`Failed to apply radiologist review edit ${edit.id}:`, applyErr);
            await db
              .update(reviewEdit)
              .set({
                status: "open",
                claimToken: null,
                appliedBy: null,
                updatedAt: new Date(),
              })
              .where(eq(reviewEdit.id, edit.id));
          } finally {
            try {
              if (fs.existsSync(tmpRawPath)) fs.unlinkSync(tmpRawPath);
            } catch {
              // ignore
            }
          }
        }
      } catch (err) {
        console.error("Error processing radiologist review edits:", err);
      }
    }

    // Apply open team edits for me
    if (!dryRun && me) {
      try {
        const openTeamEdits = await db
          .select({
            id: reviewEdit.id,
            caseId: reviewEdit.caseId,
            reviewer: reviewEdit.reviewer,
            labelsGzB64: reviewEdit.labelsGzB64,
          })
          .from(reviewEdit)
          .where(
            and(
              eq(reviewEdit.kind, "team"),
              eq(reviewEdit.reviewer, me),
              eq(reviewEdit.status, "open"),
            ),
          );

        for (const edit of openTeamEdits) {
          if (onlySet && !onlySet.has(edit.caseId)) continue;
          if (!isValidCaseId(edit.caseId)) continue;

          // Skip if the case scan is not on this laptop
          const scanPath = path.join(
            repoRoot,
            "data",
            "nifti",
            edit.caseId,
            `${edit.caseId}_primary.nii.gz`,
          );
          if (!fs.existsSync(scanPath)) continue;

          // Decode labelsGzB64: base64 -> gunzip -> flat buffer
          let rawBuf: Buffer;
          try {
            const gzBuf = Buffer.from(edit.labelsGzB64, "base64");
            rawBuf = zlib.gunzipSync(gzBuf);
          } catch {
            continue;
          }

          // Write temp raw file and execute write_seg.py
          const tmpRawPath = path.join(
            os.tmpdir(),
            `bme-team-${edit.caseId}-${process.pid}-${Date.now()}.raw`,
          );
          try {
            fs.writeFileSync(tmpRawPath, rawBuf);
            const pythonExe = getPythonPath(repoRoot);
            const writeSegScript = path.join(repoRoot, "ml", "scripts", "write_seg.py");
            await exec(pythonExe, [writeSegScript, repoRoot, edit.caseId, tmpRawPath, me], {
              cwd: repoRoot,
              timeout: 120_000,
            });

            await db
              .update(reviewEdit)
              .set({
                status: "applied",
                appliedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(reviewEdit.id, edit.id));

            appliedOnline++;
            if (!changedCases.includes(edit.caseId)) {
              changedCases.push(edit.caseId);
            }
          } finally {
            try {
              if (fs.existsSync(tmpRawPath)) fs.unlinkSync(tmpRawPath);
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // Table review_edit may not exist yet or query failed
      }
    }

    if (!dryRun) {
      persistSyncState();

      // Step E: main-file fallback.
      let ownerByCase = new Map<string, string | null>();
      try {
        const ownerRows = await db
          .select({
            caseId: caseOwner.caseId,
            annotatedBy: caseOwner.annotatedBy,
          })
          .from(caseOwner);
        for (const o of ownerRows) {
          ownerByCase.set(o.caseId, o.annotatedBy);
        }
      } catch {
        // case_owner table query failed or not populated
      }

      for (const cid of allCaseIds) {
        if (onlySet && !onlySet.has(cid)) {
          continue;
        }
        const caseDir = path.join(annotationsDir, cid);
        const mainPath = path.join(caseDir, `${cid}.seg.nrrd`);
        if (fs.existsSync(mainPath)) {
          continue;
        }
        if (syncState[`${cid}/_main`]) {
          continue;
        }
        if (!fs.existsSync(caseDir)) {
          continue;
        }

        // Must not recreate a main file whose _main row is tombstoned unless a new non-tombstoned annotation replaced it
        const remMain = remoteMap.get(`${cid}/_main`);
        if (remMain?.deletedAt) {
          const mainDeletedAt = remMain.deletedAt;
          const hasReplacement = Array.from(remoteMap.values()).some(
            (r) =>
              r.caseId === cid &&
              r.annotator !== "_main" &&
              !r.deletedAt &&
              (r.annotator === remMain.supersededBy || r.createdAt >= mainDeletedAt),
          );
          if (!hasReplacement) {
            continue;
          }
        }

        // Check for local annotator copies (excluding any tombstoned copies)
        const files = fs.readdirSync(caseDir, { withFileTypes: true });
        const localAnnotators: { name: string; file: string; mtimeMs: number }[] = [];
        for (const f of files) {
          if (!f.isFile()) continue;
          const m = f.name.match(new RegExp(`^${cid}__([A-Za-z0-9_-]{1,40})\\.seg\\.nrrd$`));
          if (m) {
            const annotatorName = m[1];
            const rem = remoteMap.get(`${cid}/${annotatorName}`);
            if (rem?.deletedAt) {
              continue;
            }
            const st = fs.statSync(path.join(caseDir, f.name));
            localAnnotators.push({ name: annotatorName, file: f.name, mtimeMs: st.mtimeMs });
          }
        }

        if (localAnnotators.length === 0) {
          continue;
        }

        // Prefer case_owner.annotated_by person's copy, then earliest created_at
        const ownerName =
          ownerByCase.get(cid) ??
          (typeof ownerForCase === "function" ? ownerForCase(cid) : null);

        let chosenAnnotator: string | null = null;
        if (ownerName && localAnnotators.some((la) => la.name === ownerName)) {
          chosenAnnotator = ownerName;
        } else {
          const matchingRemoteRows: RemoteIndexEntry[] = [];
          for (const la of localAnnotators) {
            const rem = remoteMap.get(`${cid}/${la.name}`);
            if (rem && !rem.deletedAt) matchingRemoteRows.push(rem);
          }

          if (matchingRemoteRows.length > 0) {
            matchingRemoteRows.sort((a, b) => {
              const tDiff = a.createdAt.getTime() - b.createdAt.getTime();
              if (tDiff !== 0) return tDiff;
              return a.annotator.localeCompare(b.annotator);
            });
            chosenAnnotator = matchingRemoteRows[0].annotator;
          } else {
            localAnnotators.sort((a, b) => {
              const tDiff = a.mtimeMs - b.mtimeMs;
              if (tDiff !== 0) return tDiff;
              return a.name.localeCompare(b.name);
            });
            chosenAnnotator = localAnnotators[0].name;
          }
        }

        if (chosenAnnotator) {
          const sourcePath = path.join(caseDir, `${cid}__${chosenAnnotator}.seg.nrrd`);
          if (fs.existsSync(sourcePath) && !fs.existsSync(mainPath)) {
            try {
              fs.copyFileSync(sourcePath, mainPath);
              if (!changedCases.includes(cid)) {
                changedCases.push(cid);
              }
            } catch {
              // Copy failed
            }
          }
        }
      }
    }

    // Batch insert logged events at end of sync
    if (!dryRun && eventRows.length > 0) {
      await logEvents(eventRows);
    }

    return {
      ok: true,
      dryRun,
      at: now,
      me,
      pushed,
      pulled,
      recorded,
      retired,
      appliedOnline,
      conflicts,
      skipped,
      changedCases,
      ...(dryRun ? { actions: dryRunActions } : {}),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const errCode = (err as { code?: string })?.code;
    const isTableMissing =
      errCode === "42P01" ||
      (msg.includes("case_annotation") &&
        (msg.includes("does not exist") || msg.includes("undefined_table")));

    return {
      ok: false,
      reason: isTableMissing
        ? "table missing, run pnpm db:migrate"
        : "database unreachable",
      dryRun,
      at: now,
      me,
      pushed: 0,
      pulled: 0,
      recorded: 0,
      retired: 0,
      appliedOnline: 0,
      conflicts: [],
      skipped: [],
      changedCases: [],
      ...(dryRun ? { actions: dryRunActions } : {}),
    };
  }
}

export interface BackfillLabelsOptions {
  me?: string | null;
}

export interface BackfillLabelsResult {
  ok: boolean;
  backfilled: number;
  totalChecked: number;
  cases: string[];
  error?: string;
}

export async function backfillLabels(
  options: BackfillLabelsOptions = {},
): Promise<BackfillLabelsResult> {
  const me = options.me ? sanitizeAnnotator(options.me) : null;
  const repoRoot = getRepoRoot();
  const annotationsDir = path.join(repoRoot, "data", "annotations");

  try {
    const conditions = [isNull(caseAnnotation.labelsGzB64)];
    if (me) {
      conditions.push(
        or(eq(caseAnnotation.annotator, me), eq(caseAnnotation.savedBy, me))!,
      );
    }

    const candidateRows = await db
      .select({
        id: caseAnnotation.id,
        caseId: caseAnnotation.caseId,
        annotator: caseAnnotation.annotator,
        sha256: caseAnnotation.sha256,
      })
      .from(caseAnnotation)
      .where(and(...conditions));

    const matchingRows: typeof candidateRows = [];
    for (const row of candidateRows) {
      if (!isValidCaseId(row.caseId) || !isValidAnnotator(row.annotator)) continue;
      const fileName =
        row.annotator === "_main"
          ? `${row.caseId}.seg.nrrd`
          : `${row.caseId}__${row.annotator}.seg.nrrd`;
      const filePath = path.join(annotationsDir, row.caseId, fileName);
      if (!fs.existsSync(filePath)) continue;

      try {
        const buf = fs.readFileSync(filePath);
        const localSha = crypto.createHash("sha256").update(buf).digest("hex");
        if (localSha === row.sha256) {
          matchingRows.push(row);
        }
      } catch {
        // Skip unreadable files
      }
    }

    const uniqueCaseIds = Array.from(new Set(matchingRows.map((r) => r.caseId)));
    let backfilled = 0;
    const backfilledCases: string[] = [];

    for (let i = 0; i < uniqueCaseIds.length; i += 12) {
      const batchCaseIds = uniqueCaseIds.slice(i, i + 12);
      const pythonExe = getPythonPath(repoRoot);
      const scriptPath = path.join(repoRoot, "ml", "scripts", "annotation_sync_info.py");

      try {
        const { stdout } = await exec(
          pythonExe,
          [scriptPath, repoRoot, "--labels", ...batchCaseIds],
          {
            cwd: repoRoot,
            timeout: 600_000,
            maxBuffer: 32 * 1024 * 1024,
          },
        );
        const parsed = JSON.parse(stdout.trim()) as Record<string, PyCaseInfo>;

        for (const row of matchingRows) {
          if (!batchCaseIds.includes(row.caseId)) continue;
          const pyCase = parsed[row.caseId];
          if (!pyCase) continue;
          const fileName =
            row.annotator === "_main"
              ? `${row.caseId}.seg.nrrd`
              : `${row.caseId}__${row.annotator}.seg.nrrd`;
          const fileInfo = pyCase.files?.[fileName];
          if (fileInfo?.labels_gz_b64) {
            await db
              .update(caseAnnotation)
              .set({
                labelsGzB64: fileInfo.labels_gz_b64,
              })
              .where(
                and(
                  eq(caseAnnotation.caseId, row.caseId),
                  eq(caseAnnotation.annotator, row.annotator),
                  eq(caseAnnotation.sha256, row.sha256),
                ),
              );
            backfilled++;
            if (!backfilledCases.includes(row.caseId)) {
              backfilledCases.push(row.caseId);
            }
          }
        }
      } catch {
        // Batch failed
      }
    }

    return {
      ok: true,
      backfilled,
      totalChecked: matchingRows.length,
      cases: backfilledCases,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      backfilled: 0,
      totalChecked: 0,
      cases: [],
      error: msg,
    };
  }
}
