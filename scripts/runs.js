import fs from "node:fs";
import path from "node:path";
import {
  datasetOwner, kaggle, kaggleJson, kaggleLocalState, kaggleReady, listAccounts, root,
  runNode, stagingFor, usable, yes,
} from "./lib/accounts.js";
import { c, choose, info, next, ok, section, stop, table, title, warn } from "./lib/ui.js";

/**
 * pnpm runs             menu
 * pnpm runs:status      every account on the H200 and Kaggle, plus this PC, in one place
 * pnpm runs:log         the log of one run (H200: live)
 * pnpm runs:get         download a finished run's scores and weights
 * pnpm runs:cancel      stop one H200 job (Kaggle: how to stop it on kaggle.com)
 * pnpm runs:compare     the scores of every finished run on this PC, side by side
 */

const kernelOf = (run) => String(run?.kernel_slug || "").split("/").pop();

function kaggleLive(account, run) {
  const r = kaggle(account, ["status", "--kernel-slug", kernelOf(run)], { capture: true });
  const m = r.out.match(/:\s*([A-Z_]+)/);
  return m ? m[1].toLowerCase() : "unknown";
}

function kaggleRows() {
  const acc = listAccounts().filter(usable.kaggle);
  if (!acc.length) return null;
  const { owner } = datasetOwner();
  let current = "";
  if (owner && kaggleReady()) {
    const st = kaggleJson(owner, ["data-status"]);
    current = st.error ? "?" : st.needs_upload ? c.yellow(`upload pending (${st.reason})`) : "up to date";
  }
  return acc.map((a) => {
    const { run } = kaggleLocalState(a);
    let phase = run ? String(run.phase).toLowerCase() : "-";
    if (run && ["QUEUED", "RUNNING"].includes(run.phase) && kaggleReady()) phase = `${phase} (live: ${kaggleLive(a, run)})`;
    const isOwner = owner && a.roll === owner.roll && (a.slot || 1) === (owner.slot || 1);
    const dataset = isOwner ? `holds it: ${current || "?"}` : owner ? `shared from ${owner.label}` : "?";
    const startedBy = run?.startedBy
      ? (run.startedBy.name ? `${run.startedBy.name} (${run.startedBy.usn || ""})`.trim() : (run.startedBy.usn || a.label))
      : a.label;
    const where = run?.platform || "kaggle";
    const account = run?.account || a.kaggleUser || a.label;
    return [a.label, run?.import_name || run?.model_arch || "-", phase, dataset, startedBy, where, account];
  });
}

function localRows() {
  const data = path.join(root, "data");
  if (!fs.existsSync(data)) return [];
  const dirs = fs.readdirSync(data).filter((d) => /^results3d-.*-pc$/.test(d));
  return dirs.map((d) => {
    const isFin = fs.existsSync(path.join(data, d, "metrics.json"));
    const statusFile = path.join(data, d, "run_status.json");
    let meta = null;
    if (fs.existsSync(statusFile)) {
      try { meta = JSON.parse(fs.readFileSync(statusFile, "utf8")); } catch { /* ignore */ }
    }
    const startedBy = meta?.startedBy
      ? (meta.startedBy.name ? `${meta.startedBy.name} (${meta.startedBy.usn || ""})`.trim() : (meta.startedBy.usn || "-"))
      : "-";
    const where = meta?.platform || "local";
    const account = meta?.account || "-";
    return [d, isFin ? "finished" : "started, not finished", startedBy, where, account];
  });
}

