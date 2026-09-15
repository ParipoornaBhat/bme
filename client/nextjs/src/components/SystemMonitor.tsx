"use client";

import { useEffect, useState } from "react";
import { Cpu, Zap } from "lucide-react";

/**
 * Live CPU and GPU load.
 *
 * Shared by the training page and the storage page so the two cannot drift.
 * Training is where it earns its place — you want to see whether the GPU is
 * actually being used, and a run that shows 0% GPU is on the CPU whatever the
 * dropdown claims.
 *
 * Two layouts, same data: "strip" is a single quiet line for a page that is
 * about something else, "cards" is the fuller panel for the storage page.
 *
 * READ ONLY. The endpoint queries nvidia-smi and nothing more; no hardware
 * setting is read-modify-written anywhere in this path.
 */

export type Sys = {
  cpu: {
    loadPercent: number | null;
    cores: number;
    model: string | null;
    tempC: number | null;
    tempNote: string;
  };
  gpu: {
    name: string;
    utilPercent: number;
    memUsedMB: number;
    memTotalMB: number;
    tempC: number;
  } | null;
  memory: { totalGB: number; freeGB: number };
  note: string;
};

/**
 * @param intervalMs poll cadence. Callers pass a shorter one while a job runs,
 *   because that is the only time second-to-second movement means anything.
 */
export function useSystem(intervalMs = 3000) {
  const [sys, setSys] = useState<Sys | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/system", { cache: "no-store" });
        if (r.ok && alive) setSys(await r.json());
      } catch {
        /* telemetry is optional — never break the page over it */
      }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs]);
  return sys;
}

function Bar({ value, className }: { value: number; className: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={`h-full rounded-full transition-all duration-700 ${className}`}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

export function SystemMonitor({
  sys,
  variant = "strip",
}: {
  sys: Sys | null;
  variant?: "strip" | "cards";
}) {
  if (!sys) return null;

  const cpu = sys.cpu.loadPercent ?? 0;
  const gpu = sys.gpu?.utilPercent ?? 0;

  if (variant === "strip") {
    return (
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border bg-card px-4 py-2.5 text-xs">
        <span className="inline-flex min-w-[9rem] items-center gap-2">
          <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">CPU</span>
          <span className="tabular-nums font-medium">{sys.cpu.loadPercent ?? "—"}%</span>
        </span>
        <span className="w-24"><Bar value={cpu} className="bg-violet-500" /></span>

        <span className="inline-flex min-w-[9rem] items-center gap-2">
          <Zap className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">GPU</span>
          {sys.gpu ? (
            <span className="tabular-nums font-medium">
              {sys.gpu.utilPercent}% · {sys.gpu.tempC}°C
            </span>
          ) : (
            <span className="text-muted-foreground">none</span>
          )}
        </span>
        <span className="w-24"><Bar value={gpu} className="bg-teal-500" /></span>

        {sys.gpu && (
          <span className="tabular-nums text-muted-foreground">
            VRAM {(sys.gpu.memUsedMB / 1024).toFixed(1)}/{(sys.gpu.memTotalMB / 1024).toFixed(1)} GB
          </span>
        )}
        <span className="tabular-nums text-muted-foreground">
          RAM {(sys.memory.totalGB - sys.memory.freeGB).toFixed(1)}/{sys.memory.totalGB} GB
        </span>
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="inline-flex items-center gap-2 text-sm font-semibold">
            <Cpu className="h-4 w-4 text-muted-foreground" /> CPU
          </span>
          <span className="text-sm tabular-nums">
            {sys.cpu.loadPercent != null ? `${sys.cpu.loadPercent}%` : "—"}
          </span>
        </div>
        <Bar value={cpu} className="bg-violet-500" />
        <p className="mt-2 text-xs text-muted-foreground">
          {sys.cpu.model ?? "CPU"} · {sys.cpu.cores} threads · RAM{" "}
          {(sys.memory.totalGB - sys.memory.freeGB).toFixed(1)}/{sys.memory.totalGB} GB
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground/70">{sys.cpu.tempNote}</p>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="inline-flex items-center gap-2 text-sm font-semibold">
            <Zap className="h-4 w-4 text-muted-foreground" /> GPU
          </span>
          <span className="text-sm tabular-nums">
            {sys.gpu ? `${sys.gpu.utilPercent}% · ${sys.gpu.tempC}°C` : "none"}
          </span>
        </div>
        <Bar value={gpu} className="bg-teal-500" />
        <p className="mt-2 text-xs text-muted-foreground">
          {sys.gpu
            ? `${sys.gpu.name} · VRAM ${(sys.gpu.memUsedMB / 1024).toFixed(1)}/${(sys.gpu.memTotalMB / 1024).toFixed(1)} GB`
            : "No NVIDIA GPU detected."}
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground/70">{sys.note}</p>
      </div>
    </div>
  );
}
