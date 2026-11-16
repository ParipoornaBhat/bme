"use client";

import { Maximize2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const NL = String.fromCharCode(10);

function lineClass(line: string) {
  if (/error|traceback|failed|killed|no such file|exception/i.test(line)) return "text-red-400";
  if (/^==|submitted batch job|finished|saved|SETUP_OK/i.test(line)) return "text-emerald-400";
  if (/warning|stopping|time guard|waiting/i.test(line)) return "text-amber-300";
  return "text-zinc-200";
}

function Bar({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
      <span className="h-2.5 w-2.5 rounded-full bg-red-500/90" />
      <span className="h-2.5 w-2.5 rounded-full bg-amber-400/90" />
      <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/90" />
      <span className="ml-2 min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-400">{title}</span>
      {right}
    </div>
  );
}

function Lines({ prompt, lines, live }: { prompt?: string; lines: string[]; live?: boolean }) {
  return (
    <>
      {prompt && (
        <div className="whitespace-pre-wrap break-all">
          <span className="text-emerald-400">{prompt.split("$")[0]}$</span>
          <span className="text-zinc-100">{prompt.split("$").slice(1).join("$")}</span>
        </div>
      )}
      {lines.map((l, i) => (
        <div key={i} className={`whitespace-pre-wrap break-all ${lineClass(l)}`}>
          {l}
        </div>
      ))}
      {live && <span className="inline-block h-3 w-1.5 translate-y-0.5 animate-pulse bg-zinc-200" />}
    </>
  );
}

/** A small terminal window. Click it (or the expand icon) to open the full log. */
export function TerminalBox({
  title,
  prompt,
  lines,
  live,
  onOpen,
  heightClass = "h-44",
}: {
  title: string;
  prompt?: string;
  lines: string[];
  live?: boolean;
  onOpen?: () => void;
  heightClass?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length, lines[lines.length - 1]]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-black shadow-inner">
      <Bar
        title={title}
        right={
          onOpen && (
            <button type="button" onClick={onOpen} title="Open the full log" className="cursor-pointer text-zinc-400 hover:text-white">
              <Maximize2 className="h-3 w-3" />
            </button>
          )
        }
      />
      <div
        ref={ref}
        onClick={onOpen}
        className={`${heightClass} overflow-auto px-3 py-2 font-mono text-[10.5px] leading-[1.45] ${onOpen ? "cursor-pointer" : ""}`}
      >
        <Lines prompt={prompt} lines={lines} live={live} />
      </div>
    </div>
  );
}

export interface LogTarget {
  title: string;
  prompt?: string;
  /** Fetch from the server (H200, Kaggle, this PC). */
  platform?: string;
  targetId?: string;
  /** Or show these lines as they are (a launch that is already in memory). */
  lines?: string[];
  live?: boolean;
}

/** Full-screen terminal with the whole log. Refreshes every 5 s while open. */
export function LogModal({ target, onClose }: { target: LogTarget | null; onClose: () => void }) {
  const [fetched, setFetched] = useState<{ file?: string; lines: string[]; err?: string[] } | null>(null);
  const [error, setError] = useState("");
  const [follow, setFollow] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFetched(null);
    setError("");
    if (!target || !target.targetId) return;
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch(
          `/api/training-advanced/log?platform=${target.platform}&targetId=${encodeURIComponent(target.targetId || "")}&lines=600`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (stop) return;
        if (!res.ok) setError(json.error || "Could not read the log");
        else {
          setError("");
          setFetched({ file: json.file, lines: json.lines || [], err: json.err || [] });
        }
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : "Could not read the log");
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [target?.targetId, target?.platform, target?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!target) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [target, onClose]);

  const lines = target?.targetId ? fetched?.lines || [] : target?.lines || [];
  const errLines = (target?.targetId && fetched?.err) || [];
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length, lines[lines.length - 1], follow]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!target) return null;
  const prompt = fetched?.file ? `${(target.prompt || "h200:~/bme$").split("$")[0]}$ tail -f ${fetched.file}` : target.prompt;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-3 sm:p-6" onClick={onClose}>
      <div
        className="flex h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-zinc-700 bg-black shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Bar
          title={target.title}
          right={
            <div className="flex items-center gap-3">
              <label className="flex cursor-pointer items-center gap-1 font-mono text-[10px] text-zinc-400">
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="h-3 w-3" />
                follow
              </label>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText([...lines, ...errLines].join(NL))}
                className="cursor-pointer font-mono text-[10px] text-zinc-400 hover:text-white"
              >
                copy
              </button>
              <button type="button" onClick={onClose} title="Close (Esc)" className="cursor-pointer text-zinc-400 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>
          }
        />
        <div ref={ref} className="flex-1 overflow-auto px-4 py-3 font-mono text-[12px] leading-[1.5]">
          {target.targetId && !fetched && !error && <div className="text-zinc-500">connecting...</div>}
          {error && <div className="text-red-400">{error}</div>}
          <Lines prompt={prompt} lines={lines} live={target.live !== false} />
          {errLines.length > 0 && (
            <div className="mt-3 border-t border-zinc-800 pt-2">
              <div className="text-zinc-500"># stderr of this job (warnings land here too)</div>
              {errLines.map((l, i) => (
                <div key={i} className="whitespace-pre-wrap break-all text-amber-300">
                  {l}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
