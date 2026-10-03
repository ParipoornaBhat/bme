import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { conflictingJob, jobPid } from "~/lib/jobs";

/**
 * AI suggestion runs for the 3D annotate page, one at a time.
 *
 * The page can be opened through the tunnel by several people at once, and the
 * one GPU is shared with training. So requests wait in a single FIFO queue
 * held by this server process, and the next one starts only when nothing else
 * is on the GPU: no other suggestion run, and no training job (lib/jobs.ts).
 * While a run is live its PID file locks training out the same way.
 *
 * A job belongs to the session that asked for it. Only that session can see
 * its status, read its labels or cancel it, so one person's suggestion never
 * reaches another person's screen. Results stay under data/suggest/ on this
 * machine and are deleted an hour after they finish.
 */

export type SuggestState = "queued" | "running" | "done" | "failed" | "cancelled";

export type SuggestJob = {
  id: string;
  owner: string;
  caseId: string;
  series: string;
  state: SuggestState;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  progress: { done: number; total: number } | null;
  error: string | null;
  /** Why a queued job has not started yet, when it is not just its place in line. */
  waiting: string | null;
};

const KEEP_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 10 * 60 * 1000;
const RETRY_MS = 5_000;

type Store = {
  jobs: Map<string, SuggestJob>;
  order: string[];
  child: ChildProcess | null;
  retry: ReturnType<typeof setTimeout> | null;
};

// Kept on globalThis so a dev-server module reload does not forget a running
// child or start a second queue beside the first.
const g = globalThis as unknown as { __bmeSuggest?: Store };
const store: Store = (g.__bmeSuggest ??= { jobs: new Map(), order: [], child: null, retry: null });

function root() {
  return path.resolve(process.cwd(), "..", "..");
}

function python() {
  const r = root();
  const local =
    process.platform === "win32"
      ? path.join(r, "ml", ".venv", "Scripts", "python.exe")
      : path.join(r, "ml", ".venv", "bin", "python");
  return fs.existsSync(local) ? local : process.platform === "win32" ? "python" : "python3";
}

const BASE = () => path.join(root(), "data", "suggest");
const PID = () => path.join(BASE(), "run.pid");
export const jobDir = (id: string) => path.join(BASE(), id);

function prune() {
  const now = Date.now();
  for (const [id, j] of store.jobs) {
    if (j.finishedAt && now - j.finishedAt > KEEP_MS) {
      store.jobs.delete(id);
      fs.rmSync(jobDir(id), { recursive: true, force: true });
    }
  }
  // Results left by an earlier server process, which this one never knew about.
  if (!fs.existsSync(BASE())) return;
  for (const name of fs.readdirSync(BASE())) {
    const dir = jobDir(name);
    if (store.jobs.has(name) || !fs.statSync(dir).isDirectory()) continue;
    if (now - fs.statSync(dir).mtimeMs > KEEP_MS) fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function queuePosition(id: string): number {
  return store.order.indexOf(id);
}

export function getJob(id: string, owner: string): SuggestJob | null {
  const j = store.jobs.get(id);
  return j && j.owner === owner ? j : null;
}

export function enqueue(owner: string, caseId: string, series: string): SuggestJob {
  prune();
  // Asking again for the same scan while a run is pending returns that run.
  for (const j of store.jobs.values()) {
    if (j.owner === owner && j.caseId === caseId && j.series === series &&
        (j.state === "queued" || j.state === "running")) return j;
  }
  const job: SuggestJob = {
    id: randomUUID(), owner, caseId, series, state: "queued",
    createdAt: Date.now(), startedAt: null, finishedAt: null,
    progress: null, error: null, waiting: null,
  };
  store.jobs.set(job.id, job);
  store.order.push(job.id);
  pump();
  return job;
}

export function cancel(id: string, owner: string): boolean {
  const j = getJob(id, owner);
  if (!j) return false;
  if (j.state === "queued") {
    store.order = store.order.filter((x) => x !== id);
    finish(j, "cancelled", null);
    pump();
  } else if (j.state === "running") {
    j.error = "cancelled";
    store.child?.kill();
  }
  return true;
}

function finish(j: SuggestJob, state: SuggestState, error: string | null) {
  j.state = state;
  j.error = error;
  j.finishedAt = Date.now();
}

function retryLater() {
  if (store.retry) return;
  store.retry = setTimeout(() => { store.retry = null; pump(); }, RETRY_MS);
}

function pump() {
  if (store.child) return;
  const next = store.order.length ? store.jobs.get(store.order[0]!) : undefined;
  if (!next) return;

  // A run left over from before a server restart still holds the GPU.
  if (jobPid("suggestion") !== null) {
    next.waiting = "Another suggestion run is still finishing.";
    retryLater();
    return;
  }
  const clash = conflictingJob("suggestion");
  if (clash) {
    next.waiting = "Waiting for training to finish: it is using the GPU.";
    retryLater();
    return;
  }

  store.order.shift();
  next.waiting = null;
  next.state = "running";
  next.startedAt = Date.now();
  const r = root();
  const out = jobDir(next.id);
  fs.mkdirSync(out, { recursive: true });

  const child = spawn(
    python(),
    ["-u", path.join(r, "ml", "scripts", "suggest_3d.py"), r, next.caseId,
     ...(next.series && next.series !== "primary" ? ["--series", next.series] : []),
     "--out", out],
    { cwd: r, stdio: ["ignore", "pipe", "pipe"] },
  );
  store.child = child;
  if (child.pid) fs.writeFileSync(PID(), String(child.pid));

  let tail = "";
  const timer = setTimeout(() => {
    next.error = "took longer than 10 minutes and was stopped";
    child.kill();
  }, TIMEOUT_MS);
  child.stdout?.on("data", (d: Buffer) => {
    for (const line of String(d).split(/\r?\n/)) {
      const m = /^progress (\d+) (\d+)$/.exec(line.trim());
      if (m) next.progress = { done: Number(m[1]), total: Number(m[2]) };
    }
  });
  child.stderr?.on("data", (d: Buffer) => { tail = (tail + String(d)).slice(-4000); });

  const done = (code: number | null, spawnError?: string) => {
    clearTimeout(timer);
    if (store.child !== child) return;
    store.child = null;
    try { fs.unlinkSync(PID()); } catch { /* gone */ }
    const ok = code === 0 && fs.existsSync(path.join(out, "result.json"));
    if (ok) finish(next, "done", null);
    else if (next.error === "cancelled") finish(next, "cancelled", null);
    else {
      const last = (spawnError ?? tail).trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ");
      finish(next, "failed", next.error ?? (last || `exited with code ${code}`));
    }
    if (!ok) fs.rmSync(out, { recursive: true, force: true });
    pump();
  };
  child.on("error", (e) => done(-1, String(e)));
  child.on("close", (code) => done(code));
}
