"use client";

import React from "react";
import { UserCheck } from "lucide-react";

export interface AnnotatorItem {
  name: string;
  savedAt?: string;
  isMain?: boolean;
}

export interface ReviewEditInfo {
  status: string;
  updatedAt: string;
}

interface AnnotatorPickerProps {
  annotators: AnnotatorItem[];
  hasMainAnnotation?: boolean;
  review?: ReviewEditInfo | null;
  selected: string;
  onChange: (value: string) => void;
  isReview: boolean;
  userRole?: "reviewer" | "team";
  disabled?: boolean;
}

export function AnnotatorPicker({
  annotators,
  hasMainAnnotation = false,
  review,
  selected,
  onChange,
  isReview,
  userRole = "reviewer",
  disabled = false,
}: AnnotatorPickerProps) {
  const mainAnnotator = annotators.find((a) => a.isMain);
  const otherAnnotators = annotators.filter((a) => !a.isMain);

  return (
    <div className="flex items-center gap-1.5 text-xs">
      <label
        htmlFor="annotator-picker"
        className="flex items-center gap-1 font-medium text-muted-foreground whitespace-nowrap"
      >
        <UserCheck className="h-3.5 w-3.5 text-muted-foreground" />
        <span>Annotation:</span>
      </label>
      <select
        id="annotator-picker"
        value={selected}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || (annotators.length === 0 && !review && !hasMainAnnotation)}
        className="h-7 rounded-md border border-border bg-background px-2 py-0.5 text-xs font-medium text-foreground hover:bg-muted/50 focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
      >
        {/* Main annotation */}
        {mainAnnotator ? (
          <option value={mainAnnotator.name}>
            {mainAnnotator.name} (first)
          </option>
        ) : hasMainAnnotation || annotators.length === 0 ? (
          <option value="">
            {annotators.length === 0 && !hasMainAnnotation ? "No annotations" : "Main (first)"}
          </option>
        ) : null}

        {/* Other annotators */}
        {otherAnnotators.map((a) => (
          <option key={a.name} value={a.name}>
            {a.name}
          </option>
        ))}

        {/* Review mode mine edit */}
        {isReview && review && (
          <option value="_mine">
            {userRole === "team" ? "Mine (online)" : "My review"}
          </option>
        )}
      </select>
    </div>
  );
}

export default AnnotatorPicker;
