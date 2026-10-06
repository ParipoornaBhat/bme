"use client";

import { useEffect, useMemo, useState } from "react";
import { Boxes, CheckCircle2, ChevronLeft, ChevronRight, Circle, Download, Flag, Layers, Search, Users } from "lucide-react";
import type { FlagRecord } from "~/lib/flag-store";
import { useFocusMode } from "~/lib/useFocusMode";
import Viewer, { type ViewerView } from "./Viewer";
import Painter2D from "./Painter2D";

type Case = {
  id: string;
  cls: "bme" | "non_bme";
  assignedTo: string;
  isOverlap: boolean;
  isotropic: boolean;
  slices: number;
  thickness: number;
  plane: string;
  hasT1: boolean;
  annotated: boolean;
  savedAt: string | null;
  sourceName: string | null;
  flag: FlagRecord | null;
};

const FILTERS = ["all", "bme", "non_bme", "annotated", "unannotated", "flagged"] as const;
type Filter = (typeof FILTERS)[number];

function matchesFilter(c: Case, f: Filter) {
  if (f === "bme") return c.cls === "bme";
  if (f === "non_bme") return c.cls === "non_bme";
  if (f === "annotated") return c.annotated;
  if (f === "unannotated") return !c.annotated;
  if (f === "flagged") return Boolean(c.flag);
  return true;
}

