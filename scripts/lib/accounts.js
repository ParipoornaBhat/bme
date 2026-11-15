import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
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
  const people = new Map();
  const getPerson = (roll) => {
    if (!people.has(roll)) {
      people.set(roll, { roll, name: "", h200: null, kaggleSlots: new Map() });
    }
    return people.get(roll);
  };

  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;

    // Numbered Kaggle slot: NNM23CS124_2_KAGGLE_USER, etc.
    let m = key.match(/^NNM23CS(\d{3})_(\d+)_(KAGGLE_USER|KAGGLE_KEY|KAGGLE_TOKEN)$/i);
    if (m) {
      const roll = m[1];
      const slotNum = Number(m[2]);
      const field = m[3].toUpperCase();
      const p = getPerson(roll);
      if (!p.kaggleSlots.has(slotNum)) p.kaggleSlots.set(slotNum, {});
      const slotData = p.kaggleSlots.get(slotNum);
      if (field === "KAGGLE_USER") slotData.user = value;
      else if (field === "KAGGLE_KEY") {
        if (value.startsWith("KGAT_")) slotData.token = value;
        else slotData.key = value;
      } else if (field === "KAGGLE_TOKEN") {
        slotData.token = value;
      }
      continue;
    }

    // Default slot 1 or person metadata: NNM23CS124_NAME, NNM23CS124_H200, NNM23CS124_KAGGLE_USER, etc.
    m = key.match(/^NNM23CS(\d{3})_(NAME|H200|KAGGLE_USER|KAGGLE_KEY|KAGGLE_TOKEN)$/i) ||
      key.match(/^H200_PASS_(\d{3})$/i);
    if (m) {
      const roll = m[1];
      const field = (m[2] || "H200").toUpperCase();
      const p = getPerson(roll);
      if (field === "NAME") {
        p.name = value.toLowerCase();
      } else if (field === "H200") {
        p.h200 = { user: `nnm23cs${roll}_stu_cse`, password: value };
      } else {
        if (!p.kaggleSlots.has(1)) p.kaggleSlots.set(1, {});
        const slotData = p.kaggleSlots.get(1);
        if (field === "KAGGLE_USER") slotData.user = value;
        else if (field === "KAGGLE_KEY") {
          if (value.startsWith("KGAT_")) slotData.token = value;
          else slotData.key = value;
        } else if (field === "KAGGLE_TOKEN") {
          slotData.token = value;
        }
      }
    }
  }

  const result = [];
  for (const p of people.values()) {
    const usn = `NNM23CS${p.roll}`;
    const slots = [...p.kaggleSlots.entries()].sort((a, b) => a[0] - b[0]);
    if (slots.length > 0) {
      for (const [slotNum, slotData] of slots) {
        if (!(slotData.token || (slotData.user && slotData.key))) {
          slotData.incomplete = true;
        }
        const kaggleUser = slotData.user || "";
        const label = slotNum === 1
          ? (p.name ? `${p.name} (${p.roll})` : p.roll)
          : (p.name ? `${p.name} (kaggle ${slotNum}: ${kaggleUser || p.roll})` : `${p.roll} (kaggle ${slotNum}: ${kaggleUser || p.roll})`);

        result.push({
          usn,
          roll: p.roll,
          name: p.name,
          slot: slotNum,
          kaggleUser,
          h200: slotNum === 1 ? p.h200 : null,
          kaggle: slotData,
          label,
        });
      }
      if (p.h200 && !p.kaggleSlots.has(1)) {
        // If slot 1 wasn't defined for Kaggle, the first slot still has h200
        const first = result.find((r) => r.roll === p.roll);
        if (first && !first.h200) first.h200 = p.h200;
      }
    } else {
      const label = p.name ? `${p.name} (${p.roll})` : p.roll;
      result.push({
        usn,
        roll: p.roll,
        name: p.name,
        slot: 1,
        kaggleUser: "",
        h200: p.h200,
        kaggle: null,
        label,
      });
    }
  }

  return result.sort((x, y) => x.roll.localeCompare(y.roll) || x.slot - y.slot);
}

export function findAccount(accounts, want) {
  const w = String(want || "").trim().toLowerCase();
  if (!w) return undefined;
  if (w.includes(":")) {
    const [target, slotStr] = w.split(":");
    const targetSlot = Number(slotStr);
    return accounts.find(
      (a) =>
        a.slot === targetSlot &&
        (a.usn?.toLowerCase() === target ||
          a.roll?.toLowerCase() === target ||
          a.name?.toLowerCase() === target ||
          a.kaggleUser?.toLowerCase() === target ||
          a.h200?.user?.toLowerCase() === target ||
          `nnm23cs${a.roll}`.toLowerCase() === target)
    );
  }
  const byKaggle = accounts.find((a) => a.kaggleUser?.toLowerCase() === w);
  if (byKaggle) return byKaggle;

  const matches = accounts.filter(
    (a) =>
      a.usn?.toLowerCase() === w ||
      a.roll?.toLowerCase() === w ||
      a.name?.toLowerCase() === w ||
      a.h200?.user?.toLowerCase() === w ||
      `nnm23cs${a.roll}`.toLowerCase() === w
  );
  if (matches.length) {
    return matches.find((a) => a.slot === 1) || matches[0];
  }
  return undefined;
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
  const sub = account.slot && account.slot > 1 ? `${account.roll}_${account.slot}` : account.roll;
  return path.resolve(root, "..", "bme_kaggle_staging", "accounts", sub);
}

export function kaggleEnv(account, extra = {}) {
  const env = { ...process.env, PYTHONUNBUFFERED: "1", KAGGLE_STAGING_DIR: stagingFor(account), ...extra };
  delete env.KAGGLE_CONFIG_DIR;
  const isToken = Boolean(account.kaggle?.token || account.kaggle?.key?.startsWith("KGAT_"));
  const token = account.kaggle?.token || (account.kaggle?.key?.startsWith("KGAT_") ? account.kaggle.key : null);
  if (isToken) {
    env.KAGGLE_API_TOKEN = token;
    delete env.KAGGLE_KEY;
  } else if (account.kaggle?.key) {
    env.KAGGLE_KEY = account.kaggle.key;
    delete env.KAGGLE_API_TOKEN;
  }
  if (account.kaggle?.user) env.KAGGLE_USERNAME = account.kaggle.user;
  return env;
}

export function createRunMetadata({ account, platform, methodId }) {
  const hostname = os.hostname();
  const startedAt = new Date().toISOString();
  let accName = "";
  if (platform === "kaggle") {
    accName = `${account?.kaggleUser || account?.kaggle?.user || ""}${account?.slot && account.slot > 1 ? ` (slot ${account.slot})` : ""}`;
  } else if (platform === "h200") {
    accName = account?.h200?.user || account?.user || "";
  } else {
    accName = os.userInfo().username;
  }
  return {
    startedBy: {
      usn: account?.usn || (account?.roll ? `NNM23CS${account.roll}` : ""),
      name: account?.name || os.userInfo().username,
    },
    platform,
    account: accName,
    host: hostname,
    startedAt,
    methodId: methodId || "",
  };
}

const PIPELINE = path.join(root, "ml", "scripts", "kaggle_pipeline.py");

/** Run one kaggle_pipeline.py subcommand as this account. capture: return stdout instead of showing it. */
export function kaggle(account, args, { capture = false, extraEnv = {} } = {}) {
  const r = spawnSync(python, [PIPELINE, "--src", root, ...args], {
    cwd: root,
    env: kaggleEnv(account, extraEnv),
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
