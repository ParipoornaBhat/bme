#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const isWin = process.platform === "win32";

const venvPy = isWin
  ? path.join(root, "ml", ".venv", "Scripts", "python.exe")
  : path.join(root, "ml", ".venv", "bin", "python");

if (!fs.existsSync(venvPy)) {
  console.error(`[ERROR] Python virtual environment not found at: ${venvPy}`);
  console.error("Please create the virtual environment and install requirements:");
  console.error("  python -m venv ml/.venv");
  console.error("  ml/.venv/Scripts/pip install -r ml/requirements.txt (or pip install kaggle nibabel torch)");
  process.exit(1);
}

const scriptPath = path.join(root, "ml", "scripts", "kaggle_pipeline.py");
if (!fs.existsSync(scriptPath)) {
  console.error(`[ERROR] Kaggle pipeline script not found at: ${scriptPath}`);
  process.exit(1);
}

const args = [scriptPath, "--src", root, ...process.argv.slice(2)];
const res = spawnSync(venvPy, args, {
  stdio: "inherit",
  cwd: root,
  env: {
    ...process.env,
    PYTHONUNBUFFERED: "1",
  },
});

process.exit(res.status ?? 0);
