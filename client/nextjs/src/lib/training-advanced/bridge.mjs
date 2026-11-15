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
  kaggle, kaggleJson, usable, createRunMetadata, python,
} = accountsMod;
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

async function runSshCommand(session, cmd, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(
      "ssh",
      [
        ...session.sshOpts,
        "-o", "ConnectTimeout=5",
        "-o", "StrictHostKeyChecking=accept-new",
        session.target,
        cmd,
      ],
      {
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

// ---------- ACCOUNTS COMMAND -------------------------------------------------
async function handleAccounts() {
  const env = mergedEnv();
  const all = listAccounts(env);
  const route = await h200Route(env);
  const isDirectH200 = !route.remote;
  const isHostReachable = await tcpReachable(route.host, 22, 2000);

  const cards = [];

  // 1. H200 cards (one per teammate; with password tested, without password marked)
  for (const acc of all) {
    const id = `h200-${acc.roll}`;
    if (!usable.h200(acc)) {
      cards.push({
        id,
        platform: "h200",
        label: `H200 - ${acc.usn}${acc.name ? ` (${acc.name})` : ""}`,
        accountName: acc.h200?.user || `nnm23cs${acc.roll}_stu_cse`,
        usn: acc.usn,
        roll: acc.roll,
        connected: false,
        connectionDetails: `No H200 password in .env for ${acc.name || acc.usn}`,
        currentJob: null,
      });
      continue;
    }

    let connected = false;
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
          // Check running Slurm jobs and server data
          const statusRes = await runSshCommand(
            session,
            `squeue -u $USER -h -o '%i|%j|%T|%M|%l'; ` +
            `echo "===RESULTS==="; ` +
            `cd $HOME/bme/data 2>/dev/null && for d in results3d-holdout results3d-aug-low results3d-aug-med results3d-aug-max results3d-h200-v2 results-nnunet-3d_fullres results-nnunet-2d; do ` +
            `[ -f $d/metrics.json ] && echo "$d|finished"; ` +
            `[ ! -f $d/metrics.json ] && [ -n "$(ls -A $d 2>/dev/null)" ] && echo "$d|stopped"; done; ` +
            `echo "===LOG==="; ` +
            `f=$(ls -t $HOME/bme/logs/*.out 2>/dev/null | head -1); [ -n "$f" ] && { echo "FILE:$f"; tail -n 25 "$f"; }`,
            12000
          );

          if (statusRes.code === 0) {
            const [squeuePart, rest1 = ""] = statusRes.out.split("===RESULTS===");
            const [resultsPart, logPart = ""] = rest1.split("===LOG===");

            const activeJobLine = squeuePart.trim().split(/\r?\n/).filter(Boolean)[0];
            const logLines = logPart.trim().split(/\r?\n/).filter(Boolean);
            const tailText = logLines.join("\n");

            let jobStatus = "idle";
            let resumePending = false;
            let methodId = "";
            let methodLabel = "";
            let slurmJobId = "";
            let startedAt = null;
            let elapsedSeconds = null;

            if (activeJobLine) {
              const [jid, jname, jstate, jelapsed] = activeJobLine.split("|");
              slurmJobId = jid;
              jobStatus = jstate === "RUNNING" ? "running" : "running"; // QUEUED / PENDING is still running
              methodId = jname.replace(/^bme_/, "");
              methodLabel = `Job ${jid} (${jname})`;
              // Parse elapsed e.g. 1:20:30 or 05:12
              const parts = (jelapsed || "").split(":").map(Number);
              if (parts.length === 3) elapsedSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
              else if (parts.length === 2) elapsedSeconds = parts[0] * 60 + parts[1];
            } else {
              // Check if stopped before finishing (Resume pending)
              for (const rLine of resultsPart.trim().split(/\r?\n/).filter(Boolean)) {
                const [rFolder, rState] = rLine.split("|");
                if (rState === "stopped") {
                  jobStatus = "stopped";
                  resumePending = true;
                  methodId = rFolder.replace("results3d-", "").replace("results-", "");
                  methodLabel = rFolder;
                  break;
                }
              }
            }

            // Look up local run_status.json for startedBy metadata
            let metaStartedBy = { usn: acc.usn, name: acc.name || acc.roll };
            let metaAccount = acc.h200?.user || `nnm23cs${acc.roll}_stu_cse`;
            let metaHost = "";
            const statusFile = path.join(root, "data", `results3d-${methodId}`, "run_status.json");
            if (fs.existsSync(statusFile)) {
              try {
                const meta = JSON.parse(fs.readFileSync(statusFile, "utf8"));
                if (meta.startedBy) metaStartedBy = meta.startedBy;
                if (meta.account) metaAccount = meta.account;
                if (meta.host) metaHost = meta.host;
                if (meta.startedAt) startedAt = meta.startedAt;
              } catch {}
            }

            const progress = parseLogProgress(tailText, 5, 40, startedAt);

            if (jobStatus !== "idle" || resumePending) {
              currentJob = {
                methodId,
                methodLabel: methodLabel || methodId,
                iteration: resumePending ? "Resume pending" : "1st run",
                startedBy: metaStartedBy,
                startedAt,
                elapsedSeconds,
                status: jobStatus,
                resumePending,
                resumeAutomatic: false, // State clearly: NOT automatic today
                slurmJobId,
                logTail: logLines.slice(-20),
                progress,
              };
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

    cards.push({
      id,
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
    });
  }

  // 2. Kaggle cards (one per Kaggle slot)
  const kaggleAccounts = all.filter(usable.kaggle);
  const isKaggleCliReady = kaggleReady();
  const { owner } = datasetOwner(env);

  for (const acc of kaggleAccounts) {
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

      // Query live status if running/queued and CLI ready
      if (["QUEUED", "RUNNING"].includes(phase) && isKaggleCliReady) {
        const kernelSlug = String(run.kernel_slug || "").split("/").pop();
        if (kernelSlug) {
          const liveRes = kaggle(acc, ["status", "--kernel-slug", kernelSlug], { capture: true });
          const m = liveRes.out.match(/:\s*([A-Z_]+)/);
          if (m) liveStatus = m[1].toUpperCase();

          const logRes = kaggle(acc, ["logs", "--kernel-slug", kernelSlug], { capture: true });
          if (logRes.out) logTail = logRes.out.trim().split(/\r?\n/).slice(-25);
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
    }

    cards.push({
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
    });
  }

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
          status: isAlive ? "running" : isFin ? "finished" : "stopped",
          resumePending: !isAlive && !isFin,
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

      let platform = meta?.platform || (d.includes("-pc") ? "local" : (d.startsWith("results3d_experiments") ? "kaggle" : "h200"));
      let platformLabel = platform === "h200" ? "College H200" : platform === "kaggle" ? "Kaggle" : "This PC";

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

  // Check currently running jobs across all targets to determine locks
  const { cards } = await handleAccounts();
  const activeRuns = new Map();
  for (const c of cards) {
    if (c.currentJob && c.currentJob.status === "running") {
      activeRuns.set(c.id, {
        method: c.currentJob.methodLabel || c.currentJob.methodId || "training",
        status: c.currentJob.status,
        account: c.accountName,
        jobId: c.currentJob.slurmJobId || (c.currentJob.pid ? String(c.currentJob.pid) : undefined),
      });
    }
  }

  const targets = [];

  // H200 targets
  for (const acc of all.filter(usable.h200)) {
    const targetId = `h200-${acc.roll}`;
    const blocking = activeRuns.get(targetId) || null;
    targets.push({
      targetId,
      platform: "h200",
      label: `H200 - ${acc.usn} (${acc.name || acc.roll})`,
      datasetVersion: "server-synced",
      localExportVersion: localExport.hash,
      isUpToDate: !blocking, // Push will verify remote md5
      casesCount: localExport.cases,
      filesCount: localExport.files,
      bytesToSync: localExport.bytes,
      isRemoteRoute: route.remote,
      routeLabel: route.label,
      runningJobBlocking: blocking,
    });
  }

  // Kaggle dataset sync: 1 designated account (owner or first usable)
  const kaggleSyncAcc = owner || all.find(usable.kaggle);
  if (kaggleSyncAcc) {
    const targetId = `kaggle-${kaggleSyncAcc.roll}-${kaggleSyncAcc.slot || 1}`;
    const blocking = activeRuns.get(targetId) || null;

    let hasUploaded = false;
    let isEmpty = true;
    let lastUpdated = null;
    let uploadedHash = null;

    const stagingDir = stagingFor(kaggleSyncAcc);
    const appFile = path.join(stagingDir, "dataset_approval.json");
    if (fs.existsSync(appFile)) {
      try {
        const appData = JSON.parse(fs.readFileSync(appFile, "utf8"));
        uploadedHash = appData.uploaded_hash || null;
        hasUploaded = Boolean(uploadedHash);
        const cases = appData.case_count || 0;
        const files = appData.file_count || 0;
        isEmpty = !hasUploaded || (cases === 0 && files === 0);
        lastUpdated = appData.uploaded_at || null;
      } catch {}
    }

    const isUpToDate = hasUploaded && !isEmpty && !needsUpload;

    targets.push({
      targetId,
      platform: "kaggle",
      label: `Kaggle - ${kaggleSyncAcc.kaggleUser || kaggleSyncAcc.label} (Dataset Sync)`,
      datasetVersion: hasUploaded ? (uploadedHash?.slice(0, 12) || "uploaded") : "not-uploaded",
      localExportVersion: localExport.hash,
      isUpToDate,
      reason: isEmpty ? "Dataset empty / not uploaded" : needsUpload ? (uploadReason || "Local data changed") : "Up to date",
      casesCount: localExport.cases,
      filesCount: localExport.files,
      bytesToSync: localExport.bytes,
      lastUpdated,
      hasUploaded,
      isEmpty,
      needsUpload: !isUpToDate,
      runningJobBlocking: blocking,
    });
  }

  // Local target
  const localBlocking = activeRuns.get("this-pc") || null;
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
    runningJobBlocking: localBlocking,
  });

  // Collect available Kaggle datasets for training:
  // Rule: If an account has not yet uploaded for first time or if its dataset is empty, DON'T show it!
  const kaggleDatasets = [];
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
        });
      }
    } catch {}
  }

  return { localExport, targets, kaggleDatasets };
}