async function status() {
  title("Runs", "Where every training run is. Nothing here starts or stops anything.");
  section("Kaggle");
  const rows = kaggleRows();
  if (!rows) info("No Kaggle account in .env (see pnpm accounts).");
  else {
    if (!kaggleReady()) warn("Kaggle tools not installed here, so live states are not checked (pnpm accounts says how).");
    table(rows, ["slot", "method", "state", "dataset", "Started by", "Where", "Account"]);
  }
  section("This PC");
  const loc = localRows();
  if (loc.length) table(loc, ["folder", "state", "Started by", "Where", "Account"]);
  else info("No comparison run on this PC yet.");
  section("College H200");
  const h = listAccounts().filter(usable.h200);
  if (!h.length) info("No H200 account in .env (see pnpm accounts).");
  for (const a of h) {
    console.log("");
    console.log(c.bold(`-- ${a.label} `.padEnd(40, "-")));
    if (runNode("h200-menu.js", ["status", "--as", a.roll]) !== 0) warn(`${a.label}: not reachable now; the others are still listed.`);
  }
  next("pnpm runs:log       follow one run's log", "pnpm runs:get       download a finished run", "pnpm runs:compare   compare the scores");
}

async function pickRun(why) {
  const items = [];
  for (const a of listAccounts()) {
    if (usable.h200(a)) items.push({ group: "College H200", label: a.label, about: "its newest job", platform: "h200", a });
  }
  for (const a of listAccounts().filter(usable.kaggle)) {
    const { run } = kaggleLocalState(a);
    items.push({
      group: "Kaggle",
      label: a.label,
      about: run ? `${run.import_name || run.model_arch}: ${String(run.phase).toLowerCase()}` : "no run yet",
      disabled: run ? undefined : "no run on this account",
      platform: "kaggle",
      a,
      run,
    });
  }
  if (!items.length) stop("No account in .env yet.", "See: pnpm accounts");
  return choose(why, items, { prompt: "Which" });
}

async function log() {
  title("Log");
  const p = await pickRun("Whose log?");
  if (!p) return;
  if (p.platform === "h200") process.exit(runNode("h200-menu.js", ["log", "--as", p.a.roll]));
  if (!kaggleReady()) stop("The Kaggle tools are not installed here.", "pnpm accounts says how.");
  kaggle(p.a, ["logs", "--kernel-slug", kernelOf(p.run)]);
}

async function get() {
  title("Download a finished run");
  const p = await pickRun("From which account?");
  if (!p) return;
  if (p.platform === "h200") process.exit(runNode("h200-menu.js", ["get", "--as", p.a.roll]));
  if (!kaggleReady()) stop("The Kaggle tools are not installed here.", "pnpm accounts says how.");
  const { run, a } = p;
  const name = run.import_name || run.model_arch;
  if (run.phase === "COMPLETED") {
    ok(`${name} is already downloaded: ${path.relative(root, run.dest_dir || "") || "data/results3d_experiments"}`);
    next("pnpm runs:compare");
    return;
  }
  if (run.phase === "INCOMPLETE") {
    warn(`${name} stopped at Kaggle's time limit; its checkpoints are on Kaggle.`);
    next(`pnpm train ${name} --as ${a.roll}   continue it in a new session`);
    return;
  }
  if (run.phase === "FAILED") {
    warn(`${name} failed: ${String(run.status_message || "").slice(0, 300)}`);
    next(`pnpm train ${name} --as ${a.roll}   start it again`);
    return;
  }
  if (["QUEUED", "RUNNING"].includes(run.phase)) {
    info(`${name} may still be running. This waits here until it ends, then downloads.`);
    info("Ctrl+C stops the waiting only; the run on Kaggle continues.");
  }
  info("The download is the weights and scores only, usually 5-50 MB of internet data.");
  if (!(await yes("Download now?"))) return;
  const args = ["run", "--resume"];
  const { owner } = datasetOwner();
  if (owner && (owner.roll !== a.roll || (owner.slot || 1) !== (a.slot || 1))) args.push("--approval-dir", stagingFor(owner));
  const r = kaggle(a, args);
  if (r.code !== 0) stop("The download did not finish.", "Run pnpm runs:get again; it picks up where it stopped.");
  next("pnpm runs:compare");
}

