import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../../../..");

// Import existing modules
const accountsMod = await import(pathToFileURL(path.join(root, "scripts", "lib", "accounts.js")).href);
const methodsMod = await import(pathToFileURL(path.join(root, "scripts", "lib", "methods.js")).href);
const deviceMod = await import(pathToFileURL(path.join(root, "scripts", "lib", "device.js")).href);
const h200LoginMod = await import(pathToFileURL(path.join(root, "scripts", "h200-login.js")).href);

const {
  listAccounts, mergedEnv, findAccount, h200Route, tcpReachable,
  kaggleReady, stagingFor, kaggleLocalState, kaggleUserOf, datasetOwner,
  kaggle, kaggleJson, kaggleEnv, usable, createRunMetadata, python, operator,
} = accountsMod;
const PIPELINE = path.join(root, "ml", "scripts", "kaggle_pipeline.py");
const { METHODS } = methodsMod;
const { detectDevice, describeDevice } = deviceMod;
const { chooseH200 } = h200LoginMod;

function parseLogProgress(logText, defaultFolds = 5, defaultEpochs = 40, startedAt = null) {
  if (!logText) return null;
  // The 3D U-Net prints its own counters: "] 23/85  fold 2/5  epoch 6/17" and
  // "134.1s/epoch | ETA: 141m 11s". They are exact, so they win.
  const own = [...logText.matchAll(/\]\s*(\d+)\/(\d+)\s+fold\s+(\d+)\/(\d+)\s+epoch\s+(\d+)\/(\d+)/g)].pop();
  if (own) {
    const [done, total, fold, folds, ep] = own.slice(1).map(Number);
    const sec = Number(([...logText.matchAll(/([\d.]+)s\/epoch/g)].pop() || [])[1] || 0);
    const eta = [...logText.matchAll(/ETA:\s*(?:(\d+)h\s*)?(\d+)m\s*(\d+)s/g)].pop();
    const etaSeconds = eta
      ? Number(eta[1] || 0) * 3600 + Number(eta[2]) * 60 + Number(eta[3])
      : sec > 0 ? Math.round((total - done) * sec) : null;
    return {
      doneEpochs: done,
      totalEpochs: total,
      doneFolds: fold - 1,
      totalFolds: folds,
      currentFold: fold - 1,
      currentEpoch: ep,
      percent: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0,
      secPerEpoch: sec > 0 ? Math.round(sec) : undefined,
      etaSeconds,
    };
  }
  const foldMatches = [...logText.matchAll(/fold\s*(\d+)[:\s]/gi)];
  const epochMatches = [...logText.matchAll(/epoch\s*(\d+)(?:\/(\d+))?/gi)];
  const epochTimeMatches = [...logText.matchAll(/epoch\s*time:\s*([\d.]+)\s*s/gi)];

  let currentFold = 0;
  let currentEpoch = 0;
  let totalEpochsPerFold = defaultEpochs;
  let totalFolds = defaultFolds;

  if (foldMatches.length > 0) {
    const lastFold = foldMatches[foldMatches.length - 1];
    currentFold = Number(lastFold[1]);
  }
  if (epochMatches.length > 0) {
    const lastEpoch = epochMatches[epochMatches.length - 1];
    currentEpoch = Number(lastEpoch[1]);
    if (lastEpoch[2]) totalEpochsPerFold = Number(lastEpoch[2]);
  }

  const doneEpochs = Math.max(0, currentFold * totalEpochsPerFold + currentEpoch);
  const totalEpochs = totalFolds * totalEpochsPerFold;
  const percent = totalEpochs > 0 ? Math.min(100, Math.round((doneEpochs / totalEpochs) * 100)) : 0;

  let secPerEpoch = 0;
  if (epochTimeMatches.length > 0) {
    const recentTimes = epochTimeMatches.slice(-10).map((m) => Number(m[1]));
    secPerEpoch = recentTimes.reduce((a, b) => a + b, 0) / recentTimes.length;
  }

  let etaSeconds = null;
  const leftEpochs = Math.max(0, totalEpochs - doneEpochs);
  if (secPerEpoch > 0) {
    etaSeconds = Math.round(leftEpochs * secPerEpoch);
  } else if (startedAt && doneEpochs > 0) {
    const elapsedSec = (Date.now() - new Date(startedAt).getTime()) / 1000;
    const avgSec = elapsedSec / doneEpochs;
    etaSeconds = Math.round(leftEpochs * avgSec);
  }

  return {
    doneEpochs,
    totalEpochs,
    doneFolds: currentFold,
    totalFolds,
    currentFold,
    currentEpoch,
    percent,
    secPerEpoch: secPerEpoch > 0 ? Math.round(secPerEpoch) : undefined,
    etaSeconds,
  };
}

// Runs started from this PC that `pnpm h200:auto` keeps going part after part.
const AUTO_FILE = path.join(root, "data", "advanced_training", "auto_runs.json");
function readAutoRuns() {
  try { return JSON.parse(fs.readFileSync(AUTO_FILE, "utf8")); } catch { return []; }
}
function writeAutoRuns(list) {
  fs.mkdirSync(path.dirname(AUTO_FILE), { recursive: true });
  fs.writeFileSync(AUTO_FILE, JSON.stringify(list, null, 2), "utf8");
}
function trackRun(target, methodId) {
  const list = readAutoRuns().filter((r) => !(r.target === target && r.methodId === methodId));
  const old = readAutoRuns().find((r) => r.target === target && r.methodId === methodId);
  list.push({ target, methodId, startedBy: operator(), startedAt: old?.startedAt || new Date().toISOString(), continues: old?.continues || 0, state: "active" });
  writeAutoRuns(list);
}
function untrackTarget(target) {
  writeAutoRuns(readAutoRuns().filter((r) => r.target !== target));
}

const H200_RUNS = [
  { folder: "results-nnunet-3d_fullres", methodId: "nnunet-3d", job: "bme_nnunet", log: "nnunet", label: "nnU-Net ResEnc M, 3D" },
  { folder: "results-nnunet-2d", methodId: "nnunet-2d", job: "bme_nnunet", log: "nnunet", label: "nnU-Net ResEnc M, 2D" },
  { folder: "results3d-aug-low", methodId: "unet-aug-low", job: "bme_aug_low", log: "aug_low", label: "3D U-Net, augmentation low" },
  { folder: "results3d-aug-med", methodId: "unet-aug-med", job: "bme_aug_med", log: "aug_med", label: "3D U-Net, augmentation med" },
  { folder: "results3d-aug-max", methodId: "unet-aug-max", job: "bme_aug_max", log: "aug_max", label: "3D U-Net, augmentation max" },
  { folder: "results-nnunet-3d_fullres-noaug", methodId: "nnunet-3d-noaug", job: "bme_nnunet_noaug", log: "nnunet_noaug", label: "nnU-Net ResEnc M, 3D, no augmentation" },
  { folder: "results-nnunet-2d-noaug", methodId: "nnunet-2d-noaug", job: "bme_nnunet_noaug", log: "nnunet_noaug", label: "nnU-Net ResEnc M, 2D, no augmentation" },
  { folder: "results3d-holdout-none", methodId: "unet-holdout-none", job: "bme_holdout_none", log: "holdout_none", label: "3D U-Net, fixed 80/20 split, no augmentation" },
  { folder: "results3d-holdout-low", methodId: "unet-holdout-low", job: "bme_holdout_low", log: "holdout_low", label: "3D U-Net, fixed 80/20 split, augmentation low" },
  { folder: "results3d-holdout-max", methodId: "unet-holdout-max", job: "bme_holdout_max", log: "holdout_max", label: "3D U-Net, fixed 80/20 split, augmentation max" },
  { folder: "results3d-holdout", methodId: "unet-holdout", job: "bme_holdout", log: "holdout", label: "3D U-Net, fixed 80/20 split, augmentation med" },
  { folder: "results3d-h200-plain", methodId: "unet-noaug", job: "bme_unet3d_plain", log: "unet3dplain", label: "3D U-Net, no augmentation" },
  { folder: "results3d-selftest-aug", methodId: "selftest-aug", job: "bme_selftest_aug", log: "selftest_aug", label: "Self-test, augmentation max" },
  { folder: "results3d-selftest-plain", methodId: "selftest-plain", job: "bme_selftest_plain", log: "selftest_plain", label: "Self-test, no augmentation" },
  { folder: "results3d-h200-v2", methodId: "train3d", job: "bme_unet3d", log: "unet3d", label: "3D U-Net (v2)" },
];

// The other architectures on the H200: same trainer, same settings as the 3D U-Net.
const ARCH_LABELS = { mednext: "MedNeXt", orthogate: "OrthoGate-MedNeXt", cnet: "C-Net dual U-Net" };
for (const [k, label] of Object.entries(ARCH_LABELS)) {
  for (const lvl of ["none", "low", "med", "max"]) {
    H200_RUNS.push({
      folder: `results3d-${k}-${lvl}`,
      methodId: `arch-${k}-${lvl}`,
      job: `bme_${k}_${lvl}`,
      log: `arch_${k}_${lvl}`,
      label: `${label}, ${lvl === "none" ? "no augmentation" : `augmentation ${lvl}`}`,
    });
  }
}
const KAGGLE_TO_ARCH = { "k-mednext": "mednext", "k-orthogate": "orthogate", "k-cnet-dual": "cnet" };

async function runSshCommand(session, cmd, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(
      session.sshBin || "ssh",
      [
        ...session.sshOpts,
        "-o", "ConnectTimeout=5",
        "-o", "StrictHostKeyChecking=accept-new",
        session.target,
        cmd,
      ],
      {
        windowsHide: true,
        cwd: root,
        env: session.env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve({ code: 124, out, err: "Timed out" });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, out, err: String(e) });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out, err });
    });
  });
}

// ---------- CARD JOB CACHE ---------------------------------------------------
function cacheCardJob(cardId, currentJob) {
  try {
    const dir = path.join(root, "data", ".cache");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `card_job_${cardId}.json`), JSON.stringify({ currentJob, at: Date.now() }));
  } catch {}
}

