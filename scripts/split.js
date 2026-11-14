import { spawnSync } from "node:child_process";
import path from "node:path";
import { python, requirePython, root, yes } from "./lib/accounts.js";
import { next, ok, title } from "./lib/ui.js";

/**
 * pnpm train:split            show the fixed 80/20 split (or the proposal), offer to save it
 * pnpm train:split --remake   a new split; the old file is kept under a dated name
 */

requirePython();
const script = path.join(root, "ml", "scripts", "holdout_split.py");
const remake = process.argv.includes("--remake");
title("Fixed 80/20 split", "Method 5 trains once on the training scans and is scored on the same validation scans every time.");
const show = spawnSync(python, [script, root], { cwd: root, encoding: "utf8" });
process.stdout.write(show.stdout || "");
if (show.status !== 0) {
  process.stderr.write(show.stderr || "");
  process.exit(show.status ?? 1);
}
const saved = !/Not saved yet/.test(show.stdout || "");
if (saved && !remake) {
  next("pnpm train 5                 train on it (H200 or this PC)", "pnpm train:split --remake    only if the split must change (old scores stop being comparable)");
  process.exit(0);
}
if (remake && !(await yes("Make a NEW split? Scores from the old one are then not comparable."))) process.exit(0);
if (!remake && !(await yes("Save this split? From then on it never changes."))) process.exit(0);
const r = spawnSync(python, [script, root, remake ? "--remake" : "--create"], { cwd: root, stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
ok("Saved. It goes to the H200 with the next push.");
next("pnpm train 5                 train on it");
