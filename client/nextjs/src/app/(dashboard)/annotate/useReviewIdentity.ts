"use client";

import { useEffect, useState } from "react";

export interface ReviewIdentityUser {
  username: string;
  displayName: string;
  role: "reviewer" | "team";
}

export function useReviewIdentity(enabled: boolean) {
  const [user, setUser] = useState<ReviewIdentityUser | null>(null);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetch("/api/review/me", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.user) {
          setUser(data.user);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { user, loading };
}
