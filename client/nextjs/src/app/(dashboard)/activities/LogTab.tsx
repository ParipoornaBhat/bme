"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Loader2, Search, RotateCcw, ChevronDown, Filter } from "lucide-react";

export interface AnnotationEvent {
  id: string;
  at: string;
  caseId: string;
  annotator: string | null;
  actor: string | null;
  action: string;
  sha256: string | null;
  details: any;
}

const ACTION_COLORS: Record<string, string> = {
  save: "bg-purple-500/10 text-purple-400 border-purple-500/30",
  push: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  pull: "bg-cyan-500/10 text-cyan-400 border-cyan-500/30",
  "review-submit": "bg-indigo-500/10 text-indigo-400 border-indigo-500/30",
  "team-submit": "bg-sky-500/10 text-sky-400 border-sky-500/30",
  supersede: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  "review-apply": "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  "review-dismiss": "bg-zinc-500/10 text-zinc-400 border-zinc-500/30",
  "retire-local": "bg-orange-500/10 text-orange-400 border-orange-500/30",
  delete: "bg-rose-500/10 text-rose-400 border-rose-500/30",
  restore: "bg-teal-500/10 text-teal-400 border-teal-500/30",
  "set-main": "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  "owner-set": "bg-violet-500/10 text-violet-400 border-violet-500/30",
};

const KNOWN_ACTIONS = [
  "all",
  "save",
  "push",
  "pull",
  "review-submit",
  "team-submit",
  "supersede",
  "review-apply",
  "review-dismiss",
  "retire-local",
  "delete",
  "restore",
  "set-main",
  "owner-set",
];

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

export function LogTab() {
  const [events, setEvents] = useState<AnnotationEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const [caseFilter, setCaseFilter] = useState("");
  const [personFilter, setPersonFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("all");

  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({});

  const fetchEvents = useCallback(
    async (before?: string, append = false) => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }

      const params = new URLSearchParams();
      if (caseFilter.trim()) params.set("case", caseFilter.trim());
      if (personFilter.trim()) params.set("person", personFilter.trim());
      if (actionFilter !== "all") params.set("action", actionFilter);
      params.set("limit", "100");
      if (before) params.set("before", before);

      try {
        const res = await fetch(`/api/activities/events?${params.toString()}`, { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          const list: AnnotationEvent[] = data.events ?? [];
          if (append) {
            setEvents((prev) => [...prev, ...list]);
          } else {
            setEvents(list);
          }
          setHasMore(list.length >= 100);
        } else {
          if (!append) setEvents([]);
          setHasMore(false);
        }
      } catch {
        if (!append) setEvents([]);
        setHasMore(false);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [caseFilter, personFilter, actionFilter]
  );

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const handleLoadMore = () => {
    if (events.length === 0 || loadingMore) return;
    const oldest = events[events.length - 1];
    if (oldest?.at) {
      fetchEvents(oldest.at, true);
    }
  };

  const handleClearFilters = () => {
    setCaseFilter("");
    setPersonFilter("");
    setActionFilter("all");
  };

  const toggleDetails = (id: string) => {
    setExpandedDetails((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="space-y-4">
      {/* Filters Bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-card p-3 shadow-xs">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground mr-1">
          <Filter className="h-3.5 w-3.5" />
          <span>Filters:</span>
        </div>

        {/* Case filter */}
        <div className="relative min-w-[140px]">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            value={caseFilter}
            onChange={(e) => setCaseFilter(e.target.value)}
            placeholder="Case ID (e.g. BME-001)"
            className="h-8 w-full rounded-lg border border-border bg-background py-1 pl-8 pr-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        {/* Person filter */}
        <div className="relative min-w-[140px]">
          <input
            type="text"
            value={personFilter}
            onChange={(e) => setPersonFilter(e.target.value)}
            placeholder="Person or Actor"
            className="h-8 w-full rounded-lg border border-border bg-background px-2.5 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        {/* Action filter */}
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="h-8 rounded-lg border border-border bg-background px-2.5 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
        >
          {KNOWN_ACTIONS.map((act) => (
            <option key={act} value={act}>
              {act === "all" ? "All actions" : act}
            </option>
          ))}
        </select>

        {(caseFilter || personFilter || actionFilter !== "all") && (
          <button
            type="button"
            onClick={handleClearFilters}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition cursor-pointer"
          >
            <RotateCcw className="h-3 w-3" />
            <span>Reset</span>
          </button>
        )}

        <div className="ml-auto text-xs text-muted-foreground">
          <span>{events.length} event{events.length === 1 ? "" : "s"}</span>
        </div>
      </div>

      {/* Events Table */}
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border/60 bg-muted/30 text-[11px] font-semibold text-muted-foreground">
                <th className="py-2.5 px-3 whitespace-nowrap">Time</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Case</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Person</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Action</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Actor</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40 font-mono text-[11px]">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-muted-foreground">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin mb-1 text-primary" />
                    <span>Loading activity log…</span>
                  </td>
                </tr>
              ) : events.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-muted-foreground">
                    No activity events recorded yet.
                  </td>
                </tr>
              ) : (
                events.map((ev) => {
                  const hasDetails = ev.details && Object.keys(ev.details).length > 0;
                  const isExpanded = Boolean(expandedDetails[ev.id]);
                  const actionStyle = ACTION_COLORS[ev.action] || "bg-muted text-muted-foreground border-border";

                  return (
                    <tr key={ev.id} className="hover:bg-muted/20 transition-colors">
                      <td className="py-2 px-3 text-muted-foreground whitespace-nowrap">
                        {formatDate(ev.at)}
                      </td>
                      <td className="py-2 px-3 font-semibold whitespace-nowrap">
                        <Link
                          href={`/annotate?case=${encodeURIComponent(ev.caseId)}`}
                          className="text-primary hover:underline"
                        >
                          {ev.caseId}
                        </Link>
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap text-foreground">
                        {ev.annotator || <span className="text-muted-foreground/60">—</span>}
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-bold uppercase tracking-wider ${actionStyle}`}
                        >
                          {ev.action}
                        </span>
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap text-muted-foreground">
                        {ev.actor || "—"}
                      </td>
                      <td className="py-2 px-3 max-w-xs truncate">
                        {hasDetails ? (
                          <div className="flex flex-col">
                            <button
                              type="button"
                              onClick={() => toggleDetails(ev.id)}
                              className="inline-flex items-center gap-1 text-[10px] font-sans text-muted-foreground hover:text-foreground transition cursor-pointer"
                            >
                              <span>{isExpanded ? "Hide details" : "Show details"}</span>
                              <ChevronDown
                                className={`h-3 w-3 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                              />
                            </button>
                            {isExpanded && (
                              <pre className="mt-1 p-1.5 rounded bg-muted/60 text-[10px] whitespace-pre-wrap break-all text-muted-foreground">
                                {JSON.stringify(ev.details, null, 2)}
                              </pre>
                            )}
                          </div>
                        ) : ev.sha256 ? (
                          <span className="text-muted-foreground/70" title={ev.sha256}>
                            sha: {ev.sha256.slice(0, 10)}…
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

        {/* Load More Button */}
        {!loading && hasMore && events.length > 0 && (
          <div className="border-t border-border/60 p-3 text-center bg-card">
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-1.5 text-xs font-semibold text-foreground hover:bg-muted transition cursor-pointer disabled:opacity-50"
            >
              {loadingMore ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Loading older events…</span>
                </>
              ) : (
                <span>Load more</span>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