export default function AnnotatePage() {
  const [tab, setTab] = useState<"2d" | "3d">("2d");
  const [cases, setCases] = useState<Case[]>([]);
  const [annotators, setAnnotators] = useState<string[]>([]);
  const [who, setWho] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [showNames, setShowNames] = useState(false);
  const [ledger, setLedger] = useState<Record<string, { annotator: string | null; at: string; localFile: boolean }>>({});
  const [needFrom, setNeedFrom] = useState<string[]>([]);
  const [caseListCollapsed, setCaseListCollapsed] = useState(false);
  const [casesState, setCasesState] = useState<"loading" | "ready" | "error">("loading");
  // Held here, not in the viewer: the viewer is remounted on every case switch.
  const focus = useFocusMode<ViewerView>();

  // Restore tab and filters from localStorage
  useEffect(() => {
    try {
      const savedTab = localStorage.getItem("bme_annotate_tab") as "2d" | "3d" | null;
      if (savedTab === "2d" || savedTab === "3d") setTab(savedTab);
      const savedWho = localStorage.getItem("bme_annotate_3d_who");
      if (savedWho) setWho(savedWho);
      const savedQ = localStorage.getItem("bme_annotate_3d_q");
      if (savedQ) setQ(savedQ);
      const savedFilter = localStorage.getItem("bme_annotate_3d_filter") as Filter | null;
      if (savedFilter && FILTERS.includes(savedFilter)) setFilter(savedFilter);
    } catch { /* ignore */ }
  }, []);

  const handleTabChange = (newTab: "2d" | "3d") => {
    setTab(newTab);
    try {
      localStorage.setItem("bme_annotate_tab", newTab);
    } catch { /* ignore */ }
  };

  const handleSelectCase = (caseId: string) => {
    setSelected(caseId);
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      setCaseListCollapsed(true);
    }
    try {
      localStorage.setItem("bme_annotate_3d_selected", caseId);
    } catch { /* ignore */ }
  };

  const handleWhoChange = (val: string) => {
    setWho(val);
    try {
      localStorage.setItem("bme_annotate_3d_who", val);
    } catch { /* ignore */ }
  };

  const handleFilterChange = (val: Filter) => {
    setFilter(val);
    try {
      localStorage.setItem("bme_annotate_3d_filter", val);
    } catch { /* ignore */ }
  };

  const handleQChange = (val: string) => {
    setQ(val);
    try {
      localStorage.setItem("bme_annotate_3d_q", val);
    } catch { /* ignore */ }
  };


  const load = async () => {
    try {
    const res = await fetch("/api/cases", { cache: "no-store" });
    if (!res.ok) throw new Error("cases unavailable");
    const j = await res.json();
    const list: Case[] = j.cases ?? [];
    setCases(list);
    setAnnotators(j.annotators ?? []);
    setShowNames(Boolean(j.showSourceNames));
    setSelected((prev) => {
      const want = prev ?? localStorage.getItem("bme_annotate_3d_selected");
      return want && list.some((c) => c.id === want) ? want : null;
    });
    setCasesState("ready");
    } catch {
      setCases([]);
      setSelected(null);
      setCasesState("error");
      return;
    }

    // The shared ledger says who annotated what. A case recorded here but
    // missing locally is one a teammate holds — that is the cue to ask them
    // for the file, since the imaging moves by hand, not through this app.
    try {
      const lg = await fetch("/api/annotation-log", { cache: "no-store" });
      if (lg.ok) {
        const d = await lg.json();
        const map: Record<string, { annotator: string | null; at: string; localFile: boolean }> = {};
        for (const e of d.entries ?? []) map[e.caseId] = e;
        setLedger(map);
        setNeedFrom(d.needFromTeammate ?? []);
      }
    } catch { /* ledger optional */ }
  };

  useEffect(() => { load(); }, []);

  const visible = useMemo(
    () =>
      cases.filter(
        (c) =>
          (!who || c.assignedTo === who || c.assignedTo === "ALL") &&
          matchesFilter(c, filter) &&
          (!q ||
            c.id.toLowerCase().includes(q.toLowerCase()) ||
            (c.flag?.reason ?? "").toLowerCase().includes(q.toLowerCase()) ||
            (c.flag?.note ?? "").toLowerCase().includes(q.toLowerCase())),
      ),
    [cases, who, q, filter],
  );

  const done = cases.filter((c) => c.annotated).length;

  // Previous and next follow the list as filtered on screen.
  const at = visible.findIndex((c) => c.id === selected);
  const prevCase = at > 0 ? visible[at - 1].id : null;
  const nextCase = at < visible.length - 1 ? visible[at + 1].id : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-1">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-bold tracking-tight">Annotate</h1>
          <div className="flex gap-1">
            {([
              ["2d", "2D slices", Layers],
              ["3d", "3D volume", Boxes],
            ] as const).map(([id, label, Icon]) => (
              <button
                key={id}
                onClick={() => handleTabChange(id)}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition ${
                  tab === id
                    ? "bg-primary text-primary-foreground font-semibold"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="text-xs text-muted-foreground flex items-center gap-2">
          <span>{done} of {cases.length} annotated</span>
          {needFrom.length > 0 && (
            <span className="text-amber-500 font-medium">
              &middot; {needFrom.length} on teammate machine
            </span>
          )}
        </div>
      </div>

      {needFrom.length > 0 && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-400">
          <strong>Note:</strong> {needFrom.length} annotation files are held by teammates.
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "2d" && <Painter2D />}

      {/* Mobile/Tablet Case List Toggle for 3D */}
      {tab === "3d" && (
        <div className="flex lg:hidden items-center justify-between gap-2 bg-card/90 backdrop-blur p-2 rounded-lg border border-border mb-2">
          <button
            type="button"
            onClick={() => setCaseListCollapsed(!caseListCollapsed)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted transition shadow-sm cursor-pointer"
          >
            <Boxes className="h-3.5 w-3.5 text-primary" />
            <span>{caseListCollapsed ? `Show Cases (${cases.length})` : "Hide Cases"}</span>
            {caseListCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
          </button>
          {selected && (
            <span className="text-xs font-mono font-medium text-muted-foreground truncate max-w-[160px]">
              Case: <strong className="text-foreground">{selected}</strong>
            </span>
          )}
        </div>
      )}

      {tab === "3d" && (
        // On a wide screen the case list and the viewer share the window
        // height, and only the list scrolls, so the toolbar never leaves view.
        <div className={`grid gap-3 lg:min-h-0 lg:flex-1 lg:grid-rows-[minmax(0,1fr)] ${caseListCollapsed ? "grid-cols-1" : "lg:grid-cols-[230px_minmax(0,1fr)]"}`}>
          {!caseListCollapsed && (
            <div className="flex min-h-0 flex-col gap-3 rounded-lg border border-border bg-card p-2.5">
              <div className="flex items-center gap-1.5">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <input
                    value={q}
                    onChange={(e) => handleQChange(e.target.value)}
                    placeholder="Find case"
                    className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-sm"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setCaseListCollapsed(true)}
                  title="Collapse case list"
                  className="p-1.5 rounded border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted transition cursor-pointer"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
              </div>

              <div className="relative">
                <Users className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <select
                  value={who}
                  onChange={(e) => handleWhoChange(e.target.value)}
                  className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-sm"
                >
                  <option value="">Everyone&apos;s cases</option>
                  {annotators.map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </div>

              <div className="flex flex-wrap gap-1 text-xs">
                {FILTERS.map((f) => {
                  const count = f === "all" ? undefined : cases.filter((c) => matchesFilter(c, f)).length;
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => handleFilterChange(f)}
                      className={`inline-flex items-center gap-1 rounded px-2 py-1 transition cursor-pointer ${
                        filter === f
                          ? f === "flagged"
                            ? "bg-amber-500 text-white font-medium"
                            : "bg-primary text-primary-foreground font-medium"
                          : f === "flagged" && (count ?? 0) > 0
                          ? "bg-amber-500/15 text-amber-500 hover:bg-amber-500/25"
                          : "bg-muted text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {f === "flagged" && <Flag className="h-3 w-3 fill-current" />}
                      <span>{f.replace("_", " ")}</span>
                      {count !== undefined && <span className="opacity-70 text-[10px]">({count})</span>}
                    </button>
                  );
                })}
              </div>

              <div className="max-h-[min(calc(100vh_-_250px),1100px)] space-y-1 overflow-y-auto rounded-lg border border-border p-1 lg:max-h-none lg:min-h-0 lg:flex-1">
                {visible.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => handleSelectCase(c.id)}
                    title={c.sourceName ?? undefined}
                    className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition cursor-pointer ${
                      selected === c.id ? "bg-accent" : "hover:bg-accent/50"
                    }`}
                  >
                    {c.annotated ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                    ) : ledger[c.id] ? (
                      <Download className="h-4 w-4 shrink-0 text-amber-500" />
                    ) : (
                      <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />
                    )}
                    <span className="flex-1">
                      <span className="font-medium tabular-nums">{c.id}</span>
                      {ledger[c.id]?.annotator && (
                        <span className="block text-[10px] leading-tight text-muted-foreground">
                          {c.annotated ? "by " : "ask "}{ledger[c.id].annotator}
                        </span>
                      )}
                    </span>
                    {c.flag && (
                      <span title={`Flagged: ${c.flag.reason || "Not Sure"}`}>
                        <Flag className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />
                      </span>
                    )}
                    {c.isotropic && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Iso
                      </span>
                    )}
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        c.cls === "bme" ? "bg-rose-500" : "bg-slate-400"
                      }`}
                      title={c.cls === "bme" ? "BME positive" : "No BME"}
                    />
                  </button>
                ))}
                {casesState === "loading" && (
                  <p className="p-4 text-center text-xs text-muted-foreground">Loading cases…</p>
                )}
                {casesState === "error" && (
                  <p className="p-4 text-center text-xs text-destructive">Could not load the case list.</p>
                )}
                {casesState === "ready" && cases.length === 0 && (
                  <p className="p-4 text-center text-xs text-muted-foreground">
                    No 3D cases yet. Add folders under data/newbme and run pnpm data:process.
                  </p>
                )}
                {casesState === "ready" && cases.length > 0 && visible.length === 0 && (
                  <p className="p-4 text-center text-xs text-muted-foreground">
                    No cases match.
                  </p>
                )}
              </div>

              <p className="shrink-0 text-[11px] leading-snug text-muted-foreground">
                <span className="mr-2 inline-block h-2 w-2 rounded-full bg-rose-500" />BME
                <span className="ml-3 mr-2 inline-block h-2 w-2 rounded-full bg-slate-400" />No BME
                <br />
                <strong>Iso</strong> = thin slices, best for 3D. Annotate these first.
                <br />
                <Download className="mr-1 inline h-3 w-3 text-amber-500" />
                means a teammate annotated it — ask them to send the file.
              </p>
            </div>
          )}

          <div className="flex min-h-0 flex-col">
            {caseListCollapsed && (
              <div className="mb-2 hidden lg:flex items-center">
                <button
                  type="button"
                  onClick={() => setCaseListCollapsed(false)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-semibold text-foreground hover:bg-muted transition shadow-sm cursor-pointer"
                >
                  <Boxes className="h-3.5 w-3.5 text-primary" />
                  <span>Show Cases ({cases.length})</span>
                </button>
              </div>
            )}
            {casesState === "loading" ? (
              <div className="flex h-96 items-center justify-center gap-2 rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                Loading cases…
              </div>
            ) : casesState === "error" ? (
              <div className="flex h-96 items-center justify-center rounded-lg border border-dashed border-border px-6 text-center text-sm text-muted-foreground">
                Could not load the case list. Refresh the page once the server is up.
              </div>
            ) : cases.length === 0 ? (
              <div className="flex h-96 items-center justify-center rounded-lg border border-dashed border-border px-6 text-center text-sm text-muted-foreground">
                No 3D cases yet. Put one folder per patient in data/newbme, then run pnpm data:process.
              </div>
            ) : selected ? (
              <Viewer
                key={selected}
                caseId={selected}
                onSaved={load}
                savedOnDisk={cases.find((c) => c.id === selected)?.annotated ?? false}
                flag={cases.find((c) => c.id === selected)?.flag ?? null}
                focus={focus}
                onPrevCase={prevCase ? () => handleSelectCase(prevCase) : undefined}
                onNextCase={nextCase ? () => handleSelectCase(nextCase) : undefined}
              />
            ) : (
              <div className="flex h-96 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                Pick a case from the list to start annotating.
              </div>
            )}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
