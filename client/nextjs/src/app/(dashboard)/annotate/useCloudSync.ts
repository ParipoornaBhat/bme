"use client";

import { useEffect, useRef, useState, useCallback } from "react";

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
  const [syncStatus, setSyncStatus] = useState<string>("");
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [teamNotice, setTeamNotice] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const onReloadRef = useRef(onReloadCase);
  onReloadRef.current = onReloadCase;

  const runSync = useCallback(async (opts?: { all?: boolean }) => {
    if (!enabled || inFlightRef.current) return null;
    inFlightRef.current = true;
    setIsSyncing(true);
    setSyncStatus("Syncing...");

    try {
      const params = new URLSearchParams();
      if (me) params.set("by", me);
      if (!opts?.all && caseId) params.set("case", caseId);
      const q = params.toString() ? `?${params.toString()}` : "";

      const res = await fetch(`/api/annotation-sync${q}`, {
        method: "POST",
      });

      if (!res.ok) {
        setSyncStatus("Sync off (database unreachable)");
        return null;
      }

      const report: SyncReport = await res.json().catch(() => ({ ok: false }));
      if (!report.ok) {
        setSyncStatus("Sync off (database unreachable)");
        return report;
      }

      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
      setSyncStatus(`Synced ${timeStr}`);

      if (caseId && report.changedCases && report.changedCases.includes(caseId)) {
        if (!dirtyRef.current) {
          setTeamNotice(null);
          await onReloadRef.current();
        } else {
          setTeamNotice("New annotations from the team for this case. Save, then reload.");
        }
      }
      return report;
    } catch {
      setSyncStatus("Sync off (database unreachable)");
      return null;
    } finally {
      inFlightRef.current = false;
      setIsSyncing(false);
    }
  }, [enabled, caseId, me]);

  const clearTeamNotice = useCallback(() => {
    setTeamNotice(null);
  }, []);

  return {
    syncStatus,
    isSyncing,
    teamNotice,
    clearTeamNotice,
    triggerSync: runSync,
  };
}
