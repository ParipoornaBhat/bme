"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";

export interface SyncReport {
  ok: boolean;
  reason?: string;
  dryRun?: boolean;
  at?: string;
  me?: string | null;
  pushed?: number;
  pulled?: number;
  recorded?: number;
  appliedOnline?: number;
  conflicts?: { caseId: string; annotator: string }[];
  skipped?: { caseId: string; annotator: string; why: string }[];
  changedCases?: string[];
}

type Active = { caseId: string; reload: () => void | Promise<void>; dirty: () => boolean };

// One shared store for the whole page. The viewer remounts when the case
// changes, but a sync that is already running keeps going and reports back
// here, so its result and its message are never lost.
const store = {
  status: "",
  running: false,
  promise: null as Promise<SyncReport | null> | null,
  notices: {} as Record<string, string>,
  listeners: new Set<() => void>(),
  active: null as Active | null,
  version: 0,
};

function emit() {
  store.version++;
  store.listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

function announce(report: SyncReport) {
  const pulled = report.pulled ?? 0;
  const pushed = report.pushed ?? 0;
  const applied = report.appliedOnline ?? 0;
  const conflicts = report.conflicts?.length ?? 0;
  const skipped = report.skipped?.length ?? 0;
  const parts: string[] = [];
  if (pulled) parts.push(`${pulled} new annotation${pulled === 1 ? "" : "s"} saved locally`);
  if (pushed) parts.push(`${pushed} annotation${pushed === 1 ? "" : "s"} updated in the database`);
  if (applied) parts.push(`${applied} reviewer edit${applied === 1 ? "" : "s"} applied`);
  if (parts.length === 0 && conflicts === 0 && skipped === 0) {
    toast.success("Annotations are in sync with the cloud database");
    return;
  }
  const text = parts.length ? `Cloud sync finished: ${parts.join(", ")}.` : "Cloud sync finished.";
  if (conflicts || skipped) {
    toast.warning(`${text} ${conflicts} conflict(s), ${skipped} skipped. Open Activities to decide.`);
  } else {
    toast.success(text);
  }
}

function runSync(caseId: string, me: string | null, all: boolean): Promise<SyncReport | null> {
  if (store.promise) return store.promise;
  store.running = true;
  store.status = "Syncing...";
  emit();

  const job = (async (): Promise<SyncReport | null> => {
    try {
      const params = new URLSearchParams();
      if (me) params.set("by", me);
      if (!all && caseId) params.set("case", caseId);
      const q = params.toString() ? `?${params.toString()}` : "";
      const res = await fetch(`/api/annotation-sync${q}`, { method: "POST" });
      if (!res.ok) {
        store.status = "Sync off (database unreachable)";
        toast.error("Cloud sync failed: database unreachable");
        return null;
      }
      const report = (await res.json().catch(() => ({ ok: false }))) as SyncReport;
      if (!report.ok) {
        store.status = "Sync off (database unreachable)";
        toast.error(`Cloud sync failed: ${report.reason ?? "unknown error"}`);
        return report;
      }
      store.status = `Synced ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
      announce(report);
      const active = store.active;
      const changed = report.changedCases ?? [];
      if (active && changed.includes(active.caseId)) {
        if (!active.dirty()) {
          delete store.notices[active.caseId];
          await active.reload();
        } else {
          store.notices[active.caseId] = "New annotations from the team for this case. Save, then reload.";
        }
      }
      return report;
    } catch {
      store.status = "Sync off (database unreachable)";
      toast.error("Cloud sync failed");
      return null;
    } finally {
      store.running = false;
      store.promise = null;
      emit();
    }
  })();

  store.promise = job;
  return job;
}

export function useCloudSync({
  caseId,
  me,
  dirty,
  onReloadCase,
  enabled = true,
}: {
  caseId: string;
  me?: string | null;
  dirty: boolean;
  onReloadCase: () => void | Promise<void>;
  enabled?: boolean;
}) {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const reloadRef = useRef(onReloadCase);
  reloadRef.current = onReloadCase;

  useEffect(() => {
    const entry: Active = {
      caseId,
      reload: () => reloadRef.current(),
      dirty: () => dirtyRef.current,
    };
    store.active = entry;
    return () => {
      if (store.active === entry) store.active = null;
    };
  }, [caseId]);

  useSyncExternalStore(subscribe, () => store.version, () => store.version);

  const triggerSync = useCallback(
    (opts?: { all?: boolean }) => {
      if (!enabled) return Promise.resolve(null);
      return runSync(caseId, me ?? null, Boolean(opts?.all));
    },
    [caseId, me, enabled],
  );

  const clearTeamNotice = useCallback(() => {
    delete store.notices[caseId];
    emit();
  }, [caseId]);

  return {
    syncStatus: store.status,
    isSyncing: store.running,
    teamNotice: store.notices[caseId] ?? null,
    clearTeamNotice,
    triggerSync,
  };
}
