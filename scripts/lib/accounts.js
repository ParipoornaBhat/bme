import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Accounts, one block per teammate in .env, keyed by USN roll number:
 *
 *   NNM23CS124_NAME=paripoorna          shown in menus (optional)
 *   NNM23CS124_H200=<h200 password>     college H200 login nnm23cs124_stu_cse
 *   NNM23CS124_KAGGLE_USER=<username>   Kaggle API credentials
 *   NNM23CS124_KAGGLE_KEY=<api key>     (or NNM23CS124_KAGGLE_TOKEN for the newer token)
 *
 * Old lines keep working: H200_PASS_124=... Values are never printed.
 */

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const H200_HOST_DEFAULT = "172.18.0.83";
export const JUMP_HOST_DEFAULT = "pc-server-1";

export function loadDotEnv(base = root) {
  const file = path.join(base, ".env");
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

export function mergedEnv() {
  return { ...process.env, ...loadDotEnv() };
}

export function listAccounts(env = mergedEnv()) {
  const byRoll = new Map();
  const slot = (roll) => {
    if (!byRoll.has(roll)) byRoll.set(roll, { roll, name: "", h200: null, kaggle: null });
    return byRoll.get(roll);
  };
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    let m = key.match(/^NNM23CS(\d{3})_(NAME|H200|KAGGLE_USER|KAGGLE_KEY|KAGGLE_TOKEN)$/i) ||
      key.match(/^H200_PASS_(\d{3})$/i);
    if (!m) continue;
    const a = slot(m[1]);
    const field = (m[2] || "H200").toUpperCase();
    if (field === "NAME") a.name = value.toLowerCase();
    else if (field === "H200") a.h200 = { user: `nnm23cs${m[1]}_stu_cse`, password: value };
    else {
      a.kaggle = a.kaggle || {};
      if (field === "KAGGLE_USER") a.kaggle.user = value;
      if (field === "KAGGLE_KEY") a.kaggle.key = value;
      if (field === "KAGGLE_TOKEN") a.kaggle.token = value;
    }
  }
  for (const a of byRoll.values()) {
    if (a.kaggle && !(a.kaggle.token || (a.kaggle.user && a.kaggle.key))) a.kaggle.incomplete = true;
    a.label = a.name ? `${a.name} (${a.roll})` : a.roll;
  }
  return [...byRoll.values()].sort((x, y) => x.roll.localeCompare(y.roll));
}

export function findAccount(accounts, want) {
  const w = String(want || "").toLowerCase();
  return accounts.find((a) => a.roll === w || a.name === w || a.h200?.user === w || `nnm23cs${a.roll}` === w);
}

export const usable = {
  h200: (a) => Boolean(a.h200),
  kaggle: (a) => Boolean(a.kaggle && !a.kaggle.incomplete),
};

export const howToAdd = {
  h200: (roll = "124") => `NNM23CS${roll}_H200=<college H200 password>`,
  kaggle: (roll = "124") =>
    `NNM23CS${roll}_KAGGLE_USER=<kaggle username>\n  NNM23CS${roll}_KAGGLE_KEY=<key from kaggle.com > Settings > API > Create New Token>`,
};