// ---------- DATASET SYNC COMMAND ---------------------------------------------
async function handleDatasetSync(targetId, confirmed = false) {
  const { targets } = await handleDatasetStatus();
  const target = targets.find((t) => t.targetId === targetId);
  if (!target) {
    throw new Error(`Target not found: ${targetId}`);
  }

  // Strict check: refuse while any run on that target is running!
  if (target.runningJobBlocking) {
    return {
      success: false,
      refused: true,
      message: `Cannot sync data: ${target.runningJobBlocking.method} is currently running on ${target.label}. Updating dataset while training would corrupt the run state.`,
      blockingRun: target.runningJobBlocking,
    };
  }

  if (target.platform === "kaggle") {
    const { owner } = datasetOwner(mergedEnv());
    const syncAcc = owner || findAccount(listAccounts(mergedEnv()), targetId.replace("kaggle-", "").split("-")[0]);
    if (!syncAcc) throw new Error("No Kaggle dataset sync account found in .env");

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

    const exp = kaggle(syncAcc, ["export"]);
    if (exp.code !== 0) throw new Error(`De-identified export failed: ${exp.err || exp.out}`);
    const up = kaggle(syncAcc, ["update-dataset"]);
    if (up.code !== 0) throw new Error(`Kaggle dataset upload failed: ${up.err || up.out}`);
    return { success: true, message: `Kaggle private dataset synced to latest local export on ${syncAcc.label}.` };
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

    // If local college network (route.remote === false), no confirmation needed!
    const pushArgs = [path.join(root, "scripts", "h200-menu.js"), "push", "--as", roll];
    if (confirmed || route.remote) {
      pushArgs.push("--yes");
    }

    const r = spawnSync(process.execPath, pushArgs, {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    });
    if (r.status !== 0) throw new Error(`H200 push failed: ${r.stderr || r.stdout}`);
    const routeMsg = route.remote ? "over Internet jump route" : "via direct local college network";
    return { success: true, message: `H200 files pushed and up-to-date for roll ${roll} (${routeMsg}).` };
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
    if (methodId.startsWith("unet-aug-")) {
      h200Args = ["aug", methodId.replace("unet-aug-", ""), "--as", roll];
    } else if (methodId === "unet-holdout") {
      h200Args = ["holdout", "--as", roll];
    } else if (methodId === "nnunet-3d") {
      h200Args = ["best", "3d", "--as", roll];
    } else if (methodId === "nnunet-2d") {
      h200Args = ["best", "2d", "--as", roll];
    }
    const r = spawnSync(process.execPath, [path.join(root, "scripts", "h200-menu.js"), ...h200Args], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    });
    if (r.status !== 0) throw new Error(`H200 start failed: ${r.stderr || r.stdout}`);
    return { success: true, message: `H200 job started for ${methodId} on account ${roll}` };
  } else if (platform === "local") {
    const r = spawnSync(process.execPath, [path.join(root, "scripts", "train-local.js"), methodId], {
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
  if (action === "accounts") {
    result = await handleAccounts();
  } else if (action === "runs") {
    result = await handleRuns();
  } else if (action === "dataset-status") {
    result = await handleDatasetStatus();
  } else if (action === "dataset-sync") {
    const confirmed = arg2 === "true" || arg2 === "--yes" || process.argv.includes("--yes");
    result = await handleDatasetSync(arg1, confirmed);
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
