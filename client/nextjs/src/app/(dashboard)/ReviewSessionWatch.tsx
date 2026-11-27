"use client";

import { useEffect } from "react";
import { toast } from "sonner";

const TOAST_ID = "review-session-expired";

export function ReviewSessionWatch() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const originalFetch = window.fetch;
    if ((originalFetch as any).__reviewSessionWatchWrapped) {
      return;
    }

    const wrappedFetch: typeof window.fetch = async (...args) => {
      const res = await originalFetch(...args);

      try {
        if (res.status === 401) {
          const input = args[0];
          let urlStr: string;
          if (typeof input === "string") {
            urlStr = input;
          } else if (input instanceof URL) {
            urlStr = input.href;
          } else if (input && typeof (input as Request).url === "string") {
            urlStr = (input as Request).url;
          } else {
            urlStr = String(input);
          }

          const parsed = new URL(urlStr, window.location.origin);
          if (
            parsed.origin === window.location.origin &&
            parsed.pathname.startsWith("/api/") &&
            parsed.pathname !== "/api/review/login"
          ) {
            const currentPath = window.location.pathname + window.location.search;
            const loginUrl = `/login?next=${encodeURIComponent(currentPath)}`;

            toast.error(
              "Your sign-in has expired. Your drawing is kept on this device. Sign in again to keep saving.",
              {
                id: TOAST_ID,
                duration: Infinity,
                action: {
                  label: "Sign in",
                  onClick: () => {
                    window.location.href = loginUrl;
                  },
                },
              },
            );
          }
        }
      } catch {
        // Ignore inspection errors to keep response intact
      }

      return res;
    };

    (wrappedFetch as any).__reviewSessionWatchWrapped = true;
    window.fetch = wrappedFetch;

    return () => {
      if (window.fetch === wrappedFetch) {
        window.fetch = originalFetch;
      }
    };
  }, []);

  return null;
}

export default ReviewSessionWatch;
