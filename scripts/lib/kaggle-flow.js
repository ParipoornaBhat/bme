import fs from "node:fs";
import path from "node:path";
import {
  createRunMetadata, datasetOwner, explainKaggleMissing, fmt, howToAdd, kaggle, kaggleJson, kaggleLocalState,
  kaggleReady, kaggleUserOf, pickAccount, requirePython, root, stagingFor, yes,
} from "./accounts.js";
import { pastKaggleRuns } from "./estimates.js";
import { KAGGLE_SETTINGS, PLATFORM } from "./methods.js";
import { c, info, next, ok, section, stop, title, warn } from "./ui.js";

const ACTIVE = new Set(["QUEUED", "RUNNING"]);
const ENDED_NOT_FETCHED = new Set(["DOWNLOADING", "IMPORTING"]);

export function runNote(account) {
  const { run } = kaggleLocalState(account);
  if (!run) return "no run yet";
  const what = run.import_name || run.model_arch || "a run";
  return `${what}: ${String(run.phase || "?").toLowerCase()}`;
}

/** Make sure the shared dataset is current; upload from the owner account only if it changed. */
export async function ensureKaggleData(owner) {
  section("Data");
  info(`The dataset is one private Kaggle dataset on ${owner.label}'s account.`);
  info("Refreshing the local de-identified export (this PC only, no internet)...");
  const exp = kaggle(owner, ["export"]);
  if (exp.code !== 0) stop("The de-identified export failed; nothing was uploaded or started.", "Read the lines above.");
  const st = kaggleJson(owner, ["data-status", "--remote"]);
  if (st.error) stop(`Could not check the Kaggle dataset: ${st.error}`, "Check the login with: pnpm accounts");
  const ex = st.export || {};
  info(`Local export: ${ex.cases ?? "?"} scans, ${ex.files ?? "?"} files, ${fmt(ex.bytes || 0)}.`);
  if (!st.needs_upload) {
    ok(`Kaggle dataset is the same as the local export (${ex.hash}). Nothing to upload.`);
    return st;
  }
  warn(`Upload needed: ${st.reason}.`);
  info(`It uses about ${c.bold(fmt(ex.bytes || 0))} of internet data (the whole dataset goes as one zip).`);
  info("On mobile data, consider waiting for WiFi.");
  if (!(await yes("Upload it now?"))) stop("Not uploaded, so nothing was started.", "Run this again when you are on WiFi.");
  const up = kaggle(owner, ["update-dataset"]);
  if (up.code !== 0) stop("The upload did not finish; nothing was started.", "Run this again; unchanged files are checked first.");
  ok("Dataset uploaded and private.");
  return st;
}

function sharingSteps(owner, account, ownerUser, mateUser) {
  section("Sharing");
  info(`This run uses ${owner.label}'s dataset, so ${account.label}'s Kaggle account must be allowed to see it.`);
  info("Once per teammate, on kaggle.com:");
  info(`  1. Sign in as ${ownerUser || owner.label} and open Your Work > Datasets > bme-3d-dataset.`);
  info(`  2. Settings (or the Share button) > add ${c.bold(mateUser || account.label)} > can view.`);
  info("  3. Leave the dataset Private. Never make it public.");
  info("The launch checks this first and stops with this message if it is not shared yet.");
}

