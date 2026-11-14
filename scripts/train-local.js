import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { python, requirePython, root, runNode, yes } from "./lib/accounts.js";
import { describeDevice, detectDevice, deviceEnv } from "./lib/device.js";
import { METHODS, PLATFORM } from "./lib/methods.js";
import { c, choose, info, next, ok, section, stop, title, warn } from "./lib/ui.js";

/**
 * pnpm train:local            menu
 * pnpm train:local <id>       one method on this PC, e.g. unet-aug-med
 *
 * Uses this PC's GPU: NVIDIA through CUDA, Apple through MPS. Without either it
 * says so and asks before a (much slower) CPU run. A smaller setup than the H200
 * (width 16, patch 128x128x16, batch 2) so a 6 GB laptop GPU fits; results go to
 * data/results3d-<id>-pc and are not compared with the H200 numbers.
 */

const HOLDOUT = "data/splits/holdout_80_20.json";

function deviceCheck() {
  section("This PC");
  const d = detectDevice();
  if (d.kind === "cuda") ok(`Training on ${describeDevice(d)}. GPU memory is capped at 90%.`);
  if (d.kind === "mps") {
    ok(`Training on the ${describeDevice(d)}.`);
    warn("A few 3D steps fall back to the CPU on Apple GPUs, so it is slower than CUDA.");
  }
  return d;
}

async function cpuOk(d) {
  if (d.kind !== "cpu") return true;
  warn(`No usable GPU: ${d.why || "PyTorch found none"}.`);
  info("On the CPU a 3D run is 20-40x slower: many hours for one fold.");
  info("Faster options: pnpm train (choose the H200 or Kaggle).");
  if (d.why?.includes("CPU-only build")) {
    info("Have an NVIDIA GPU? Reinstall PyTorch with CUDA in ml/.venv (see docs/COMMANDS.md, section 9).");
  }
  return yes("Train on the CPU anyway?");
}

function state(out) {
  const dir = path.join(root, "data", out);
  if (!fs.existsSync(dir)) return "none";
  if (fs.existsSync(path.join(dir, "metrics.json"))) return "done";
  return fs.readdirSync(dir).length ? "started" : "none";
}

async function method(m) {
  title(`This PC: ${m.n}. ${m.label}`, PLATFORM.local.limit);
  const d = deviceCheck();
  if (!(await cpuOk(d))) return;
  if (m.local.holdout && !fs.existsSync(path.join(root, HOLDOUT))) {
    stop("There is no fixed 80/20 split yet.", "Make it first (it shows which scans go where): pnpm train:split");
  }
  const out = `results3d-${m.id}-pc`;
  const st = state(out);
  if (st === "done") {
    ok(`Already finished: data/${out}/metrics.json`);
    next("pnpm runs:local   the scores of runs on this PC");
    return;
  }
  section("Run");
  info(`${st === "started" ? "Continuing" : "Starting"} ${m.id} -> data/${out}`);
  info(`Model ${m.local.arch}, augmentation ${m.local.aug}${m.local.holdout ? ", fixed 80/20 split" : ", 5 folds x 40 epochs"}.`);
  info("Laptop setup (width 16, patch 128x128x16, batch 2): not comparable with the H200 runs.");
  info("Ctrl+C stops it safely; choosing it again continues from the last saved epoch.");
  if (!(await yes("Start?"))) return;
  const args = [
    path.join(root, "ml", "scripts", "train_3d.py"), root,
    "--model", "unet", "--model-arch", m.local.arch, "--device", d.kind,
    "--out", out, "--folds", "5", "--epochs", "40",
    "--spacing", "1.0,1.0,3.0", "--aniso", "--width", "16", "--patch", "128,128,16",
    "--patches-per-case", "16", "--batch", "2", "--resample", "--aug-level", m.local.aug,
    "--sampling-mix", "lesion=0.33,bone=0.33,random=0.34", "--allow-case-level-folds",
    "--checkpoint-every-epoch", "--cosine",
  ];
  if (d.kind === "cuda") args.push("--amp");
  if (m.local.holdout) args.push("--holdout", HOLDOUT);
  if (st === "started") args.push("--resume");
  const r = spawnSync(python, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...deviceEnv(d) } });
  if (r.status !== 0) {
    stop("Training stopped before the end.", "Choose the same method again to continue from the last saved epoch.");
  }
  ok(`Finished: data/${out}/metrics.json`);
}

async function quick(task) {
  const d = deviceCheck();
  if (!(await cpuOk(d))) return;
  process.exit(runNode("train-model.js", [task], { BME_DEVICE: d.kind }));
}

const want = process.argv[2];
requirePython();
if (want) {
  const m = METHODS.find((x) => x.id === want || String(x.n) === want);
  if (!m) stop(`No method ${want}.`, `One of: ${METHODS.filter((x) => x.local).map((x) => x.id).join(", ")}`);
  if (!m.local) stop(`${m.id} cannot train on this PC.`, m.needsMib ? "nnU-Net needs about 9 GB of GPU memory: use the H200 (pnpm train)." : "");
  await method(m);
} else {
  title("Train on this PC", "Uses this PC's GPU (NVIDIA CUDA or Apple MPS); asks before a CPU run.");
  const items = [
    { group: "Quick models (the app's current 2D and 3D models)", label: "2D U-Net or 2D Attention U-Net", about: "builds the axial slices, then trains; about 1-2 h on a laptop GPU", run: () => quick("2d") },
    { label: "3D U-Net or 3D Attention U-Net", about: "the small 3D model; about 15-30 min on a laptop GPU", run: () => quick("3d") },
    ...METHODS.filter((m) => m.local).map((m, i) => ({
      group: i === 0 ? "Comparison methods, laptop setup (results go to data/results3d-<id>-pc)" : undefined,
      label: `${m.n}. ${m.label}`,
      about: m.tests,
      run: () => method(m),
    })),
  ];
  const pick = await choose("", items, { prompt: "Which one" });
  if (pick) await pick.run();
}
