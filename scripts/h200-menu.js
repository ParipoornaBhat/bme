import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ask, chooseH200 } from "./h200-login.js";
import { findAccount, listAccounts } from "./lib/accounts.js";

/**
 * pnpm h200                     menu
 * pnpm h200 <op>                one op directly (see OPS below)
 * pnpm h200 <op> --as <roll>    on that account, e.g. --as 149; one terminal per account
 * pnpm h200 aug max --as 149    one augmentation level (low, med, max)
 * pnpm h200 best 2d --as 293    the nnU-Net pipeline, 2d or 3d part
 * pnpm h200 holdout --as 124    one round on the fixed 80/20 split (pnpm train:split)
 * --as also takes a name from .env (NNM23CS<roll>_NAME), e.g. --as reegan
 *
 * Route: direct on the college network; otherwise through pc-server-1, and
 * then every copy shows its size and asks first (it uses internet data).
 *
 * Nothing trains on this PC. Training runs as a Slurm job on the 1g.18gb slice;
 * the login node only copies files and calls sbatch (H200 rules: no compute there).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE = "$HOME/bme";
// Where ml/slurm/train_3d.sbatch writes. Bump it when the 3D setup changes, so
// a new run never mixes folds with an old one.
const R3D = "data/results3d-h200-v2";
// H200 rules: 50 GB per student. Refuse to start a job above this.
const DISK_LIMIT_GB = 45;
// Every result folder a job here can write, for status and download.
const RESULTS = [
  "results3d-holdout",
  "results3d-aug-low",
  "results3d-aug-med",
  "results3d-aug-max",
  "results3d-h200-v2",
  "results3d-h200-plain",
  "results-nnunet-3d_fullres",
  "results-nnunet-2d",
  "results3d-h200",
  "results2dseg3d",
];
const NNUNET = "nnunetv2==2.5.1";
let session;

function run(cmd, args, { stdin, capture, interactive } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      windowsHide: true,
      cwd: root,
      env: session.env,
      stdio: [stdin ? "pipe" : interactive ? "inherit" : "ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    let out = "";
    if (capture) child.stdout.on("data", (chunk) => { out += chunk; });
    if (stdin) stdin.stdout.pipe(child.stdin);
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, out }));
  });
}

function ssh(command, opts = {}) {
  const tty = opts.interactive ? ["-t"] : [];
  return run(
    session.sshBin || "ssh",
    [...tty, ...session.sshOpts, "-o", "ConnectTimeout=30", "-o", "StrictHostKeyChecking=accept-new", session.target, command],
    { capture: !opts.stdin && !opts.interactive, ...opts },
  );
}

function fmt(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const HOLDOUT = "data/splits/holdout_80_20.json";

/** Outside the college network a copy uses mobile or home data: say how much, and ask. */
async function internetOk(bytes, what) {
  if (process.argv.includes("--yes") || process.argv.includes("-y") || process.argv.includes("--confirm-internet")) {
    return true;
  }
  console.log(`You are outside the college network: this ${what} goes through pc-server-1`);
  console.log(`and uses about ${fmt(bytes)} of your internet data. On college WiFi it would not ask.`);
  return (await ask("Go ahead? [y/N] ")).toLowerCase() === "y";
}

function md5(file) {
  return crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex");
}

function fail(msg, code = 1) {
  console.error(msg);
  session?.close();
  process.exit(code);
}

// ---------- what training needs --------------------------------------------

function walk(rel, out) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== "__pycache__") walk(r, out);
    } else if (e.isFile()) out.push(r);
  }
}

/**
 * Code, the worklist, and for every case with a saved 3D annotation: its main
 * .seg.nrrd, series.json and the one volume that annotation was painted on.
 * Per-annotator copies, other series, raw DICOM and the name map stay here.
 */
