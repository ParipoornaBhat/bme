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

export function getTasks(): BackgroundTask[] {
  try {
    const f = tasksFile();
    if (!fs.existsSync(f)) return [];
    return JSON.parse(fs.readFileSync(f, "utf8")) as BackgroundTask[];
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
  return runBridgeCommand(["accounts"], 30000);
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

const SYNC_LOCK_DIR = path.join(root, "data", ".cache");

function syncLockFile(targetId: string) {
  return path.join(SYNC_LOCK_DIR, `sync_${targetId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
  confirmed = false
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
      message: `H200 is connected through the Internet (jump host: pc-server-1). Syncing requires ~${formattedSize} using your internet data. Confirmation required.`,
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
    message: `Syncing training data to ${target.label}...`,
    log: [],
  };
  saveTask(task);

  const bridgeArgs = ["dataset-sync", targetId];
  if (confirmed) bridgeArgs.push("true");

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
    const lines = log.split(/\r?\n/).filter(Boolean);
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
    task.log = log.split(/\r?\n/).slice(-30);
    saveTask(task);
  });

  child.unref();

  return { success: true, message: `Sync started in background for ${target.label}`, taskId };
}

export async function cancelJob(platform: PlatformType, targetId: string, jobId?: string): Promise<{ success: boolean; message: string }> {
  return runBridgeCommand(["cancel", platform, targetId, jobId || ""], 15000);
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
    augLevel?: "low" | "med" | "max";
    epochs?: number;
    folds?: number;
    holdout?: boolean;
  };
  datasetOwnerRoll?: string;
}): Promise<{ success: boolean; message: string; taskId: string }> {
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
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });

  child.on("exit", (code) => {
    task.status = code === 0 ? "completed" : "failed";
    task.endedAt = new Date().toISOString();
    task.message = code === 0 ? `Run ${methodId} launched successfully.` : `Run ${methodId} failed with exit code ${code}`;
    task.log = log.split(/\r?\n/).slice(-30);
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

  let scriptPath = "";
  let args: string[] = [];

  if (platform === "h200") {
    const roll = targetId.replace("h200-", "");
    scriptPath = path.join(root, "scripts", "h200-menu.js");
    if (methodId?.includes("holdout")) {
      args = ["holdout", "--as", roll];
    } else if (methodId?.includes("aug")) {
      const lvl = methodId.includes("max") ? "max" : methodId.includes("low") ? "low" : "med";
      args = ["aug", lvl, "--as", roll];
    } else if (methodId?.includes("nnunet")) {
      args = ["best", methodId.includes("2d") ? "2d" : "3d", "--as", roll];
    } else {
      args = ["resume3d", "--as", roll];
    }
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
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });

  child.on("exit", (code) => {
    task.status = code === 0 ? "completed" : "failed";
    task.endedAt = new Date().toISOString();
    task.message = code === 0 ? `Resume for ${methodId} finished successfully.` : `Resume stopped with code ${code}`;
    task.log = log.split(/\r?\n/).slice(-30);
    saveTask(task);
  });

  child.unref();

  return { success: true, message: `Resume command submitted for ${methodId || targetId}`, taskId };
}
