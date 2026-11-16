"use client";

import { AlertTriangle, HardDrive, RotateCcw, X } from "lucide-react";

export interface ConfirmationModalProps {
  open: boolean;
  title: string;
  description?: string;
  warnings?: string[];
  actionLabel?: string;
  isFresh?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmationModal({
  open,
  title,
  description,
  warnings = [],
  actionLabel = "Confirm & Proceed",
  isFresh = false,
  onConfirm,
  onCancel,
}: ConfirmationModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-xs">
      <div className="relative w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-xl space-y-4 animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-start justify-between gap-3 border-b border-border/50 pb-3">
          <div className="flex items-center gap-2.5">
            <div
              className={`rounded-xl p-2 ${
                isFresh
                  ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
                  : "bg-primary/10 text-primary border border-primary/20"
              }`}
            >
              {isFresh ? (
                <RotateCcw className="h-5 w-5" />
              ) : (
                <HardDrive className="h-5 w-5" />
              )}
            </div>
            <div>
              <h3 className="text-base font-bold text-foreground">{title}</h3>
              {description && (
                <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {warnings.length > 0 && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3.5 space-y-2">
            <div className="flex items-center gap-2 text-xs font-bold text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
              <span>Please review carefully before confirming:</span>
            </div>
            <ul className="space-y-1.5 pl-6 text-xs text-muted-foreground list-disc leading-relaxed">
              {warnings.map((w, idx) => (
                <li key={idx} className={w.includes("DELETE") || w.includes("consume") ? "font-semibold text-foreground/90" : ""}>
                  {w}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center justify-end gap-2.5 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-border bg-card px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground transition-all cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold transition-all cursor-pointer shadow-xs ${
              isFresh
                ? "bg-amber-600 hover:bg-amber-500 text-white dark:bg-amber-500 dark:hover:bg-amber-400 dark:text-zinc-950"
                : "bg-primary hover:bg-primary/90 text-primary-foreground"
            }`}
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
