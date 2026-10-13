import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chooseH200 } from "./h200-login.js";

/**
 * Copy the finished 2D H200 model and its metrics back to this PC.
 * Does not copy scans or annotations.
 *
 *   pnpm copy:model:remote
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let session;
const remoteRel = "data/results2dseg3d";

function run(cmd, args, { input, capture, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: root,
      env,
      stdio: [input ? "pipe" : "inherit", capture ? "pipe" : "inherit", "inherit"],
    });
    let out = "";
    if (capture) child.stdout.on("data", (chunk) => { out += chunk; });
    if (input) input.stdout.pipe(child.stdin);
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, out }));
  });
}

async function ssh(password, remoteCommand) {
  return run(
    "ssh",
    ["-o", "ConnectTimeout=30", "-o", "StrictHostKeyChecking=accept-new", session.target, remoteCommand],
    { capture: true, env: session.env },
  );
}

session = await chooseH200(root);
const password = session.password;

try {
  const check = await ssh(
    password,
    `if [ -f "$HOME/bme/${remoteRel}/metrics.json" ]; then echo READY; find "$HOME/bme/${remoteRel}/metrics.json" "$HOME/bme/${remoteRel}/checkpoints" -type f -printf '%s %p\\n' 2>/dev/null; else echo NOT_READY; fi`,
  );
  if (check.code !== 0) {
    console.error("Could not reach the college GPU. Join the college WiFi, then run this again.");
    process.exit(check.code);
  }
  if (!check.out.includes("READY") || check.out.includes("NOT_READY")) {
    console.error("2D training is not finished. metrics.json is not on the server yet.");
    console.error("On the server: squeue -u $USER && tail -n 20 ~/bme/logs/unet2d_*.out");
    process.exit(1);
  }

  const lines = check.out.split(/\r?\n/).filter((line) => /^\d+ /.test(line));
  let bytes = 0;
  console.log("On the server, copying only these files:");
  for (const line of lines) {
    const size = Number(line.split(" ")[0]);
    bytes += size;
    const name = line.slice(line.indexOf(" ") + 1).replace(/^.*\/bme\//, "");
    console.log(`  ${name}`);
  }
  console.log(`Total ${(bytes / (1024 * 1024)).toFixed(1)} MB. Scans are not copied.`);

  const remote = spawn(
    "ssh",
    ["-o", "ConnectTimeout=30", "-o", "StrictHostKeyChecking=accept-new", session.target,
      `cd "$HOME/bme" && tar -cf - ${remoteRel}/metrics.json ${remoteRel}/checkpoints`],
    { cwd: root, env: session.env, stdio: ["ignore", "pipe", "inherit"] },
  );
  const untar = spawn("tar", ["-xf", "-", "-C", root], {
    cwd: root,
    stdio: ["pipe", "inherit", "inherit"],
  });
  remote.stdout.pipe(untar.stdin);
  const code = await new Promise((resolve) => {
    let left = 2;
    const done = (c) => { if (c !== 0) resolve(c); else if (--left === 0) resolve(0); };
    remote.on("exit", done);
    untar.on("exit", done);
  });
  if (code !== 0) {
    console.error("Copy failed.");
    process.exit(code);
  }

  const metricsPath = path.join(root, remoteRel, "metrics.json");
  const python = path.join(root, "ml", ".venv", "Scripts", "python.exe");
  if (fs.existsSync(python)) {
    const logged = spawnSync(python, ["-c", `
import json, sys
from pathlib import Path
sys.path.insert(0, r"${path.join(root, "ml", "scripts")}")
from metrics_log import from_summary
base = Path(r"${root}")
m = json.loads((base / "${remoteRel}" / "metrics.json").read_text(encoding="utf-8"))
summary = m.get("summary") or {}
print(from_summary(
    base, task="2d", model=m.get("model", "unet"), device=m.get("device", "cuda"),
    out_dir="${remoteRel}", folds=m.get("folds", ""), epochs=m.get("epochs", ""),
    n_cases=m.get("n_cases", ""), summary=summary, n_slices=m.get("n_slices", ""),
    fp_key="fp_slices", fp_unit="slices"))
`], { cwd: root, encoding: "utf8" });
    if (logged.stdout) process.stdout.write(logged.stdout);
  }
  console.log(`Saved to ${remoteRel}/`);
} finally {
  session?.close();
}