function readCachedCardJob(cardId) {
  try {
    const file = path.join(root, "data", ".cache", `card_job_${cardId}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  return null;
}

// ---------- ACCOUNTS COMMAND -------------------------------------------------
async function handleAccounts() {
  const env = mergedEnv();
  const all = listAccounts(env);
  const route = await h200Route(env);
  const isDirectH200 = !route.remote;
  const isHostReachable = await tcpReachable(route.host, 22, 2000);

  // 1. Parallel H200 cards check
  const h200Candidates = all.filter((acc) => !acc.slot || acc.slot <= 1);
  const h200Cards = await Promise.all(
    h200Candidates.map(async (acc) => {
      const id = `h200-${acc.roll}`;
      if (!usable.h200(acc)) {
        return {
          id,
          platform: "h200",
          label: `H200 - ${acc.usn}${acc.name ? ` (${acc.name})` : ""}`,
          accountName: acc.h200?.user || `nnm23cs${acc.roll}_stu_cse`,
          usn: acc.usn,
          roll: acc.roll,
          connected: false,
          connectionDetails: `No H200 password in .env for ${acc.name || acc.usn}`,
          currentJob: null,
        };
      }

      let connected = false;
      let envReady = null;
      let nnunetReady = null;
      const runStates = {};
      let connDetails = isDirectH200
        ? "Direct college network route"
        : `Outside college, via jump host ${route.jump}`;
      let currentJob = null;

      if (!isHostReachable && !route.remote) {
        connDetails = "Unreachable on direct college network (connect to college WiFi or jump host)";
      } else {
        let session = null;
        try {
          session = await chooseH200(root, acc.roll);
          const testRes = await runSshCommand(session, "echo OK", 5000);
          if (testRes.code === 0 && testRes.out.includes("OK")) {
            connected = true;
            const statusRes = await runSshCommand(
              session,
              `squeue -u $USER -h -o '%i|%j|%T|%M|%l|%r'; ` +
              `echo "===RESULTS==="; ` +
              `cd $HOME/bme/data 2>/dev/null && for d in ${H200_RUNS.map((r) => r.folder).join(" ")}; do ` +
              `[ -f $d/metrics.json ] && echo "$d|finished"; ` +
              `[ ! -f $d/metrics.json ] && [ -n "$(ls -A $d 2>/dev/null | grep -v -e '^run_status.json$' -e '^dataset_manifest.json$')" ] && echo "$d|stopped"; done; ` +
              `echo "===ENV==="; [ -x $HOME/bme/env/bin/python3 ] && echo ENV_OK; ` +
              `$HOME/bme/env/bin/python3 -c "import nnunetv2" 2>/dev/null && echo NNUNET_OK; ` +
              `echo "===LAST==="; sacct -u $USER -S now-3days -X -n -P --format=JobID,JobName,State,Elapsed 2>/dev/null | tail -1; ` +
              `e=$(ls -t $HOME/bme/logs/*.err 2>/dev/null | head -1); [ -n "$e" ] && tail -n 1 "$e"; ` +
              `echo "===PARTS==="; ` +
              `for p in ${[...new Set(H200_RUNS.map((r) => r.log))].join(" ")}; do echo "$p|$(find $HOME/bme/logs -regex ".*/\${p}_[0-9]+\\.out" -size +600c 2>/dev/null | wc -l)"; done; ` +
              `echo "===LOG==="; ` +
              `f=$(ls -t $HOME/bme/logs/*.out 2>/dev/null | head -1); [ -n "$f" ] && { echo "FILE:$f"; tail -n 25 "$f"; }; true`,
              12000
            );

            if (statusRes.code === 0) {
              const [squeuePart, rest1 = ""] = statusRes.out.split("===RESULTS===");
              const [resultsAndParts, logPart = ""] = rest1.split("===LOG===");
              const [beforeParts, partsPart = ""] = resultsAndParts.split("===PARTS===");
              const [beforeLast, lastPart = ""] = beforeParts.split("===LAST===");
              const [resultsPart, envPart = ""] = beforeLast.split("===ENV===");
              envReady = envPart.includes("ENV_OK");
              nnunetReady = envPart.includes("NNUNET_OK");
              const lastLines = lastPart.trim().split(/\r?\n/).filter(Boolean);
              const [lastId = "", lastName = "", lastState = "", lastElapsed = ""] = (lastLines[0] || "").split("|");
              const lastErr = lastLines[1] || "";
              const partsByLog = {};
              for (const line of partsPart.trim().split(/\r?\n/).filter(Boolean)) {
                const [k, n] = line.split("|");
                partsByLog[k] = Number(n) || 0;
              }
              const folderState = {};
              for (const line of resultsPart.trim().split(/\r?\n/).filter(Boolean)) {
                const [f, st] = line.split("|");
                folderState[f] = st;
              }
              for (const r of H200_RUNS) if (folderState[r.folder]) runStates[r.methodId] = folderState[r.folder];
              let run = null;

              const activeJobLine = squeuePart.trim().split(/\r?\n/).filter(Boolean)[0];
              const logLines = logPart.trim().split(/\r?\n/).filter(Boolean);
              const tailText = logLines.join("\n");

              let jobStatus = "idle";
              let queueReason = "";
              let ownLog = null;
              let nnProgress = null;
              let resumePending = false;
              let methodId = "";
              let methodLabel = "";
              let slurmJobId = "";
              let jname = "";
              let startedAt = null;
              let partStartedAt = null;
              let partCount = 0;
              let partLog = [];
              let intermediateResults = null;
              let elapsedSeconds = null;

              if (activeJobLine) {
                const [jid, jobName, jstate, jelapsed, , jreason = ""] = activeJobLine.split("|");
                slurmJobId = jid;
                jname = jobName;
                jobStatus = jstate === "RUNNING" || jstate === "COMPLETING" ? "running" : "queued";
                queueReason = jreason;
                const sameJob = H200_RUNS.filter((r) => r.job === jname);
                run = sameJob.find((r) => folderState[r.folder] === "stopped") || sameJob[0] || null;
                methodId = run ? run.methodId : jname.replace(/^bme_/, "");
                methodLabel = run ? `${run.label} (job ${jid})` : `Job ${jid} (${jname})`;
                const parts = (jelapsed || "").split(":").map(Number);
                if (parts.length === 3) elapsedSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
                else if (parts.length === 2) elapsedSeconds = parts[0] * 60 + parts[1];
              } else {
                run = H200_RUNS.find((r) => folderState[r.folder] === "stopped") || null;
                if (run) {
                  jname = run.job;
                  jobStatus = "stopped";
                  resumePending = true;
                  methodId = run.methodId;
                  methodLabel = run.label;
                }
              }

              let metaStartedBy = { usn: acc.usn, name: acc.name || acc.roll };
              let metaAccount = acc.h200?.user || `nnm23cs${acc.roll}_stu_cse`;
              let metaHost = "";
              const statusFile = path.join(root, "data", run ? run.folder : `results3d-${methodId}`, "run_status.json");
              let datasetNote = "";
              try {
                const dm = JSON.parse(fs.readFileSync(path.join(path.dirname(statusFile), "dataset_manifest.json"), "utf8"));
                const when = new Date(dm.created).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
                datasetNote = `${dm.counts.used} of ${dm.counts.annotated} annotated cases (${dm.counts.used_bme} BME, ${dm.counts.used_non_bme} non-BME), snapshot ${when}` +
                  (dm.counts.left_out ? `; ${dm.counts.left_out} left out as incomplete` : "") +
                  (dm.rule && dm.rule.startsWith("every") ? "; started before snapshots, so every annotated case" : "");
              } catch { /* run started before snapshots */ }
              const partsDone = run ? partsByLog[run.log] || 0 : 0;
              if (fs.existsSync(statusFile)) {
                try {
                  const meta = JSON.parse(fs.readFileSync(statusFile, "utf8"));
                  if (meta.startedBy) metaStartedBy = meta.startedBy;
                  // Runs started from this PC before the operator was recorded
                  // carry the account owner's name; the person here started them.
                  if (!meta.accountOwner && meta.host === os.hostname()) metaStartedBy = { usn: "", name: operator() };
                  if (meta.account) metaAccount = meta.account;
                  if (meta.host) metaHost = meta.host;
                  if (meta.startedAt) startedAt = meta.startedAt;
                  if (meta.partStartedAt) partStartedAt = meta.partStartedAt;
                  if (meta.parts) partCount = meta.parts;
                  if (Array.isArray(meta.partLog)) partLog = meta.partLog;
                } catch {}
              }

              let partNo = Math.max(1, partsDone);
              if (run) {
                try {
                  const remStatus = await runSshCommand(session, `cat $HOME/bme/data/${run.folder}/run_status.json 2>/dev/null; true`, 5000);
                  const rMeta = JSON.parse((remStatus.out || "").trim() || "{}");
                  if (rMeta.startedAt && (!startedAt || new Date(rMeta.startedAt) < new Date(startedAt))) startedAt = rMeta.startedAt;
                  if (rMeta.partStartedAt && !partStartedAt) partStartedAt = rMeta.partStartedAt;
                  if (rMeta.parts && !partCount) partCount = rMeta.parts;
                  if (Array.isArray(rMeta.partLog) && rMeta.partLog.length > partLog.length) partLog = rMeta.partLog;
                } catch {}
              }
              if (run && slurmJobId) {
                const nn = run.methodId.startsWith("nnunet")
                  ? `cd $HOME/bme/data/nnunet/results/Dataset501_BMEKnee/nnUNetTrainer_BME100${run.methodId.endsWith("-noaug") ? "NoDA" : ""}__nnUNetResEncUNetMPlans__${run.methodId.includes("2d") ? "2d" : "3d_fullres"} 2>/dev/null && ` +
                    `for f in 0 1 2 3 4; do if [ -f fold_$f/checkpoint_final.pth ]; then echo "FOLD $f 100"; else echo "FOLD $f $(cat fold_$f/training_log_*.txt 2>/dev/null | grep -c 'Epoch time')"; fi; done; ` +
                    `cat fold_*/training_log_*.txt 2>/dev/null | grep -E 'Epoch [0-9]+|train_loss|Pseudo dice|Epoch time' | tail -n 8; `
                  : "";
                const firstLine = await runSshCommand(
                  session,
                  `sacct -u $USER -X -n -P -S 2026-11-01 --format=JobName,Start 2>/dev/null | awk -F'|' -v n='${(jname || "").replace(/'/g, "")}' '$1==n && $2!="Unknown" && $2!="" {print $2}' | sort | head -1; true`,
                  10000
                );
                const slurmFirst = (firstLine.out || "").trim().split(/\r?\n/).pop() || "";
                if (slurmFirst && (!startedAt || new Date(slurmFirst.replace(" ", "T")) < new Date(startedAt))) {
                  startedAt = new Date(slurmFirst.replace(" ", "T") + "Z").toISOString();
                }
                const own = await runSshCommand(
                  session,
                  `echo "PRIOR $(find $HOME/bme/logs -regex ".*/${run.log}_[0-9]+\\.out" -size +600c ! -name "${run.log}_${slurmJobId}.out" 2>/dev/null | wc -l)"; ` +
                  `echo "===OWN==="; tail -n 20 $HOME/bme/logs/${run.log}_${slurmJobId}.out 2>/dev/null; ` +
                  `echo "===NN==="; ${nn}true`,
                  10000
                );
                if (own.code === 0) {
                  const prior = Number((own.out.match(/PRIOR (\d+)/) || [])[1] || 0);
                  partNo = prior + 1;
                  const [, afterOwn = ""] = own.out.split("===OWN===");
                  const [ownPart, nnPart = ""] = afterOwn.split("===NN===");
                  ownLog = ownPart.trim().split(/\r?\n/).filter(Boolean).map((l) => l.slice(0, 240));
                  const folds = [...nnPart.matchAll(/FOLD (\d) (\d+)/g)];
                  if (folds.length) {
                    const done = folds.reduce((a, m) => a + Math.min(100, Number(m[2])), 0);
                    const cur = folds.findIndex((m) => Number(m[2]) < 100);
                    nnProgress = {
                      doneEpochs: done,
                      totalEpochs: 500,
                      doneFolds: folds.filter((m) => Number(m[2]) >= 100).length,
                      totalFolds: 5,
                      currentFold: cur < 0 ? 4 : cur,
                      currentEpoch: cur < 0 ? 100 : Number(folds[cur][2]),
                      percent: Math.round((done / 500) * 100),
                      etaSeconds: null,
                    };
                    const nnTimes = [...nnPart.matchAll(/Epoch time: ([\d.]+) s/g)].map((m) => Number(m[1]));
                    if (nnTimes.length) {
                      const per = nnTimes.reduce((a, b) => a + b, 0) / nnTimes.length;
                      nnProgress.secPerEpoch = Math.round(per);
                      nnProgress.etaSeconds = Math.round((500 - done) * per);
                    }
                    const nnLines = nnPart.trim().split(/\r?\n/).filter((l) => l && !l.startsWith("FOLD ")).map((l) => l.slice(0, 240));
                    if (nnLines.length) ownLog = nnLines;
                  }
                  const logCombined = [...(ownLog || []), ...(logLines || [])].join("\n");
                  const lastLoss = [...logCombined.matchAll(/train_loss:\s*([\d.]+)/gi)].pop()?.[1] || null;
                  const lastDice = [...logCombined.matchAll(/Pseudo dice:\s*([\d.]+)/gi)].pop()?.[1] || null;
                  const foldsDoneCount = folds.filter((m) => Number(m[2]) >= 100).length;
                  if (foldsDoneCount > 0 || lastDice || lastLoss) {
                    intermediateResults = {
                      foldsDone: foldsDoneCount,
                      totalFolds: 5,
                      currentFold: nnProgress ? nnProgress.currentFold : undefined,
                      currentEpoch: nnProgress ? nnProgress.currentEpoch : undefined,
                      trainLoss: lastLoss ? Number(lastLoss) : null,
                      pseudoDice: lastDice ? Number(lastDice) : null,
                      summaryText: `Folds finished: ${foldsDoneCount}/5${lastDice ? ` | Latest Pseudo dice: ${lastDice}` : ""}${lastLoss ? ` | Loss: ${lastLoss}` : ""}`,
                    };
                  }
                }
              }
              const progress = jobStatus === "queued" ? null : nnProgress || parseLogProgress((ownLog || logLines).join("\n"), 5, 40, startedAt);

              // One job is one part of at most 3 h 45 m. Say how many more are needed.
              let partsNote = "";
              if (jobStatus === "running" && progress?.etaSeconds && elapsedSeconds != null) {
                const leftInPart = Math.max(0, 13500 - elapsedSeconds);
                partsNote = progress.etaSeconds <= leftInPart
                  ? " It should finish inside this part."
                  : ` This part stops at 3 h 45 m with a checkpoint; about ${Math.ceil((progress.etaSeconds - leftInPart) / 13500)} more part(s) after it.`;
              }

              // The newest job ended in failure: say so instead of offering "Continue".
              const lastFailed = !activeJobLine && /FAILED|OUT_OF_MEMORY|NODE_FAIL/.test(lastState) && lastName.startsWith("bme_");
              if (lastFailed) {
                const failedRun = H200_RUNS.filter((r) => r.job === lastName).find((r) => !run || r === run) || run;
                const why = /env\/bin\/python3: No such file/.test(lastErr)
                  ? "this account has no Python environment yet (run: pnpm h200 setup)"
                  : lastErr.slice(0, 160) || "see the log on the server";
                currentJob = {
                  methodId: failedRun?.methodId || methodId,
                  methodLabel: `${failedRun?.label || lastName} (job ${lastId})`,
                  iteration: `Job ${lastId} failed after ${lastElapsed}: ${why}`,
                  startedBy: metaStartedBy,
                  startedAt,
                  elapsedSeconds: null,
                  status: "failed",
                  resumePending: false,
                  resumeAutomatic: false,
                  slurmJobId: lastId,
                  logTail: [lastErr, ...logLines.slice(-8)].filter(Boolean),
                  progress: null,
                };
              } else if (jobStatus !== "idle" || resumePending) {
                currentJob = {
                  methodId,
                  methodLabel: methodLabel || methodId,
                  partStartedAt,
                  partCount,
                  dataset: datasetNote || undefined,
                  partLog,
                  intermediateResults,
                  iteration: resumePending
                    ? `Part ${partsDone} ended, not finished. Press Continue for part ${partsDone + 1}.`
                    : jobStatus === "queued"
                    ? `Part ${partNo} is waiting in the H200 queue (${queueReason || "no free GPU slot"}). Nothing has run yet.`
                    : `Part ${partNo} running.${partsNote}`,
                  partsDone,
                  startedBy: metaStartedBy,
                  startedAt,
                  elapsedSeconds,
                  status: jobStatus,
                  resumePending,
                  resumeAutomatic: false,
                  slurmJobId,
                  logTail: jobStatus === "queued"
                    ? ["Waiting for a free GPU slot on the H200. The log starts when the job starts."]
                    : ownLog && ownLog.length ? ownLog : ["No output from this job yet."],
                  progress,
                };
                cacheCardJob(id, currentJob);
              }
            }
          } else {
            connDetails = `SSH connection refused or host key mismatch: ${testRes.err.slice(0, 100)}`;
          }
        } catch (err) {
          connDetails = `Connection failed: ${String(err.message || err).slice(0, 120)}`;
        } finally {
          if (session) session.close();
        }
      }

      if (!currentJob && !connected) {
        const cached = readCachedCardJob(id);
        if (cached?.currentJob) {
          currentJob = {
            ...cached.currentJob,
            isCached: true,
            cachedAt: new Date(cached.at).toISOString(),
          };
        }
      }

      return {
        runStates,
        autoRuns: readAutoRuns().filter((r) => r.target === id),
        id,
        envReady,
        nnunetReady,
        platform: "h200",
        label: `H200 - ${acc.usn}${acc.name ? ` (${acc.name})` : ""}`,
        accountName: acc.h200?.user || `nnm23cs${acc.roll}_stu_cse`,
        usn: acc.usn,
        roll: acc.roll,
        connected,
        connectionDetails: connDetails,
        isRemoteRoute: route.remote,
        jumpHost: route.jump,
        currentJob,
      };
    })
  );

  // 2. Parallel Kaggle cards check
  const kaggleAccounts = all.filter(usable.kaggle);
  const isKaggleCliReady = kaggleReady();
  const kaggleCards = await Promise.all(
    kaggleAccounts.map(async (acc) => {
      const slotNum = acc.slot || 1;
      const slotUser = acc.kaggleUser || acc.kaggle?.user || "";
      const id = `kaggle-${acc.roll}-${slotNum}`;
      let connected = isKaggleCliReady;
      let connDetails = isKaggleCliReady
        ? `Kaggle API configured for ${slotUser || acc.label}`
        : "Kaggle package not installed in ml/.venv";

      let currentJob = null;
      const { run } = kaggleLocalState(acc);

      if (run) {
        let phase = String(run.phase || "").toUpperCase();
        let liveStatus = phase;
        let logTail = [];

        if (["QUEUED", "RUNNING"].includes(phase) && isKaggleCliReady) {
          const kernelSlug = String(run.kernel_slug || "").split("/").pop();
          if (kernelSlug) {
            try {
              const liveRes = kaggle(acc, ["status", "--kernel-slug", kernelSlug], { capture: true });
              const m = liveRes.out.match(/:\s*([A-Z_]+)/);
              if (m) liveStatus = m[1].toUpperCase();

              const logRes = kaggle(acc, ["logs", "--kernel-slug", kernelSlug], { capture: true });
              if (logRes.out) logTail = logRes.out.trim().split(/\r?\n/).slice(-25);
            } catch {}
          }
        }

        let jobStatus = "idle";
        let resumePending = false;
        if (["QUEUED", "RUNNING"].includes(liveStatus)) jobStatus = "running";
        else if (liveStatus === "INCOMPLETE") {
          jobStatus = "incomplete";
          resumePending = true;
        } else if (liveStatus === "COMPLETED") jobStatus = "finished";
        else if (liveStatus === "FAILED") jobStatus = "failed";

        const methodId = run.import_name || run.model_arch || "k-unet3d";
        const startedAt = run.startedAt || null;
        let elapsedSeconds = null;
        if (startedAt) {
          elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
        }

        const progress = parseLogProgress(logTail.join("\n"), 5, 40, startedAt);

        currentJob = {
          methodId,
          methodLabel: run.model_arch ? `${methodId} (${run.model_arch})` : methodId,
          iteration: resumePending ? "Resume pending (--continue-previous)" : "1st run",
          startedBy: run.startedBy || { usn: acc.usn, name: acc.name || slotUser },
          startedAt,
          elapsedSeconds,
          status: jobStatus,
          resumePending,
          resumeAutomatic: false,
          kernelSlug: run.kernel_slug,
          logTail,
          progress,
        };
        cacheCardJob(id, currentJob);
      }

      if (!currentJob) {
        const cached = readCachedCardJob(id);
        if (cached?.currentJob) {
          currentJob = {
            ...cached.currentJob,
            isCached: true,
            cachedAt: new Date(cached.at).toISOString(),
          };
        }
      }

      return {
        id,
        platform: "kaggle",
        label: `Kaggle - ${slotUser || acc.label}${slotNum > 1 ? ` (slot ${slotNum})` : ""}`,
        accountName: slotUser || acc.label,
        usn: acc.usn,
        roll: acc.roll,
        slot: slotNum,
        connected,
        connectionDetails: connDetails,
        currentJob,
      };
    })
  );

  const cards = [...h200Cards, ...kaggleCards];

  // 3. This PC card
  const d = detectDevice();
  const dDesc = describeDevice(d);
  let localJob = null;

  // Check data/ for local running jobs
  const dataDir = path.join(root, "data");
  if (fs.existsSync(dataDir)) {
    const pcDirs = fs.readdirSync(dataDir).filter((x) => /^results3d-.*-pc$/.test(x));
    for (const dName of pcDirs) {
      const dirPath = path.join(dataDir, dName);
      const isFin = fs.existsSync(path.join(dirPath, "metrics.json"));
      const statusFile = path.join(dirPath, "run_status.json");
      let meta = null;
      if (fs.existsSync(statusFile)) {
        try { meta = JSON.parse(fs.readFileSync(statusFile, "utf8")); } catch {}
      }

      const pidFile = path.join(dirPath, "train.pid");
      let pid = null;
      let isAlive = false;
      if (fs.existsSync(pidFile)) {
        pid = Number(fs.readFileSync(pidFile, "utf8").trim());
        try {
          process.kill(pid, 0);
          isAlive = true;
        } catch {
          isAlive = false;
        }
      }

      if (isAlive || (!isFin && meta)) {
        const logFile = path.join(dirPath, "train.log");
        const heartbeatFile = path.join(dirPath, "heartbeat.json");
        let lastActivityMs = 0;
        if (fs.existsSync(heartbeatFile)) {
          try { lastActivityMs = JSON.parse(fs.readFileSync(heartbeatFile, "utf8")).at || 0; } catch {}
        } else if (fs.existsSync(logFile)) {
          try { lastActivityMs = fs.statSync(logFile).mtimeMs; } catch {}
        }
        const isStalled = isAlive && lastActivityMs > 0 && (Date.now() - lastActivityMs > 10 * 60 * 1000);
        const effectiveAlive = isAlive && !isStalled;

        let logLines = [];
        if (fs.existsSync(logFile)) {
          logLines = fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).slice(-25);
        }
        const methodId = dName.replace(/^results3d-/, "").replace(/-pc$/, "");
        const startedAt = meta?.startedAt || null;
        let elapsedSeconds = null;
        if (startedAt) {
          elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
        }

        localJob = {
          methodId,
          methodLabel: `${methodId} (Local PC)`,
          iteration: "1st run",
          startedBy: meta?.startedBy || { usn: "LOCAL", name: os.userInfo().username },
          startedAt,
          elapsedSeconds,
          status: effectiveAlive ? "running" : isFin ? "finished" : "stopped",
          resumePending: !effectiveAlive && !isFin,
          resumeAutomatic: false,
          pid: pid || undefined,
          logTail: logLines,
          progress: parseLogProgress(logLines.join("\n"), 5, 40, startedAt),
        };
        break;
      }
    }
  }

  cards.push({
    id: "this-pc",
    platform: "local",
    label: `This PC (${os.hostname()})`,
    accountName: os.userInfo().username,
    connected: true,
    connectionDetails: `Device: ${dDesc}`,
    deviceInfo: dDesc,
    currentJob: localJob,
  });

  return { cards, route };
}

