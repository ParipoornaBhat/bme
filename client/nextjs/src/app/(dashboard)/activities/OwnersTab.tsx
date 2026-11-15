"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Loader2, Search, Check, AlertCircle, User, Filter } from "lucide-react";
import { toast } from "sonner";

interface CaseItem {
  id: string;
  cls: "bme" | "non_bme";
  assignedTo: string;
  annotatedBy: string | null;
  annotated: boolean;
  savedAt: string | null;
}

const TEAM_MEMBERS = ["Paripoorna", "Elvin", "Aditi", "Reegan"];

export function OwnersTab() {
  const [cases, setCases] = useState<CaseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [ownerFilter, setOwnerFilter] = useState<"all" | "assigned" | "unassigned">("all");

  // Track pending edits per case
  const [editingCase, setEditingCase] = useState<{ [caseId: string]: string }>({});
  const [customInput, setCustomInput] = useState<{ [caseId: string]: string }>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const fetchCases = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/cases", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setCases(data.cases ?? []);
      } else {
        setCases([]);
      }
    } catch {
      setCases([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCases();
  }, [fetchCases]);

  const handleOwnerChange = async (caseId: string, newOwner: string | null) => {
    setSavingId(caseId);
    try {
      const res = await fetch("/api/activities/owner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId,
          annotatedBy: newOwner ? newOwner.trim() : null,
        }),
      });

      if (res.ok) {
        toast.success(`Owner for ${caseId} updated to ${newOwner || "Unassigned"}`);
        setCases((prev) =>
          prev.map((c) => (c.id === caseId ? { ...c, annotatedBy: newOwner ? newOwner.trim() : null } : c))
        );
        // Clear editing state
        setEditingCase((prev) => {
          const next = { ...prev };
          delete next[caseId];
          return next;
        });
        setCustomInput((prev) => {
          const next = { ...prev };
          delete next[caseId];
          return next;
        });
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to update owner");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Update failed: ${msg}`);
    } finally {
      setSavingId(null);
    }
  };

  const filteredCases = cases.filter((c) => {
    const hasOwner = Boolean(c.annotatedBy);
    if (ownerFilter === "assigned" && !hasOwner) return false;
    if (ownerFilter === "unassigned" && hasOwner) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      const matchId = c.id.toLowerCase().includes(q);
      const matchOwner = (c.annotatedBy || "").toLowerCase().includes(q);
      return matchId || matchOwner;
    }
    return true;
  });

  const unassignedCount = cases.filter((c) => !c.annotatedBy).length;

  return (
    <div className="space-y-4">
      {/* Header and Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-card p-3 shadow-xs">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px]">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search case or owner…"
              className="h-8 w-full rounded-lg border border-border bg-background py-1 pl-8 pr-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div className="flex items-center gap-1 bg-muted/40 p-0.5 rounded-lg border border-border/40 text-xs">
            {(["all", "assigned", "unassigned"] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                onClick={() => setOwnerFilter(filter)}
                className={`rounded-md px-2.5 py-1 text-xs font-semibold capitalize transition cursor-pointer ${
                  ownerFilter === filter
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {filter}
                {filter === "unassigned" && unassignedCount > 0 && (
                  <span className="ml-1.5 rounded-full bg-amber-500/20 px-1.5 py-0.2 text-[10px] font-bold text-amber-400">
                    {unassignedCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="text-xs text-muted-foreground flex items-center gap-2">
          <span>{cases.length} total cases</span>
          {unassignedCount > 0 && (
            <span className="text-amber-400 font-semibold flex items-center gap-1">
              <AlertCircle className="h-3.5 w-3.5" />
              <span>{unassignedCount} without owner</span>
            </span>
          )}
        </div>
      </div>

      {/* Cases Table */}
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border/60 bg-muted/30 text-[11px] font-semibold text-muted-foreground">
                <th className="py-2.5 px-3 whitespace-nowrap">Case ID</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Class</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Status</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Current Annotated By</th>
                <th className="py-2.5 px-3 whitespace-nowrap text-right">Edit Owner</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {loading ? (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-muted-foreground">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin mb-1 text-primary" />
                    <span>Loading cases and ownership data…</span>
                  </td>
                </tr>
              ) : filteredCases.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-muted-foreground">
                    No cases match the filter.
                  </td>
                </tr>
              ) : (
                filteredCases.map((c) => {
                  const hasOwner = Boolean(c.annotatedBy);
                  const isSaving = savingId === c.id;
                  const selectedVal = editingCase[c.id] ?? (c.annotatedBy || "");
                  const isCustom = selectedVal === "__custom__";

                  return (
                    <tr
                      key={c.id}
                      className={`transition-colors ${
                        !hasOwner
                          ? "bg-amber-500/5 hover:bg-amber-500/10"
                          : "hover:bg-muted/20"
                      }`}
                    >
                      <td className="py-2.5 px-3 font-semibold font-mono whitespace-nowrap">
                        <Link
                          href={`/annotate?case=${encodeURIComponent(c.id)}`}
                          className="text-primary hover:underline"
                        >
                          {c.id}
                        </Link>
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                            c.cls === "bme"
                              ? "bg-rose-500/15 text-rose-400"
                              : "bg-slate-500/15 text-slate-400"
                          }`}
                        >
                          {c.cls === "bme" ? "BME" : "Non-BME"}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1 text-[11px] font-medium ${
                            c.annotated ? "text-emerald-400" : "text-muted-foreground"
                          }`}
                        >
                          {c.annotated ? "Annotated" : "Unannotated"}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        {hasOwner ? (
                          <div className="flex items-center gap-1.5">
                            <User className="h-3.5 w-3.5 text-primary" />
                            <span className="font-semibold text-foreground">{c.annotatedBy}</span>
                          </div>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-400 border border-amber-500/30">
                            <AlertCircle className="h-3 w-3" />
                            <span>No owner assigned</span>
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5 justify-end">
                          {/* Owner selection dropdown */}
                          <select
                            value={isCustom ? "__custom__" : (editingCase[c.id] !== undefined ? editingCase[c.id] : (c.annotatedBy || ""))}
                            onChange={(e) => {
                              const val = e.target.value;
                              setEditingCase((prev) => ({ ...prev, [c.id]: val }));
                              if (val !== "__custom__") {
                                handleOwnerChange(c.id, val === "" ? null : val);
                              }
                            }}
                            disabled={isSaving}
                            className="h-7 rounded-md border border-border bg-background px-2 py-0.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer disabled:opacity-50"
                          >
                            <option value="">Unassigned (none)</option>
                            {TEAM_MEMBERS.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                            {c.annotatedBy && !TEAM_MEMBERS.includes(c.annotatedBy) && (
                              <option value={c.annotatedBy}>{c.annotatedBy}</option>
                            )}
                            <option value="__custom__">Custom name…</option>
                          </select>

                          {/* Custom input if chosen */}
                          {isCustom && (
                            <div className="inline-flex items-center gap-1">
                              <input
                                type="text"
                                value={customInput[c.id] ?? ""}
                                onChange={(e) =>
                                  setCustomInput((prev) => ({ ...prev, [c.id]: e.target.value }))
                                }
                                placeholder="Enter name"
                                className="h-7 w-28 rounded-md border border-border bg-background px-2 py-0.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                              <button
                                type="button"
                                onClick={() => handleOwnerChange(c.id, customInput[c.id] || null)}
                                disabled={isSaving || !customInput[c.id]?.trim()}
                                className="h-7 rounded-md bg-primary px-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition disabled:opacity-50 cursor-pointer"
                              >
                                Save
                              </button>
                            </div>
                          )}

                          {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
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
