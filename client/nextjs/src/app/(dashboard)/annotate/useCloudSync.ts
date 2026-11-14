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
  const [teamNotice, setTeamNotice] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const onReloadRef = useRef(onReloadCase);
  onReloadRef.current = onReloadCase;

  const runSync = useCallback(async () => {
    if (!enabled || !caseId || inFlightRef.current) return;
    inFlightRef.current = true;
    setSyncStatus("Syncing...");

    try {
      const q = me ? `?by=${encodeURIComponent(me)}` : "";
      const res = await fetch(`/api/annotation-sync${q}`, {
        method: "POST",
      });

      if (!res.ok) {
        setSyncStatus("Sync off (database unreachable)");
        return;
      }

      const report: SyncReport = await res.json().catch(() => ({ ok: false }));
      if (!report.ok) {
        setSyncStatus("Sync off (database unreachable)");
        return;
      }

      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
      setSyncStatus(`Synced ${timeStr}`);

      if (report.changedCases && report.changedCases.includes(caseId)) {
        if (!dirtyRef.current) {
          setTeamNotice(null);
          await onReloadRef.current();
        } else {
          setTeamNotice("New annotations from the team for this case. Save, then reload.");
        }
      }
    } catch {
      setSyncStatus("Sync off (database unreachable)");
    } finally {
      inFlightRef.current = false;
    }
  }, [enabled, caseId, me]);

  // Sync on open
  useEffect(() => {
    if (!enabled || !caseId) return;
    void runSync();
  }, [enabled, caseId, runSync]);

  // Sync every 60s while visible
  useEffect(() => {
    if (!enabled || !caseId) return;
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      void runSync();
    }, 60_000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void runSync();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, caseId, runSync]);

  const clearTeamNotice = useCallback(() => {
    setTeamNotice(null);
  }, []);

  return {
    syncStatus,
    teamNotice,
    clearTeamNotice,
    triggerSync: runSync,
  };
}