// ---------- RUNS COMMAND -----------------------------------------------------
async function handleRuns() {
  const dataDir = path.join(root, "data");
  const runs = [];

  // 1. Folders in data/
  if (fs.existsSync(dataDir)) {
    const dirs = [];
    for (const d of fs.readdirSync(dataDir)) {
      if (/^results3d/.test(d) && d !== "results3d_experiments") dirs.push(d);
      if (/^results-nnunet/.test(d)) dirs.push(d);
    }
    const expDir = path.join(dataDir, "results3d_experiments");
    if (fs.existsSync(expDir)) {
      for (const d of fs.readdirSync(expDir)) dirs.push(`results3d_experiments/${d}`);
    }

    for (const d of dirs) {
      const dirPath = path.join(dataDir, d);
      const metricsFile = path.join(dirPath, "metrics.json");
      const statusFile = path.join(dirPath, "run_status.json");

      let m = null;
      let meta = null;
      if (fs.existsSync(metricsFile)) {
        try { m = JSON.parse(fs.readFileSync(metricsFile, "utf8")); } catch {}
      }
      if (fs.existsSync(statusFile)) {
        try { meta = JSON.parse(fs.readFileSync(statusFile, "utf8")); } catch {}
      }

      if (!m && !meta) continue;

      const baseName = path.basename(d);
      const methodId = meta?.methodId || m?.model_arch || m?.model || baseName;
      const matchedMethod = METHODS.find((x) => x.id === methodId || baseName.includes(x.id));
      const methodLabel = matchedMethod ? matchedMethod.label : methodId;

      let platform = meta?.platform || (d.startsWith("results3d_experiments") ? "kaggle" : "local");
      let platformLabel = !meta?.platform && platform === "local"
        ? "Local folder (origin not recorded)"
        : platform === "h200" ? "College H200" : platform === "kaggle" ? "Kaggle" : "This PC";

      const startedBy = meta?.startedBy || m?.startedBy || { usn: "-", name: "Unknown" };
      const account = meta?.account || m?.account || "-";
      const startedAt = meta?.startedAt || m?.trained_at || null;

      const isFin = Boolean(m);
      const status = isFin ? "finished" : "stopped";

      const s = m?.summary || {};
      const folds = m?.fold_mode === "fixed_holdout_80_20" ? "80/20 holdout" : `${m?.folds || 5} folds`;

      runs.push({
        id: d,
        methodId,
        methodLabel,
        datasetVersion: meta?.datasetVersion || m?.dataset_hash?.slice(0, 8) || "v1-baseline",
        nCases: m?.n_cases ?? "?",
        bmeCount: m?.bme_cases,
        nonBmeCount: m?.non_bme_cases,
        folds,
        foldMode: m?.fold_mode,
        iteration: meta?.iteration ? `${meta.iteration} run` : "1st run",
        status,
        startedBy,
        platform,
        platformLabel,
        account,
        host: meta?.host,
        startedAt,
        metrics: m ? {
          boneDice: s.bone_dice || null,
          bmeDicePos: s.bme_dice_pos || s.bme_dice || null,
          lesionSensitivityPos: s.lesion_sensitivity_pos || s.lesion_sensitivity || null,
          cleanScanSpecificity: s.clean_scan_specificity || null,
          fpPerCase: s.fp_per_case || null,
        } : null,
      });
    }
  }

  // 2. Add staged Kaggle runs not yet in results3d_experiments
  const all = listAccounts(mergedEnv()).filter(usable.kaggle);
  for (const acc of all) {
    const { run } = kaggleLocalState(acc);
    if (!run) continue;
    const importName = run.import_name || run.model_arch || "k-run";
    const exists = runs.some((r) => r.id.includes(importName));
    if (!exists) {
      let phase = String(run.phase || "").toLowerCase();
      let status = "stopped";
      if (["queued", "running"].includes(phase)) status = "running";
      else if (phase === "completed") status = "finished";
      else if (phase === "failed") status = "failed";
      else if (phase === "incomplete") status = "incomplete";

      runs.push({
        id: `kaggle-staging-${acc.roll}-${importName}`,
        methodId: importName,
        methodLabel: `${importName} (Kaggle)`,
        datasetVersion: "kaggle-export",
        nCases: run.n_cases || "?",
        folds: "5 folds",
        iteration: status === "incomplete" ? "Resume pending" : "1st run",
        status,
        startedBy: run.startedBy || { usn: acc.usn, name: acc.kaggleUser || acc.label },
        platform: "kaggle",
        platformLabel: "Kaggle",
        account: acc.kaggleUser || acc.label,
        startedAt: run.startedAt || null,
        metrics: null,
      });
    }
  }

  return runs;
}

