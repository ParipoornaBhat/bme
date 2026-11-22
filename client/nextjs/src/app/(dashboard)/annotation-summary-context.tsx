"use client";

import { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import type { AnnotationSummaryResponse } from "~/lib/annotation-stats";

export interface AnnotationSummaryContextType {
  summary: AnnotationSummaryResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export const AnnotationSummaryContext = createContext<AnnotationSummaryContextType | undefined>(undefined);

export function AnnotationSummaryProvider({ children }: { children: React.ReactNode }) {
  const [summary, setSummary] = useState<AnnotationSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchSummary = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/annotation-summary", { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`Summary API returned ${res.status}`);
      }
      const data: AnnotationSummaryResponse = await res.json();
      setSummary(data);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load summary");
    } finally {
      setLoading(false);
    }
  }, []);

  const triggerDebouncedRefresh = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    debounceTimer.current = setTimeout(() => {
      fetchSummary();
    }, 2500);
  }, [fetchSummary]);

  useEffect(() => {
    fetchSummary();

    const handler = () => {
      triggerDebouncedRefresh();
    };
    window.addEventListener("bme:annotations-changed", handler);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      window.removeEventListener("bme:annotations-changed", handler);
    };
  }, [fetchSummary, triggerDebouncedRefresh]);

  return (
    <AnnotationSummaryContext.Provider
      value={{
        summary,
        loading,
        error,
        refresh: fetchSummary,
      }}
    >
      {children}
    </AnnotationSummaryContext.Provider>
  );
}

export function useAnnotationSummary(): AnnotationSummaryContextType {
  const context = useContext(AnnotationSummaryContext);
  if (!context) {
    throw new Error("useAnnotationSummary must be used within an AnnotationSummaryProvider");
  }
  return context;
}
