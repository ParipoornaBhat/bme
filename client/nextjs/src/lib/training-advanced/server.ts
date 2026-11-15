import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
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
        try {
          const res = JSON.parse(stdout.trim());
          resolve(res);
        } catch (e) {
          reject(new Error(`Failed to parse bridge output: ${stdout.slice(0, 200)}`));
        }
      }
    );
  });
}

export async function fetchAccounts(): Promise<{ cards: AccountCard[]; route: any }> {
  return runBridgeCommand(["accounts"], 30000);
}

export async function fetchRuns(): Promise<RunItem[]> {
  return runBridgeCommand(["runs"], 20000);
}

export async function fetchDatasetStatus(): Promise<{ localExport: any; targets: TargetDatasetStatus[] }> {
  return runBridgeCommand(["dataset-status"], 25000);
}

export async function syncDataset(targetId: string): Promise<{ success: boolean; refused?: boolean; message: string; taskId?: string }> {
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

  // Run in background process
  const child = spawn(process.execPath, [bridgeScript, "dataset-sync", targetId], {
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

  let scriptPath = "";
  let args: string[] = [];

  if (platform === "h200") {
    const roll = targetId.replace("h200-", "");
    scriptPath = path.join(root, "scripts", "h200-menu.js");
    if (methodId.startsWith("unet-aug-")) {
      const lvl = methodId.replace("unet-aug-", "");
      args = ["aug", lvl, "--as", roll];
    } else if (methodId === "unet-holdout") {
      args = ["holdout", "--as", roll];
    } else if (methodId === "nnunet-3d") {
      args = ["best", "3d", "--as", roll];
    } else if (methodId === "nnunet-2d") {
      args = ["best", "2d", "--as", roll];
    } else {
      args = ["aug", settings.augLevel || "med", "--as", roll];
    }
  } else if (platform === "local") {
    scriptPath = path.join(root, "scripts", "train-local.js");
    args = [methodId];
  } else if (platform === "kaggle") {
    // Handled via kaggle pipeline runner
    scriptPath = path.join(root, "scripts", "train.js");
    args = [methodId];
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
    task.message = code === 0 ? `Run ${methodId} finished successfully.` : `Run ${methodId} stopped with code ${code}`;
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