function neededFiles() {
  const files = [];
  walk("ml/scripts", files);
  walk("ml/slurm", files);
  if (fs.existsSync(path.join(root, "data/worklist.csv"))) files.push("data/worklist.csv");
  if (fs.existsSync(path.join(root, HOLDOUT))) files.push(HOLDOUT);
  const ann = path.join(root, "data/annotations");
  if (!fs.existsSync(ann)) fail("data/annotations is not on this PC, so there is nothing to train on.");
  let cases = 0;
  for (const cid of fs.readdirSync(ann).sort()) {
    const seg = `data/annotations/${cid}/${cid}.seg.nrrd`;
    if (!fs.existsSync(path.join(root, seg))) continue;
    const dir = `data/nifti/${cid}`;
    let series = "primary";
    const meta = path.join(root, dir, "series.json");
    if (fs.existsSync(meta)) {
      files.push(`${dir}/series.json`);
      try { series = JSON.parse(fs.readFileSync(meta, "utf8")).annotated || "primary"; } catch { /* primary */ }
    }
    let vol = `${dir}/${cid}_${series}.nii.gz`;
    if (!fs.existsSync(path.join(root, vol))) vol = `${dir}/${cid}_primary.nii.gz`;
    if (!fs.existsSync(path.join(root, vol))) {
      console.log(`  ${cid}  no scan on this PC, left out`);
      continue;
    }
    files.push(seg, vol);
    cases++;
  }
  return { files: files.filter((f) => !/deid|rename_map|name\.json/i.test(f)), cases };
}