// ---------- DATASET STATUS COMMAND -------------------------------------------
function readCachedH200Plan(roll) {
  const cacheFile = path.join(root, "data", ".cache", `h200_plan_${roll}.json`);
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (!c.error) return c;
  } catch {}
  return null;
}

function writeH200Plan(roll, plan) {
  const dir = path.join(root, "data", ".cache");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `h200_plan_${roll}.json`), JSON.stringify({ ...plan, at: Date.now() }));
}

// Asks the server what a sync would send, without copying anything.
function handleDatasetPlan(targetId) {
  const roll = targetId.replace("h200-", "");
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "h200-menu.js"), "push", "--as", roll, "--plan"], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 180000,
  });
  const m = /PLAN (\{.*\})/.exec(r.stdout || "");
  if (!m) throw new Error(`Could not check the H200 for ${roll}: ${(r.stdout || r.stderr || "").trim().split(/\r?\n/).slice(-3).join(" ")}`);
  const plan = JSON.parse(m[1]);
  writeH200Plan(roll, plan);
  return { success: true, targetId, ...plan };
}

async function handleDatasetStatus() {
  const env = mergedEnv();
  const all = listAccounts(env);
  const { owner } = datasetOwner(env);
  const route = await h200Route(env);

  // 1. Get local export status
  let localExport = { cases: 0, files: 0, bytes: 0, hash: "unknown" };
  let needsUpload = false;
  let uploadReason = "";
  if (owner && kaggleReady()) {
    const st = kaggleJson(owner, ["data-status"]);
    if (st.export) localExport = st.export;
    needsUpload = Boolean(st.needs_upload);
    uploadReason = st.reason || "";
  }

  // No Kaggle export yet: describe the local training dataset straight from disk.
  if (localExport.hash === "unknown") {
    try {
      const annDir = path.join(root, "data", "annotations");
      let cases = 0, files = 0, bytes = 0, newest = 0;
      for (const cid of fs.readdirSync(annDir)) {
        const seg = path.join(annDir, cid, `${cid}.seg.nrrd`);
        if (!fs.existsSync(seg)) continue;
        cases++;
        const st = fs.statSync(seg);
        files++; bytes += st.size; newest = Math.max(newest, st.mtimeMs);
        const dir = path.join(root, "data", "nifti", cid);
        let series = "primary";
        try { series = JSON.parse(fs.readFileSync(path.join(dir, "series.json"), "utf8")).annotated || "primary"; } catch {}
        for (const name of [`${cid}_${series}.nii.gz`, `${cid}_primary.nii.gz`]) {
          const vol = path.join(dir, name);
          if (fs.existsSync(vol)) { files++; bytes += fs.statSync(vol).size; break; }
        }
      }
      localExport = { cases, files, bytes, hash: newest ? `local-${new Date(newest).toISOString().slice(0, 10)}` : "unknown" };
    } catch {}
  }

  // Active sync locks from cache (no slow remote calls)
  const syncLockDir = path.join(root, "data", ".cache");
  const activeSyncTargets = new Set();
  try {
    if (fs.existsSync(syncLockDir)) {
      for (const f of fs.readdirSync(syncLockDir)) {
        if (f.startsWith("sync_") && f.endsWith(".json")) {
          const lockPath = path.join(syncLockDir, f);
          let alive = false;
          try {
            const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
            try { process.kill(lock.pid, 0); alive = true; } catch (e) { alive = e?.code === "EPERM"; }
          } catch {}
          if (alive) activeSyncTargets.add(f.replace("sync_", "").replace(".json", ""));
          else { try { fs.unlinkSync(lockPath); } catch {} }
        }
      }
    }
  } catch {}

  const targets = [];

  // H200 targets
  for (const acc of all.filter(usable.h200)) {
    const targetId = `h200-${acc.roll}`;
    const plan = readCachedH200Plan(acc.roll);
    targets.push({
      targetId,
      platform: "h200",
      label: `H200 - ${acc.usn} (${acc.name || acc.roll})`,
      datasetVersion: "server-synced",
      localExportVersion: localExport.hash,
      isUpToDate: Boolean(plan && !plan.error && plan.files === 0),
      casesCount: localExport.cases,
      filesCount: plan && !plan.error ? plan.files : localExport.files,
      bytesToSync: plan && !plan.error ? plan.bytes : localExport.bytes,
      filesSame: plan ? plan.same : null,
      checkedAt: plan ? new Date(plan.at).toISOString() : null,
      isRemoteRoute: route.remote,
      routeLabel: route.label,
      runningJobBlocking: null,
    });
  }

  // Kaggle: one row per usable account. Each account has its own dataset and
  // staging folder, so each row is checked and synced with its own credentials.
  for (const acc of all.filter(usable.kaggle)) {
    const slot = acc.slot || 1;
    const targetId = `kaggle-${acc.roll}-${slot}`;
    const isOwner = Boolean(owner && owner.roll === acc.roll && (owner.slot || 1) === slot);

    let hasUploaded = false;
    let isEmpty = true;
    let lastUpdated = null;
    let uploadedHash = null;
    const appFile = path.join(stagingFor(acc), "dataset_approval.json");
    if (fs.existsSync(appFile)) {
      try {
        const appData = JSON.parse(fs.readFileSync(appFile, "utf8"));
        uploadedHash = appData.uploaded_hash || null;
        hasUploaded = Boolean(uploadedHash);
        isEmpty = !hasUploaded || ((appData.case_count || 0) === 0 && (appData.file_count || 0) === 0);
        lastUpdated = appData.uploaded_at || null;
      } catch {}
    }

    const knownLocal = localExport.hash !== "unknown";
    const accNeedsUpload = isOwner
      ? needsUpload || !hasUploaded
      : !hasUploaded || (knownLocal && uploadedHash !== localExport.hash);
    const isUpToDate = hasUploaded && !isEmpty && !accNeedsUpload;

    targets.push({
      targetId,
      platform: "kaggle",
      label: `Kaggle - ${acc.kaggleUser || acc.label}`,
      isOwner,
      datasetVersion: hasUploaded ? (uploadedHash?.slice(0, 12) || "uploaded") : "not-uploaded",
      localExportVersion: localExport.hash,
      isUpToDate,
      reason: isEmpty
        ? "Dataset empty / not uploaded"
        : accNeedsUpload
        ? (isOwner && uploadReason ? uploadReason : "Local data changed")
        : "Up to date",
      casesCount: localExport.cases,
      filesCount: localExport.files,
      bytesToSync: localExport.bytes,
      lastUpdated,
      hasUploaded,
      isEmpty,
      needsUpload: !isUpToDate,
      runningJobBlocking: null,
    });
  }

  // Local target
  targets.push({
    targetId: "this-pc",
    platform: "local",
    label: "This PC (Local storage)",
    datasetVersion: localExport.hash,
    localExportVersion: localExport.hash,
    isUpToDate: true,
    casesCount: localExport.cases,
    filesCount: localExport.files,
    bytesToSync: 0,
    runningJobBlocking: null,
  });

  // Collect available Kaggle datasets for training:
  // Rule: If an account has not yet uploaded for first time or if its dataset is empty, DON'T show it!
  const kaggleDatasets = [];
  const defaultOwnerRoll = owner?.roll || (all.find(usable.kaggle)?.roll || "");
  for (const acc of all.filter(usable.kaggle)) {
    const stagingDir = stagingFor(acc);
    const appFile = path.join(stagingDir, "dataset_approval.json");
    if (!fs.existsSync(appFile)) continue;
    try {
      const appData = JSON.parse(fs.readFileSync(appFile, "utf8"));
      const uploadedHash = appData.uploaded_hash || null;
      const cases = appData.case_count || 0;
      const files = appData.file_count || 0;
      if (uploadedHash && (cases > 0 || files > 0)) {
        kaggleDatasets.push({
          roll: acc.roll,
          slot: acc.slot || 1,
          user: acc.kaggleUser || acc.kaggle?.user || acc.roll,
          label: `${acc.name ? `${acc.name} (${acc.usn || acc.roll})` : acc.roll}`,
          uploadedAt: appData.uploaded_at || null,
          uploadedHash,
          caseCount: cases,
          fileCount: files,
          isDefault: acc.roll === defaultOwnerRoll,
        });
      }
    } catch {}
  }

  return { localExport, targets, kaggleDatasets, defaultDatasetOwner: defaultOwnerRoll };
}

