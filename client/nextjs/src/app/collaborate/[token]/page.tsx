"use client";

import dynamic from "next/dynamic";
import { use, useEffect, useState } from "react";
import { RefreshCw, ShieldAlert, Stethoscope } from "lucide-react";

const Painter2D = dynamic(() => import("~/app/(dashboard)/annotate/Painter2D"), {
  ssr: false,
});

/**
 * Full Radiologist Collaboration Viewer Page matching /annotate.
 * Route: /collaborate/[token]
 */
export default function CollaborateViewerPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const [mounted, setMounted] = useState<boolean>(false);
  const [userName, setUserName] = useState<string>("");
  const [nameSubmitted, setNameSubmitted] = useState<boolean>(false);
  const [inputName, setInputName] = useState<string>("");
  const [checkingSession, setCheckingSession] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Load saved radiologist name from localStorage on mount
  useEffect(() => {
    setMounted(true);
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("bme_collab_radiologist_name");
        if (saved) {
          setUserName(saved);
          setInputName(saved);
          setNameSubmitted(true);
        }
      } catch {
        // Storage might be unavailable or restricted
      }
    }
  }, []);

  // Verify session validity on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setCheckingSession(true);
        const res = await fetch(`/api/collaborate/session/${token}`, { cache: "no-store" });
        if (!res.ok) {
          if (!cancelled) {
            setSessionError(res.status === 404 ? "Collaboration session not found or expired" : "Failed to load session");
          }
        }
      } catch {
        if (!cancelled) setSessionError("Failed to connect to collaboration server");
      } finally {
        if (!cancelled) setCheckingSession(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Until mounted on client, render only a neutral loading screen (never the form on SSR)
  if (!mounted) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-slate-950 text-slate-100">
        <RefreshCw className="h-8 w-8 animate-spin text-blue-500" />
        <span className="mt-3 text-sm font-medium text-slate-400">
          Loading...
        </span>
      </div>
    );
  }

  // 1. Name Sign-In Prompt Modal (if name not provided or not in localStorage)
  if (!nameSubmitted) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-slate-950 p-6 text-slate-100">
        <div className="flex max-w-md w-full flex-col rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center shadow-2xl backdrop-blur-xl">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-500/10 border border-blue-500/20 text-blue-400">
            <Stethoscope className="h-7 w-7" />
          </div>
          <h1 className="mt-4 text-xl font-bold text-white">
            Join Radiologist Review Session
          </h1>
          <p className="mt-1.5 text-xs text-slate-400">
            Please enter your name or medical title to participate in this real-time MRI consultation.
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = inputName.trim() || `Dr. Radiologist`;
              setUserName(trimmed);
              setNameSubmitted(true);
              if (typeof window !== "undefined") {
                try {
                  localStorage.setItem("bme_collab_radiologist_name", trimmed);
                } catch {
                  // Storage might be unavailable or restricted
                }
              }
            }}
            className="mt-6 flex flex-col gap-4 text-left"
          >
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Your Name / Title
              </label>
              <input
                type="text"
                required
                autoFocus
                placeholder="e.g. Dr. Sarah Jenkins"
                value={inputName}
                onChange={(e) => setInputName(e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-slate-800 bg-slate-950 py-2.5 px-3.5 text-sm text-slate-100 placeholder-slate-600 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              className="flex items-center justify-center gap-2 rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white shadow-lg hover:bg-blue-500 transition-all cursor-pointer active:scale-95"
            >
              <Stethoscope className="h-4 w-4" />
              Join Session
            </button>
          </form>

          <span className="mt-5 text-[11px] text-slate-500">
            Zero Cloud Storage • Local Security Active
          </span>
        </div>
      </div>
    );
  }

  if (checkingSession) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-slate-950 text-slate-100">
        <RefreshCw className="h-8 w-8 animate-spin text-blue-500" />
        <span className="mt-3 text-sm font-medium text-slate-400">
          Connecting to secure collaboration session...
        </span>
      </div>
    );
  }

  if (sessionError) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-slate-950 p-6 text-slate-100">
        <div className="flex max-w-md flex-col items-center rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center shadow-2xl">
          <ShieldAlert className="h-12 w-12 text-red-500" />
          <h1 className="mt-4 text-xl font-bold text-white">Session Unavailable</h1>
          <p className="mt-2 text-sm text-slate-400">{sessionError}</p>
        </div>
      </div>
    );
  }

  return (
    <main className="flex h-screen w-screen flex-col bg-background text-foreground overflow-hidden p-3">
      <Painter2D
        collabToken={token}
        isCollaborator={true}
        collaboratorUserName={userName}
      />
    </main>
  );
}
