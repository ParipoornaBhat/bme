import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { root } from "./lib/accounts.js";

/**
 * Keeps H200 runs going. One H200 job is one part of at most 3 h 45 m; a long
 * run needs several. This looks at every run started from this PC and submits
 * the next part of any that stopped unfinished.
 *
 *   pnpm h200:auto            show the tracked runs and their state (changes nothing)
 *   pnpm h200:auto run        the same, and continue every run whose part ended
 *   pnpm h200:auto on         check every 15 minutes in the background, also after a restart
 *   pnpm h200:auto off        stop the background check
 *   pnpm h200:auto track <roll> <method>     follow a run that was started elsewhere
 *   pnpm h200:auto untrack <roll>            stop following that account's runs
 *
 * Only runs in data/advanced_training/auto_runs.json are touched: the ones
 * started from the Training page on this PC. A cancelled run is dropped from
 * the list. A run whose last job failed is not resubmitted; it needs a look.
 * It never starts a second job on an account that already has one.
 */

const DIR = path.join(root, "data", "advanced_training");
const FILE = path.join(DIR, "auto_runs.json");
const LOG = path.join(DIR, "auto_resume.log");
const BRIDGE = path.join(root, "client", "nextjs", "src", "lib", "training-advanced", "bridge.mjs");
const TASK = "BME H200 auto-continue";
const MAX_PARTS = 12;
const RETRY_MINUTES = 20;

const read = () => {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return []; }
};
const write = (list) => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), "utf8");
};
const say = (line) => {
  console.log(line);
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch { /* the log is a convenience */ }
};

function bridge(args, timeout = 300000) {
  const r = spawnSync(process.execPath, [BRIDGE, ...args], { cwd: root, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 });
  const lines = (r.stdout || "").trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l.startsWith("{") && !l.startsWith("[")) continue;
    try { return { ok: r.status === 0, json: JSON.parse(l), text: r.stdout || "" }; } catch { /* keep looking */ }
  }
  let error = (r.stderr || "").trim();
  try { error = JSON.parse(error).error; } catch { /* plain text */ }
  return { ok: false, json: null, text: r.stdout || "", error: error || "no answer" };
}

function check(act) {
  const list = read();
  if (!list.length) {
    console.log("No tracked H200 runs. Runs started from the Training page are tracked automatically.");
    return;
  }
  if (act) say(`checking ${list.length} tracked run(s)`);
  const res = bridge(["accounts"]);
  if (!res.json) {
    say(`Could not read the H200 accounts: ${res.error}`);
    return;
  }
  const cards = (res.json.cards || res.json).filter((c) => c.platform === "h200");
  let changed = false;
  for (const run of list) {
    const card = cards.find((c) => c.id === run.target);
    const tag = `${run.target} ${run.methodId}`;
    if (!card || !card.connected) {
      console.log(`${tag}: account not reachable now (${card?.connectionDetails || "unknown"}). Left as it is.`);
      continue;
    }
    const job = card.currentJob;
    const state = (card.runStates || {})[run.methodId];
    if (state === "finished") {
      if (run.state !== "finished") {
        run.state = "finished";
        changed = true;
        say(`${tag}: finished. Download it with: pnpm runs:get`);
      } else console.log(`${tag}: finished.`);
      continue;
    }
    if (job && (job.status === "running" || job.status === "queued")) {
      const mine = job.methodId === run.methodId;
      console.log(`${tag}: ${mine ? `${job.status}, ${job.iteration}` : `waiting, the account is busy with ${job.methodId}`}${mine && job.progress ? ` [${job.progress.percent}%]` : ""}`);
      if (run.state !== "active" && mine) { run.state = "active"; delete run.note; changed = true; }
      continue;
    }
    if (job && job.status === "failed") {
      if (run.state !== "failed") {
        run.state = "failed";
        run.note = String(job.iteration || "").slice(0, 200);
        changed = true;
        say(`${tag}: NOT continued, the last job failed. ${run.note}`);
      } else console.log(`${tag}: failed earlier, not continued. ${run.note || ""}`);
      continue;
    }
    if (run.state === "failed" || run.state === "limit") {
      console.log(`${tag}: ${run.state}, not continued. ${run.note || ""} Start it from the Training page to track it again.`);
      continue;
    }
    // No job on the account, the run is not finished: the next part is due.
    if (!act) {
      console.log(`${tag}: part ended, not finished. "pnpm h200:auto run" continues it.`);
      continue;
    }
    if ((run.continues || 0) >= MAX_PARTS) {
      run.state = "limit";
      run.note = `${MAX_PARTS} parts continued without finishing`;
      changed = true;
      say(`${tag}: NOT continued, ${run.note}. Check the log.`);
      continue;
    }
    if (run.lastTry && Date.now() - new Date(run.lastTry).getTime() < RETRY_MINUTES * 60000) {
      console.log(`${tag}: tried ${Math.round((Date.now() - new Date(run.lastTry).getTime()) / 60000)} min ago, waiting before the next try.`);
      continue;
    }
    run.lastTry = new Date().toISOString();
    changed = true;
    write(list);
    const started = bridge(["start", "h200", run.target, run.methodId, "{}"], 900000);
    if (started.ok && started.json?.success) {
      // bridge start re-tracks the run; keep our counters on top of it.
      run.continues = (run.continues || 0) + 1;
      run.state = "active";
      say(`${tag}: continued, part ${run.continues + 1} submitted.`);
    } else if (/already finished/.test(started.text)) {
      run.state = "finished";
      say(`${tag}: finished.`);
    } else {
      say(`${tag}: could not continue now: ${started.error || started.text.trim().split(/\r?\n/).slice(-2).join(" | ")}`);
    }
  }
  if (changed) {
    // Keep entries another process added meanwhile (a start from the page).
    const now = read();
    const merged = [...list, ...now.filter((n) => !list.some((r) => r.target === n.target && r.methodId === n.methodId))];
    write(merged);
  }
}

