"use client";

import { useEffect, useMemo, useState } from "react";
import { Boxes, CheckCircle2, Circle, Layers, Search, Users } from "lucide-react";
import Viewer from "./Viewer";

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

  const load = async () => {
    const res = await fetch("/api/cases", { cache: "no-store" });
    if (!res.ok) return;
    const j = await res.json();
    setCases(j.cases);
    setAnnotators(j.annotators);
    setShowNames(j.showSourceNames);
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
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Annotate</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {done} of {cases.length} cases annotated
            {!showNames && (
              <span className="ml-2 opacity-70">
                &middot; real filenames hidden (set SHOW_SOURCE_NAMES=true in .env to reveal)
              </span>
            )}
          </p>
        </div>
      </div>

      <div className="flex gap-1 border-b border-border">
        {([
          ["2d", "2D slices", Layers],
          ["3d", "3D volume", Boxes],
        ] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition ${
              tab === id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {tab === "2d" && (
        <div className="rounded-lg border border-border border-l-4 border-l-primary bg-card p-4 text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">
            The 2D model needs no drawing.
          </span>{" "}
          Its label is the case class you already have — BME or not. Slices were extracted
          automatically from all 107 volumes. Use the <strong>Model Results</strong> page to
          see how it performs, and the review page to check individual predictions.
        </div>
      )}

      {tab === "3d" && (
        <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <div className="space-y-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Find case"
                  className="w-full rounded-md border border-border bg-background py-2 pl-8 pr-2 text-sm"
                />
              </div>
            </div>

            <div className="relative">
              <Users className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <select
                value={who}
                onChange={(e) => setWho(e.target.value)}
                className="w-full rounded-md border border-border bg-background py-2 pl-8 pr-2 text-sm"
              >
                <option value="">Everyone&apos;s cases</option>
                {annotators.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>

            <div className="max-h-[560px] space-y-1 overflow-y-auto rounded-lg border border-border p-1">
              {visible.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelected(c.id)}
                  title={c.sourceName ?? undefined}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition ${
                    selected === c.id ? "bg-accent" : "hover:bg-accent/50"
                  }`}
                >
                  {c.annotated ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                  ) : (
                    <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />
                  )}
                  <span className="flex-1 font-medium tabular-nums">{c.id}</span>
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
            </p>
          </div>

          <div>
            {selected ? (
              <Viewer key={selected} caseId={selected} />
            ) : (
              <div className="flex h-96 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                Pick a case from the list to start annotating.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
