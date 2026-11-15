"use client";

import React, { useState } from "react";
import { Check, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";

export interface ReviewItem {
  reviewer: string;
  role?: string;
  status: "reviewed" | "reviewed_with_edits" | string;
  locked: boolean;
  markedAt?: string;
}

export interface ReviewMarkButtonProps {
  caseId: string;
  myReview?: ReviewItem | null;
  onReviewChange?: (review: ReviewItem | null) => void;
  disabled?: boolean;
}

export function ReviewMarkButton({
  caseId,
  myReview,
  onReviewChange,
  disabled = false,
}: ReviewMarkButtonProps) {
  const [busy, setBusy] = useState(false);

  const isMarked = Boolean(myReview?.locked);
  const isWithEdits = myReview?.status === "reviewed_with_edits";

  const handleMark = async () => {
    if (busy || disabled || !caseId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/review/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, action: "mark" }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to mark case as reviewed");
      }
      const label = data.review?.status === "reviewed_with_edits"
        ? "Marked as reviewed with edits"
        : "Marked as reviewed";
      toast.success(label);
      onReviewChange?.(data.review ?? null);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to mark as reviewed");
    } finally {
      setBusy(false);
    }
  };

  const handleUnmark = async () => {
    if (busy || disabled || !caseId) return;
    const ok = window.confirm("Unmark this case so you can edit it?");
    if (!ok) return;

    setBusy(true);
    try {
      const res = await fetch("/api/review/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, action: "unmark" }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to unmark case");
      }
      toast.success("Case unmarked");
      onReviewChange?.(data.review ?? null);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to unmark case");
    } finally {
      setBusy(false);
    }
  };

  if (isMarked) {
    return (
      <div className="inline-flex items-center rounded-md border border-border shadow-sm overflow-hidden text-xs shrink-0">
        <button
          type="button"
          disabled={disabled}
          title={isWithEdits ? "Reviewed with edits" : "Reviewed"}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 font-semibold transition cursor-default ${
            isWithEdits
              ? "bg-amber-600 text-white"
              : "bg-emerald-600 text-white"
          }`}
        >
          <Check className="h-3.5 w-3.5" />
          <span>{isWithEdits ? "Reviewed with edits" : "Reviewed"}</span>
        </button>
        <button
          type="button"
          onClick={handleUnmark}
          disabled={busy || disabled}
          title="Unmark this case so you can edit it"
          className={`px-2 py-1 font-medium transition cursor-pointer border-l ${
            isWithEdits
              ? "bg-amber-700/80 text-white hover:bg-amber-700 border-amber-500"
              : "bg-emerald-700/80 text-white hover:bg-emerald-700 border-emerald-500"
          } disabled:opacity-50`}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Unmark"}
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={handleMark}
      disabled={busy || disabled}
      title="Mark this case as reviewed"
      className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary hover:bg-primary/20 transition cursor-pointer disabled:opacity-50 shrink-0"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
      <span>Mark as reviewed</span>
    </button>
  );
}

export default ReviewMarkButton;
