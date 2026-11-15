"use client";

import React, { useEffect, useState, useCallback, useTransition, useMemo } from "react";
import { UserCheck, Trash2, Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

export interface AnnotatorItem {
  name: string;
  savedAt?: string;
  isMain?: boolean;
  slices?: { marked: number; total: number } | null;
  identicalTo?: string | null;
}

export interface ReviewEditInfo {
  status: string;
  updatedAt: string;
}

export interface ReviewItem {
  reviewer: string;
  role?: string;
  status: "reviewed" | "reviewed_with_edits" | string;
  locked: boolean;
  markedAt?: string;
}

export interface DeletedAnnotationItem {
  name: string;
  deletedAt: string;
  reason: string | null;
  supersededBy: string | null;
}

interface AnnotatorPickerProps {
  annotators: AnnotatorItem[];
  hasMainAnnotation?: boolean;
  review?: ReviewEditInfo | null;
  reviews?: ReviewItem[];
  myReview?: ReviewItem | null;
  annotatedByAll?: string[];
  selected: string;
  onChange: (value: string) => void;
  isReview: boolean;
  userRole?: "radiologist" | "reviewer" | "team";
  disabled?: boolean;
  caseId?: string;
  annotatedBy?: string | null;
  deleted?: DeletedAnnotationItem[];
  onDeletedChange?: () => void;
}

export function getReviewerStatusText(r: { reviewer: string; status: string; locked: boolean }): string {
  if (r.locked) {
    if (r.status === "reviewed_with_edits") {
      return `Reviewed with edits by ${r.reviewer}`;
    }
    return `Reviewed by ${r.reviewer}`;
  }
  return `In review by ${r.reviewer}`;
}

function computeDice(bufA: Uint8Array, bufB: Uint8Array, labelVal: number): number {
  if (bufA.length === 0 || bufB.length === 0) return 0;
  const len = Math.min(bufA.length, bufB.length);
  let countA = 0;
  let countB = 0;
  let intersection = 0;

  for (let i = 0; i < len; i++) {
    const a = bufA[i] === labelVal;
    const b = bufB[i] === labelVal;
    if (a) countA++;
    if (b) countB++;
    if (a && b) intersection++;
  }

  const total = countA + countB;
  if (total === 0) return 1.0;
  return (2 * intersection) / total;
}

export function AnnotatorPicker({
  annotators,
  hasMainAnnotation = false,
  review,
  reviews: reviewsProp,
  myReview,
  annotatedByAll: annotatedByAllProp,
  selected,
  onChange,
  isReview,
  userRole = "reviewer",
  disabled = false,
  caseId: caseIdProp,
  annotatedBy: annotatedByProp,
  deleted: deletedProp,
  onDeletedChange,
}: AnnotatorPickerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const urlCase = searchParams.get("case") || "";
  const urlBy = searchParams.get("by") || "";
  const urlDeleted = searchParams.get("deleted");
  const urlCompare = searchParams.get("compare");

  const effectiveCaseId = caseIdProp || urlCase;

  const [annotatedBy, setAnnotatedBy] = useState<string | null>(annotatedByProp ?? null);
  const [annotatedByAllList, setAnnotatedByAllList] = useState<string[]>(annotatedByAllProp ?? []);
  const [reviewsList, setReviewsList] = useState<ReviewItem[]>(reviewsProp ?? []);
  const [deletedList, setDeletedList] = useState<DeletedAnnotationItem[]>(deletedProp ?? []);
  const [deleting, setDeleting] = useState(false);

  // Compare state
  const isCompare = urlDeleted === "1" && Boolean(urlCompare);
  const deletedTarget = urlBy || (selected.startsWith("deleted:") ? selected.replace("deleted:", "") : selected);
  const [activeToggle, setActiveToggle] = useState<"A" | "B">("A");
  const [diceScores, setDiceScores] = useState<{
    bone: number | null;
    edema: number | null;
    loading: boolean;
    error: string | null;
  }>({
    bone: null,
    edema: null,
    loading: false,
    error: null,
  });

  const loadMeta = useCallback(async (cId: string) => {
    if (!cId) return;
    try {
      const res = await fetch(`/api/annotation/${encodeURIComponent(cId)}`, { cache: "no-store" });
      if (res.ok) {
        const j = await res.json();
        setAnnotatedBy(j.annotatedBy ?? null);
        if (Array.isArray(j.annotatedByAll)) {
          setAnnotatedByAllList(j.annotatedByAll);
        }
        if (Array.isArray(j.reviews)) {
          setReviewsList(j.reviews);
        }
        setDeletedList(j.deleted ?? []);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (annotatedByProp !== undefined) {
      setAnnotatedBy(annotatedByProp);
    }
  }, [annotatedByProp]);

  useEffect(() => {
    if (annotatedByAllProp !== undefined) {
      setAnnotatedByAllList(annotatedByAllProp);
    }
  }, [annotatedByAllProp]);

  useEffect(() => {
    if (reviewsProp !== undefined) {
      setReviewsList(reviewsProp);
    }
  }, [reviewsProp]);

  useEffect(() => {
    if (deletedProp !== undefined) {
      setDeletedList(deletedProp);
    }
  }, [deletedProp]);

  useEffect(() => {
    if (effectiveCaseId && (annotatedByProp === undefined || deletedProp === undefined || reviewsProp === undefined)) {
      loadMeta(effectiveCaseId);
    }
  }, [effectiveCaseId, annotatedByProp, deletedProp, reviewsProp, loadMeta]);

  // Client-side Dice computation when compare mode is active
  useEffect(() => {
    if (!isCompare || !effectiveCaseId || !deletedTarget || !urlCompare) {
      setDiceScores({ bone: null, edema: null, loading: false, error: null });
      return;
    }

    let cancelled = false;
    setDiceScores({ bone: null, edema: null, loading: true, error: null });

    const fetchBuffers = async () => {
      try {
        const deletedUrl = `/api/annotation/${encodeURIComponent(effectiveCaseId)}/labels?by=${encodeURIComponent(deletedTarget)}&deleted=1`;
        const compareParam = urlCompare === "_main" ? "" : `?by=${encodeURIComponent(urlCompare)}`;
        const compareUrl = `/api/annotation/${encodeURIComponent(effectiveCaseId)}/labels${compareParam}`;

        const [resA, resB] = await Promise.all([
          fetch(deletedUrl, { cache: "no-store" }),
          fetch(compareUrl, { cache: "no-store" }),
        ]);

        if (!resA.ok || !resB.ok) {
          throw new Error("Could not load one or both label sets for comparison");
        }

        const [bufA, bufB] = await Promise.all([
          resA.arrayBuffer(),
          resB.arrayBuffer(),
        ]);

        if (cancelled) return;

        const u8A = new Uint8Array(bufA);
        const u8B = new Uint8Array(bufB);

        const boneDice = computeDice(u8A, u8B, 1);
        const edemaDice = computeDice(u8A, u8B, 2);

        setDiceScores({
          bone: boneDice,
          edema: edemaDice,
          loading: false,
          error: null,
        });
      } catch (err: unknown) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setDiceScores({
            bone: null,
            edema: null,
            loading: false,
            error: msg,
          });
        }
      }
    };

    fetchBuffers();

    return () => {
      cancelled = true;
    };
  }, [isCompare, effectiveCaseId, deletedTarget, urlCompare]);

  const handleDelete = async () => {
    if (!effectiveCaseId || !selected || selected.startsWith("deleted:") || selected === "_mine") {
      return;
    }

    const ok = window.confirm(
      "This moves the file to a backup folder and marks it deleted online. It can be restored from Activities."
    );
    if (!ok) return;

    setDeleting(true);
    try {
      const res = await fetch("/api/activities/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId: effectiveCaseId,
          annotator: selected,
        }),
      });

      if (res.ok) {
        toast.success(`Deleted annotation for ${selected}`);
        onChange("");
        await loadMeta(effectiveCaseId);
        onDeletedChange?.();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to delete annotation");
      }
    } catch {
      toast.error("Failed to delete annotation");
    } finally {
      setDeleting(false);
    }
  };

  const handleSelectChange = (val: string) => {
    if (val.startsWith("deleted:")) {
      const dName = val.replace("deleted:", "");
      startTransition(() => {
        router.push(`/annotate?case=${encodeURIComponent(effectiveCaseId)}&by=${encodeURIComponent(dName)}&deleted=1`);
      });
      onChange(val);
    } else {
      if (urlDeleted === "1" || urlCompare) {
        startTransition(() => {
          router.push(`/annotate?case=${encodeURIComponent(effectiveCaseId)}&by=${encodeURIComponent(val)}`);
        });
      }
      onChange(val);
    }
  };

  const handleToggleAB = (target: "A" | "B") => {
    setActiveToggle(target);
    if (!urlCompare) return;

    if (target === "A") {
      startTransition(() => {
        router.replace(
          `/annotate?case=${encodeURIComponent(effectiveCaseId)}&by=${encodeURIComponent(deletedTarget)}&deleted=1&compare=${encodeURIComponent(urlCompare)}`
        );
      });
      onChange(deletedTarget);
    } else {
      startTransition(() => {
        router.replace(
          `/annotate?case=${encodeURIComponent(effectiveCaseId)}&by=${encodeURIComponent(urlCompare)}&deleted=0&compare=${encodeURIComponent(deletedTarget)}`
        );
      });
      onChange(urlCompare);
    }
  };

  const mainAnnotator = annotators.find((a) => a.isMain);
  const otherAnnotators = annotators.filter((a) => !a.isMain);

  // Compute selected value for the <select> element
  let selectValue = selected;
  if (urlDeleted === "1" && !selected.startsWith("deleted:")) {
    selectValue = `deleted:${urlBy || selected}`;
  }

  const canDeleteSelected =
    !isReview &&
    Boolean(selected) &&
    !selected.startsWith("deleted:") &&
    selected !== "_mine" &&
    selected !== "_review";

  // First annotator and also list
  const firstAnnotator = annotatedByAllList.length > 0
    ? annotatedByAllList[0]
    : (annotatedBy || (mainAnnotator ? mainAnnotator.name : (annotators[0]?.name || null)));

  const alsoAnnotators = annotatedByAllList.length > 1
    ? annotatedByAllList.slice(1)
    : annotators
        .map((a) => a.name)
        .filter((n) => n && n !== firstAnnotator && n !== "_main");

  // All reviewers list to display (merging myReview if not yet in reviewsList)
  const displayReviews = useMemo(() => {
    const list = [...reviewsList];
    if (myReview && !list.some((r) => r.reviewer === myReview.reviewer)) {
      list.push(myReview);
    }
    return list;
  }, [reviewsList, myReview]);

  return (
    <div className="flex flex-col gap-0.5 text-xs">
      {/* Annotated by owner display */}
      <div className="text-[11px] leading-tight">
        <span className="text-muted-foreground">Annotated by </span>
        {firstAnnotator ? (
          <span className="font-semibold text-foreground">{firstAnnotator}</span>
        ) : (
          <span className="italic text-muted-foreground/70">not set</span>
        )}
        {alsoAnnotators.length > 0 && (
          <span className="text-muted-foreground font-normal"> (also: {alsoAnnotators.join(", ")})</span>
        )}
      </div>

      {/* One line per reviewer with status text */}
      {displayReviews.map((r) => (
        <div key={r.reviewer} className="text-[11px] text-muted-foreground leading-tight">
          {getReviewerStatusText(r)}
        </div>
      ))}

      {/* Main Annotation Picker Row */}
      <div className="flex items-center gap-1.5 mt-0.5">
        <label
          htmlFor="annotator-picker"
          className="flex items-center gap-1 font-medium text-muted-foreground whitespace-nowrap"
        >
          <UserCheck className="h-3.5 w-3.5 text-muted-foreground" />
          <span>Annotation:</span>
        </label>
        <select
          id="annotator-picker"
          value={selectValue}
          onChange={(e) => handleSelectChange(e.target.value)}
          disabled={disabled || (annotators.length === 0 && !review && !hasMainAnnotation && deletedList.length === 0)}
          className="h-7 rounded-md border border-border bg-background px-2 py-0.5 text-xs font-medium text-foreground hover:bg-muted/50 focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        >
          {/* Main annotation */}
          {mainAnnotator ? (
            <option
              value={mainAnnotator.name}
              title={mainAnnotator.slices ? "Axial slices with paint" : undefined}
              className={
                mainAnnotator.slices && mainAnnotator.slices.marked < mainAnnotator.slices.total
                  ? "text-amber-500"
                  : undefined
              }
              style={
                mainAnnotator.slices && mainAnnotator.slices.marked < mainAnnotator.slices.total
                  ? { color: "#f59e0b" }
                  : undefined
              }
            >
              {mainAnnotator.identicalTo
                ? `${mainAnnotator.identicalTo} (main)`
                : `${mainAnnotator.name} (first)`}
              {mainAnnotator.slices ? ` ${mainAnnotator.slices.marked}/${mainAnnotator.slices.total}` : ""}
            </option>
          ) : hasMainAnnotation || annotators.length === 0 ? (
            <option value="">
              {annotators.length === 0 && !hasMainAnnotation ? "No annotations" : "Main (first)"}
            </option>
          ) : null}

          {/* Other annotators */}
          {otherAnnotators.map((a) => {
            const isAmber = a.slices != null && a.slices.marked < a.slices.total;
            return (
              <option
                key={a.name}
                value={a.name}
                title={a.slices ? "Axial slices with paint" : undefined}
                className={isAmber ? "text-amber-500" : undefined}
                style={isAmber ? { color: "#f59e0b" } : undefined}
              >
                {a.name}
                {a.slices ? ` ${a.slices.marked}/${a.slices.total}` : ""}
              </option>
            );
          })}

          {/* Review mode mine edit */}
          {isReview && review && (
            <option value="_mine">
              {userRole === "team" ? "Mine (online)" : "My review"}
            </option>
          )}

          {/* Replaced / deleted group (local mode only) */}
          {!isReview && deletedList.length > 0 && (
            <optgroup label="Replaced / deleted" className="text-muted-foreground font-normal">
              {deletedList.map((d) => (
                <option key={`del-${d.name}`} value={`deleted:${d.name}`}>
                  {d.name} {d.reason ? `(${d.reason})` : "(deleted)"}
                </option>
              ))}
            </optgroup>
          )}
        </select>

        {/* Small Delete action in local mode */}
        {canDeleteSelected && (
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting || disabled}
            title={`Delete annotation by ${selected}`}
            className="inline-flex items-center gap-1 rounded border border-destructive/40 bg-destructive/10 px-1.5 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/20 transition cursor-pointer disabled:opacity-50"
          >
            {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
            <span className="hidden sm:inline">Delete</span>
          </button>
        )}
      </div>

      {mainAnnotator?.identicalTo && (
        <div className="text-[11px] text-muted-foreground leading-tight">
          same as {mainAnnotator.identicalTo}&apos;s copy
        </div>
      )}

      {/* Compare A/B Toggle and Dice Bar */}
      {isCompare && (
        <div className="flex flex-wrap items-center gap-2 mt-1 pt-1 border-t border-border/40 text-[11px]">
          <div className="flex items-center gap-1 font-medium text-muted-foreground">
            <span>Compare:</span>
            <div className="inline-flex rounded-md border border-border p-0.5 bg-background">
              <button
                type="button"
                onClick={() => handleToggleAB("A")}
                className={`px-2 py-0.5 rounded text-[10px] font-semibold transition cursor-pointer ${
                  activeToggle === "A"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                A: {deletedTarget} (deleted)
              </button>
              <button
                type="button"
                onClick={() => handleToggleAB("B")}
                className={`px-2 py-0.5 rounded text-[10px] font-semibold transition cursor-pointer ${
                  activeToggle === "B"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                B: {urlCompare}
              </button>
            </div>
          </div>

          {diceScores.loading ? (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Computing Dice…
            </span>
          ) : diceScores.bone !== null && diceScores.edema !== null ? (
            <div className="flex items-center gap-1.5">
              <span className="inline-flex items-center rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-400 border border-emerald-500/30">
                Bone Dice: {(diceScores.bone * 100).toFixed(1)}%
              </span>
              <span className="inline-flex items-center rounded bg-red-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-red-400 border border-red-500/30">
                Edema Dice: {(diceScores.edema * 100).toFixed(1)}%
              </span>
            </div>
          ) : diceScores.error ? (
            <span className="text-destructive text-[10px]">{diceScores.error}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default AnnotatorPicker;
