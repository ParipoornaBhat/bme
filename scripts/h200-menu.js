import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ask, chooseH200 } from "./h200-login.js";

/**
 * pnpm h200                     menu
 * pnpm h200 <op>                one op directly (see OPS below)
 * pnpm h200 <op> --as <roll>    on that account, e.g. --as 149; one terminal per account
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
    "ssh",
    [...tty, "-o", "ConnectTimeout=30", "-o", "StrictHostKeyChecking=accept-new", session.target, command],
    { capture: !opts.stdin && !opts.interactive, ...opts },
  );
}

function fmt(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
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
  const { files, cases } = neededFiles();
  console.log(`${cases} annotated case(s) on this PC.`);
  const listing = await ssh(
    `mkdir -p ${REMOTE}/logs ${REMOTE}/data && cd ${REMOTE} && ` +
      `find ml data/annotations data/nifti data/worklist.csv -type f -printf '%s %p\\n' 2>/dev/null; ` +
      `echo ===MD5; md5sum data/annotations/*/*.seg.nrrd data/worklist.csv 2>/dev/null; true`,
  );
  if (listing.code !== 0) fail("Could not reach the H200. Join the college WiFi, then try again.", listing.code);
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
    const hashed = rel.endsWith(".seg.nrrd") || rel === "data/worklist.csv";
    const unchanged = hashed
      ? remoteMd5.get(rel) === md5(path.join(root, rel))
      : remoteSize.get(rel) === size;
    if (unchanged) {
      same++;
      continue;
    }
    send.push(rel);
    bytes += size;
  }
  console.log(`Already on the server and unchanged: ${same} file(s).`);
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

  const listFile = path.join(os.tmpdir(), `bme-h200-push-${process.pid}.txt`);
  fs.writeFileSync(listFile, send.join("\n"), "utf8");
  const tar = spawn("tar", ["-cf", "-", "-C", root, "-T", listFile], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
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

async function submit(sbatch, what, logPrefix, extra = "") {
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
  const r = await ssh(`cd ${REMOTE} && sbatch ml/slurm/${sbatch} ${extra}`);
  process.stdout.write(r.out || "");
  if (r.code !== 0) fail("sbatch refused the job.", r.code);
  const id = (r.out.match(/(\d+)/) || [])[1];
  console.log("");
  console.log(`Log on the server: ~/bme/logs/${logPrefix}_${id ?? "<jobid>"}.out`);
  console.log("Follow it here with: pnpm h200 log");
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
  if (r.code !== 0) fail("Could not reach the H200. Join the college WiFi, then try again.", r.code);
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
  if (have.code !== 0) fail("Could not reach the H200. Join the college WiFi, then try again.", have.code);
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
    `cd ${REMOTE} && [ -f ${remoteRel}/metrics.json ] && find ${remoteRel} -maxdepth 1 -type f \\( -name 'fold_*.pt' -o -name metrics.json \\) -printf '%s %f\\n'`,
  );
  if (check.code !== 0 || !check.out.includes("metrics.json")) {
    console.log(`${label} is not finished on the server yet (no ${remoteRel}/metrics.json).`);
    console.log("Check with: pnpm h200 status");
    return;
  }
  const names = check.out.split(/\r?\n/).map((l) => l.split(" ")[1]).filter(Boolean);
  const bytes = check.out.split(/\r?\n/).reduce((s, l) => s + (Number(l.split(" ")[0]) || 0), 0);
  console.log(`Downloading ${label}: ${names.length} file(s), ${fmt(bytes)}. Scans and annotations are not copied.`);

  const dest = path.join(root, localRel);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) {
    const keep = `${dest}_before_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
    fs.renameSync(dest, keep);
    console.log(`Your previous ${localRel} is kept as ${path.relative(root, keep)}`);
  }
  fs.mkdirSync(dest, { recursive: true });
  const remote = spawn(
    "ssh",
    ["-o", "ConnectTimeout=30", session.target, `cd ${REMOTE}/${remoteRel} && tar -cf - ${names.join(" ")}`],
    { cwd: root, env: session.env, stdio: ["ignore", "pipe", "inherit"] },
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
  await op.fn();
} finally {
  session.close();
}
