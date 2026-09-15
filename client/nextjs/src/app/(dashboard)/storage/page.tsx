"use client";

import { useCallback, useEffect, useState } from "react";
import { HardDrive, Loader2, RefreshCw } from "lucide-react";
import { SystemMonitor, useSystem } from "~/components/SystemMonitor";

type Item = {
  label: string; group: string; path: string; exists: boolean; bytes: number; files: number;
  reason?: string; removable?: string;
};
type Group = { name: string; bytes: number; files: number; items: Item[] };
type Payload = {
  groups: Group[]; total: number; totalFiles: number;
  disk: { total: number; free: number } | null; note: string;
};

const human = (b: number) => {
  if (!b) return "0";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1);
  return `${(b / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};

// One hue per group, so the stacked bar and the section headings agree.
const HUES: Record<string, string> = {
  "Source data": "bg-rose-500",
  "Processed — 3D": "bg-sky-500",
  "Processed — 2D": "bg-emerald-500",
  "Models & results": "bg-amber-500",
  "GPU support": "bg-teal-500",
  Code: "bg-violet-500",
};

export default function StoragePage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const sys = useSystem(4000);
  const [reverting, setReverting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/storage", { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  const revertTorch = async () => {
    if (!confirm(
      "Switch back to CPU-only PyTorch? This frees the CUDA runtime, but training returns to CPU speed — segmentation goes from minutes to over an hour. It downloads a smaller CPU wheel, so it is not instant, and you can reinstall the GPU build later.",
    )) return;
    setReverting(true);
    try {
      const r = await fetch("/api/storage", { method: "DELETE" });
      const j = await r.json();
      alert(j.note ?? j.error ?? "started");
    } finally { setReverting(false); }
  };

  useEffect(() => { load(); }, [load]);

  if (loading && !data) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Measuring…
      </div>
    );
  }
  if (!data) return null;

  const usedPct = data.disk ? ((data.disk.total - data.disk.free) / data.disk.total) * 100 : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Storage</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {human(data.total)} across {data.totalFiles.toLocaleString()} files. {data.note}
          </p>
        </div>
        <button onClick={load}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {data.disk && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="inline-flex items-center gap-2 font-medium">
              <HardDrive className="h-4 w-4" /> Disk
            </span>
            <span className="tabular-nums text-muted-foreground">
              {human(data.disk.free)} free of {human(data.disk.total)}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className={`h-full ${usedPct! > 90 ? "bg-rose-500" : "bg-primary"}`}
              style={{ width: `${usedPct}%` }} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            This project is {((data.total / data.disk.total) * 100).toFixed(1)}% of the drive.
          </p>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Where it goes
        </div>
        <div className="flex h-4 overflow-hidden rounded-full">
          {data.groups.filter((g) => g.bytes > 0).map((g) => (
            <div key={g.name} className={HUES[g.name] ?? "bg-neutral-400"}
              style={{ width: `${(g.bytes / data.total) * 100}%` }}
              title={`${g.name} — ${human(g.bytes)}`} />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
          {data.groups.filter((g) => g.bytes > 0).map((g) => (
            <span key={g.name} className="inline-flex items-center gap-1.5">
              <span className={`h-2.5 w-2.5 rounded-sm ${HUES[g.name] ?? "bg-neutral-400"}`} />
              {g.name}
              <span className="font-semibold tabular-nums">{human(g.bytes)}</span>
              <span className="text-muted-foreground">
                ({((g.bytes / data.total) * 100).toFixed(0)}%)
              </span>
            </span>
          ))}
        </div>
      </div>

      <SystemMonitor sys={sys} variant="cards" />

      <div className="space-y-4">
        {data.groups.map((g) => (
          <div key={g.name} className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex items-baseline justify-between">
              <span className="inline-flex items-center gap-2 text-sm font-semibold">
                <span className={`h-2.5 w-2.5 rounded-sm ${HUES[g.name] ?? "bg-neutral-400"}`} />
                {g.name}
              </span>
              <span className="text-sm tabular-nums text-muted-foreground">
                {human(g.bytes)} &middot; {g.files.toLocaleString()} files
              </span>
            </div>
            {g.name === "GPU support" && (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 p-2.5">
                <p className="max-w-xl text-xs text-muted-foreground">
                  Installed on purpose so training can use the GPU. Safe to remove at any time —
                  the project keeps working, it just trains on the CPU again.
                </p>
                <button onClick={revertTorch} disabled={reverting}
                  className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-destructive hover:text-destructive disabled:opacity-40">
                  {reverting ? "Starting…" : "Switch back to CPU-only"}
                </button>
              </div>
            )}
            <div className="space-y-1.5">
              {g.items.map((i) => (
                <div key={i.path} className="flex items-start gap-3 text-sm">
                  <span className={`flex-1 ${i.exists ? "" : "text-muted-foreground/50"}`}>
                    {i.label}
                    {!i.exists && <span className="ml-2 text-xs">(not installed)</span>}
                    {i.reason && (
                      <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground/70">
                        {i.reason}
                      </span>
                    )}
                  </span>
                  <div className="hidden h-1.5 w-32 overflow-hidden rounded-full bg-muted sm:block">
                    <div className={`h-full ${HUES[g.name] ?? "bg-neutral-400"}`}
                      style={{ width: `${g.bytes ? (i.bytes / g.bytes) * 100 : 0}%` }} />
                  </div>
                  <span className="w-20 text-right tabular-nums">{human(i.bytes)}</span>
                  <span className="hidden w-20 text-right tabular-nums text-muted-foreground md:inline">
                    {i.files.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Everything under <code className="rounded bg-muted px-1">BME/</code>,{" "}
        <code className="rounded bg-muted px-1">Non BME/</code> and{" "}
        <code className="rounded bg-muted px-1">data/</code> is gitignored — it never reaches
        the repository. Teammates receive it separately.
      </p>
    </div>
  );
}