export async function ask(question) {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function yes(question) {
  return ["y", "yes"].includes((await ask(`${question} [y/N] `)).toLowerCase());
}

/** Pick one account that has this platform. want: roll or name to skip the menu. */
export async function pickAccount(platform, want = "", { note } = {}) {
  const all = listAccounts();
  const ok = all.filter(usable[platform]);
  const name = platform === "h200" ? "H200" : "Kaggle";
  if (want) {
    const a = findAccount(ok, want);
    if (!a) {
      console.error(`No ${name} login in .env for ${want}. Have: ${ok.map((x) => x.label).join(", ") || "none"}.`);
      console.error(`Add to .env:\n  ${howToAdd[platform](/^\d{3}$/.test(want) ? want : "124")}`);
      process.exit(1);
    }
    return a;
  }
  if (!ok.length) {
    console.error(`No ${name} account in .env yet. Add one (your own USN), then run this again:`);
    console.error(`  ${howToAdd[platform]()}`);
    console.error("Check what is set with: pnpm accounts");
    process.exit(1);
  }
  if (ok.length === 1) {
    console.log(`Using ${ok[0].label}, the only ${name} account in .env.`);
    return ok[0];
  }
  console.log(`\nWhich ${name} account?`);
  ok.forEach((a, i) => console.log(`  ${i + 1}. ${a.label}${note ? `   ${note(a) || ""}` : ""}`));
  const a = ok[Number(await ask(`Account [1-${ok.length}]: `)) - 1];
  if (!a) {
    console.error("No account chosen.");
    process.exit(1);
  }
  return a;
}

// ---------- network ---------------------------------------------------------

export function tcpReachable(host, port = 22, ms = 2500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(ms, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/**
 * Direct when the H200 answers on port 22 (college WiFi / LAN, no internet data);
 * otherwise through the jump host (headscale + pc-server-1, uses internet data).
 */
export async function h200Route(env = mergedEnv()) {
  const host = env.H200_HOST || H200_HOST_DEFAULT;
  const jump = env.H200_JUMP || JUMP_HOST_DEFAULT;
  if (await tcpReachable(host)) return { host, remote: false, sshOpts: [], label: "college network, direct" };
  return { host, remote: true, sshOpts: ["-J", jump], jump, label: `outside college, through ${jump}` };
}

export const UNREACHABLE =
  "Cannot reach the H200.\n" +
  "  On college WiFi or LAN it connects directly.\n" +
  "  Outside college it goes through pc-server-1: connect headscale (tailscale) first,\n" +
  "  and check that `ssh h200` works in a terminal. Setup steps: docs/COMMANDS.md, section 8.";

// ---------- python ------------------------------------------------------------

export const python =
  process.platform === "win32"
    ? path.join(root, "ml", ".venv", "Scripts", "python.exe")
    : path.join(root, "ml", ".venv", "bin", "python");

export function requirePython() {
  if (fs.existsSync(python)) return;
  console.error(`Python environment missing: ${path.relative(root, python)}`);
  console.error("Create it once:  python -m venv ml/.venv  then install ml/requirements.");
  process.exit(1);
}

export function kaggleReady() {
  const r = spawnSync(python, ["-c", "import kaggle.api.kaggle_api_extended, psutil"], {
    encoding: "utf8",
    env: { ...process.env, KAGGLE_USERNAME: "x", KAGGLE_KEY: "x" },
  });
  return r.status === 0;
}

export function explainKaggleMissing() {
  console.error("The Kaggle tools are not installed in ml/.venv (needs the kaggle and psutil packages).");
  console.error("Install them once (about 5 MB):");
  console.error(`  ${path.relative(root, python)} -m pip install kaggle psutil`);
}

export function stagingFor(account) {
  return path.resolve(root, "..", "bme_kaggle_staging", "accounts", account.roll);
}

export function kaggleEnv(account) {
  const env = { ...process.env, PYTHONUNBUFFERED: "1", KAGGLE_STAGING_DIR: stagingFor(account) };
  delete env.KAGGLE_CONFIG_DIR;
  if (account.kaggle.token) env.KAGGLE_API_TOKEN = account.kaggle.token;
  if (account.kaggle.user) env.KAGGLE_USERNAME = account.kaggle.user;
  if (account.kaggle.key) env.KAGGLE_KEY = account.kaggle.key;
  return env;
}

const PIPELINE = path.join(root, "ml", "scripts", "kaggle_pipeline.py");

/** Run one kaggle_pipeline.py subcommand as this account. capture: return stdout instead of showing it. */
export function kaggle(account, args, { capture = false } = {}) {
  const r = spawnSync(python, [PIPELINE, "--src", root, ...args], {
    cwd: root,
    env: kaggleEnv(account),
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  return { code: r.status ?? 1, out: r.stdout || "", err: r.stderr || "" };
}

export function kaggleJson(account, args) {
  const r = kaggle(account, args, { capture: true });
  const line = r.out.trim().split(/\r?\n/).reverse().find((l) => l.startsWith("{"));
  if (r.code !== 0 || !line) return { error: (r.err || r.out).trim().split(/\r?\n/).pop() || `exit ${r.code}` };
  return JSON.parse(line);
}

export function fmt(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// ---------- shared Kaggle dataset ----------------------------------------------

/**
 * KAGGLE_DATASET_OWNER=<roll> in .env: the one account that uploads the private
 * dataset. The other accounts train on it after the owner shares it with them
 * on kaggle.com (Kaggle's API cannot share). Unset with one Kaggle account: that one.
 */
export function datasetOwner(env = mergedEnv()) {
  const kag = listAccounts(env).filter(usable.kaggle);
  const want = (env.KAGGLE_DATASET_OWNER || "").trim();
  if (want) return { owner: findAccount(kag, want) || null, set: want, all: kag };
  return { owner: kag.length === 1 ? kag[0] : null, set: "", all: kag };
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** This account's last Kaggle run and dataset record, read locally (no internet). */
export function kaggleLocalState(account) {
  const dir = stagingFor(account);
  return {
    run: readJson(path.join(dir, "run_state.json")),
    approval: readJson(path.join(dir, "dataset_approval.json")),
  };
}

/** The Kaggle user name of an account: from .env, or asked from Kaggle once. */
export function kaggleUserOf(account) {
  if (account.kaggle.user) return account.kaggle.user;
  const r = kaggle(account, ["whoami"], { capture: true });
  return r.code === 0 ? r.out.trim().split(/\r?\n/).pop() : "";
}

// ---------- other scripts ------------------------------------------------------

export function runNode(script, args = [], extraEnv = {}) {
  const r = spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  return r.status ?? 1;
}