// ---------- DATASET SYNC COMMAND ---------------------------------------------
// Runs a command and passes each output line to this process's stdout as it
// comes, so the dashboard can show live progress.
function runStreaming(cmd, args, { env = process.env } = {}) {
  const merged = { ...env, PYTHONUNBUFFERED: "1" };
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, env: merged, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { const s = chunk.toString(); out += s; process.stdout.write(s); });
    child.stderr.on("data", (chunk) => { const s = chunk.toString(); err += s; process.stdout.write(s); });
    child.on("error", (e) => resolve({ status: 1, stdout: out, stderr: String(e.message || e) }));
    child.on("close", (code) => resolve({ status: code ?? 1, stdout: out, stderr: err }));
  });
}

async function handleDatasetSync(targetId, confirmed = false, isFresh = false) {
  const { targets } = await handleDatasetStatus();
  const target = targets.find((t) => t.targetId === targetId);
  if (!target) {
    throw new Error(`Target not found: ${targetId}`);
  }

  if (target.platform === "kaggle") {
    const m = /^kaggle-(.+)-(\d+)$/.exec(targetId);
    const syncAcc = m
      ? listAccounts(mergedEnv()).filter(usable.kaggle).find((a) => a.roll === m[1] && String(a.slot || 1) === m[2])
      : null;
    if (!syncAcc) throw new Error(`No Kaggle account found for ${targetId}`);

    // Require explicit confirmation for internet data upload
    if (!confirmed) {
      const sizeStr = target.bytesToSync ? `${(target.bytesToSync / (1024 * 1024)).toFixed(1)} MB` : "dataset";
      return {
        success: false,
        requiresConfirmation: true,
        bytesToSync: target.bytesToSync,
        formattedSize: sizeStr,
        message: `Uploading dataset to Kaggle will transfer ~${sizeStr} over your internet connection. Confirmation required.`,
      };
    }

    const kaggleArgs = [PIPELINE, "--src", root, "update-dataset"];
    if (isFresh) kaggleArgs.push("--force");

    const r = await runStreaming(python, kaggleArgs, { env: kaggleEnv(syncAcc) });
    if (r.status !== 0) throw new Error(`Kaggle dataset upload failed: ${r.stderr || r.stdout}`);
    return { success: true, message: `Kaggle dataset ${isFresh ? "fresh upload" : "update"} completed for ${syncAcc.label}.` };
  } else if (target.platform === "h200") {
    const roll = targetId.replace("h200-", "");
    const route = await h200Route(mergedEnv());

    // Internet route safety check:
    // If connected through Internet (jump host) and not confirmed, prompt for confirmation with size
    if (route.remote && !confirmed) {
      const sizeStr = target.bytesToSync ? `${(target.bytesToSync / (1024 * 1024)).toFixed(1)} MB` : "estimated data";
      return {
        success: false,
        requiresConfirmation: true,
        isRemoteRoute: true,
        bytesToSync: target.bytesToSync,
        formattedSize: sizeStr,
        message: `H200 is connected through the Internet (jump host: ${route.jump || "pc-server-1"}). Syncing requires ~${sizeStr} using your internet data. Confirmation required.`,
      };
    }

    const pushArgs = [path.join(root, "scripts", "h200-menu.js"), "push", "--as", roll];
    if (isFresh) {
      pushArgs.push("--fresh");
    }
    if (confirmed || route.remote) {
      pushArgs.push("--yes");
    }

    const r = await runStreaming(process.execPath, pushArgs);
    if (r.status !== 0) throw new Error(`H200 push failed: ${r.stderr || r.stdout}`);
    const sent = /Sending (\d+) file/.exec(r.stdout);
    const same = /unchanged: (\d+) file/.exec(r.stdout);
    writeH200Plan(roll, { files: 0, bytes: 0, same: Number(sent?.[1] || 0) + Number(same?.[1] || 0) });
    const routeMsg = route.remote ? "over Internet jump route" : "via direct local college network";
    const modeMsg = isFresh ? "Fresh re-upload" : "Incremental sync";
    return { success: true, message: `H200 files pushed (${modeMsg}) for roll ${roll} (${routeMsg}).` };
  } else {
    return { success: true, message: "Local data is the primary copy." };
  }
}

