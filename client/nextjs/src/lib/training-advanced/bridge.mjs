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
  kaggle, kaggleJson, kaggleEnv, usable, createRunMetadata, python,
} = accountsMod;
const PIPELINE = path.join(root, "ml", "scripts", "kaggle_pipeline.py");
const { METHODS } = methodsMod;
const { detectDevice, describeDevice } = deviceMod;
const { chooseH200 } = h200LoginMod;

function parseLogProgress(logText, defaultFolds = 5, defaultEpochs = 40, startedAt = null) {
  if (!logText) return null;
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

const H200_RUNS = [
  { folder: "results-nnunet-3d_fullres", methodId: "nnunet-3d", job: "bme_nnunet", log: "nnunet", label: "nnU-Net ResEnc M, 3D" },
  { folder: "results-nnunet-2d", methodId: "nnunet-2d", job: "bme_nnunet", log: "nnunet", label: "nnU-Net ResEnc M, 2D" },
  { folder: "results3d-aug-low", methodId: "unet-aug-low", job: "bme_aug_low", log: "aug_low", label: "3D U-Net, augmentation low" },
  { folder: "results3d-aug-med", methodId: "unet-aug-med", job: "bme_aug_med", log: "aug_med", label: "3D U-Net, augmentation med" },
  { folder: "results3d-aug-max", methodId: "unet-aug-max", job: "bme_aug_max", log: "aug_max", label: "3D U-Net, augmentation max" },
  { folder: "results3d-holdout", methodId: "unet-holdout", job: "bme_holdout", log: "holdout", label: "3D U-Net, fixed 80/20 split" },
  { folder: "results3d-h200-plain", methodId: "unet-noaug", job: "bme_unet3d_plain", log: "unet3dplain", label: "3D U-Net, no augmentation" },
  { folder: "results3d-selftest-aug", methodId: "selftest-aug", job: "bme_selftest_aug", log: "selftest_aug", label: "Self-test, augmentation max" },
  { folder: "results3d-selftest-plain", methodId: "selftest-plain", job: "bme_selftest_plain", log: "selftest_plain", label: "Self-test, no augmentation" },
  { folder: "results3d-h200-v2", methodId: "train3d", job: "bme_unet3d", log: "unet3d", label: "3D U-Net (v2)" },
];

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
              `[ ! -f $d/metrics.json ] && [ -n "$(ls -A $d 2>/dev/null)" ] && echo "$d|stopped"; done; ` +
              `echo "===ENV==="; [ -x $HOME/bme/env/bin/python3 ] && echo ENV_OK; ` +
              `$HOME/bme/env/bin/python3 -c "import nnunetv2" 2>/dev/null && echo NNUNET_OK; ` +
              `echo "===LAST==="; sacct -u $USER -S now-3days -X -n -P --format=JobID,JobName,State,Elapsed 2>/dev/null | tail -1; ` +
              `e=$(ls -t $HOME/bme/logs/*.err 2>/dev/null | head -1); [ -n "$e" ] && tail -n 1 "$e"; ` +
              `echo "===PARTS==="; ` +
              `for p in ${[...new Set(H200_RUNS.map((r) => r.log))].join(" ")}; do echo "$p|$(find $HOME/bme/logs -name "\${p}_*.out" -size +600c 2>/dev/null | wc -l)"; done; ` +
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
              let startedAt = null;
              let elapsedSeconds = null;

              if (activeJobLine) {
                const [jid, jname, jstate, jelapsed, , jreason = ""] = activeJobLine.split("|");
                slurmJobId = jid;
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
              const partsDone = run ? partsByLog[run.log] || 0 : 0;
              if (fs.existsSync(statusFile)) {
                try {
                  const meta = JSON.parse(fs.readFileSync(statusFile, "utf8"));
                  if (meta.startedBy) metaStartedBy = meta.startedBy;
                  if (meta.account) metaAccount = meta.account;
                  if (meta.host) metaHost = meta.host;
                  if (meta.startedAt) startedAt = meta.startedAt;
                } catch {}
              }

              let partNo = Math.max(1, partsDone);
              if (run && slurmJobId) {
                const nn = run.methodId.startsWith("nnunet")
                  ? `cd $HOME/bme/data/nnunet/results/Dataset501_BMEKnee/nnUNetTrainer_BME100__nnUNetResEncUNetMPlans__${run.methodId === "nnunet-2d" ? "2d" : "3d_fullres"} 2>/dev/null && ` +
                    `for f in 0 1 2 3 4; do if [ -f fold_$f/checkpoint_final.pth ]; then echo "FOLD $f 100"; else echo "FOLD $f $(cat fold_$f/training_log_*.txt 2>/dev/null | grep -c 'Epoch time')"; fi; done; ` +
                    `cat fold_*/training_log_*.txt 2>/dev/null | grep -E 'Epoch [0-9]+|train_loss|Pseudo dice|Epoch time' | tail -n 8; `
                  : "";
                const own = await runSshCommand(
                  session,
                  `echo "PRIOR $(find $HOME/bme/logs -name "${run.log}_*.out" -size +600c ! -name "${run.log}_${slurmJobId}.out" 2>/dev/null | wc -l)"; ` +
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
                    const nnLines = nnPart.trim().split(/\r?\n/).filter((l) => l && !l.startsWith("FOLD ")).map((l) => l.slice(0, 240));
                    if (nnLines.length) ownLog = nnLines;
                  }
                }
              }
              const progress = jobStatus === "queued" ? null : nnProgress || parseLogProgress((ownLog || logLines).join("\n"), 5, 40, startedAt);

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
                  iteration: resumePending
                    ? `Part ${partsDone} ended, not finished. Press Continue for part ${partsDone + 1}.`
                    : jobStatus === "queued"
                    ? `Part ${partNo} is waiting in the H200 queue (${queueReason || "no free GPU slot"}). Nothing has run yet.`
                    : `Part ${partNo} running`,
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
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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

    const args = [
      "run", "--confirm-launch", "--no-wait", "--mode", "full",
      "--model-arch", m.arch || "unet3d",
      "--kernel-slug", `bme-${methodId}`,
      "--import-name", methodId,
      ...KAGGLE_SETTINGS,
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
    let h200Args = ["aug", extra.augLevel || "med", "--as", roll];
    if (methodId.startsWith("selftest-")) {
      h200Args = ["selftest", methodId.replace("selftest-", ""), "--as", roll];
    } else if (methodId === "unet-noaug") {
      h200Args = ["train3dplain", "--as", roll];
    } else if (methodId.startsWith("unet-aug-")) {
      h200Args = ["aug", methodId.replace("unet-aug-", ""), "--as", roll];
    } else if (methodId === "unet-holdout") {
      h200Args = ["holdout", "--as", roll];
    } else if (methodId === "nnunet-3d") {
      h200Args = ["best", "3d", "--as", roll];
    } else if (methodId === "nnunet-2d") {
      h200Args = ["best", "2d", "--as", roll];
    }
    const r = await runStreaming(process.execPath, [path.join(root, "scripts", "h200-menu.js"), ...h200Args], {
      env: { ...process.env, BME_NO_PROMPT: "1" },
    });
    if (r.status !== 0 || !/Submitted batch job/.test(r.stdout)) {
      const tail = (r.stderr || r.stdout || "").trim().split(/\r?\n/).slice(-3).join(" | ");
      throw new Error(`H200 did not start the run: ${tail || "no answer from the H200"}`);
    }
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
    try {
      const scancelCmd = jobId ? `scancel ${jobId}` : `scancel -u $USER`;
      const res = await runSshCommand(session, scancelCmd);
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