function ps(script) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
}

function on() {
  if (process.platform !== "win32") {
    console.log("The background check is set up for Windows. Elsewhere, run this from cron: pnpm h200:auto run");
    return;
  }
  // A hidden launcher, so no console window flashes every 15 minutes.
  fs.mkdirSync(DIR, { recursive: true });
  const vbs = path.join(DIR, "h200-auto.vbs");
  const me = path.join(root, "scripts", "h200-auto.js");
  fs.writeFileSync(
    vbs,
    `Set s = CreateObject("WScript.Shell")\r\ns.CurrentDirectory = "${root}"\r\ns.Run """${process.execPath}"" ""${me}"" run", 0, False\r\n`,
  );
  console.log(`Will register a Windows scheduled task for your user only: "${TASK}".`);
  console.log(`It runs "pnpm h200:auto run" hidden every 15 minutes, and right after sign-in if a run was missed while the PC was off.`);
  const q = (x) => x.replace(/'/g, "''");
  const r = ps(
    `$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"${q(vbs)}"';` +
      `$t = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15);` +
      `$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20);` +
      `Register-ScheduledTask -TaskName '${TASK}' -Action $a -Trigger $t -Settings $s -Force | Out-Null; 'REGISTERED'`,
  );
  if (!/REGISTERED/.test(r.stdout || "")) {
    console.log(`Could not register the task: ${(r.stderr || r.stdout || "").trim().split(/\r?\n/)[0]}`);
    process.exit(1);
  }
  console.log("On. Turn it off with: pnpm h200:auto off");
  console.log(`What it did is written to ${path.relative(root, LOG)}`);
}

function off() {
  if (process.platform !== "win32") return;
  const r = ps(`Unregister-ScheduledTask -TaskName '${TASK}' -Confirm:$false; 'REMOVED'`);
  console.log(/REMOVED/.test(r.stdout || "") && !r.stderr ? "Off. The background check is removed." : "It was not on.");
}

function taskState() {
  if (process.platform !== "win32") return "";
  const r = ps(`(Get-ScheduledTask -TaskName '${TASK}' -ErrorAction SilentlyContinue).State`);
  return (r.stdout || "").trim();
}

const [cmd = "show", a1, a2] = process.argv.slice(2).filter((a) => a !== "--");
if (cmd === "on") on();
else if (cmd === "off") off();
else if (cmd === "track") {
  if (!a1 || !a2) {
    console.log("Use: pnpm h200:auto track <roll> <method>   e.g. pnpm h200:auto track 071 nnunet-3d");
    process.exit(1);
  }
  const target = `h200-${a1.replace("h200-", "")}`;
  const list = read().filter((r) => !(r.target === target && r.methodId === a2));
  list.push({ target, methodId: a2, startedAt: new Date().toISOString(), continues: 0, state: "active" });
  write(list);
  console.log(`Tracking ${target} ${a2}.`);
} else if (cmd === "untrack") {
  const target = `h200-${String(a1 || "").replace("h200-", "")}`;
  write(read().filter((r) => r.target !== target));
  console.log(`No longer tracking ${target}.`);
} else if (cmd === "run" || cmd === "show") {
  if (cmd === "show") {
    const st = taskState();
    console.log(`Background check: ${st ? `on (${st})` : "off. Turn it on with: pnpm h200:auto on"}\n`);
  }
  try {
    check(cmd === "run");
    if (cmd === "run") say("check done");
  } catch (e) {
    say(`check failed: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
} else {
  console.log("Use: pnpm h200:auto [run | on | off | track <roll> <method> | untrack <roll>]");
  process.exit(1);
}
