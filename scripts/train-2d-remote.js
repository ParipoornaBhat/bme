import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chooseH200 } from "./h200-login.js";

/**
 * Copy what the H200 job needs, if it is not already on the server, then submit
 * 2D training as its own Slurm job. Nothing is trained on this PC. A 3D job
 * already running is not killed: Slurm is asked for a separate 1g.18gb GPU.
 *
 *   pnpm remote:2d:remote
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let session;

function run(cmd, args, { input, capture, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: root,
      env,
      stdio: [input ? "pipe" : "inherit", capture ? "pipe" : "inherit", "inherit"],
    });
    let out = "";
    if (capture) child.stdout.on("data", (chunk) => { out += chunk; });
    if (input) {
      input.stdout.pipe(child.stdin);
      input.on("exit", (code) => {
        if (code !== 0) child.kill();
      });
    }
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, out }));
  });
}

async function ssh(password, remoteCommand, input) {
  return run("ssh", ["-o", "ConnectTimeout=30", "-o", "StrictHostKeyChecking=accept-new", session.target, remoteCommand], {
    input,
    capture: !input,
    env: session.env,
  });
}

const ROOTS = ["ml/scripts", "ml/slurm", "data/annotations", "data/nifti"];

function localFiles() {
  const files = new Map();
  const skipName = (name) => /deid|rename_map|^name\.json$/i.test(name);
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (skipName(entry.name)) continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = `${rel}/${entry.name}`.replaceAll("\\", "/");
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) files.set(childRel, fs.statSync(childAbs).size);
    }
  };
  for (const rel of ROOTS) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      if (rel.startsWith("data/")) {
        console.error(`${rel} is not on this PC, so there is nothing to train on.`);
        process.exit(1);
      }
      continue;
    }
    walk(abs, rel);
  }
  return files;
}

async function remoteFiles(password) {
  const result = await ssh(
    password,
    `cd "$HOME/bme" 2>/dev/null || exit 0; find ml/scripts ml/slurm data/annotations data/nifti -type f 2>/dev/null || true`,
  );
  if (result.code !== 0) {
    console.error("Could not reach the college GPU. Join the college WiFi, then run this again.");
    process.exit(result.code);
  }
  const have = new Set();
  for (const line of String(result.out || "").split(/\r?\n/)) {
    const name = line.trim().replaceAll("\\", "/");
    if (name) have.add(name);
  }
  return have;
}

function fmt(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function uploadMissing(password, missing, totalBytes) {
  const listFile = path.join(os.tmpdir(), "bme-h200-upload.txt");
  fs.writeFileSync(listFile, missing.join("\n"), "utf8");
  console.log(`Copying ${missing.length} missing files (${fmt(totalBytes)}) ...`);
  const tar = spawn("tar", ["-cf", "-", "-C", root, "-T", listFile], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let sent = 0;
  let shown = 0;
  tar.stdout.on("data", (chunk) => {
    sent += chunk.length;
    if (sent - shown < 8 * 1024 * 1024) return;
    shown = sent;
    const pct = totalBytes ? Math.min(99, Math.round((100 * sent) / totalBytes)) : 0;
    process.stdout.write(`\r  ${fmt(sent)} sent${totalBytes ? `, about ${pct}%` : ""}   `);
  });
  const result = await ssh(password, `mkdir -p "$HOME/bme" && tar -xf - -C "$HOME/bme"`, tar);
  process.stdout.write(`\r  ${fmt(sent)} sent\n`);
  try { fs.unlinkSync(listFile); } catch { /* already gone */ }
  if (result.code !== 0) {
    console.error("Copy of the missing files failed.");
    process.exit(result.code);
  }
}

session = await chooseH200(root);
const password = session.password;

try {
  console.log("Nothing is built or trained on this PC. A running 3D job is not stopped.");
  const ready = await ssh(password, `mkdir -p "$HOME/bme/logs" "$HOME/bme/ml" "$HOME/bme/data"`);
  if (ready.code !== 0) process.exit(ready.code);

  const codeItems = ["ml/scripts", "ml/slurm"].map((rel) => ({
    rel,
    ...folderStats(rel),
    pending: true,
    why: "scripts are refreshed every time",
  }));
  const dataItems = [];
  for (const rel of ["data/annotations", "data/nifti"]) {
    if (!fs.existsSync(path.join(root, rel))) {
      console.error(`${rel} is not on this PC, so there is nothing to train on.`);
      process.exit(1);
    }
    const stats = folderStats(rel);
    const remoteFiles = await remoteFileCount(password, rel);
    dataItems.push({
      rel,
      ...stats,
      pending: remoteFiles === 0,
      why: remoteFiles === 0 ? "missing on the server" : `already there (${remoteFiles} files), not replaced`,
    });
  }

  const plan = [...codeItems, ...dataItems];
  console.log("");
  console.log("Copy plan:");
  for (const item of plan) {
    const state = item.pending ? "PENDING" : "SKIP";
    console.log(`  ${state.padEnd(8)} ${item.rel.padEnd(20)} ${fmt(item.bytes).padStart(10)}  ${item.files} files  ${item.why}`);
  }
  const pendingBytes = plan.filter((item) => item.pending).reduce((sum, item) => sum + item.bytes, 0);
  const skipBytes = plan.filter((item) => !item.pending).reduce((sum, item) => sum + item.bytes, 0);
  console.log(`Pending ${fmt(pendingBytes)}. Already on the server ${fmt(skipBytes)}.`);
  console.log("");

  for (const item of plan) {
    if (!item.pending) continue;
    await upload(password, item.rel, item.bytes);
  }

  const submit = await ssh(
    password,
    `cd "$HOME/bme" && sed -i 's/\\r$//' ml/slurm/train_2d_seg.sbatch && sbatch ml/slurm/train_2d_seg.sbatch && echo "Submitted. 3D training was not stopped."`,
  );
  process.stdout.write(submit.out || "");
  if (submit.code !== 0) process.exit(submit.code);
  console.log("Watch it on the server with: squeue -u $USER");
  console.log("Log: ~/bme/logs/unet2d_<jobid>.out");
} finally {
  session?.close();
}
