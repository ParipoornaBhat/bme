"use client";

import { useState, type ReactNode } from "react";
import { Check, Flag, Loader2, X } from "lucide-react";

export const FLAG_REASONS = [
  "Not Sure",
  "Questionable Edema",
  "Needs Expert Review",
  "Image Artifact / Quality",
] as const;

/** Flag-for-review modal shared by the 2D painter and the 3D viewer. */
export default function FlagDialog({
  title,
  subject,
  flagged,
  initialReason,
  initialNote,
  saving,
  onSave,
  onRemove,
  onClose,
}: {
  title: string;
  subject: ReactNode;
  flagged: boolean;
  initialReason?: string;
  initialNote?: string;
  saving: boolean;
  onSave: (reason: string, note: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState(initialReason || "Not Sure");
  const [note, setNote] = useState(initialNote || "");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl space-y-4">
        <div className="flex items-center justify-between border-b border-border pb-3">
          <div className="flex items-center gap-2">
            <Flag className="h-4 w-4 text-amber-500 fill-amber-500" />
            <h3 className="font-semibold text-sm">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="text-xs text-muted-foreground">{subject}</div>

        <div className="space-y-2">
          <label className="block text-xs font-semibold text-muted-foreground">Reason for flagging:</label>
          <div className="grid grid-cols-2 gap-2">
            {FLAG_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReason(r)}
                className={`rounded-md border p-2 text-left text-xs transition ${
                  reason === r
                    ? "border-amber-500 bg-amber-500/15 text-amber-500 font-semibold"
                    : "border-border hover:bg-muted text-muted-foreground"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <label className="block text-xs font-semibold text-muted-foreground">Optional Note / Observation:</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Unclear edema boundary along lateral condyle..."
            rows={3}
            className="w-full rounded-md border border-border bg-background p-2 text-xs focus:border-primary focus:outline-hidden"
          />
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-border">
          {flagged ? (
            <button
              type="button"
              onClick={onRemove}
              disabled={saving}
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/20 transition"
            >
              Remove Flag
            </button>
          ) : (
            <div />
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onSave(reason, note)}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 transition"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Save Flag
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
