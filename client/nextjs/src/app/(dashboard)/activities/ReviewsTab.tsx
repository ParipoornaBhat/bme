"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Loader2, CheckCircle2, XCircle, Clock, Check, Layers, AlertCircle } from "lucide-react";
import { toast } from "sonner";

export interface ReviewItem {
  id: string;
  caseId: string;
  reviewer: string;
  baseAnnotator: string | null;
  note: string | null;
  status: "open" | "applied" | "dismissed";
  kind: "review" | "team";
  role: "radiologist" | "reviewer" | "team";
  versionsCount: number;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
  appliedBy: string | null;
}

export function ReviewsTab() {
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "applied" | "dismissed">("all");
  const [actingId, setActingId] = useState<string | null>(null);

  const fetchReviews = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/activities/reviews", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setReviews(data.reviews ?? data.edits ?? []);
      } else {
        setReviews([]);
      }
    } catch {
      setReviews([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews]);

  const handleAction = async (id: string, action: "apply" | "dismiss", main?: boolean) => {
    setActingId(id);
    try {
      const res = await fetch("/api/activities/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action, main }),
      });

      if (res.ok) {
        const actionLabel = action === "dismiss" ? "Dismissed" : main ? "Applied as main" : "Kept alongside";
        toast.success(`Review edit ${actionLabel.toLowerCase()} successfully`);
        await fetchReviews();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to update review edit");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Action failed: ${msg}`);
    } finally {
      setActingId(null);
    }
  };

  const filteredReviews = reviews.filter((r) => {
    if (statusFilter === "all") return true;
    return r.status === statusFilter;
  });

  const openCount = reviews.filter((r) => r.status === "open").length;

  return (
    <div className="space-y-4">
      {/* Header and Filter */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-card p-3 shadow-xs">
        <div className="flex items-center gap-1.5">
          {(["all", "open", "applied", "dismissed"] as const).map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setStatusFilter(st)}
              className={`rounded-lg px-3 py-1 text-xs font-semibold capitalize transition cursor-pointer ${
                statusFilter === st
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {st}
              {st === "open" && openCount > 0 && (
                <span className="ml-1.5 rounded-full bg-amber-500/20 px-1.5 py-0.2 text-[10px] font-bold text-amber-400">
                  {openCount}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="text-xs text-muted-foreground">
          Showing {filteredReviews.length} of {reviews.length} reviews
        </div>
      </div>

      {/* Reviews Table */}
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border/60 bg-muted/30 text-[11px] font-semibold text-muted-foreground">
                <th className="py-2.5 px-3 whitespace-nowrap">Case</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Reviewer</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Role</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Base</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Versions</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Status</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Note</th>
                <th className="py-2.5 px-3 whitespace-nowrap text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {loading ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-muted-foreground">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin mb-1 text-primary" />
                    <span>Loading reviews…</span>
                  </td>
                </tr>
              ) : filteredReviews.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-muted-foreground">
                    No review edits found.
                  </td>
                </tr>
              ) : (
                filteredReviews.map((r) => {
                  const isActing = actingId === r.id;
                  const canAct = r.status === "open" && r.role === "reviewer";

                  return (
                    <tr key={r.id} className="hover:bg-muted/20 transition-colors">
                      <td className="py-2.5 px-3 font-semibold font-mono whitespace-nowrap">
                        <Link
                          href={`/annotate?case=${encodeURIComponent(r.caseId)}`}
                          className="text-primary hover:underline"
                        >
                          {r.caseId}
                        </Link>
                      </td>
                      <td className="py-2.5 px-3 font-medium whitespace-nowrap">
                        {r.reviewer}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-bold uppercase tracking-wider ${
                            r.role === "radiologist"
                              ? "bg-purple-500/10 text-purple-400 border-purple-500/30"
                              : r.role === "reviewer"
                              ? "bg-blue-500/10 text-blue-400 border-blue-500/30"
                              : "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                          }`}
                        >
                          {r.role}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-muted-foreground whitespace-nowrap font-mono text-[11px]">
                        {r.baseAnnotator || "_main"}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                          <Layers className="h-3 w-3" />
                          <span>v{r.versionsCount}</span>
                        </span>
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider ${
                            r.status === "open"
                              ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                              : r.status === "applied"
                              ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                              : "bg-zinc-500/15 text-zinc-400 border border-zinc-500/30"
                          }`}
                        >
                          {r.status === "open" && <Clock className="h-2.5 w-2.5" />}
                          {r.status === "applied" && <CheckCircle2 className="h-2.5 w-2.5" />}
                          {r.status === "dismissed" && <XCircle className="h-2.5 w-2.5" />}
                          <span>{r.status}</span>
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-muted-foreground max-w-xs truncate" title={r.note ?? undefined}>
                        {r.note || <span className="text-muted-foreground/40 italic">none</span>}
                      </td>
                      <td className="py-2.5 px-3 text-right whitespace-nowrap">
                        {canAct ? (
                          <div className="inline-flex items-center gap-1.5 justify-end">
                            {isActing ? (
                              <Loader2 className="h-4 w-4 animate-spin text-primary" />
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={() => handleAction(r.id, "apply", true)}
                                  className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold text-emerald-400 hover:bg-emerald-500/20 transition cursor-pointer"
                                  title="Replace the case's main annotation with this edit"
                                >
                                  <Check className="h-3 w-3" />
                                  <span>Apply as main</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleAction(r.id, "apply", false)}
                                  className="inline-flex items-center gap-1 rounded-md border border-blue-500/40 bg-blue-500/10 px-2 py-1 text-[11px] font-semibold text-blue-400 hover:bg-blue-500/20 transition cursor-pointer"
                                  title="Save alongside as this reviewer's annotation file"
                                >
                                  <span>Keep alongside</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleAction(r.id, "dismiss")}
                                  className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition cursor-pointer"
                                >
                                  <span>Dismiss</span>
                                </button>
                              </>
                            )}
                          </div>
                        ) : r.status === "applied" ? (
                          <span className="text-[11px] text-emerald-400 font-mono">
                            Applied {r.appliedBy ? `by ${r.appliedBy}` : ""}
                          </span>
                        ) : r.status === "dismissed" ? (
                          <span className="text-[11px] text-muted-foreground font-mono">Dismissed</span>
                        ) : r.role === "radiologist" ? (
                          <span className="text-[11px] text-purple-400 font-mono flex items-center gap-1 justify-end">
                            <AlertCircle className="h-3 w-3" />
                            <span>Auto-applied by sync</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground/40">—</span>
                        )}
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
