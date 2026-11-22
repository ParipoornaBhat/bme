"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Layers,
  Loader2,
  RefreshCw,
  Search,
  Users,
  XCircle,
} from "lucide-react";
import { useAnnotationSummary } from "../../annotation-summary-context";
import type { AnnotationStatus, Case3DSummary, Case2DSummary, AnnotationVersion } from "~/lib/annotation-stats";

const STATUS_CONFIG: Record<
  AnnotationStatus,
  { label: string; badgeClass: string; icon: typeof CheckCircle2 }
> = {
  complete: {
    label: "Complete",
    badgeClass: "bg-emerald-500/15 border-emerald-500/30 text-emerald-600 dark:text-emerald-400",
    icon: CheckCircle2,
  },
  needs_bone: {
    label: "Needs Bone",
    badgeClass: "bg-amber-500/15 border-amber-500/30 text-amber-600 dark:text-amber-400",
    icon: AlertTriangle,
  },
  needs_edema: {
    label: "Needs Edema",
    badgeClass: "bg-rose-500/15 border-rose-500/30 text-rose-600 dark:text-rose-400",
    icon: AlertTriangle,
  },
  too_few_slices: {
    label: "Too Few Slices",
    badgeClass: "bg-orange-500/15 border-orange-500/30 text-orange-600 dark:text-orange-400",
    icon: AlertTriangle,
  },
  not_started: {
    label: "Not Started",
    badgeClass: "bg-muted border-border text-muted-foreground",
    icon: Clock,
  },
  unreadable: {
    label: "Unreadable",
    badgeClass: "bg-red-500/15 border-red-500/30 text-red-600 dark:text-red-400",
    icon: XCircle,
  },
};

const PENDING_GROUPS: { status: AnnotationStatus; title: string; desc: string }[] = [
  { status: "needs_bone", title: "Needs bone marrow", desc: "Bone marrow outline is missing" },
  { status: "needs_edema", title: "Needs edema", desc: "BME scan with no edema marked" },
  { status: "too_few_slices", title: "Too few slices", desc: "Marked on fewer than 5 slices overall" },
  { status: "not_started", title: "Not started", desc: "No main annotation file exists yet" },
  { status: "unreadable", title: "Unreadable", desc: "Annotation could not be parsed" },
];

