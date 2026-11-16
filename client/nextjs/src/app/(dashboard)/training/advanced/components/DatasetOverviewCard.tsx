"use client";

import { Check, Copy, Database, FileCode, HardDrive, Layers } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export interface LocalExportData {
  cases?: number;
  files?: number;
  bytes?: number;
  hash?: string;
  bmeCases?: number;
  nonBmeCases?: number;
  bmeCount?: number;
  nonBmeCount?: number;
}

export function fmtBytes(bytes?: number | null): string {
  if (bytes == null || isNaN(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function DatasetOverviewCard({ exportData }: { exportData: LocalExportData | null }) {
  const [copied, setCopied] = useState(false);

  const copyHash = (hash: string) => {
    navigator.clipboard.writeText(hash);
    setCopied(true);
    toast.success("Export SHA-256 hash copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  const bmeCount = exportData?.bmeCount ?? exportData?.bmeCases ?? 0;
  const nonBmeCount = exportData?.nonBmeCount ?? exportData?.nonBmeCases ?? 0;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {/* 1. Local Export Fingerprint */}
      <div className="rounded-2xl border border-border bg-card p-4 shadow-xs space-y-1">
        <div className="flex items-center justify-between text-muted-foreground">
          <span className="text-[10px] uppercase font-bold tracking-wider">Local Export Version</span>
          <FileCode className="h-4 w-4 text-primary/70" />
        </div>
        <div className="flex items-center justify-between pt-1">
          <span
            className="font-mono text-xs font-semibold text-foreground truncate max-w-[190px]"
            title={exportData?.hash || "Not exported yet"}
          >
            {exportData?.hash ? exportData.hash.slice(0, 16) : "Not exported yet"}
          </span>
          {exportData?.hash && (
            <button
              type="button"
              onClick={() => copyHash(exportData.hash!)}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
              title="Copy full hash"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
      </div>

      {/* 2. Annotated Scans */}
      <div className="rounded-2xl border border-border bg-card p-4 shadow-xs space-y-1">
        <div className="flex items-center justify-between text-muted-foreground">
          <span className="text-[10px] uppercase font-bold tracking-wider">Annotated Scans</span>
          <Layers className="h-4 w-4 text-emerald-500/70" />
        </div>
        <div className="text-sm font-semibold text-foreground pt-1">
          {exportData?.cases ? (
            <div className="flex items-baseline gap-2">
              <span>{exportData.cases} total</span>
              {(bmeCount > 0 || nonBmeCount > 0) && (
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                  {bmeCount} BME + {nonBmeCount} Control
                </span>
              )}
            </div>
          ) : (
            "0 scans"
          )}
        </div>
      </div>

      {/* 3. Files in Export */}
      <div className="rounded-2xl border border-border bg-card p-4 shadow-xs space-y-1">
        <div className="flex items-center justify-between text-muted-foreground">
          <span className="text-[10px] uppercase font-bold tracking-wider">Files in Export</span>
          <Database className="h-4 w-4 text-purple-500/70" />
        </div>
        <div className="text-sm font-semibold text-foreground pt-1">
          {exportData?.files ? `${exportData.files} files (masks & volumes)` : "0 files"}
        </div>
      </div>

      {/* 4. Total Size */}
      <div className="rounded-2xl border border-border bg-card p-4 shadow-xs space-y-1">
        <div className="flex items-center justify-between text-muted-foreground">
          <span className="text-[10px] uppercase font-bold tracking-wider">Archive Size</span>
          <HardDrive className="h-4 w-4 text-sky-500/70" />
        </div>
        <div className="text-sm font-semibold text-foreground pt-1 font-mono">
          {fmtBytes(exportData?.bytes)}
        </div>
      </div>
    </div>
  );
}