/** Start or continue one Kaggle method on one account. */
export async function trainOnKaggle(method, want = "") {
  requirePython();
  title(`Kaggle: ${method.n}. ${method.label}`, PLATFORM.kaggle.limit);
  if (!kaggleReady()) {
    explainKaggleMissing();
    process.exit(1);
  }
  const { owner, set, all } = datasetOwner();
  if (!all.length) stop("No Kaggle account in .env yet.", "Add your own (see .env.example):", `  ${howToAdd.kaggle()}`, "Then: pnpm accounts");
  if (!owner) {
    if (set) stop(`KAGGLE_DATASET_OWNER=${set} in .env, but that account has no complete Kaggle login.`, "Fix it, then check with: pnpm accounts");
    stop(
      "Several Kaggle accounts: say which one holds the shared dataset.",
      "Add one line to .env (the uploader's USN), for example:",
      `  KAGGLE_DATASET_OWNER=${all[0].roll}`,
    );
  }

  const account = await pickAccount("kaggle", want, {
    note: (a) => `${runNote(a)}${a.roll === owner.roll && (a.slot || 1) === (owner.slot || 1) ? ", holds the dataset" : ""}`,
  });
  const { run } = kaggleLocalState(account);
  let resume = false;
  if (run) {
    const name = run.import_name || run.model_arch || "a run";
    const same = run.import_name === method.id;
    if (ACTIVE.has(run.phase)) {
      stop(`${account.label} is still running ${name}. One run per account at a time.`,
        "Watch it: pnpm runs:status", "Or choose another Kaggle account.");
    }
    if (ENDED_NOT_FETCHED.has(run.phase)) {
      stop(`${name} has ended on ${account.label}'s Kaggle but is not downloaded yet.`, "Download it first: pnpm runs:get");
    }
    if (run.phase === "INCOMPLETE" && same) {
      warn(`${name} stopped at Kaggle's time limit before every fold finished.`);
      resume = await yes("Continue it from its checkpoints in a new 12 h session?");
      if (!resume && !(await yes("Start it again from scratch instead?"))) return;
    } else if (run.phase === "INCOMPLETE") {
      warn(`${name} on this account stopped before finishing. Starting ${method.id} here means this menu`);
      warn(`can no longer continue ${name} (use another account for ${method.id} to keep that option).`);
      if (!(await yes(`Start ${method.id} anyway?`))) return;
    } else if (run.phase === "COMPLETED" && same) {
      const done = fs.existsSync(path.join(root, "data", "results3d_experiments", method.id, "metrics.json"));
      if (done) {
        ok(`${method.id} already finished here: data/results3d_experiments/${method.id}/metrics.json`);
        if (!(await yes("Train it again from scratch (the old result is kept as a backup)?"))) return;
      }
    } else if (run.phase === "FAILED") {
      warn(`The last run here (${name}) failed: ${String(run.status_message || "").slice(0, 200)}`);
    }
  }

  await ensureKaggleData(owner);
  const shared = account.roll !== owner.roll || (account.slot || 1) !== (owner.slot || 1);
  const ownerUser = shared ? kaggleUserOf(owner) : "";
  if (shared) {
    if (!ownerUser) stop(`Cannot tell ${owner.label}'s Kaggle user name.`, `Add NNM23CS${owner.roll}_KAGGLE_USER=<username> to .env.`);
    sharingSteps(owner, account, ownerUser, kaggleUserOf(account));
  }

  section("Time");
  const past = pastKaggleRuns(method.arch);
  if (past.length) {
    info("Earlier Kaggle runs (T4 x2) of this project:");
    past.forEach((p) => info(`  ${p.text}`));
  } else {
    info("No earlier Kaggle run of this model is recorded, so there is no measured time yet.");
  }
  info(`Limit: ${PLATFORM.kaggle.limit}.`);
  info("If it stops at the limit, choosing this method again on this account continues it.");

  section("Start");
  info(`${resume ? "Continue" : "Start"} ${method.id} as ${account.label}: ${method.arch}, augmentation med, 5 folds.`);
  if (!(await yes("Go ahead?"))) return;

  const meta = createRunMetadata({ account, platform: "kaggle", methodId: method.id });
  const stagingDir = stagingFor(account);
  fs.mkdirSync(stagingDir, { recursive: true });
  const statePath = path.join(stagingDir, "run_state.json");
  const existingState = kaggleLocalState(account).run || {};
  fs.writeFileSync(statePath, JSON.stringify({ ...existingState, ...meta }, null, 2), "utf8");

  const args = [
    "run", "--confirm-launch", "--no-wait", "--mode", "full",
    "--model-arch", method.arch, "--kernel-slug", `bme-${method.id}`, "--import-name", method.id,
    ...KAGGLE_SETTINGS,
  ];
  if (resume) args.push("--continue-previous");
  if (shared) args.push("--dataset-owner", ownerUser, "--approval-dir", stagingFor(owner));
  const r = kaggle(account, args, { extraEnv: { BME_RUN_METADATA: JSON.stringify(meta) } });
  if (r.code !== 0) stop("Kaggle did not start the run. The reason is printed above.", "Fix it and choose the method again.");
  ok(`${method.id} is running on Kaggle as ${account.label}. This PC can sleep; nothing here waits for it.`);
  next(
    "pnpm runs:status   where every run is",
    "pnpm runs:log      its log (Kaggle releases it when the run ends)",
    "pnpm runs:get      download the scores and weights when it has finished",
  );
  if (r.code !== 0) stop("Kaggle did not start the run. The reason is printed above.", "Fix it and choose the method again.");
  ok(`${method.id} is running on Kaggle as ${account.label}. This PC can sleep; nothing here waits for it.`);
  next(
    "pnpm runs:status   where every run is",
    "pnpm runs:log      its log (Kaggle releases it when the run ends)",
    "pnpm runs:get      download the scores and weights when it has finished",
  );
}