// ---------- START COMMAND ----------------------------------------------------
async function handleStart(platform, targetId, methodId, extraJson = "{}") {
  let extra = {};
  try { extra = JSON.parse(extraJson || "{}"); } catch {}

  const env = mergedEnv();
  const all = listAccounts(env);

  if (platform === "kaggle") {
    const roll = targetId.replace("kaggle-", "").split("-")[0];
    const account = findAccount(all, roll);
    if (!account) throw new Error(`Kaggle account ${roll} not found in .env`);

    const m = METHODS.find((x) => x.id === methodId);
    if (!m) throw new Error(`Unknown method: ${methodId}`);

    const meta = createRunMetadata({ account, platform: "kaggle", methodId });
    const stagingDir = stagingFor(account);
    fs.mkdirSync(stagingDir, { recursive: true });
    const statePath = path.join(stagingDir, "run_state.json");
    const existingState = kaggleLocalState(account).run || {};
    fs.writeFileSync(statePath, JSON.stringify({ ...existingState, ...meta }, null, 2), "utf8");

    const lvl = ["none", "low", "med", "max"].includes(extra.augLevel) ? extra.augLevel : "med";
    const runName = lvl === "med" ? methodId : `${methodId}-${lvl}`;
    const args = [
      "run", "--confirm-launch", "--no-wait", "--mode", "full",
      "--model-arch", m.arch || "unet3d",
      "--kernel-slug", `bme-${runName}`,
      "--import-name", runName,
      ...KAGGLE_SETTINGS.map((x) => (x === 'AUG_LEVEL="med"' ? (lvl === "none" ? "AUG_LEVEL=None" : `AUG_LEVEL="${lvl}"`) : x)),
    ];

    const datasetOwnerRoll = extra.datasetOwnerRoll || "";
    if (datasetOwnerRoll) {
      const dsOwner = findAccount(all, datasetOwnerRoll);
      if (dsOwner && (dsOwner.roll !== account.roll || (dsOwner.slot || 1) !== (account.slot || 1))) {
        const ownerUser = kaggleUserOf(dsOwner);
        args.push("--dataset-owner", ownerUser, "--approval-dir", stagingFor(dsOwner));
      }
    }

    const r = kaggle(account, args, { extraEnv: { BME_RUN_METADATA: JSON.stringify(meta) } });
    if (r.code !== 0) throw new Error(`Kaggle start failed: ${r.err || r.out}`);
    return { success: true, message: `${methodId} launched on Kaggle for ${account.label}` };
  } else if (platform === "h200") {
    const roll = targetId.replace("h200-", "");
    // Every one of these continues by itself when the run was already started.
    let h200Args = ["aug", ["low", "med", "max"].includes(extra.augLevel) ? extra.augLevel : "med"];
    if (methodId.startsWith("selftest-")) h200Args = ["selftest", methodId.replace("selftest-", "")];
    else if (methodId.startsWith("arch-")) h200Args = ["arch", methodId.split("-")[1], methodId.split("-")[2] || "med"];
    else if (KAGGLE_TO_ARCH[methodId]) h200Args = ["arch", KAGGLE_TO_ARCH[methodId], ["none", "low", "med", "max"].includes(extra.augLevel) ? extra.augLevel : "med"];
    else if (methodId.startsWith("nnunet-")) h200Args = ["best", methodId.includes("2d") ? "2d" : "3d", ...(methodId.endsWith("-noaug") ? ["noaug"] : [])];
    else if (methodId.startsWith("unet-holdout")) h200Args = ["holdout", methodId.replace("unet-holdout", "").replace("-", "") || "med"];
    else if (methodId === "unet-noaug") h200Args = ["plain"];
    else if (methodId.startsWith("unet-aug-")) h200Args = ["aug", methodId.replace("unet-aug-", "")];
    h200Args.push("--as", roll);
    const epochsAsked = Math.round(Number(extra.epochs) || 0);
    const r = await runStreaming(process.execPath, [path.join(root, "scripts", "h200-menu.js"), ...h200Args], {
      env: {
        ...process.env,
        BME_NO_PROMPT: "1",
        ...(h200Args[0] !== "best" && !methodId.startsWith("selftest-") && epochsAsked >= 10 && epochsAsked <= 400
          ? { BME_EPOCHS: String(epochsAsked) }
          : {}),
      },
    });
    if (r.status !== 0 || !/Submitted batch job/.test(r.stdout)) {
      const tail = (r.stderr || r.stdout || "").trim().split(/\r?\n/).slice(-3).join(" | ");
      throw new Error(`H200 did not start the run: ${tail || "no answer from the H200"}`);
    }
    trackRun(targetId, methodId);
    return { success: true, message: `H200 job submitted for ${methodId} on account ${roll}` };
  } else if (platform === "local") {
    const r = spawnSync(process.execPath, [path.join(root, "scripts", "train-local.js"), methodId], {
      windowsHide: true,
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    });
    if (r.status !== 0) throw new Error(`Local start failed: ${r.stderr || r.stdout}`);
    return { success: true, message: `Local training started for ${methodId}` };
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

// ---------- CANCEL COMMAND ---------------------------------------------------
function handleAccountsQuick() {
  const env = mergedEnv();
  const cards = [];
  const all = listAccounts(env);
  for (const acc of all) {
    if (acc.slot && acc.slot > 1) continue;
    const usn = acc.usn || `NNM23CS${acc.roll}`;
    const hasPass = Boolean(acc.h200 && acc.h200.password);
    cards.push({
      id: `h200-${acc.roll}`,
      platform: "h200",
      label: `H200 - ${usn}${acc.name ? ` (${acc.name})` : ""}`,
      accountName: acc.h200?.user || `nnm23cs${acc.roll}_stu_cse`,
      usn,
      roll: acc.roll,
      connected: false,
      connectionDetails: hasPass ? "Checking connection..." : `No H200 password in .env for ${acc.name || usn}`,
      currentJob: null,
      checking: hasPass,
    });
  }
  for (const acc of all) {
    if (!acc.kaggleUser) continue;
    cards.push({
      id: `kaggle-${acc.roll}-${acc.slot || 1}`,
      platform: "kaggle",
      label: `Kaggle - ${acc.kaggleUser}`,
      accountName: acc.kaggleUser,
      usn: acc.usn || `NNM23CS${acc.roll}`,
      roll: acc.roll,
      slot: acc.slot || 1,
      connected: false,
      connectionDetails: "Checking connection...",
      currentJob: null,
      checking: true,
    });
  }
  cards.push({
    id: "this-pc",
    platform: "local",
    label: "This PC",
    accountName: "local",
    connected: true,
    connectionDetails: "Checking device...",
    currentJob: null,
    checking: true,
  });
  return { cards, quick: true };
}

async function handleCancel(platform, targetId, jobId) {
  if (platform === "h200") {
    const roll = targetId.replace("h200-", "");
    const session = await chooseH200(root, roll);
    if (!/^\d+$/.test(String(jobId || ""))) {
      return { success: false, message: "No job id given; nothing was cancelled." };
    }
    try {
      const scancelCmd = `scancel ${jobId}`;
      const res = await runSshCommand(session, scancelCmd);
      // A run the user cancelled is not continued automatically.
      if (res.code === 0) untrackTarget(targetId);
      return { success: res.code === 0, message: `Cancelled H200 job: ${scancelCmd}` };
    } finally {
      session.close();
    }
  } else if (platform === "local") {
    if (jobId) {
      try {
        process.kill(Number(jobId), "SIGTERM");
        return { success: true, message: `Stopped local training process ${jobId}` };
      } catch (err) {
        return { success: false, message: `Could not stop process: ${err.message}` };
      }
    }
    return { success: false, message: "No local process ID specified" };
  } else if (platform === "kaggle") {
    return {
      success: true,
      message: "Kaggle API does not support cancelling sessions directly. Open kaggle.com > Your Work > Code > stop the session.",
      manualUrl: "https://www.kaggle.com/work/code",
    };
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

// ---------- H200 RUNS (DETAIL & HISTORY) -------------------------------------
function parseElapsedSec(str) {
  if (!str) return 0;
  let days = 0;
  let timeStr = String(str).trim();
  if (timeStr.includes("-")) {
    const parts = timeStr.split("-");
    days = Number(parts[0]) || 0;
    timeStr = parts[1] || "";
  }
  const parts = timeStr.split(":").map(Number);
  if (parts.length === 3) {
    return days * 86400 + (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  }
  if (parts.length === 2) {
    return days * 86400 + (parts[0] || 0) * 60 + (parts[1] || 0);
  }
  return days * 86400;
}

async function handleRunsH200() {
  const env = mergedEnv();
  const all = listAccounts(env);
  const h200Accounts = all.filter((acc) => acc.h200 && (!acc.slot || acc.slot <= 1));
  const runs = [];
  const errors = [];

  const folderList = [...new Set(H200_RUNS.map((r) => r.folder))].join(" ");
  const nnunetConfigs = [
    { folder: "results-nnunet-3d_fullres", dir: "Dataset501_BMEKnee/nnUNetTrainer_BME100__nnUNetResEncUNetMPlans__3d_fullres" },
    { folder: "results-nnunet-2d", dir: "Dataset501_BMEKnee/nnUNetTrainer_BME100__nnUNetResEncUNetMPlans__2d" },
    { folder: "results-nnunet-3d_fullres-noaug", dir: "Dataset501_BMEKnee/nnUNetTrainer_BME100NoDA__nnUNetResEncUNetMPlans__3d_fullres" },
    { folder: "results-nnunet-2d-noaug", dir: "Dataset501_BMEKnee/nnUNetTrainer_BME100NoDA__nnUNetResEncUNetMPlans__2d" },
  ];
  const nnunetCmd = nnunetConfigs
    .map(
      (c) =>
        `b="$HOME/bme/data/nnunet/results/${c.dir}"; if [ -d "$b" ]; then echo ""; echo "@@NNUNET ${c.folder}"; ` +
        `for f in 0 1 2 3 4; do ep=$(cat $b/fold_$f/training_log_*.txt 2>/dev/null | grep -c 'Epoch time'); ` +
        `fin=$([ -f $b/fold_$f/checkpoint_final.pth ] && echo yes || echo no); ` +
        `echo "FOLD $f $ep final $fin"; done; fi;`
    )
    .join(" ");

  const sshQueryCmd =
    `echo "===SACCT==="; ` +
    `sacct -u $USER -X -n -P -S 2026-11-01 --format=JobID,JobName,State,Start,End,Elapsed,ExitCode 2>/dev/null; ` +
    `echo "===RUNS==="; ` +
    `for d in ${folderList}; do ` +
    `p="$HOME/bme/data/$d"; if [ -d "$p" ]; then ` +
    `[ -f "$p/run_status.json" ] && { echo ""; echo "@@STATUS $d"; cat "$p/run_status.json"; echo ""; }; ` +
    `[ -f "$p/metrics.json" ] && { echo ""; echo "@@METRICS $d"; cat "$p/metrics.json"; echo ""; }; ` +
    `[ -f "$p/metrics_partial.json" ] && { echo ""; echo "@@PARTIAL $d"; cat "$p/metrics_partial.json"; echo ""; }; ` +
    `[ -f "$p/dataset_manifest.json" ] && { echo ""; echo "@@MANIFEST $d"; cat "$p/dataset_manifest.json"; echo ""; }; ` +
    `fi; done; ` +
    `${nnunetCmd} true`;

  await Promise.all(
    h200Accounts.map(async (acc) => {
      let session = null;
      try {
        session = await chooseH200(root, acc.roll);
      } catch (err) {
        errors.push({ roll: acc.roll, error: err.message || "unreachable" });
        return;
      }

      try {
        const testRes = await runSshCommand(session, "echo OK", 7000);
        if (testRes.code !== 0 || !testRes.out.includes("OK")) {
          errors.push({ roll: acc.roll, error: "unreachable" });
          return;
        }

        const queryRes = await runSshCommand(session, sshQueryCmd, 60000);
        if (queryRes.code !== 0) {
          errors.push({ roll: acc.roll, error: queryRes.err || "SSH query failed" });
          return;
        }

        const [sacctPart = "", runsPart = ""] = queryRes.out.split("===RUNS===");
        const sacctClean = sacctPart.replace("===SACCT===", "").trim();
        const sacctLines = sacctClean.split(/\r?\n/).filter(Boolean);
        const sacctJobs = [];
        for (const line of sacctLines) {
          const [jobId, jobName, state, start, end, elapsed, exitCode] = line.split("|");
          if (jobId) {
            sacctJobs.push({
              jobId: jobId.trim(),
              jobName: (jobName || "").trim(),
              state: (state || "").trim(),
              start: start && start !== "Unknown" ? start.trim() : null,
              end: end && end !== "Unknown" ? end.trim() : null,
              elapsed: elapsed && elapsed !== "Unknown" ? elapsed.trim() : null,
              exit: exitCode ? exitCode.trim() : null,
            });
          }
        }

        const chunks = runsPart.split(/(?=^@@)/m);
        const folderData = new Map();
        for (const chunk of chunks) {
          const trimmed = chunk.trim();
          if (!trimmed.startsWith("@@")) continue;
          const firstLineEnd = trimmed.indexOf("\n");
          const header = (firstLineEnd === -1 ? trimmed : trimmed.slice(0, firstLineEnd)).trim();
          const body = firstLineEnd === -1 ? "" : trimmed.slice(firstLineEnd + 1).trim();

          const [tag, folder] = header.split(/\s+/);
          if (!tag || !folder) continue;

          if (!folderData.has(folder)) {
            folderData.set(folder, { status: null, metrics: null, partial: null, manifest: null, nnunet: [] });
          }
          const fd = folderData.get(folder);

          if (tag === "@@STATUS") {
            try { fd.status = JSON.parse(body); } catch {}
          } else if (tag === "@@METRICS") {
            try { fd.metrics = JSON.parse(body); } catch {}
          } else if (tag === "@@PARTIAL") {
            try { fd.partial = JSON.parse(body); } catch {}
          } else if (tag === "@@MANIFEST") {
            try { fd.manifest = JSON.parse(body); } catch {}
          } else if (tag === "@@NNUNET") {
            const lines = body.split(/\r?\n/).filter(Boolean);
            for (const l of lines) {
              const m = l.match(/FOLD\s+(\d+)\s+(\d+)\s+final\s+(\w+)/i);
              if (m) {
                fd.nnunet.push({
                  fold: Number(m[1]),
                  epochs: Number(m[2]),
                  final: m[3].toLowerCase() === "yes",
                });
              }
            }
          }
        }

        const accountLabel = acc.name ? `H200 - ${acc.roll} (${acc.name})` : `H200 - ${acc.roll}`;

        for (const [folder, data] of folderData.entries()) {
          const runConfig = H200_RUNS.find((r) => r.folder === folder) || {
            folder,
            methodId: folder,
            job: folder,
            log: folder,
            label: folder,
          };

          const hasStatus = Boolean(data.status);
          const hasMetrics = Boolean(data.metrics);
          const hasNnunetFolds = data.nnunet.some((f) => f.epochs > 0 || f.final);
          const hasMatchingSacct = sacctJobs.some((j) => j.jobName === runConfig.job);

          if (!hasStatus && !hasMetrics && !hasNnunetFolds && !hasMatchingSacct) {
            continue;
          }

          // Find matching sacct jobs for this run (from 2026-11-01 onwards)
          const matchingSacct = sacctJobs.filter((j) => j.jobName === runConfig.job);

          // Build parts map keyed by jobId
          const partMap = new Map();

          // 1. Add all matching sacct jobs
          for (const sJob of matchingSacct) {
            partMap.set(sJob.jobId, {
              part: 0,
              jobId: sJob.jobId,
              state: sJob.state,
              start: sJob.start,
              end: sJob.end,
              elapsed: sJob.elapsed,
              exit: sJob.exit,
              logFile: runConfig.log ? `${runConfig.log}_${sJob.jobId}.out` : undefined,
            });
          }

          // 2. Merge partLog entries (which may have custom logFile or foldEpoch)
          if (data.status?.partLog && Array.isArray(data.status.partLog)) {
            for (const p of data.status.partLog) {
              const jid = String(p.slurmJobId || p.jobId || "");
              if (jid) {
                const sJob = sacctJobs.find((j) => j.jobId === jid);
                const existing = partMap.get(jid) || {};
                partMap.set(jid, {
                  part: p.part || existing.part || 0,
                  jobId: jid,
                  state: sJob?.state || existing.state || (p.endedAt ? "COMPLETED" : "UNKNOWN"),
                  start: sJob?.start || existing.start || p.startedAt || null,
                  end: sJob?.end || existing.end || p.endedAt || null,
                  elapsed: sJob?.elapsed || existing.elapsed || null,
                  exit: sJob?.exit || existing.exit || null,
                  logFile: p.logFile || existing.logFile || (runConfig.log ? `${runConfig.log}_${jid}.out` : undefined),
                  foldEpoch: p.results || p.foldEpoch || existing.foldEpoch || undefined,
                });
              }
            }
          }

          if (partMap.size === 0 && data.status?.slurmJobId) {
            const jid = String(data.status.slurmJobId);
            const sJob = sacctJobs.find((j) => j.jobId === jid);
            partMap.set(jid, {
              part: data.status.parts || 1,
              jobId: jid,
              state: sJob?.state || "COMPLETED",
              start: sJob?.start || data.status.partStartedAt || data.status.startedAt || null,
              end: sJob?.end || null,
              elapsed: sJob?.elapsed || null,
              exit: sJob?.exit || null,
              logFile: data.status.logFile || (runConfig.log ? `${runConfig.log}_${jid}.out` : undefined),
            });
          }

          let parts = Array.from(partMap.values());
          parts.sort((a, b) => {
            const ta = a.start ? new Date(a.start).getTime() : 0;
            const tb = b.start ? new Date(b.start).getTime() : 0;
            if (ta !== tb) return ta - tb;
            return Number(a.jobId) - Number(b.jobId);
          });
          parts.forEach((p, idx) => {
            p.part = idx + 1;
          });

          const isQuickFail = (p) => {
            if (/RUNNING|PENDING|COMPLETING/i.test(p.state)) return false;
            const sec = parseElapsedSec(p.elapsed);
            const exitNonZero = Boolean(p.exit && p.exit !== "0:0");
            const stateFailed = /FAILED|CANCELLED|NODE_FAIL|TIMEOUT|BOOT_FAIL/i.test(p.state);
            return (exitNonZero || stateFailed) && sec < 60;
          };

          // Filter out parts that failed within a minute (e.g. immediate setup failure)
          parts = parts.filter((p) => !isQuickFail(p));

          // If no usable parts and no completed metrics/folds, leave run out
          if (parts.length === 0 && !hasMetrics && !hasNnunetFolds) {
            continue;
          }

          // Re-index parts 1..N after filtering
          parts.forEach((p, idx) => {
            p.part = idx + 1;
          });

          let status = "part ended";
          if (hasMetrics) {
            status = "finished";
          } else if (parts.some((p) => /RUNNING|COMPLETING/i.test(p.state))) {
            status = "running";
          } else if (parts.some((p) => /PENDING/i.test(p.state))) {
            status = "queued";
          } else {
            status = "part ended";
          }

          if (data.nnunet.length > 0 && parts.length > 0) {
            const activeFold = data.nnunet.find((f) => !f.final && f.epochs > 0);
            if (activeFold && !parts[parts.length - 1].foldEpoch) {
              parts[parts.length - 1].foldEpoch = `fold ${activeFold.fold} (${activeFold.epochs}/100)`;
            }
          }

          const startedAt =
            data.status?.startedAt ||
            data.status?.partLog?.[0]?.startedAt ||
            parts[0]?.start ||
            data.metrics?.trained_at ||
            null;

          const rawStartedBy = data.status?.startedBy || data.metrics?.startedBy || null;
          const startedBy = typeof rawStartedBy === "string" ? { name: rawStartedBy } : rawStartedBy;

          const epochsPerFold =
            data.status?.epochs ??
            data.metrics?.epochs ??
            (runConfig.methodId.includes("nnunet") ? 100 : null);

          const manifestCounts = data.manifest?.counts || data.manifest || null;
          const dataset = manifestCounts
            ? {
                used: manifestCounts.used ?? null,
                annotated: manifestCounts.annotated ?? null,
                left_out: manifestCounts.left_out ?? null,
              }
            : null;

          let result = null;
          if (data.metrics) {
            const m = data.metrics;
            const s = m.summary || {};
            result = {
              summary: s,
              bmeDice: s.bme_dice || s.bme_dice_pos || null,
              boneDice: s.bone_dice || null,
              fpPerCase: s.fp_per_case || null,
              nCases: m.n_cases ?? m.patient_count ?? null,
              folds: m.folds ?? null,
              epochs: m.epochs ?? null,
              foldMode: m.fold_mode ?? null,
              trainedAt: m.trained_at ?? null,
              hoursTaken: m.hours_taken ?? null,
            };
          }

          let partial = null;
          if (data.nnunet.length > 0) {
            const foldsDone = data.nnunet.filter((f) => f.final).length;
            const activeFold = data.nnunet.find((f) => !f.final && f.epochs > 0);
            partial = {
              type: "nnunet",
              foldsDone,
              totalFolds: 5,
              activeFold: activeFold ? { fold: activeFold.fold, epoch: activeFold.epochs, totalEpochs: 100 } : null,
              folds: data.nnunet,
            };
          } else if (data.partial) {
            partial = {
              type: "unet3d",
              foldsDone: Array.isArray(data.partial) ? data.partial.length : 0,
              totalFolds: data.status?.folds || 5,
              data: data.partial,
            };
          }

          const localMetricsPath = path.join(root, "data", folder, "metrics.json");
          const hasLocalMetrics = fs.existsSync(localMetricsPath);

          runs.push({
            id: `${acc.roll}:${folder}`,
            roll: acc.roll,
            accountLabel,
            methodId: data.status?.methodId || runConfig.methodId || folder,
            label: runConfig.label || folder,
            startedAt,
            startedBy,
            epochsPerFold,
            dataset,
            status,
            result,
            partial,
            parts,
            folder,
            hasLocalMetrics,
          });
        }
      } catch (err) {
        errors.push({ roll: acc.roll, error: err.message || "Failed reading runs" });
      } finally {
        session.close();
      }
    })
  );

  runs.sort((a, b) => {
    const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return ta - tb;
  });

  return { runs, errors };
}

// ---------- FULL LOG ---------------------------------------------------------
/** The log of the job on one H200 account: specific jobId, running job, or newest. */
async function handleLog(targetId, linesArg, jobId) {
  const n = Math.min(2000, Math.max(20, Number(linesArg) || 400));
  const roll = String(targetId || "").replace("h200-", "");
  const session = await chooseH200(root, roll);
  const isJobIdDigits = jobId && /^\d+$/.test(String(jobId).trim());
  const cleanJobId = isJobIdDigits ? String(jobId).trim() : null;
  try {
    const fileFindCmd = cleanJobId
      ? `f=$(ls $HOME/bme/logs/*_${cleanJobId}.out 2>/dev/null | head -1); `
      : `j=$(squeue -u $USER -h -o %i | head -1); f=""; ` +
        `[ -n "$j" ] && f=$(ls $HOME/bme/logs/*_$j.out 2>/dev/null | head -1); ` +
        `[ -z "$f" ] && f=$(ls -t $HOME/bme/logs/*.out 2>/dev/null | head -1); `;

    const r = await runSshCommand(
      session,
      `${fileFindCmd}` +
      `echo "FILE:$f"; [ -n "$f" ] && tail -n ${n} "$f"; ` +
      `echo "===TRAIN==="; case "$f" in *nnunet*) t=$(ls -t $HOME/bme/data/nnunet/results/Dataset501_BMEKnee/*/fold_*/training_log_*.txt 2>/dev/null | head -1); ` +
      `[ -n "$t" ] && { echo "FILE:$t"; tail -n ${n} "$t"; } ;; esac; ` +
      `echo "===ERR==="; [ -n "$f" ] && tail -n 40 "\${f%.out}.err" 2>/dev/null; true`,
      20000,
    );
    if (r.code !== 0) throw new Error("Could not reach the H200 account to read its log.");
    const [outPart, rest = ""] = r.out.split("===TRAIN===");
    const [trainPart, errPart = ""] = rest.split("===ERR===");
    const clean = (t) => t.split(/\r?\n|\r/).map((l) => l.trimEnd()).filter(Boolean);
    const out = clean(outPart);
    const train = clean(trainPart);
    const file = ((train[0] || out[0] || "").match(/^FILE:(.*)$/) || [])[1] || "";
    const body = [...out.slice(1), ...(train.length > 1 ? ["", `# ${train[0].replace("FILE:", "")}`, ...train.slice(1)] : [])];
    return {
      targetId,
      platform: "h200",
      file: ((out[0] || "").match(/^FILE:(.*)$/) || [])[1] || file,
      lines: body.length ? body : [cleanJobId ? `No log found for job ${cleanJobId}.` : "No log on this account yet."],
      err: clean(errPart).filter((l) => !/^\s*$/.test(l)),
    };
  } finally {
    session.close();
  }
}

// ---------- CLI DISPATCHER ---------------------------------------------------
const [action, arg1, arg2, arg3, arg4] = process.argv.slice(2);

try {
  let result = null;
  if (action === "accounts-quick") {
    result = handleAccountsQuick();
  } else if (action === "accounts") {
    result = await handleAccounts();
  } else if (action === "runs") {
    result = await handleRuns();
  } else if (action === "runs-h200") {
    result = await handleRunsH200();
  } else if (action === "dataset-status") {
    result = await handleDatasetStatus();
  } else if (action === "setup") {
    const roll = String(arg1 || "").replace("h200-", "");
    const r = await runStreaming(process.execPath, [path.join(root, "scripts", "h200-menu.js"), "setup", "--as", roll], {
      env: { ...process.env, BME_NO_PROMPT: "1" },
    });
    if (r.status !== 0 || !/SETUP_OK/.test(r.stdout)) {
      throw new Error(`Setup did not finish on ${roll}: ${(r.stderr || r.stdout || "").trim().split(/\r?\n/).slice(-2).join(" | ")}`);
    }
    result = { success: true, message: `Python environment ready on H200 account ${roll}` };
  } else if (action === "dataset-plan") {
    result = handleDatasetPlan(arg1);
  } else if (action === "dataset-sync") {
    const confirmed = arg2 === "true" || arg2 === "--yes" || process.argv.includes("--yes");
    const isFresh = arg3 === "fresh" || arg3 === "--fresh" || process.argv.includes("--fresh");
    result = await handleDatasetSync(arg1, confirmed, isFresh);
  } else if (action === "start") {
    result = await handleStart(arg1, arg2, arg3, arg4);
  } else if (action === "log") {
    result = await handleLog(arg1, arg2, arg3);
  } else if (action === "cancel") {
    result = await handleCancel(arg1, arg2, arg3);
  } else {
    throw new Error(`Unknown action: ${action}`);
  }

  process.stdout.write(JSON.stringify(result));
  process.exit(0);
} catch (err) {
  process.stderr.write(JSON.stringify({ error: err.message || String(err) }));
  process.exit(1);
}
