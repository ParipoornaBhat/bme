"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Loader2, RotateCcw, ExternalLink, GitCompare, Archive } from "lucide-react";
import { toast } from "sonner";

export interface DeletedItem {
  caseId: string;
  annotator: string;
  deletedAt: string;
  deletedBy: string | null;
  deletedReason: string | null;
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

export function DeletedTab() {
  const [deleted, setDeleted] = useState<DeletedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoringKey, setRestoringKey] = useState<string | null>(null);

  const fetchDeleted = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/activities/deleted", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setDeleted(data.deleted ?? []);
      } else {
        setDeleted([]);
      }
    } catch {
      setDeleted([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDeleted();
  }, [fetchDeleted]);

  const handleRestore = async (caseId: string, annotator: string) => {
    const key = `${caseId}:${annotator}`;
    const ok = window.confirm(
      `Restore annotation for ${caseId} (${annotator})? This will recover the file to data/annotations and clear its deleted status.`
    );
    if (!ok) return;

    setRestoringKey(key);
    try {
      const res = await fetch("/api/activities/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, annotator }),
      });

      if (res.ok) {
        toast.success(`Restored annotation for ${caseId} (${annotator})`);
        await fetchDeleted();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to restore annotation");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Restore failed: ${msg}`);
    } finally {
      setRestoringKey(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header Info */}
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-card p-3 shadow-xs">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Archive className="h-4 w-4 text-primary" />
          <span>
            Tombstoned annotations. These files are moved to backup folders locally and soft-deleted in the database.
          </span>
        </div>
        <div className="text-xs text-muted-foreground font-medium">
          {deleted.length} deleted annotation{deleted.length === 1 ? "" : "s"}
        </div>
      </div>

      {/* Deleted Annotations Table */}
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border/60 bg-muted/30 text-[11px] font-semibold text-muted-foreground">
                <th className="py-2.5 px-3 whitespace-nowrap">Case</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Annotator</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Deleted At</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Deleted By</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Reason</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Superseded By</th>
                <th className="py-2.5 px-3 whitespace-nowrap text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-muted-foreground">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin mb-1 text-primary" />
                    <span>Loading deleted annotations…</span>
                  </td>
                </tr>
              ) : deleted.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-muted-foreground">
                    No deleted or superseded annotations found.
                  </td>
                </tr>
              ) : (
                deleted.map((d) => {
                  const key = `${d.caseId}:${d.annotator}`;
                  const isRestoring = restoringKey === key;
                  const compareTarget = d.supersededBy || "_main";

                  return (
                    <tr key={key} className="hover:bg-muted/20 transition-colors">
                      <td className="py-2.5 px-3 font-semibold font-mono whitespace-nowrap">
                        <Link
                          href={`/annotate?case=${encodeURIComponent(d.caseId)}`}
                          className="text-primary hover:underline"
                        >
                          {d.caseId}
                        </Link>
                      </td>
                      <td className="py-2.5 px-3 font-medium whitespace-nowrap">
                        {d.annotator}
                      </td>
                      <td className="py-2.5 px-3 text-muted-foreground whitespace-nowrap font-mono text-[11px]">
                        {formatDate(d.deletedAt)}
                      </td>
                      <td className="py-2.5 px-3 text-muted-foreground whitespace-nowrap">
                        {d.deletedBy || "—"}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-bold uppercase tracking-wider ${
                            d.deletedReason === "superseded"
                              ? "bg-amber-500/10 text-amber-400 border-amber-500/30"
                              : "bg-rose-500/10 text-rose-400 border-rose-500/30"
                          }`}
                        >
                          {d.deletedReason || "deleted"}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-muted-foreground whitespace-nowrap font-medium">
                        {d.supersededBy ? (
                          <span className="text-foreground">{d.supersededBy}</span>
                        ) : (
                          <span className="text-muted-foreground/40 italic">none</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2 justify-end">
                          {/* Open */}
                          <Link
                            href={`/annotate?case=${encodeURIComponent(d.caseId)}&by=${encodeURIComponent(d.annotator)}&deleted=1`}
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-semibold text-primary hover:bg-muted transition cursor-pointer"
                            title="Open this deleted annotation in the 3D annotator"
                          >
                            <ExternalLink className="h-3 w-3" />
                            <span>Open</span>
                          </Link>

                          {/* Compare */}
                          <Link
                            href={`/annotate?case=${encodeURIComponent(d.caseId)}&by=${encodeURIComponent(d.annotator)}&deleted=1&compare=${encodeURIComponent(compareTarget)}`}
                            className="inline-flex items-center gap-1 rounded-md border border-indigo-500/40 bg-indigo-500/10 px-2 py-1 text-[11px] font-semibold text-indigo-400 hover:bg-indigo-500/20 transition cursor-pointer"
                            title={`Compare this deleted annotation with ${compareTarget}`}
                          >
                            <GitCompare className="h-3 w-3" />
                            <span>Compare</span>
                          </Link>

                          {/* Restore */}
                          <button
                            type="button"
                            onClick={() => handleRestore(d.caseId, d.annotator)}
                            disabled={isRestoring}
                            className="inline-flex items-center gap-1 rounded-md border border-teal-500/40 bg-teal-500/10 px-2 py-1 text-[11px] font-semibold text-teal-400 hover:bg-teal-500/20 transition cursor-pointer disabled:opacity-50"
                            title="Restore this annotation back to active status"
                          >
                            {isRestoring ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RotateCcw className="h-3 w-3" />
                            )}
                            <span>Restore</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
