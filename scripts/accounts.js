import { spawnSync } from "node:child_process";
import {
  datasetOwner, explainKaggleMissing, h200Route, howToAdd, kaggleEnv, kaggleReady, kaggleUserOf,
  listAccounts, loadDotEnv, python, requirePython, root, tcpReachable, usable,
} from "./lib/accounts.js";
import { c, info, next, ok, section, table, title, warn, bad } from "./lib/ui.js";

/**
 * pnpm accounts          what is set up for each teammate, and a live test of each login
 * Never prints a password, key or token: only whether it is there, and the result of the test.
 */

const short = (x) => (x ? "set" : "-");

function h200Test(a, route) {
  const r = spawnSync("ssh", [
    ...route.sshOpts, "-o", "BatchMode=yes", "-o", "ConnectTimeout=12", "-o", "StrictHostKeyChecking=accept-new",
    `${a.h200.user}@${route.host}`, "echo BME_OK",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return r.stdout?.includes("BME_OK") ? "login ok" : "login failed (password, route or account)";
}

function kaggleTest(a) {
  if (!kaggleReady()) return "tools not installed";
  const env = kaggleEnv(a);
  const r = spawnSync(python, [`${root}/ml/scripts/kaggle_pipeline.py`, "--src", root, "whoami"], { encoding: "utf8", env });
  if (r.status !== 0) return "login failed (check the username and key or token)";
  return `login ok as ${(r.stdout || "").trim().split(/\r?\n/).pop()}`;
}

async function main() {
  requirePython();
  title("Accounts", "Each teammate has one block in .env (keyed by USN). Passwords and keys are never shown.");
  const env = loadDotEnv();
  const accounts = listAccounts({ ...process.env, ...env });
  if (!accounts.length) {
    warn("No account in .env yet. Add your own block (see .env.example), then run this again:");
    info(`  ${howToAdd.h200()}`);
    info(`  ${howToAdd.kaggle()}`);
    return;
  }
  const route = await h200Route({ ...process.env, ...env });
  section("Logins");
  const rows = accounts.map((a) => [
    a.label,
    short(a.h200),
    a.kaggle?.incomplete ? c.yellow("incomplete") : short(a.kaggle),
  ]);
  table(rows, ["account", "H200", "Kaggle"]);
  info("");
  info(`H200 route now: ${route.label}${route.remote ? c.yellow(" (uses internet data)") : ""}.`);

  if (process.argv.includes("--test")) {
    section("Test");
    for (const a of accounts) {
      if (usable.h200(a)) ok(`${a.label} H200: ${h200Test(a, route)}`);
      if (a.kaggle?.incomplete) bad(`${a.label} Kaggle: user or key/token missing in .env`);
      else if (usable.kaggle(a)) ok(`${a.label} Kaggle: ${kaggleTest(a)}`);
    }
  } else {
    info("Add --test to log in to each account now (for the H200 this uses the route above).");
  }

  section("Kaggle dataset");
  if (!kaggleReady()) {
    explainKaggleMissing();
  }
  const { owner, set, all } = datasetOwner({ ...process.env, ...env });
  if (all.length > 1 && !set) {
    warn("Several Kaggle accounts and no KAGGLE_DATASET_OWNER: the one holding the dataset must be named.");
    info(`  add to .env:  KAGGLE_DATASET_OWNER=${all[0].roll}`);
  } else if (owner) {
    info(`The private dataset lives on ${owner.label}'s account.`);
    info("Other Kaggle accounts train on it after the owner shares it with them on kaggle.com.");
  } else {
    info("Add a Kaggle account first.");
  }
  if (!(await tcpReachable(route.host))) {
    section("Network");
    bad("The H200 does not answer from here.");
    info("On college WiFi or LAN it connects directly. Outside college it needs headscale (tailscale)");
    info(`connected and the jump host ${route.jump || "pc-server-1"} reachable.`);
  }
  next(
    "pnpm accounts --test   log in to every account now",
    "pnpm train            start a training run",
    "pnpm runs:status      where every run is",
  );
}

await main();
