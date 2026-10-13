import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

/**
 * pnpm train:2d / pnpm train:3d
 * Asks which model, then trains on this PC's GPU with a 90% VRAM cap.
 * One run at a time. Metrics go to that run's metrics.json and to
 * data/training_log.csv.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const task = process.argv[2];
const python =
  process.platform === "win32"
    ? path.join(root, "ml", ".venv", "Scripts", "python.exe")
    : path.join(root, "ml", ".venv", "bin", "python");

const MODELS = {
  "2d": [
    {
      id: "unet",
      label: "2D U-Net",
      out: "results2dseg3d",
      hours: "about 1–1.5 hours",
    },
    {
      id: "attention-unet",
      label: "2D Attention U-Net",
      out: "results2dseg3d-attn",
      hours: "about 1.5–2 hours",
    },
  ],
  "3d": [
    {
      id: "unet",
      label: "3D U-Net",
      out: "results3d",
      hours: "about 15–20 minutes",
    },
    {
      id: "attention-unet",
      label: "3D Attention U-Net",
      out: "results3d-attn",
      hours: "about 20–30 minutes",
    },
  ],
};

function run(args) {
  const result = spawnSync(python, args, {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      OMP_NUM_THREADS: "1",
      MKL_NUM_THREADS: "1",
      OPENBLAS_NUM_THREADS: "1",
      NUMEXPR_NUM_THREADS: "1",
      PYTORCH_CUDA_ALLOC_CONF: "max_split_size_mb:128",
    },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (task !== "2d" && task !== "3d") {
  console.error("usage: node scripts/train-model.js 2d|3d");
  process.exit(1);
}
if (!fs.existsSync(python)) {
  console.error(`missing ${python}`);
  process.exit(1);
}

const choices = MODELS[task];
const rl = readline.createInterface({ input, output });
console.log("");
console.log(task === "2d" ? "Train 2D segmentation on this PC's GPU." : "Train 3D segmentation on this PC's GPU.");
console.log("GPU memory is capped at 90%. Run one training at a time.");
console.log("Times are for this RTX 4050, 5 folds, 40 epochs. 3D is the short run.");
console.log("");
choices.forEach((m, i) => {
  console.log(`  ${i + 1}. ${m.label}   ${m.hours}`);
  console.log(`     writes data/${m.out}/metrics.json`);
});
console.log("");
const answer = (await rl.question(`Which model? [1-${choices.length}] `)).trim();
rl.close();
const picked = choices[Number(answer) - 1];
if (!picked) {
  console.error("No model chosen.");
  process.exit(1);
}

console.log("");
console.log(`Starting ${picked.label} on CUDA. Do not start another train until this finishes.`);
console.log("");

if (task === "2d") {
  console.log("Step 1 of 3: turning saved 3D annotations into label volumes.");
  run([path.join(root, "ml", "scripts", "seg2nifti.py"), root, "--force"]);
  console.log("Step 2 of 3: cutting those volumes into axial slices.");
  run([path.join(root, "ml", "scripts", "make_2d_seg.py"), root, "--force"]);
  console.log("Step 3 of 3: training. A bar prints after every epoch.");
  run([
    path.join(root, "ml", "scripts", "train_2d_seg.py"), root,
    "--data", "seg2d3d",
    "--out", picked.out,
    "--model", picked.id,
    "--device", "cuda",
    "--batch", "4",
    "--folds", "5",
    "--epochs", "40",
  ]);
} else {
  console.log("Training on the saved volumes. A bar prints after every epoch.");
  run([
    path.join(root, "ml", "scripts", "train_3d.py"), root,
    "--model", picked.id,
    "--out", picked.out,
    "--device", "cuda",
    "--folds", "5",
    "--epochs", "40",
  ]);
}