async function push() {
  const isFresh = process.argv.includes("--fresh");
  const { files, cases } = neededFiles();
  console.log(`${cases} annotated case(s) on this PC.${isFresh ? " (Fresh re-upload requested)" : ""}`);

  if (isFresh) {
    console.log("Removing previous remote annotations, scans and splits on H200...");
    await ssh(`rm -rf ${REMOTE}/data/annotations ${REMOTE}/data/nifti ${REMOTE}/data/splits ${REMOTE}/data/worklist.csv && mkdir -p ${REMOTE}/data`);
  }

  const listing = isFresh
    ? { code: 0, out: "" }
    : await ssh(
        `mkdir -p ${REMOTE}/logs ${REMOTE}/data && cd ${REMOTE} && ` +
          `find ml data/annotations data/nifti data/worklist.csv data/splits -type f -printf '%s %p\\n' 2>/dev/null; ` +
          `echo ===MD5; md5sum data/annotations/*/*.seg.nrrd data/worklist.csv ${HOLDOUT} 2>/dev/null; true`,
      );
  if (listing.code !== 0) fail(session.unreachable, listing.code);
  const [sizesPart, md5Part = ""] = listing.out.split("===MD5");
  const remoteSize = new Map();
  for (const line of sizesPart.split(/\r?\n/)) {
    const m = line.match(/^(\d+) (.+)$/);
    if (m) remoteSize.set(m[2].trim(), Number(m[1]));
  }
  const remoteMd5 = new Map();
  for (const line of md5Part.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{32})\s+(.+)$/);
    if (m) remoteMd5.set(m[2].trim(), m[1]);
  }

  const send = [];
  let bytes = 0;
  let same = 0;
  for (const rel of files) {
    const size = fs.statSync(path.join(root, rel)).size;
    const hashed = rel.endsWith(".seg.nrrd") || rel === "data/worklist.csv" || rel === HOLDOUT;
    const unchanged = !isFresh && (hashed
      ? remoteMd5.get(rel) === md5(path.join(root, rel))
      : remoteSize.get(rel) === size);
    if (unchanged) {
      same++;
      continue;
    }
    send.push(rel);
    bytes += size;
  }
  console.log(`Already on the server and unchanged: ${same} file(s).`);
  if (process.argv.includes("--plan")) {
    console.log("PLAN " + JSON.stringify({ files: send.length, bytes, same }));
    return;
  }
  if (!send.length) {
    console.log("Nothing new to send.");
    return;
  }
  const groups = { code: 0, annotations: 0, scans: 0, other: 0 };
  for (const rel of send) {
    if (rel.startsWith("ml/")) groups.code++;
    else if (rel.startsWith("data/annotations/")) groups.annotations++;
    else if (rel.startsWith("data/nifti/")) groups.scans++;
    else groups.other++;
  }
  console.log(
    `Sending ${send.length} file(s), ${fmt(bytes)}: ${groups.code} code, ` +
      `${groups.annotations} annotation(s), ${groups.scans} scan file(s), ${groups.other} other.`,
  );
  if (session.remote && !(await internetOk(bytes, "upload"))) fail("Nothing was sent and no job was started.", 0);

  const listFile = path.join(os.tmpdir(), `bme-h200-push-${process.pid}.txt`);
  fs.writeFileSync(listFile, send.join("\n"), "utf8");
  const tar = spawn("tar", ["-cf", "-", "-C", root, "-T", listFile], { windowsHide: true, cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  let sent = 0;
  let shown = 0;
  tar.stdout.on("data", (chunk) => {
    sent += chunk.length;
    if (sent - shown < 8 * 1024 * 1024) return;
    shown = sent;
    process.stdout.write(`\r  ${fmt(sent)} of ~${fmt(bytes)}   `);
  });
  const result = await ssh(`cd ${REMOTE} && tar -xf -`, { stdin: tar });
  process.stdout.write(`\r  ${fmt(sent)} sent            \n`);
  try { fs.unlinkSync(listFile); } catch { /* gone */ }
  if (result.code !== 0) fail("Copy failed. Nothing was started.", result.code);
  await ssh(`cd ${REMOTE} && find ml -name '*.sbatch' -exec sed -i 's/\\r$//' {} +`);
  console.log("Server is up to date.");
}

// ---------- jobs ------------------------------------------------------------

async function submit(sbatch, what, logPrefix, extra = "", flags = "") {
  await push();
  const du = await ssh(`du -s --block-size=1G $HOME 2>/dev/null | cut -f1`);
  const usedGb = Number(du.out.trim());
  if (usedGb >= DISK_LIMIT_GB) {
    fail(`Your server home uses ${usedGb} GB; the college limit is 50 GB. Free space before training.`);
  }
  const busy = await ssh(`squeue -u $USER -h -n ${what} -o '%i %T %M'`);
  if (busy.out.trim()) {
    console.log(`A ${what} job is already queued or running:\n  ${busy.out.trim()}`);
    if ((await ask("Start another anyway? [y/N] ")).toLowerCase() !== "y") return;
  }

  let outFolder = "";
  let methodId = "";
  if (logPrefix.startsWith("aug_")) {
    const lvl = logPrefix.slice(4);
    outFolder = `results3d-aug-${lvl}`;
    methodId = `unet-aug-${lvl}`;
  } else if (logPrefix === "holdout") {
    outFolder = "results3d-holdout";
    methodId = "unet-holdout";
  } else if (logPrefix === "nnunet") {
    outFolder = extra.includes("2d") ? "results-nnunet-2d" : "results-nnunet-3d_fullres";
    methodId = extra.includes("2d") ? "nnunet-2d" : "nnunet-3d";
  } else if (logPrefix === "unet3d") {
    outFolder = "results3d-h200-v2";
    methodId = "train3d";
  } else if (logPrefix === "unet3dplain") {
    outFolder = "results3d-h200-plain";
    methodId = "train3dplain";
  } else if (logPrefix === "unet2d") {
    outFolder = "results2dseg3d";
    methodId = "train2d";
  }

  const allAccounts = listAccounts();
  const account = findAccount(allAccounts, asRoll || session.roll) || null;
  const meta = {
    startedBy: {
      usn: account?.usn || `NNM23CS${session.roll}`,
      name: account?.name || "",
    },
    platform: "h200",
    account: session.user,
    host: os.hostname(),
    startedAt: new Date().toISOString(),
    methodId: methodId || what,
  };

  if (outFolder) {
    try {
      const localDir = path.join(root, "data", outFolder);
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(path.join(localDir, "run_status.json"), JSON.stringify(meta, null, 2), "utf8");
      await ssh(`mkdir -p ${REMOTE}/data/${outFolder} && cat << 'EOF' > ${REMOTE}/data/${outFolder}/run_status.json\n${JSON.stringify(meta, null, 2)}\nEOF`);
    } catch {
      /* ignore */
    }
  }

  const r = await ssh(`cd ${REMOTE} && sbatch ${flags} ml/slurm/${sbatch} ${extra}`);
  process.stdout.write(r.out || "");
  if (r.code !== 0) fail("sbatch refused the job.", r.code);
  const id = (r.out.match(/(\d+)/) || [])[1];
  console.log("");
  console.log(`Log on the server: ~/bme/logs/${logPrefix}_${id ?? "<jobid>"}.out`);
  console.log("Follow it here with: pnpm h200 log");
}

/** Ask before queueing a second job on one account; each job holds a GPU slice. */
async function okWithOtherJobs() {
  const r = await ssh(`squeue -u $USER -h -o '%i %j %T %M'`);
  if (r.code !== 0) fail(session.unreachable, r.code);
  if (!r.out.trim()) return true;
  console.log(`This account already has a job:\n  ${r.out.trim().split(/\r?\n/).join("\n  ")}`);
  return (await ask("Queue this one as well? [y/N] ")).toLowerCase() === "y";
}

function hours(seconds) {
  return seconds >= 3600 ? `${(seconds / 3600).toFixed(1)} h` : `${Math.max(1, Math.round(seconds / 60))} min`;
}

const AUG = {
  low: "flip, mild gamma, rotation +-15 deg and zoom 0.85-1.2 on 10% of patches",
  med: "nnU-Net strength: rotation +-30 deg and zoom 0.7-1.4 on 20%, gamma, contrast, shading, blur, low-resolution",
  max: "the same steps on 30-50% of patches, plus light noise",
};

/**
 * One 3D U-Net run at a chosen augmentation level -> data/results3d-aug-<level>.
 * Continues by itself when that folder already holds checkpoints.
 */
async function aug(args) {
  let level = args[0];
  if (!AUG[level]) {
    console.log("\nAugmentation level");
    Object.entries(AUG).forEach(([k, v], i) => console.log(`  ${i + 1}. ${k}\n     ${v}`));
    level = Object.keys(AUG)[Number(await ask("Which level? [1-3] ")) - 1];
    if (!level) return;
  }
  const out = `results3d-aug-${level}`;
  const state = await ssh(
    `cd ${REMOTE}/data 2>/dev/null && { [ -f ${out}/metrics.json ] && echo DONE; [ -n "$(ls -A ${out} 2>/dev/null)" ] && echo STARTED; }; true`,
  );
  if (state.code !== 0) fail(session.unreachable, state.code);
  if (state.out.includes("DONE")) {
    console.log(`${out} is already finished on this account. Download it with: pnpm runs:get`);
    return;
  }
  const resume = state.out.includes("STARTED");
  console.log(`${resume ? "Continuing" : "Starting"} level ${level} -> data/${out} (one job, under 4 h).`);
  if (!(await okWithOtherJobs())) return;
  const name = `bme_aug_${level}`;
  await submit(
    "train_3d_aug.sbatch",
    name,
    `aug_${level}`,
    `${level}${resume ? " --resume" : ""}`,
    `--job-name=${name} --output=$HOME/bme/logs/aug_${level}_%j.out --error=$HOME/bme/logs/aug_${level}_%j.err`,
  );
}

/**
 * One round of the 3D U-Net (augmentation med) on the fixed 80/20 split in
 * data/splits/holdout_80_20.json -> data/results3d-holdout. Continues if started.
 */
async function holdout() {
  if (!fs.existsSync(path.join(root, HOLDOUT))) {
    console.log("There is no fixed 80/20 split yet. Make it here first; it shows which scans go where:");
    console.log("  pnpm train:split");
    return;
  }
  const split = JSON.parse(fs.readFileSync(path.join(root, HOLDOUT), "utf8"));
  console.log(`Fixed split from ${split.created}: ${split.train.length} training scans, ${split.val.length} validation scans.`);
  console.log("See the lists with: pnpm train:split");
  const out = "results3d-holdout";
  const state = await ssh(
    `cd ${REMOTE}/data 2>/dev/null && { [ -f ${out}/metrics.json ] && echo DONE; [ -n "$(ls -A ${out} 2>/dev/null)" ] && echo STARTED; }; true`,
  );
  if (state.code !== 0) fail(session.unreachable, state.code);
  if (state.out.includes("DONE")) {
    console.log(`${out} is already finished on this account. Download it with: pnpm runs:get`);
    return;
  }
  const resume = state.out.includes("STARTED");
  console.log(`${resume ? "Continuing" : "Starting"} the holdout run -> data/${out} (one job, under 4 h).`);
  if (!(await okWithOtherJobs())) return;
  await submit(
    "train_3d_aug.sbatch",
    "bme_holdout",
    "holdout",
    `med --holdout ${HOLDOUT} --out ${out}${resume ? " --resume" : ""}`,
    `--job-name=bme_holdout --output=$HOME/bme/logs/holdout_%j.out --error=$HOME/bme/logs/holdout_%j.err`,
  );
}

const NN_RUN = (config) =>
  `${REMOTE}/data/nnunet/results/Dataset501_BMEKnee/nnUNetTrainer_BME100__nnUNetResEncUNetMPlans__${config}`;
const NN_EPOCHS = 100;
const JOB_SECONDS = 3.75 * 3600;

/** Progress and a time estimate for one nnU-Net configuration, from its own logs on the server. */
async function nnunetProgress(config) {
  const r = await ssh(
    `cd ${NN_RUN(config)} 2>/dev/null || { echo NONE; exit 0; }; ` +
      `for f in 0 1 2 3 4; do ` +
      `if [ -f fold_$f/checkpoint_final.pth ]; then echo "FOLD $f final"; ` +
      `else echo "FOLD $f $(cat fold_$f/training_log_*.txt 2>/dev/null | grep -c 'Epoch time')"; fi; done; ` +
      `cat fold_*/training_log_*.txt 2>/dev/null | grep 'Epoch time' | tail -n 40`,
  );
  if (r.code !== 0) fail(session.unreachable, r.code);
  const done = [0, 0, 0, 0, 0];
  for (const m of r.out.matchAll(/FOLD (\d) (final|\d+)/g)) {
    done[Number(m[1])] = m[2] === "final" ? NN_EPOCHS : Math.min(NN_EPOCHS, Number(m[2]));
  }
  const times = [...r.out.matchAll(/Epoch time: ([\d.]+) s/g)].map((m) => Number(m[1]));
  const perEpoch = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
  const left = done.reduce((s, d) => s + (NN_EPOCHS - d), 0);
  return { done, perEpoch, left };
}

/**
 * The plan's first stage: nnU-Net ResEnc M learning bone and edema together,
 * as a 2D model and a 3D model on the same folds. Choosing it again continues:
 * finished folds are skipped, an unfinished fold restarts from its last
 * checkpoint (at most 4 epochs back).
 */
async function best(args) {
  let config = { "2d": "2d", "3d": "3d_fullres", "3d_fullres": "3d_fullres" }[args[0]];
  if (!config) {
    console.log("\nBest model (nnU-Net, bone + edema). Both parts are needed; use one account for each.");
    console.log("  1. 2D part\n  2. 3D part");
    config = ["2d", "3d_fullres"][Number(await ask("Which part? [1-2] ")) - 1];
    if (!config) return;
  }
  const p = await nnunetProgress(config);
  console.log(`\nnnU-Net ${config}: 5 folds x ${NN_EPOCHS} epochs. Epochs done per fold: ${p.done.join(", ")}.`);
  if (!p.left) {
    console.log("All folds are finished. This job only scores them (a few minutes).");
  } else if (p.perEpoch) {
    const total = p.left * p.perEpoch;
    console.log(
      `Measured on this account: ${Math.round(p.perEpoch)} s per epoch. ` +
        `Left: ${p.left} epochs, about ${hours(total)}, so ${Math.ceil(total / JOB_SECONDS)} more job(s) of up to 4 h.`,
    );
  } else {
    console.log("No epoch has run on this account yet, so there is no measured speed.");
    console.log("Start it, then choose this again after ~30 min to see the real estimate.");
  }
  console.log("Each job stops itself at 3 h 45. Choose this again to continue from the last checkpoint.");
  if ((await ask(`${p.left === 5 * NN_EPOCHS ? "Start" : "Continue"}? [y/N] `)).toLowerCase() !== "y") return;
  if (!(await okWithOtherJobs())) return;
  await submit("nnunet.sbatch", "bme_nnunet", "nnunet", config);
}

async function status() {
  const r = await ssh(
    `echo "== your jobs"; squeue -u $USER -o '%.10i %.12j %.9T %.10M %.10l %R'; ` +
      `echo; echo "== disk (limit 50 GB)"; du -sh ${REMOTE} 2>/dev/null; du -sh $HOME 2>/dev/null; ` +
      `echo; echo "== results on the server"; ` +
      `for d in ${RESULTS.join(" ")}; do f=${REMOTE}/data/$d/metrics.json; ` +
      `if [ -f $f ]; then echo "  $d: finished $(date -r $f '+%d %b %H:%M')"; ` +
      `else n=$(ls ${REMOTE}/data/$d/fold_*.pt ${REMOTE}/data/$d/checkpoints 2>/dev/null | wc -l); echo "  $d: not finished ($n fold file(s))"; fi; done; ` +
      `echo; echo "== latest log"; f=$(ls -t ${REMOTE}/logs/*.out 2>/dev/null | head -1); ` +
      `[ -n "$f" ] && { echo "$f"; tail -n 8 "$f"; } || echo "  none"`,
  );
  if (r.code !== 0) fail(session.unreachable, r.code);
  process.stdout.write(r.out);
}

async function follow() {
  console.log("Following the newest job log. Ctrl+C stops watching; the job keeps running.\n");
  await ssh(`f=$(ls -t ${REMOTE}/logs/*.out 2>/dev/null | head -1); [ -n "$f" ] && { echo "$f"; tail -n 30 -f "$f"; } || echo "no logs yet"`, {
    interactive: true,
  });
}

async function cancel() {
  const r = await ssh(`squeue -u $USER -h -o '%i %j %T %M'`);
  const jobs = r.out.trim().split(/\r?\n/).filter(Boolean);
  if (!jobs.length) {
    console.log("You have no jobs on the H200.");
    return;
  }
  jobs.forEach((j, i) => console.log(`  ${i + 1}. ${j}`));
  const pick = jobs[Number(await ask(`Cancel which? [1-${jobs.length}, Enter = none] `)) - 1];
  if (!pick) return;
  const id = pick.split(" ")[0];
  if ((await ask(`Really cancel job ${id}? Its progress since the last fold is lost. [y/N] `)).toLowerCase() !== "y") return;
  const c = await ssh(`scancel ${id} && echo "cancelled ${id}"`);
  process.stdout.write(c.out);
}

/**
 * Create or complete ~/bme/env on this account, the way the college guide says:
 * a venv in the home folder, packages installed inside it with pip. Installing
 * is not training, so it runs on the login node; nothing here uses the GPU.
 * The first run downloads CUDA PyTorch on the SERVER (~2.5 GB), not on this PC.
 */
async function setup() {
  const have = await ssh(
    `cd ${REMOTE} 2>/dev/null; ` +
      `[ -x env/bin/python3 ] && echo HAVE_ENV; ` +
      `env/bin/python3 -c "import torch" 2>/dev/null && echo HAVE_TORCH; ` +
      `env/bin/python3 -c "import nnunetv2" 2>/dev/null && echo HAVE_NNUNET; ` +
      `du -s --block-size=1G $HOME 2>/dev/null | cut -f1`,
  );
  if (have.code !== 0) fail(session.unreachable, have.code);
  const out = have.out;
  const usedGb = Number(out.trim().split(/\r?\n/).pop());
  const steps = [];
  if (!out.includes("HAVE_ENV")) steps.push(`mkdir -p ${REMOTE} && /usr/bin/python3 -m venv ${REMOTE}/env`);
  if (!out.includes("HAVE_TORCH")) {
    steps.push(`${REMOTE}/env/bin/pip install torch==2.5.1 --index-url https://download.pytorch.org/whl/cu121`);
  }
  steps.push(`${REMOTE}/env/bin/pip install numpy scipy nibabel pynrrd SimpleITK`);
  if (!out.includes("HAVE_NNUNET")) steps.push(`${REMOTE}/env/bin/pip install ${NNUNET}`);
  console.log(`Server home uses ${usedGb} GB of 50 GB.`);
  console.log("Will run on the server, inside ~/bme/env only:");
  steps.forEach((x) => console.log(`  ${x}`));
  if (!out.includes("HAVE_TORCH")) console.log("CUDA PyTorch is ~2.5 GB, downloaded by the server.");
  if ((await ask("Go ahead? [y/N] ")).toLowerCase() !== "y") return;
  const r = await ssh(`set -e; ${steps.join(" && ")} && echo SETUP_OK`, { interactive: true });
  if (r.code !== 0) fail("Setup stopped; nothing else was changed.", r.code);
  await checkEnv();
}

async function getResults() {
  const r = await ssh(`cd ${REMOTE}/data 2>/dev/null && for d in ${RESULTS.join(" ")}; do [ -f $d/metrics.json ] && echo $d; done; true`);
  const ready = r.out.trim().split(/\r?\n/).filter(Boolean);
  if (!ready.length) {
    console.log("No finished results on this account yet. Check with: pnpm h200 status");
    return;
  }
  ready.forEach((d, i) => console.log(`  ${i + 1}. ${d}`));
  const pick = ready[Number(await ask(`Download which? [1-${ready.length}] `)) - 1];
  if (!pick) return;
  await download(`data/${pick}`, `data/${pick}`, pick);
}

async function checkEnv() {
  const r = await ssh(
    `cd ${REMOTE} 2>/dev/null || { echo "no ~/bme yet: run push first"; exit 0; }; ` +
      `[ -f env/bin/activate ] || { echo "no ~/bme/env: create a venv there with CUDA torch, numpy, scipy, nibabel, pynrrd"; exit 0; }; ` +
      `env/bin/python3 -c "import torch, numpy, scipy, nibabel, nrrd; print('python env ok, torch', torch.__version__, 'built for CUDA', torch.version.cuda)"; ` +
      `env/bin/python3 -c "import nnunetv2" 2>/dev/null && echo "nnU-Net installed" || echo "nnU-Net missing: pnpm h200 setup"`,
  );
  process.stdout.write(r.out);
}

// ---------- results back ----------------------------------------------------

async function download(remoteRel, localRel, label) {
  const check = await ssh(
    `cd ${REMOTE} && [ -f ${remoteRel}/metrics.json ] && find ${remoteRel} -maxdepth 1 -type f \\( -name 'fold_*.pt' -o -name metrics.json -o -name run_status.json \\) -printf '%s %f\\n'`,
  );
  if (check.code !== 0 || !check.out.includes("metrics.json")) {
    console.log(`${label} is not finished on the server yet (no ${remoteRel}/metrics.json).`);
    console.log("Check with: pnpm h200 status");
    return;
  }
  const names = check.out.split(/\r?\n/).map((l) => l.split(" ")[1]).filter(Boolean);
  const bytes = check.out.split(/\r?\n/).reduce((s, l) => s + (Number(l.split(" ")[0]) || 0), 0);
  console.log(`Downloading ${label}: ${names.length} file(s), ${fmt(bytes)}. Scans and annotations are not copied.`);
  if (session.remote && !(await internetOk(bytes, "download"))) return;

  const dest = path.join(root, localRel);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) {
    const keep = `${dest}_before_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
    fs.renameSync(dest, keep);
    console.log(`Your previous ${localRel} is kept as ${path.relative(root, keep)}`);
  }
  fs.mkdirSync(dest, { recursive: true });
  const remote = spawn(
    session.sshBin || "ssh",
    [...session.sshOpts, "-o", "ConnectTimeout=30", session.target, `cd ${REMOTE}/${remoteRel} && tar -cf - ${names.join(" ")}`],
    { windowsHide: true, cwd: root, env: session.env, stdio: ["ignore", "pipe", "inherit"] },
  );
  const r = await run("tar", ["-xf", "-", "-C", dest], { stdin: remote });
  if (r.code !== 0) fail("Download failed.", r.code);
  console.log(`Saved to ${localRel}/`);
}

async function get3d() {
  await download(R3D, R3D, "the H200 3D model");
  const src = path.join(root, R3D);
  if (!fs.existsSync(path.join(src, "metrics.json"))) return;
  const m = JSON.parse(fs.readFileSync(path.join(src, "metrics.json"), "utf8"));
  const s = m.summary || {};
  const ms = (k) => (s[k] ? `${s[k].mean.toFixed(3)} ± ${s[k].std.toFixed(3)}` : "n/a");
  console.log(`\n${m.n_cases} cases, ${m.folds} folds, up to ${m.epochs} epochs, ${m.hours_taken ?? "?"} h`);
  console.log(`  bone Dice   ${ms("bone_dice")}`);
  console.log(`  edema Dice  ${ms("bme_dice")}`);
  console.log(`  FP / case   ${ms("fp_per_case")}`);
  const answer = await ask("\nUse it as the app's 3D U-Net (Results, Test, AI suggestions)? Your current one is kept. [y/N] ");
  if (answer.toLowerCase() !== "y") return;
  const live = path.join(root, "data/results3d");
  if (fs.existsSync(live)) {
    const keep = `${live}_laptop_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
    fs.renameSync(live, keep);
    console.log(`Previous 3D U-Net kept as ${path.relative(root, keep)}`);
  }
  fs.cpSync(src, live, { recursive: true });
  console.log("data/results3d now holds the H200 model.");
}

