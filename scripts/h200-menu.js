import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ask, chooseH200 } from "./h200-login.js";

/**
 * pnpm h200            menu
 * pnpm h200 <op>       one op directly: status push train3d train2d log cancel get3d get2d env
 *
 * Nothing trains on this PC. Training runs as a Slurm job on the 1g.18gb slice;
 * the login node only copies files and calls sbatch (H200 rules: no compute there).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE = "$HOME/bme";
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

async function submit(sbatch, what, logPrefix) {
  await push();
  const busy = await ssh(`squeue -u $USER -h -n ${what} -o '%i %T %M'`);
  if (busy.out.trim()) {
    console.log(`A ${what} job is already queued or running:\n  ${busy.out.trim()}`);
    if ((await ask("Start another anyway? [y/N] ")).toLowerCase() !== "y") return;
  }
  const r = await ssh(`cd ${REMOTE} && sbatch ml/slurm/${sbatch}`);
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
      `for d in results3d-h200 results2dseg3d; do f=${REMOTE}/data/$d/metrics.json; ` +
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

async function checkEnv() {
  const r = await ssh(
    `cd ${REMOTE} 2>/dev/null || { echo "no ~/bme yet: run push first"; exit 0; }; ` +
      `[ -f env/bin/activate ] || { echo "no ~/bme/env: create a venv there with CUDA torch, numpy, scipy, nibabel, pynrrd"; exit 0; }; ` +
      `source env/bin/activate; python3 -c "import torch, numpy, scipy, nibabel, nrrd; print('python env ok, torch', torch.__version__, 'built for CUDA', torch.version.cuda)"`,
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
  await download("data/results3d-h200", "data/results3d-h200", "the H200 3D model");
  const src = path.join(root, "data/results3d-h200");
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
  { key: "train3d", label: "Train 3D (long, ~3.5 h)", about: "Push, then sbatch ml/slurm/train_3d.sbatch -> data/results3d-h200.", fn: () => submit("train_3d.sbatch", "bme_unet3d", "unet3d") },
  { key: "train2d", label: "Train 2D", about: "Push, then sbatch ml/slurm/train_2d_seg.sbatch -> data/results2dseg3d.", fn: () => submit("train_2d_seg.sbatch", "bme_unet2d", "unet2d") },
  { key: "log", label: "Follow log", about: "Live tail of the newest job log. Ctrl+C stops watching only.", fn: follow },
  { key: "cancel", label: "Cancel a job", about: "Lists your jobs and asks before scancel.", fn: cancel },
  { key: "get3d", label: "Download 3D model", about: "Weights + metrics.json into data/results3d-h200; asks before using it in the app.", fn: get3d },
  { key: "get2d", label: "Download 2D model", about: "Weights + metrics.json into data/results2dseg3d.", fn: get2d },
  { key: "env", label: "Check server Python", about: "Confirms ~/bme/env has torch, numpy, scipy, nibabel, pynrrd.", fn: checkEnv },
];

const direct = process.argv.slice(2).find((a) => a !== "--");
let op = OPS.find((o) => o.key === direct);
if (direct && !op) fail(`unknown op ${direct}. one of: ${OPS.map((o) => o.key).join(" ")}`);
if (!op) {
  console.log("\nCollege H200");
  OPS.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}\n     ${o.about}`));
  console.log("");
  op = OPS[Number(await ask(`Which one? [1-${OPS.length}] `)) - 1];
  if (!op) fail("Nothing chosen.");
}

session = await chooseH200(root);
try {
  await op.fn();
} finally {
  session.close();
}
