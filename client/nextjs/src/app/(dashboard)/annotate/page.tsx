"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Boxes, CheckCircle2, Circle, Download, Layers, Search, Users } from "lucide-react";
import Viewer from "./Viewer";
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
};

export default function AnnotatePage() {
  const [tab, setTab] = useState<"2d" | "3d">("2d");
  const [cases, setCases] = useState<Case[]>([]);
  const [annotators, setAnnotators] = useState<string[]>([]);
  const [who, setWho] = useState("");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [showNames, setShowNames] = useState(false);
  const [ledger, setLedger] = useState<Record<string, { annotator: string | null; at: string; localFile: boolean }>>({});
  const [needFrom, setNeedFrom] = useState<string[]>([]);

  // Restore tab and filters from localStorage
  useEffect(() => {
    try {
      const savedTab = localStorage.getItem("bme_annotate_tab") as "2d" | "3d" | null;
      if (savedTab === "2d" || savedTab === "3d") setTab(savedTab);
      const savedSelected = localStorage.getItem("bme_annotate_3d_selected");
      if (savedSelected) setSelected(savedSelected);
      const savedWho = localStorage.getItem("bme_annotate_3d_who");
      if (savedWho) setWho(savedWho);
      const savedQ = localStorage.getItem("bme_annotate_3d_q");
      if (savedQ) setQ(savedQ);
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

  const handleQChange = (val: string) => {
    setQ(val);
    try {
      localStorage.setItem("bme_annotate_3d_q", val);
    } catch { /* ignore */ }
  };


  const load = async () => {
    const res = await fetch("/api/cases", { cache: "no-store" });
    if (!res.ok) return;
    const j = await res.json();
    setCases(j.cases);
    setAnnotators(j.annotators);
    setShowNames(j.showSourceNames);

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
          (!q || c.id.toLowerCase().includes(q.toLowerCase())),
      ),
    [cases, who, q],
  );

  const done = cases.filter((c) => c.annotated).length;

  return (
    <div className="flex flex-col gap-2 h-full">
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

      <div className="flex-1 min-h-0">
        {tab === "2d" && <Painter2D />}

      {tab === "3d" && (
        <div className="grid gap-3 lg:grid-cols-[230px_minmax(0,1fr)]">
          <div className="space-y-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  value={q}
                  onChange={(e) => handleQChange(e.target.value)}
                  placeholder="Find case"
                  className="w-full rounded-md border border-border bg-background py-2 pl-8 pr-2 text-sm"
                />
              </div>
            </div>

            <div className="relative">
              <Users className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <select
                value={who}
                onChange={(e) => handleWhoChange(e.target.value)}
                className="w-full rounded-md border border-border bg-background py-2 pl-8 pr-2 text-sm"
              >
                <option value="">Everyone&apos;s cases</option>
                {annotators.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1 overflow-y-auto rounded-lg border border-border p-1"
              style={{ maxHeight: "min(calc(100vh - 250px), 1100px)" }}>
              {visible.map((c) => (
                <button
                  key={c.id}
                  onClick={() => handleSelectCase(c.id)}
                  title={c.sourceName ?? undefined}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition ${
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
              {visible.length === 0 && (
                <p className="p-4 text-center text-xs text-muted-foreground">
                  No cases match.
                </p>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              <span className="mr-2 inline-block h-2 w-2 rounded-full bg-rose-500" />BME
              <span className="ml-3 mr-2 inline-block h-2 w-2 rounded-full bg-slate-400" />No BME
              <br />
              <strong>Iso</strong> = thin slices, best for 3D. Annotate these first.
              <br />
              <Download className="mr-1 inline h-3 w-3 text-amber-500" />
              means a teammate annotated it — ask them to send the file.
            </p>
          </div>

          <div>
            {selected ? (
              <Viewer key={selected} caseId={selected} onSaved={load} />
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
