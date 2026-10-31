import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

/**
 * Who logs in to the H200. Passwords live in .env, either as
 *   H200_PASS_<roll>=...      or      NNM23CS<roll>_H200=...
 * One password found: that account is used without asking. Several: a menu.
 * The password is never printed.
 */

export function loadDotEnv(root) {
  const file = path.join(root, ".env");
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

function accountsIn(env) {
  const found = new Map();
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    const m = key.match(/^H200_PASS_(\d{3})$/i) || key.match(/^NNM23CS(\d{3})_H200$/i);
    if (m) found.set(m[1], { roll: m[1], user: `nnm23cs${m[1]}_stu_cse`, password: value });
  }
  return [...found.values()].sort((a, b) => a.roll.localeCompare(b.roll));
}

async function ask(question) {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function chooseH200(root) {
  const env = { ...process.env, ...loadDotEnv(root) };
  const host = env.H200_HOST || "172.18.0.83";
  const accounts = accountsIn(env);
  if (!accounts.length) {
    console.error("No H200 password in .env.");
    console.error("Add one line, for example:  NNM23CS124_H200=<password>");
    process.exit(1);
  }
  let account = accounts[0];
  if (accounts.length > 1) {
    console.log("\nWhich college account?");
    accounts.forEach((a, i) => console.log(`  ${i + 1}. ${a.user}`));
    account = accounts[Number(await ask(`Account [1-${accounts.length}]: `)) - 1];
    if (!account) {
      console.error("No account chosen.");
      process.exit(1);
    }
  } else {
    console.log(`Using ${account.user} (the only H200 password in .env).`);
  }

  const askpass = path.join(os.tmpdir(), `bme-ssh-askpass-${process.pid}.cmd`);
  fs.writeFileSync(askpass, "@echo off\r\necho %BME_SSH_PASS%\r\n");
  return {
    user: account.user,
    target: `${account.user}@${host}`,
    env: {
      ...process.env,
      SSH_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: "localhost:0",
      BME_SSH_PASS: account.password,
    },
    close() {
      try { fs.unlinkSync(askpass); } catch { /* already gone */ }
    },
  };
}

export { ask };
