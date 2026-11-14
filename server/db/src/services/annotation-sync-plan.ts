/**
 * Pure decision function for cloud annotation sync.
 * No fs, no db.
 */

export type SyncAction =
  | "none"
  | "push-insert"
  | "push-update"
  | "pull-new"
  | "pull-update"
  | "record"
  | "conflict"
  | "skip-scan-mismatch"
  | "skip-no-scan"
  | "skip-not-owner";

export interface SyncLocalInfo {
  sha: string;
  hasBone: boolean;
  mtimeMs: number;
}

export interface SyncRemoteInfo {
  sha: string;
  hasBone: boolean;
  updatedAtMs: number;
  scanFingerprint?: string | null;
}

export interface SyncStateInfo {
  sha: string;
}

export interface DecideInput {
  caseId: string;
  annotator: string;
  local: SyncLocalInfo | null;
  remote: SyncRemoteInfo | null;
  state: SyncStateInfo | null;
  me: string | null;
  localScanFingerprint: string | null;
}

// Aliases for convenient integration
export type AnnotationSyncAction = SyncAction;
export type AnnotationSyncDecideInput = DecideInput;
export type AnnotationSyncLocalInfo = SyncLocalInfo;
export type AnnotationSyncRemoteInfo = SyncRemoteInfo;
export type AnnotationSyncStateInfo = SyncStateInfo;

/**
 * Decide the sync action for a single (caseId, annotator) key.
 */
export function decide(input: DecideInput): SyncAction {
  const { local, remote, state, me, localScanFingerprint, annotator } = input;

  // 1. Both null: none.
  if (!local && !remote) {
    return "none";
  }

  // 2. local and remote equal sha: record (or none if state already equals it).
  if (local && remote && local.sha === remote.sha) {
    if (state && state.sha === local.sha) {
      return "none";
    }
    return "record";
  }

  // 3. remote only:
  if (!local && remote) {
    // state exists (the file was deleted on this laptop after a sync) and state.sha == remote.sha: none
    if (state && state.sha === remote.sha) {
      return "none";
    }
    // localScanFingerprint null: skip-no-scan
    if (localScanFingerprint === null) {
      return "skip-no-scan";
    }
    // remote.scanFingerprint set and != localScanFingerprint: skip-scan-mismatch
    if (remote.scanFingerprint && remote.scanFingerprint !== localScanFingerprint) {
      return "skip-scan-mismatch";
    }
    // else pull-new
    return "pull-new";
  }

  // 4. local only: push-insert (any annotator; the unique index stops duplicates).
  if (local && !remote) {
    return "push-insert";
  }

  // 5. both exist and differ:
  if (local && remote) {
    // remote.scanFingerprint set, localScanFingerprint set, and they differ: skip-scan-mismatch
    if (
      remote.scanFingerprint &&
      localScanFingerprint &&
      remote.scanFingerprint !== localScanFingerprint
    ) {
      return "skip-scan-mismatch";
    }

    // state.sha == local.sha (local unchanged since last sync, remote changed): pull-update
    if (state && state.sha === local.sha) {
      return "pull-update";
    }

    // state.sha == remote.sha (remote unchanged, local changed): push-update only if annotator == me or annotator == _main; otherwise skip-not-owner
    if (state && state.sha === remote.sha) {
      if (annotator === me || annotator === "_main") {
        return "push-update";
      }
      return "skip-not-owner";
    }

    // no state, local has no bone and remote has bone: pull-update
    if (!state) {
      if (!local.hasBone && remote.hasBone) {
        return "pull-update";
      }
      // no state, remote has no bone and local has bone, and (annotator == me or _main): push-update
      if (!remote.hasBone && local.hasBone && (annotator === me || annotator === "_main")) {
        return "push-update";
      }
    }

    // anything else: conflict (nothing is written on either side)
    return "conflict";
  }

  return "conflict";
}