async function cancel() {
  title("Stop a run");
  const p = await pickRun("Whose run?");
  if (!p) return;
  if (p.platform === "h200") process.exit(runNode("h200-menu.js", ["cancel", "--as", p.a.roll]));
  info("Kaggle's API cannot stop a run. To stop it:");
  info(`  kaggle.com > Your Work > Code > ${kernelOf(p.run)} > the running version > Stop session.`);
  info("Its saved checkpoints stay; choosing the method again later continues from them.");
}

function fmtMs(s, key) {
  const v = s?.[key];
  if (!v) return "-";
  return v.std ? `${v.mean.toFixed(3)} +- ${v.std.toFixed(3)}` : v.mean.toFixed(3);
}

async function compare() {
  title("Compare finished runs", "Mean +- std over the folds. Holdout is one round, so it has no spread.");
  const data = path.join(root, "data");
  const dirs = [];
  if (fs.existsSync(data)) {
    for (const d of fs.readdirSync(data)) if (/^results3d/.test(d) && d !== "results3d_experiments") dirs.push(d);
    const exp = path.join(data, "results3d_experiments");
    if (fs.existsSync(exp)) for (const d of fs.readdirSync(exp)) dirs.push(`results3d_experiments/${d}`);
  }
  const rows = [];
  for (const d of dirs.sort()) {
    const f = path.join(data, d, "metrics.json");
    if (!fs.existsSync(f)) continue;
    let m;
    try { m = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    const statusFile = path.join(data, d, "run_status.json");
    let meta = null;
    if (fs.existsSync(statusFile)) {
      try { meta = JSON.parse(fs.readFileSync(statusFile, "utf8")); } catch { /* ignore */ }
    }
    const startedBy = meta?.startedBy
      ? (meta.startedBy.name ? `${meta.startedBy.name} (${meta.startedBy.usn || ""})`.trim() : (meta.startedBy.usn || "-"))
      : (m.startedBy ? (m.startedBy.name ? `${m.startedBy.name} (${m.startedBy.usn || ""})`.trim() : (m.startedBy.usn || "-")) : "-");
    const where = meta?.platform || m.platform || (d.includes("-pc") ? "local" : (d.includes("h200") ? "h200" : (d.startsWith("results3d_experiments/k-") ? "kaggle" : "-")));
    const account = meta?.account || m.account || "-";
    const s = m.summary || {};
    rows.push([
      d, startedBy, where, account, m.model_arch || m.model || "?", m.fold_mode === "fixed_holdout_80_20" ? "80/20" : `${m.folds}`,
      m.n_cases ?? "?", fmtMs(s, "bone_dice"), fmtMs(s, "bme_dice_pos"), fmtMs(s, "lesion_sensitivity_pos"),
      fmtMs(s, "clean_scan_specificity"), fmtMs(s, "fp_per_case"),
    ]);
  }
  if (!rows.length) {
    info("No finished run on this PC yet. Download one with: pnpm runs:get");
    return;
  }
  table(rows, ["folder", "Started by", "Where", "Account", "model", "folds", "scans", "bone Dice", "edema Dice*", "lesion sens*", "clean spec", "FP/case"]);
  info("");
  info("* on scans that have edema. Edema Dice over all scans looks better because clean scans score 1.0.");
  info("Compare runs of one platform with each other: the H200, Kaggle and laptop setups differ.");
}

const OPS = {
  status: { label: "Status", about: "every account on the H200 and Kaggle, plus this PC", fn: status },
  log: { label: "Log", about: "one run's log (H200 live; Kaggle when the run has ended)", fn: log },
  get: { label: "Download", about: "a finished run's scores and weights (shows the size first)", fn: get },
  compare: { label: "Compare", about: "the scores of every finished run on this PC", fn: compare },
  cancel: { label: "Stop a run", about: "cancel one H200 job; Kaggle: how to stop it", fn: cancel },
};

const op = process.argv[2];
if (op && !OPS[op]) stop(`Unknown: ${op}.`, `One of: ${Object.keys(OPS).join(", ")}`);
if (op) await OPS[op].fn();
else {
  title("Runs");
  const pick = await choose("", Object.values(OPS), { prompt: "What" });
  if (pick) await pick.fn();
}