export default function AnnotationSummaryPage() {
  const { summary, loading, error, refresh } = useAnnotationSummary();
  const [tab, setTab] = useState<"3d" | "2d">("3d");

  // 3D Table Controls
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [classFilter, setClassFilter] = useState<string>("all");
  const [sortField, setSortField] = useState<"id" | "status">("id");
  const [sortAsc, setSortAsc] = useState(true);

  // 2D Table Controls
  const [search2D, setSearch2D] = useState("");

  const threeD = summary?.threeD;
  const twoD = summary?.twoD;

  const ownersList = useMemo(() => {
    if (!threeD) return [];
    return Object.keys(threeD.totals.byOwner).sort();
  }, [threeD]);

  const filtered3DCases = useMemo(() => {
    if (!threeD) return [];
    const q = searchQuery.trim().toLowerCase();
    return threeD.cases
      .filter((c: Case3DSummary) => {
        if (q && !c.id.toLowerCase().includes(q)) return false;
        if (statusFilter !== "all" && c.status !== statusFilter) return false;
        if (ownerFilter !== "all" && (c.owner || "Unassigned") !== ownerFilter) return false;
        if (classFilter !== "all" && c.cls !== classFilter) return false;
        return true;
      })
      .sort((a: Case3DSummary, b: Case3DSummary) => {
        let diff = 0;
        if (sortField === "id") {
          const numA = parseInt(a.id.replace(/\D+/g, ""), 10) || 0;
          const numB = parseInt(b.id.replace(/\D+/g, ""), 10) || 0;
          diff = numA !== numB ? numA - numB : a.id.localeCompare(b.id);
        } else {
          diff = a.status.localeCompare(b.status);
        }
        return sortAsc ? diff : -diff;
      });
  }, [threeD, searchQuery, statusFilter, ownerFilter, classFilter, sortField, sortAsc]);

  const filtered2DCases = useMemo(() => {
    if (!twoD?.cases) return [];
    const q = search2D.trim().toLowerCase();
    if (!q) return twoD.cases;
    return twoD.cases.filter((c: Case2DSummary) => c.id.toLowerCase().includes(q));
  }, [twoD, search2D]);

  const formattedTime = useMemo(() => {
    if (!summary?.generatedAt) return null;
    try {
      return new Date(summary.generatedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return null;
    }
  }, [summary?.generatedAt]);

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Annotation Summary</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Dataset training readiness and pending annotation status across 3D volumes and 2D slices.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {formattedTime && (
            <span className="text-xs text-muted-foreground tabular-nums">
              Updated {formattedTime}
            </span>
          )}
          <button
            type="button"
            onClick={() => refresh()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-accent transition cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin text-primary" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-border">
        <button
          type="button"
          onClick={() => setTab("3d")}
          className={`inline-flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-semibold transition cursor-pointer ${
            tab === "3d"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Boxes className="h-4 w-4" />
          3D Volumes
          {threeD && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal">
              {threeD.totals.total}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setTab("2d")}
          className={`inline-flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-semibold transition cursor-pointer ${
            tab === "2d"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Layers className="h-4 w-4" />
          2D Slices
          {twoD?.available && twoD.totals && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal">
              {twoD.totals.totalCases}
            </span>
          )}
        </button>
      </div>

      {error && (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* 3D Tab */}
      {tab === "3d" && (
        <div className="space-y-6">
          {/* Stat Cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <div className="rounded-2xl border border-border bg-card p-4 shadow-xs">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Total Cases
              </span>
              <div className="mt-2 text-2xl font-extrabold text-foreground tabular-nums">
                {threeD ? threeD.totals.total : <Loader2 className="h-6 w-6 animate-spin text-primary" />}
              </div>
              <span className="mt-1 block text-[11px] text-muted-foreground">
                {threeD ? `${threeD.totals.byClass.bme.total} BME · ${threeD.totals.byClass.non_bme.total} Non-BME` : "—"}
              </span>
            </div>

            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4 shadow-xs">
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                Complete (Training-ready)
              </span>
              <div className="mt-2 text-2xl font-extrabold text-emerald-600 dark:text-emerald-400 tabular-nums">
                {threeD ? threeD.totals.complete : "—"}
              </div>
              <span className="mt-1 block text-[11px] text-emerald-600/80 dark:text-emerald-400/80">
                {threeD
                  ? `${Math.round((threeD.totals.complete / (threeD.totals.total || 1)) * 100)}% of dataset`
                  : "—"}
              </span>
            </div>

            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 shadow-xs">
              <span className="text-xs font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                Pending
              </span>
              <div className="mt-2 text-2xl font-extrabold text-amber-600 dark:text-amber-400 tabular-nums">
                {threeD ? threeD.totals.pending : "—"}
              </div>
              <span className="mt-1 block text-[11px] text-amber-600/80 dark:text-amber-400/80">
                Awaiting bone or edema
              </span>
            </div>

            <div className="rounded-2xl border border-border bg-card p-4 shadow-xs">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Not Started
              </span>
              <div className="mt-2 text-2xl font-extrabold text-foreground tabular-nums">
                {threeD ? (threeD.totals.byStatus.not_started || 0) : "—"}
              </div>
              <span className="mt-1 block text-[11px] text-muted-foreground">
                No main file drawn
              </span>
            </div>

            <div className="rounded-2xl border border-blue-500/30 bg-blue-500/5 p-4 shadow-xs">
              <span className="text-xs font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400">
                Complete in other version
              </span>
              <div className="mt-2 text-2xl font-extrabold text-blue-600 dark:text-blue-400 tabular-nums">
                {threeD ? threeD.totals.completeElsewhere : "—"}
              </div>
              <span className="mt-1 block text-[11px] text-blue-600/80 dark:text-blue-400/80">
                Ready in teammate copy
              </span>
            </div>
          </div>

          {/* Pending Grouped by Reason */}
          <div className="rounded-2xl border border-border bg-card p-5 space-y-4 shadow-xs">
            <div>
              <h2 className="text-base font-bold text-foreground">Pending by Reason</h2>
              <p className="text-xs text-muted-foreground">
                Cases not ready for training, grouped by missing requirement. Click any case ID chip to open it in Annotate.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {PENDING_GROUPS.map(({ status, title, desc }) => {
                const groupCases = (threeD?.cases || []).filter((c: Case3DSummary) => c.status === status);
                return (
                  <div
                    key={status}
                    className="rounded-xl border border-border/70 bg-background/50 p-3.5 space-y-2.5 flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-foreground">{title}</span>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-bold tabular-nums">
                          {groupCases.length}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground">{desc}</p>
                    </div>

                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {groupCases.length > 0 ? (
                        groupCases.map((c: Case3DSummary) => (
                          <Link
                            key={c.id}
                            href={`/annotate?case=${encodeURIComponent(c.id)}`}
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-xs font-mono font-medium hover:border-primary hover:text-primary transition-colors cursor-pointer"
                            title={c.completeElsewhere ? `Complete in ${c.completeElsewhere}'s copy` : undefined}
                          >
                            <span>{c.id}</span>
                            {c.completeElsewhere && (
                              <span className="rounded bg-blue-500/15 text-blue-600 dark:text-blue-400 px-1 text-[9px] font-sans font-semibold">
                                {c.completeElsewhere}
                              </span>
                            )}
                          </Link>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground italic">None</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Per-Owner Breakdown */}
          {threeD && ownersList.length > 0 && (
            <div className="rounded-2xl border border-border bg-card p-5 space-y-4 shadow-xs">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" />
                <h2 className="text-base font-bold text-foreground">Per-Owner Progress</h2>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {ownersList.map((owner) => {
                  const data = threeD.totals.byOwner[owner];
                  const pctComplete = data.total > 0 ? Math.round((data.complete / data.total) * 100) : 0;
                  return (
                    <div key={owner} className="rounded-xl border border-border/70 bg-background/50 p-3.5 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-bold text-foreground truncate">{owner}</span>
                        <span className="text-xs font-semibold tabular-nums text-muted-foreground">
                          {data.complete}/{data.total}
                        </span>
                      </div>

                      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full bg-emerald-500 transition-all duration-300"
                          style={{ width: `${pctComplete}%` }}
                        />
                      </div>

                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                          {data.complete} complete
                        </span>
                        <span className="text-amber-600 dark:text-amber-400 font-medium">
                          {data.pending} pending
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Table of all 3D cases */}
          <div className="rounded-2xl border border-border bg-card p-5 space-y-4 shadow-xs">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-base font-bold text-foreground">All 3D Cases</h2>
                <p className="text-xs text-muted-foreground">
                  Showing {filtered3DCases.length} of {threeD?.cases.length || 0} cases.
                </p>
              </div>

              {/* Filters */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search ID..."
                    className="h-8 w-32 sm:w-40 rounded-xl border border-border bg-background pl-8 pr-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-1 focus:ring-primary"
                  />
                </div>

                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="h-8 rounded-xl border border-border bg-background px-2.5 text-xs text-foreground focus:outline-hidden"
                >
                  <option value="all">All statuses</option>
                  <option value="complete">Complete</option>
                  <option value="needs_bone">Needs bone</option>
                  <option value="needs_edema">Needs edema</option>
                  <option value="too_few_slices">Too few slices</option>
                  <option value="not_started">Not started</option>
                  <option value="unreadable">Unreadable</option>
                </select>

                <select
                  value={ownerFilter}
                  onChange={(e) => setOwnerFilter(e.target.value)}
                  className="h-8 rounded-xl border border-border bg-background px-2.5 text-xs text-foreground focus:outline-hidden"
                >
                  <option value="all">All owners</option>
                  {ownersList.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>

                <select
                  value={classFilter}
                  onChange={(e) => setClassFilter(e.target.value)}
                  className="h-8 rounded-xl border border-border bg-background px-2.5 text-xs text-foreground focus:outline-hidden"
                >
                  <option value="all">All classes</option>
                  <option value="bme">BME</option>
                  <option value="non_bme">Non-BME</option>
                </select>
              </div>
            </div>

            <div className="overflow-x-auto rounded-xl border border-border/70">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-border bg-muted/40 font-semibold text-muted-foreground">
                  <tr>
                    <th
                      className="px-3.5 py-2.5 cursor-pointer hover:text-foreground"
                      onClick={() => {
                        if (sortField === "id") setSortAsc(!sortAsc);
                        else { setSortField("id"); setSortAsc(true); }
                      }}
                    >
                      <div className="flex items-center gap-1">
                        Case ID
                        {sortField === "id" && (sortAsc ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
                      </div>
                    </th>
                    <th className="px-3 py-2.5">Class</th>
                    <th className="px-3 py-2.5">Owner</th>
                    <th
                      className="px-3 py-2.5 cursor-pointer hover:text-foreground"
                      onClick={() => {
                        if (sortField === "status") setSortAsc(!sortAsc);
                        else { setSortField("status"); setSortAsc(true); }
                      }}
                    >
                      <div className="flex items-center gap-1">
                        Status
                        {sortField === "status" && (sortAsc ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
                      </div>
                    </th>
                    <th className="px-3 py-2.5">Main Slices (Bone/Edema/Marked)</th>
                    <th className="px-3 py-2.5">Versions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {filtered3DCases.map((c: Case3DSummary) => {
                    const cfg = STATUS_CONFIG[c.status];
                    const StatusIcon = cfg.icon;
                    const mainVersion = c.versions.find((v: AnnotationVersion) => v.isMain);

                    return (
                      <tr key={c.id} className="hover:bg-muted/20 transition-colors">
                        <td className="px-3.5 py-2.5 font-mono font-bold">
                          <Link
                            href={`/annotate?case=${encodeURIComponent(c.id)}`}
                            className="text-foreground hover:text-primary hover:underline"
                          >
                            {c.id}
                          </Link>
                        </td>
                        <td className="px-3 py-2.5">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                              c.cls === "bme"
                                ? "bg-red-500/10 text-red-600 dark:text-red-400"
                                : "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                            }`}
                          >
                            {c.cls}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground font-medium">
                          {c.owner || "—"}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span
                              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${cfg.badgeClass}`}
                            >
                              <StatusIcon className="h-3 w-3 shrink-0" />
                              {cfg.label}
                            </span>
                            {c.completeElsewhere && (
                              <span className="rounded-full bg-blue-500/15 border border-blue-500/30 text-blue-600 dark:text-blue-400 px-2 py-0.5 text-[10px] font-bold">
                                Complete in {c.completeElsewhere}
                              </span>
                            )}
                          </div>
                          {c.mainReason && c.status !== "complete" && (
                            <span className="block mt-0.5 text-[10px] text-muted-foreground italic">
                              {c.mainReason}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 font-mono tabular-nums text-muted-foreground">
                          {mainVersion ? (
                            <span>
                              <strong className="text-foreground">{mainVersion.bone}</strong> bone ·{" "}
                              <strong className="text-foreground">{mainVersion.edema}</strong> edema ·{" "}
                              <strong className="text-foreground">{mainVersion.marked}</strong> marked
                            </span>
                          ) : (
                            <span className="text-muted-foreground/60">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap gap-1">
                            {c.versions.length > 0 ? (
                              c.versions.map((v: AnnotationVersion, i: number) => (
                                <span
                                  key={i}
                                  className={`rounded border px-1.5 py-0.5 text-[10px] font-mono tabular-nums ${
                                    v.isMain
                                      ? "border-primary/40 bg-primary/10 text-primary font-bold"
                                      : "border-border bg-muted/30 text-muted-foreground"
                                  }`}
                                  title={`Saved: ${v.savedAt || "unknown"}`}
                                >
                                  {v.annotator}: {v.bone}b/{v.edema}e/{v.marked}m
                                </span>
                              ))
                            ) : (
                              <span className="text-muted-foreground/60">—</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {filtered3DCases.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                        No cases matched the selected criteria.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 2D Tab */}
      {tab === "2d" && (
        <div className="space-y-6">
          {!twoD?.available ? (
            <div className="rounded-2xl border border-border bg-card p-8 text-center space-y-2">
              <Layers className="h-8 w-8 mx-auto text-muted-foreground" />
              <h2 className="text-base font-bold text-foreground">2D Not Available on this Site</h2>
              <p className="text-xs text-muted-foreground max-w-md mx-auto">
                2D slice dataset and annotations are stored locally in data/slices2d and are not hosted in review mode.
              </p>
            </div>
          ) : (
            <>
              {/* Stat Cards */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-2xl border border-border bg-card p-4 shadow-xs">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    Total Cases
                  </span>
                  <div className="mt-2 text-2xl font-extrabold text-foreground tabular-nums">
                    {twoD.totals?.totalCases ?? 0}
                  </div>
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    2D curated cases
                  </span>
                </div>

                <div className="rounded-2xl border border-border bg-card p-4 shadow-xs">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    Total Slices
                  </span>
                  <div className="mt-2 text-2xl font-extrabold text-foreground tabular-nums">
                    {twoD.totals?.totalSlices ?? 0}
                  </div>
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    Indexed slice images
                  </span>
                </div>

                <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4 shadow-xs">
                  <span className="text-xs font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                    Slices Annotated
                  </span>
                  <div className="mt-2 text-2xl font-extrabold text-emerald-600 dark:text-emerald-400 tabular-nums">
                    {twoD.totals?.annotatedSlices ?? 0}
                  </div>
                  <span className="mt-1 block text-[11px] text-emerald-600/80 dark:text-emerald-400/80">
                    Saved mask files
                  </span>
                </div>

                <div className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-4 shadow-xs">
                  <span className="text-xs font-bold uppercase tracking-wider text-rose-600 dark:text-rose-400">
                    Slices with Edema
                  </span>
                  <div className="mt-2 text-2xl font-extrabold text-rose-600 dark:text-rose-400 tabular-nums">
                    {twoD.totals?.edemaSlices ?? 0}
                  </div>
                  <span className="mt-1 block text-[11px] text-rose-600/80 dark:text-rose-400/80">
                    Positive edema label
                  </span>
                </div>
              </div>

              {/* 2D Table */}
              <div className="rounded-2xl border border-border bg-card p-5 space-y-4 shadow-xs">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-base font-bold text-foreground">2D Cases</h2>
                    <p className="text-xs text-muted-foreground">
                      Overview of slices and masks per case.
                    </p>
                  </div>

                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <input
                      type="text"
                      value={search2D}
                      onChange={(e) => setSearch2D(e.target.value)}
                      placeholder="Search Case ID..."
                      className="h-8 w-44 rounded-xl border border-border bg-background pl-8 pr-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-1 focus:ring-primary"
                    />
                  </div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-border/70">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-border bg-muted/40 font-semibold text-muted-foreground">
                      <tr>
                        <th className="px-3.5 py-2.5">Case ID</th>
                        <th className="px-3 py-2.5">Total Slices</th>
                        <th className="px-3 py-2.5">Annotated Slices</th>
                        <th className="px-3 py-2.5">Bone Slices</th>
                        <th className="px-3 py-2.5">Edema Slices</th>
                        <th className="px-3 py-2.5">Flagged</th>
                        <th className="px-3 py-2.5">Last Saved</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                      {filtered2DCases.map((c: Case2DSummary) => (
                        <tr key={c.id} className="hover:bg-muted/20 transition-colors">
                          <td className="px-3.5 py-2.5 font-mono font-bold text-foreground">
                            {c.id}
                          </td>
                          <td className="px-3 py-2.5 font-mono tabular-nums">{c.totalSlices}</td>
                          <td className="px-3 py-2.5 font-mono tabular-nums">
                            <span className={c.slicesWithMask > 0 ? "font-bold text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>
                              {c.slicesWithMask}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 font-mono tabular-nums text-muted-foreground">
                            {c.slicesWithBone}
                          </td>
                          <td className="px-3 py-2.5 font-mono tabular-nums text-muted-foreground">
                            {c.slicesWithEdema}
                          </td>
                          <td className="px-3 py-2.5">
                            {c.flagged ? (
                              <span className="rounded-full bg-rose-500/15 border border-rose-500/30 text-rose-600 dark:text-rose-400 px-2 py-0.5 text-[10px] font-bold">
                                Flagged
                              </span>
                            ) : (
                              <span className="text-muted-foreground/60">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-muted-foreground tabular-nums">
                            {c.lastSaved ? new Date(c.lastSaved).toLocaleDateString() : "—"}
                          </td>
                        </tr>
                      ))}
                      {filtered2DCases.length === 0 && (
                        <tr>
                          <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                            No 2D cases found.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
