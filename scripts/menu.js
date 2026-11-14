import { runNode } from "./lib/accounts.js";
import { choose, info, title } from "./lib/ui.js";

/**
 * pnpm menu   the top level: one place to start from. Every item is also a direct pnpm command.
 */

title("BME training", "Start here. Each item is also a direct command, shown in brackets.");
const pick = await choose("", [
  { group: "Accounts", label: "Check accounts and logins", about: "[pnpm accounts]  what is set up, and a live login test with --test" },
  { group: "Data", label: "Data: import, team zips, the fixed split", about: "[pnpm data]  new scans, teammate annotation zips" },
  { group: "Train", label: "Train a model", about: "[pnpm train]  pick a method, then the account and where" },
  { label: "Train on this PC only", about: "[pnpm train:local]  the laptop's NVIDIA or Apple GPU" },
  { group: "Runs", label: "Runs: status, logs, download, compare", about: "[pnpm runs]  every run on the H200, Kaggle and this PC" },
  { label: "Compare finished runs", about: "[pnpm runs:compare]" },
], { prompt: "Choose" });

if (!pick) process.exit(0);
const map = {
  "Check accounts and logins": ["accounts.js"],
  "Data: import, team zips, the fixed split": ["data-menu.js"],
  "Train a model": ["train-menu.js"],
  "Train on this PC only": ["train-local.js"],
  "Runs: status, logs, download, compare": ["runs.js"],
  "Compare finished runs": ["runs.js", "compare"],
};
const [script, ...args] = map[pick.label];
info("");
process.exit(runNode(script, args));
