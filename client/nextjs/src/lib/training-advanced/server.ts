import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  AccountCard,
  RunItem,
  TargetDatasetStatus,
  BackgroundTask,
  PlatformType,
} from "./types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(__dirname, "../../../../..");
const bridgeScript = path.join(__dirname, "bridge.mjs");

function tasksDir(): string {
  const dir = path.join(root, "data", "advanced_training");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tasksFile(): string {
  return path.join(tasksDir(), "tasks.json");
}

// Launch, continue and setup tasks started by this app process. After a
// restart this set is empty, so their old "running" records are shown as ended.
const liveTasks = new Set<string>();

export function getTasks(): BackgroundTask[] {
  try {
    const f = tasksFile();
    if (!fs.existsSync(f)) return [];
    const tasks = JSON.parse(fs.readFileSync(f, "utf8")) as BackgroundTask[];
    // A sync marked running whose process is gone (for example after the app restarted) is shown as ended.
    return tasks.map((t) => {
      const started = Date.parse(t.startedAt || "");
      if (t.status === "running" && (t.type === "start" || t.type === "resume" || t.type === "setup") && !liveTasks.has(t.id) && !Number.isNaN(started) && Date.now() - started > 15000) {
        return {
          ...t,
          status: "failed",
          endedAt: t.endedAt || new Date().toISOString(),
          message: t.type === "setup"
            ? "The app restarted while this was running. The install continues on the server; press the button again to follow it."
            : "The app restarted before this finished. Press Refresh Status to see what the H200 says.",
        };
      }
      if (t.status === "running" && (t.type === "start" || t.type === "resume" || t.type === "setup") && !Number.isNaN(started) && Date.now() - started > 60 * 60 * 1000) {
        return { ...t, status: "failed", endedAt: t.endedAt || new Date().toISOString(), message: "Launch ended without a result (the app restarted or the process stopped)." };
      }
      if (t.status !== "running" || !t.id.startsWith("sync-") || !t.target) return t;
      if (Number.isNaN(started) || Date.now() - started < 30000) return t;
      const lock = readSyncLock(t.target);
      if (lock && lock.taskId === t.id) return t;
      return { ...t, status: "failed", endedAt: t.endedAt || new Date().toISOString(), message: "Sync ended (the process stopped or the app was restarted)." };
    });
  } catch {
    return [];
  }
}

export function saveTask(task: BackgroundTask) {
  try {
    const tasks = getTasks().filter((t) => t.id !== task.id);
    tasks.unshift(task);
    fs.writeFileSync(tasksFile(), JSON.stringify(tasks.slice(0, 50), null, 2), "utf8");
  } catch {
    // Ignore storage failure
  }
}

function runBridgeCommand(args: string[], timeoutMs = 25000): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [bridgeScript, ...args],
      {
        cwd: root,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          try {
            const errObj = JSON.parse(stderr.trim());
            return reject(new Error(errObj.error || error.message));
          } catch {
            return reject(new Error(stderr || error.message));
          }
        }
        // The bridge may print progress lines (for example the H200 route)
        // before its JSON result; the result is the last line that parses.
        const lines = stdout.trim().split(/\r?\n/);
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (!line.startsWith("{") && !line.startsWith("[")) continue;
          try {
            return resolve(JSON.parse(line));
          } catch {
            /* not this line */
          }
        }
        const start = stdout.indexOf("{");
        try {
          resolve(JSON.parse(start >= 0 ? stdout.slice(start) : stdout.trim()));
        } catch {
          reject(new Error(`Failed to parse bridge output: ${stdout.slice(0, 200)}`));
        }
      }
    );
  });
}

export async function fetchAccountsQuick(): Promise<{ cards: AccountCard[]; quick: boolean }> {
  return runBridgeCommand(["accounts-quick"], 8000);
}

export async function fetchAccounts(): Promise<{ cards: AccountCard[]; route: any }> {
  return runBridgeCommand(["accounts"], 60000);
}

export async function fetchJobLog(targetId: string, lines: number): Promise<{ file?: string; lines: string[]; err?: string[] }> {
  return runBridgeCommand(["log", targetId, String(lines)], 40000);
}

export async function fetchRuns(): Promise<RunItem[]> {
  return runBridgeCommand(["runs"], 20000);
}

export async function fetchDatasetStatus(): Promise<{
  localExport: any;
  targets: TargetDatasetStatus[];
  kaggleDatasets?: import("./types").KaggleDatasetOption[];
}> {
  return runBridgeCommand(["dataset-status"], 25000);
}

