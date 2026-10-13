import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

/** The four college logins. Password for each is H200_PASS_<roll> in .env. */
export const H200_ACCOUNTS = [
  { roll: "071", user: "nnm23cs071_stu_cse" },
  { roll: "124", user: "nnm23cs124_stu_cse" },
  { roll: "149", user: "nnm23cs149_stu_cse" },
  { roll: "293", user: "nnm23cs293_stu_cse" },
];

function loadDotEnv(root) {
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

/**
 * Ask which of the four accounts to use. The password is read from .env and
 * never printed. Returns the ssh target and an env block for SSH_ASKPASS.
 */
export async function chooseH200(root) {
  const fileEnv = loadDotEnv(root);
  const host = fileEnv.H200_HOST || process.env.H200_HOST || "172.18.0.83";
  console.log("");
  console.log("Which college account?");
  H200_ACCOUNTS.forEach((account, i) => {
    console.log(`  ${i + 1}. ${account.user}`);
  });
  const rl = readline.createInterface({ input, output });
  const answer = (await rl.question(`Account [1-${H200_ACCOUNTS.length}]: `)).trim();
  rl.close();
  const account = H200_ACCOUNTS[Number(answer) - 1];
  if (!account) {
    console.error("No account chosen.");
    process.exit(1);
  }
  const key = `H200_PASS_${account.roll}`;
  const password = fileEnv[key] || process.env[key] || "";
  if (!password) {
    console.error(`No password for ${account.user}.`);
    console.error(`Add this line to .env and fill it in: ${key}=`);
    process.exit(1);
  }
  const askpass = path.join(os.tmpdir(), `bme-ssh-askpass-${process.pid}.cmd`);
  fs.writeFileSync(askpass, "@echo off\r\necho %BME_SSH_PASS%\r\n");
  return {
    user: account.user,
    target: `${account.user}@${host}`,
    password,
    env: {
      ...process.env,
      SSH_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: "localhost:0",
      BME_SSH_PASS: password,
    },
    close() {
      try { fs.unlinkSync(askpass); } catch { /* already gone */ }
    },
  };
}