async function get2d() {
  await download("data/results2dseg3d", "data/results2dseg3d", "the H200 2D model");
}

// ---------- menu ------------------------------------------------------------

const OPS = [
  { key: "status", label: "Status", about: "Your jobs, disk use, which results are finished, last log lines.", fn: status },
  { key: "push", label: "Push data", about: "Send code and every annotated 3D case. Only new or changed files go.", fn: push },
  { key: "best", label: "Best model: nnU-Net (start or continue)", about: "nnU-Net ResEnc M, bone + edema, 2D or 3D part. Shows progress and the time left, then submits one 4 h job.", fn: best },
  { key: "holdout", label: "Holdout: one round on the fixed 80/20 split", about: "3D U-Net, augmentation med, trained once on 80% and checked on the fixed 20% -> data/results3d-holdout.", fn: holdout },
  { key: "aug", label: "Augmentation levels: low / med / max", about: "Same 3D U-Net at one augmentation level -> data/results3d-aug-<level>. Continues if already started.", fn: aug },
  { key: "train3d", label: "Train 3D (long, ~3.5 h)", about: `Push, then sbatch ml/slurm/train_3d.sbatch -> ${R3D}. Live rotation/zoom, 1 mm grid.`, fn: () => submit("train_3d.sbatch", "bme_unet3d", "unet3d") },
  { key: "resume3d", label: "Resume 3D", about: "Continue a 3D run that maintenance or the 4 h limit stopped, from its last saved epoch.", fn: () => submit("train_3d.sbatch", "bme_unet3d", "unet3d", "--resume") },
  { key: "train3dplain", label: "Train 3D, no augmentation (~3.5 h)", about: "Same 3D U-Net without augmentation -> data/results3d-h200-plain. The control run.", fn: () => submit("train_3d_plain.sbatch", "bme_unet3d_plain", "unet3dplain") },
  { key: "resume3dplain", label: "Resume 3D, no augmentation", about: "Continue the control run from its last saved epoch.", fn: () => submit("train_3d_plain.sbatch", "bme_unet3d_plain", "unet3dplain", "--resume") },
  { key: "nnunet3d", label: "nnU-Net ResEnc M, 3D", about: "Push, then train nnU-Net 3d_fullres on the same folds. Submit again to continue; finished folds are skipped.", fn: () => submit("nnunet.sbatch", "bme_nnunet", "nnunet", "3d_fullres") },
  { key: "nnunet2d", label: "nnU-Net ResEnc M, 2D", about: "Push, then train nnU-Net 2d on the same folds. Submit again to continue.", fn: () => submit("nnunet.sbatch", "bme_nnunet", "nnunet", "2d") },
  { key: "train2d", label: "Train 2D", about: "Push, then sbatch ml/slurm/train_2d_seg.sbatch -> data/results2dseg3d.", fn: () => submit("train_2d_seg.sbatch", "bme_unet2d", "unet2d") },
  { key: "log", label: "Follow log", about: "Live tail of the newest job log. Ctrl+C stops watching only.", fn: follow },
  { key: "cancel", label: "Cancel a job", about: "Lists your jobs and asks before scancel.", fn: cancel },
  { key: "get3d", label: "Download 3D model", about: `Weights + metrics.json into ${R3D}; asks before using it in the app.`, fn: get3d },
  { key: "get", label: "Download any finished result", about: "Lists finished runs on this account (U-Net, control, nnU-Net) and downloads one's scores and weights.", fn: getResults },
  { key: "get2d", label: "Download 2D model", about: "Weights + metrics.json into data/results2dseg3d.", fn: get2d },
  { key: "env", label: "Check server Python", about: "Confirms ~/bme/env has torch, numpy, scipy, nibabel, pynrrd, nnU-Net.", fn: checkEnv },
  { key: "setup", label: "Set up server Python", about: "First time on an account: create ~/bme/env and install PyTorch + nnU-Net there (asks first).", fn: setup },
];

const argv = process.argv.slice(2).filter((a) => a !== "--");
const asIdx = argv.indexOf("--as");
const asRoll = asIdx >= 0 ? argv[asIdx + 1] ?? "" : "";
if (asIdx >= 0) argv.splice(asIdx, 2);
const direct = argv[0];
let op = OPS.find((o) => o.key === direct);
if (direct && !op) fail(`unknown op ${direct}. one of: ${OPS.map((o) => o.key).join(" ")}`);
if (!op) {
  console.log("\nCollege H200");
  OPS.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}\n     ${o.about}`));
  console.log("");
  op = OPS[Number(await ask(`Which one? [1-${OPS.length}] `)) - 1];
  if (!op) fail("Nothing chosen.");
}

session = await chooseH200(root, asRoll);
try {
  await op.fn(argv.slice(1));
} finally {
  session.close();
}