export async function planDatasetSync(targetId: string): Promise<{
  success: boolean;
  targetId: string;
  files: number;
  bytes: number;
  same: number;
}> {
  return runBridgeCommand(["dataset-plan", targetId], 180000);
}

const SYNC_LOCK_DIR = path.join(root, "data", ".cache");

function syncLockFile(targetId: string) {
  return path.join(SYNC_LOCK_DIR, `sync_${targetId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // On Windows a live process can refuse the probe with EPERM; that means it is running.
    return e?.code === "EPERM";
  }
}

function readSyncLock(targetId: string): { taskId: string; pid: number; startedAt: string } | null {
  try {
    const lock = JSON.parse(fs.readFileSync(syncLockFile(targetId), "utf8"));
    if (lock.pid && pidAlive(lock.pid)) return lock;
    fs.rmSync(syncLockFile(targetId), { force: true });
    return null;
  } catch {
    return null;
  }
}

function writeSyncLock(targetId: string, taskId: string, pid: number | undefined) {
  if (!pid) return;
  fs.mkdirSync(SYNC_LOCK_DIR, { recursive: true });
  fs.writeFileSync(syncLockFile(targetId), JSON.stringify({ taskId, pid, startedAt: new Date().toISOString() }));
}

function clearSyncLock(targetId: string) {
  fs.rmSync(syncLockFile(targetId), { force: true });
}

const cancelledSyncs = new Set<string>();

export function deleteTask(id: string): boolean {
  const all = getTasks();
  const found = all.find((t) => t.id === id);
  if (!found || found.status === "running") return false;
  try {
    fs.writeFileSync(tasksFile(), JSON.stringify(all.filter((t) => t.id !== id), null, 2), "utf8");
  } catch {
    return false;
  }
  return true;
}

export function clearTasks(): void {
  try {
    fs.writeFileSync(tasksFile(), JSON.stringify([], null, 2), "utf8");
  } catch {}
}

export function cancelSync(targetId: string): { success: boolean; message: string } {
  const lock = readSyncLock(targetId);
  if (!lock) return { success: false, message: "No sync is running for this account." };
  cancelledSyncs.add(lock.taskId);
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(lock.pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-lock.pid, "SIGTERM");
    }
  } catch {
    /* already gone */
  }
  clearSyncLock(targetId);
  return { success: true, message: "Sync stopped." };
}

export async function syncDataset(
  targetId: string,
  confirmed = false,
  isFresh = false
): Promise<{
  success: boolean;
  refused?: boolean;
  requiresConfirmation?: boolean;
  isRemoteRoute?: boolean;
  bytesToSync?: number;
  formattedSize?: string;
  message: string;
  taskId?: string;
}> {
  // First check if target is locked by a running job
  const st = await fetchDatasetStatus();
  const target = st.targets.find((t) => t.targetId === targetId);
  if (!target) {
    return { success: false, message: `Unknown target ${targetId}` };
  }
  if (target.runningJobBlocking) {
    return {
      success: false,
      refused: true,
      message: `Cannot sync: ${target.runningJobBlocking.method} is currently running on ${target.label}. Updating dataset while training would corrupt the run state.`,
    };
  }

  // Pre-check for Internet route on H200 or Kaggle without confirmation:
  if (target.platform === "h200" && target.isRemoteRoute && !confirmed) {
    const formattedSize = target.bytesToSync ? `${(target.bytesToSync / (1024 * 1024)).toFixed(1)} MB` : "estimated size";
    return {
      success: false,
      requiresConfirmation: true,
      isRemoteRoute: true,
      bytesToSync: target.bytesToSync,
      formattedSize,
      message: `H200 is connected through the Internet (jump host: pc-server-1). ${isFresh ? "Fresh upload" : "Syncing"} requires ~${formattedSize} using your internet data. Confirmation required.`,
    };
  }

  if (target.platform === "kaggle" && !confirmed) {
    const formattedSize = target.bytesToSync ? `${(target.bytesToSync / (1024 * 1024)).toFixed(1)} MB` : "dataset";
    return {
      success: false,
      requiresConfirmation: true,
      bytesToSync: target.bytesToSync,
      formattedSize,
      message: `Uploading dataset to Kaggle requires ~${formattedSize} over your internet connection. Confirmation required.`,
    };
  }

  const running = readSyncLock(targetId);
  if (running) {
    return {
      success: false,
      refused: true,
      message: `A sync for ${target.label} is already running (started ${new Date(running.startedAt).toLocaleTimeString()}). Its progress shows in History.`,
    };
  }

  const taskId = `sync-${Date.now()}`;
  const task: BackgroundTask = {
    id: taskId,
    type: "sync",
    target: targetId,
    status: "running",
    startedAt: new Date().toISOString(),
    message: `${isFresh ? "Fresh uploading" : "Syncing"} training data to ${target.label}...`,
    log: [],
  };
  saveTask(task);

  const bridgeArgs = ["dataset-sync", targetId, confirmed ? "true" : "false", isFresh ? "fresh" : "normal"];

  // Run in background process
  const child = spawn(process.execPath, [bridgeScript, ...bridgeArgs], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  writeSyncLock(targetId, taskId, child.pid);

  let log = "";
  let lastSave = 0;
  const onChunk = (chunk: Buffer) => {
    log += chunk.toString();
    // Progress lines end with a carriage return, so split on both kinds of break.
    const lines = log.split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean);
    task.log = lines.slice(-30);
    task.message = lines.length ? lines[lines.length - 1].slice(0, 200) : task.message;
    if (Date.now() - lastSave > 1000) {
      lastSave = Date.now();
      saveTask(task);
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  child.on("exit", (code) => {
    liveTasks.delete(taskId);
    clearSyncLock(targetId);
    if (cancelledSyncs.has(taskId)) {
      task.status = "cancelled";
      task.endedAt = new Date().toISOString();
      task.message = "Sync stopped by user.";
      saveTask(task);
      return;
    }
    task.status = code === 0 ? "completed" : "failed";
    task.endedAt = new Date().toISOString();
    task.message = code === 0 ? "Dataset sync completed successfully." : `Dataset sync failed with exit code ${code}`;
    task.log = log.split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean).slice(-30);
    saveTask(task);
  });

  child.unref();

  return { success: true, message: `Sync started in background for ${target.label}`, taskId };
}

export async function cancelJob(platform: PlatformType, targetId: string, jobId?: string): Promise<{ success: boolean; message: string }> {
  return runBridgeCommand(["cancel", platform, targetId, jobId || ""], 15000);
}

export function setupEnv(targetId: string): { success: boolean; message: string; taskId: string } {
  const busy = getTasks().find((t) => t.status === "running" && t.target === targetId && t.type !== "sync");
  if (busy) return { success: false, message: `Something is still running for ${targetId}. Wait for it to finish.`, taskId: busy.id };
  const taskId = `setup-${Date.now()}`;
  const task: BackgroundTask = {
    id: taskId,
    type: "setup",
    target: targetId,
    status: "running",
    startedAt: new Date().toISOString(),
    message: `Installing the Python environment on ${targetId}...`,
    log: [],
  };
  saveTask(task);
  liveTasks.add(taskId);
  const child = spawn(process.execPath, [bridgeScript, "setup", targetId], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  let lastSave = 0;
  const toLines = (text: string) => text.split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean);
  const onOutput = (chunk: Buffer) => {
    log += chunk.toString();
    const lines = toLines(log);
    task.log = lines.slice(-200);
    task.message = lines[lines.length - 1] || task.message;
    if (Date.now() - lastSave > 1000) {
      lastSave = Date.now();
      saveTask(task);
    }
  };
  child.stdout?.on("data", onOutput);
  child.stderr?.on("data", onOutput);
  child.on("exit", (code) => {
    liveTasks.delete(taskId);
    task.status = code === 0 ? "completed" : "failed";
    task.endedAt = new Date().toISOString();
    task.message = code === 0 ? "Python environment is ready." : "Setup did not finish. See the log.";
    task.log = toLines(log).slice(-200);
    saveTask(task);
  });
  child.unref();
  return { success: true, message: `Setup started for ${targetId}`, taskId };
}

export async function startJob({
  platform,
  targetId,
  methodId,
  settings,
  datasetOwnerRoll,
}: {
  platform: PlatformType;
  targetId: string;
  methodId: string;
  settings: {
    augLevel?: "none" | "low" | "med" | "max";
    epochs?: number;
    folds?: number;
    holdout?: boolean;
  };
  datasetOwnerRoll?: string;
}): Promise<{ success: boolean; message: string; taskId: string }> {
  const busy = getTasks().find((t) => t.type === "start" && t.status === "running" && t.target === targetId);
  if (busy) {
    return { success: false, message: `A launch on ${targetId} is still running. Wait for it to finish.`, taskId: busy.id };
  }
  const taskId = `start-${Date.now()}`;
  const task: BackgroundTask = {
    id: taskId,
    type: "start",
    target: targetId,
    status: "running",
    startedAt: new Date().toISOString(),
    message: `Starting ${methodId} on ${targetId}...`,
    log: [],
  };
  saveTask(task);
  liveTasks.add(taskId);

  const child = spawn(
    process.execPath,
    [bridgeScript, "start", platform, targetId, methodId, JSON.stringify({ ...settings, datasetOwnerRoll })],
    {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let log = "";
  let lastSave = 0;
  const onOutput = (chunk: Buffer) => {
    log += chunk.toString();
    const lines = log.split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean);
    task.log = lines.slice(-200);
    task.message = lines[lines.length - 1] || task.message;
    if (Date.now() - lastSave > 1000) {
      lastSave = Date.now();
      saveTask(task);
    }
  };
  child.stdout?.on("data", onOutput);
  child.stderr?.on("data", onOutput);

  child.on("exit", (code) => {
    liveTasks.delete(taskId);
    task.status = code === 0 ? "completed" : "failed";
    task.endedAt = new Date().toISOString();
    task.message = code === 0 ? `Run ${methodId} submitted.` : `Run ${methodId} was not started (exit code ${code}).`;
    task.log = log.split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean).slice(-200);
    saveTask(task);
  });

  child.unref();

  return { success: true, message: `Launch initiated for ${methodId} on ${targetId}`, taskId };
}

export async function resumeJob({
  platform,
  targetId,
  methodId,
}: {
  platform: PlatformType;
  targetId: string;
  methodId?: string;
}): Promise<{ success: boolean; message: string; taskId: string }> {
  const taskId = `resume-${Date.now()}`;
  const task: BackgroundTask = {
    id: taskId,
    type: "resume",
    target: targetId,
    status: "running",
    startedAt: new Date().toISOString(),
    message: `Resuming ${methodId || "job"} on ${targetId}...`,
    log: [],
  };
  saveTask(task);
  liveTasks.add(taskId);

  let scriptPath = "";
  let args: string[] = [];

  if (platform === "h200") {
    const roll = targetId.replace("h200-", "");
    scriptPath = path.join(root, "scripts", "h200-menu.js");
    const m = methodId || "";
    if (m.startsWith("selftest-")) args = ["selftest", m.replace("selftest-", "")];
    else if (m.startsWith("nnunet-")) args = ["best", m.includes("2d") ? "2d" : "3d", ...(m.endsWith("-noaug") ? ["noaug"] : [])];
    else if (m.startsWith("unet-holdout")) args = ["holdout", m.replace("unet-holdout", "").replace("-", "") || "med"];
    else if (m === "unet-noaug") args = ["plain"];
    else if (m.startsWith("unet-aug-")) args = ["aug", m.replace("unet-aug-", "")];
    else args = ["resume3d"];
    args.push("--as", roll);
  } else if (platform === "local") {
    scriptPath = path.join(root, "scripts", "train-local.js");
    args = [methodId || "unet-aug-med"];
  } else if (platform === "kaggle") {
    scriptPath = path.join(root, "scripts", "train.js");
    args = [methodId || "k-unet3d"];
  }

  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: root,
    detached: true,
    windowsHide: true,
    env: { ...process.env, BME_NO_PROMPT: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  let lastSave = 0;
  const toLines = (text: string) => text.split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean);
  const onOutput = (chunk: Buffer) => {
    log += chunk.toString();
    const lines = toLines(log);
    task.log = lines.slice(-200);
    task.message = lines[lines.length - 1] || task.message;
    if (Date.now() - lastSave > 1000) {
      lastSave = Date.now();
      saveTask(task);
    }
  };
  child.stdout?.on("data", onOutput);
  child.stderr?.on("data", onOutput);

  child.on("exit", (code) => {
    liveTasks.delete(taskId);
    const submitted = platform !== "h200" || /Submitted batch job/.test(log);
    task.status = code === 0 && submitted ? "completed" : "failed";
    task.endedAt = new Date().toISOString();
    task.message = task.status === "completed" ? `Next part of ${methodId} submitted.` : `The next part of ${methodId} was not started.`;
    task.log = toLines(log).slice(-200);
    saveTask(task);
  });

  child.unref();

  return { success: true, message: `Resume command submitted for ${methodId || targetId}`, taskId };
}
