# Plan: accounts, 8 training methods, one inbox, restructured commands

Written 2026-11-11. Nothing in this plan is built yet. It is the brief for the
session that builds it. Read `CLAUDE.md` and `docs/STATUS.md` first.

Uncommitted work this plan builds on (already in the working tree, tested):
`--aug-level low|med|max` in `ml/scripts/train_3d.py`, `ml/slurm/train_3d_aug.sbatch`,
`ml/scripts/nnunet_trainer_bme.py`, the `best` and `aug` ops in `scripts/h200-menu.js`,
`scripts/train-menu.js`, `pnpm model:train:menu`.

---

## 0. What the user asked for

1. Add up to 4 Kaggle accounts and 4 H200 accounts, named in `.env` by USN, with a person's name shown.
2. Every train command asks which data to use, checks the copy already on the target
   (Kaggle or H200) against the local one, and uploads or updates only when they differ.
3. Before any upload or download over the internet, show how much data it will use and ask.
   On the college network (direct to the H200) do not ask.
4. 8 training methods to compare: 4 on the H200, 4 on Kaggle. Same folds and seed.
5. Status and live logs for every run, by command.
6. One menu structure for everything, commands renamed by one rule, documented in one file.
7. One folder in the repo root for everything that gets dropped in (new scans, teammate zips).
8. The terminal says what to do next wherever a step can fail or needs the user.
9. Steps to set up the `pc-server-1` jump host on a new PC.

## 1. Facts found in the code (do not re-derive)

- **H200 accounts already work.** `scripts/h200-login.js` reads `.env` lines
  `NNM23CS<roll>_H200=<password>` (or `H200_PASS_<roll>`), user is
  `nnm23cs<roll>_stu_cse`, host `H200_HOST` or `172.18.0.83`. `--as <roll>` skips the menu.
  `.env` currently holds 2 such lines. `.env` is gitignored.
- **H200 push is already incremental.** `push()` in `scripts/h200-menu.js` compares md5
  (annotations, worklist) and size (scans) and sends only changed files. It prints the
  size but never asks.
- **Kaggle is single-account today.** `ml/scripts/kaggle_pipeline.py` authenticates from
  `~/.kaggle/kaggle.json` or `KAGGLE_USERNAME` + `KAGGLE_KEY`. It refuses a `kaggle.json`
  inside the repo. State lives in one staging folder, `KAGGLE_STAGING_DIR` or
  `../bme_kaggle_staging`: `dataset_approval.json`, `run_state.json`,
  `source_fingerprint.json`, `download/<run_id>/`.
- **This laptop has never run Kaggle.** The `kaggle` package is not in `ml/.venv` and
  there is no `~/.kaggle`. All Kaggle runs so far came from Reegan's machine.
- **The web app calls the same CLI.** `client/nextjs/src/app/api/training-3d/kaggle/route.ts`
  spawns `kaggle_pipeline.py` with the default staging folder and its own lock file.
  Existing subcommands, flags and the default staging layout must keep working.
- **`ml/tests/test_kaggle_pipeline.py`** mocks the API and calls `run_pipeline` and
  `run_upload` directly. New parameters must be optional with the old defaults.
- **A Kaggle run blocks.** `run_pipeline` launches, polls every 15 s until the kernel ends,
  downloads, then imports. A full completed run is imported into `data/results3d`
  (the app's live model); anything else goes to `data/results3d_experiments/<run_id>`.
- **The notebook** `ml/notebooks/train_3d_colab.ipynb` (json, `indent=1`,
  `ensure_ascii=True`, trailing newline):
  - cell 4: configuration as top-level `NAME = value` lines. The launcher rewrites only
    `CONFIG_MODE` and `MODEL_ARCH`, in memory.
  - cell 10: `BUNDLED_CODE_B64`, a base64 copy of `train_3d.py`, synced by hand. It is
    stale: it lacks `--aug-level`.
  - cells 12, 14 and 20 each build the trainer flags (`--augment`, `--aug-spatial`,
    `--resample-patches-each-epoch`, ...). None passes `--aug-level`.
  - Kaggle settings differ from the H200 sbatch: width 20, patch 128x128x16, spacing
    0.5,0.5,3.0, 65 epochs, N4, TTA, calibration, group norm.
- **The export does not contain `train_3d.py`**, so changing the trainer does not force a
  dataset re-upload.
- **Augmentation is live.** It is applied to each patch during training, on the training
  machine. There is no stored augmented dataset.
- **SSH routes** (the user's `~/.ssh/config`): `h200-local` = direct `172.18.0.83` on college
  WiFi/LAN; `h200` / `h200-remote` = the same host through `ProxyJump pc-server-1`
  (user `root`, reached over headscale). Headscale is down today; the user fixes it
  tomorrow. The remote route cannot be tested until then.
- **Drop locations today** (all gitignored through `/data/`, `/Non BME/`, `*.zip`):
  `data/newbme`, `Non BME/3d`, `Non BME/new`, `data/newnonbme`, teammate zips in the repo
  root or `data/exports`, `fs_fix.zip` in the repo root. Zips made here go to `data/exports`.

## 2. Decisions

### 2.1 Augmented data is not uploaded or stored separately
Keep augmentation live. Reasons: every epoch sees new variants, there is nothing extra
to upload (mobile data), and nothing can go stale. Consequences for the user's questions:
- "Is all augmentation done for the uploaded data?" Always yes; there is nothing to pre-compute.
- "If I add 2 new scans?" They are augmented automatically once the dataset is updated.
- The level (low/med/max) is a setting of the run, recorded in that run's `metrics.json`
  (`data_config.aug_level`), and each level writes to its own results folder.

The menus must say this in one line where the level is chosen.

### 2.2 Account names in `.env` (USN-keyed, like the H200)
```
NNM23CS124_NAME=paripoorna
NNM23CS124_H200=<h200 password>
NNM23CS124_KAGGLE_USER=<kaggle username>
NNM23CS124_KAGGLE_KEY=<kaggle api key>
```
One block per teammate, 4 in total. `_NAME` is optional and only for display
("paripoorna (124)"). `--as` accepts a roll or a name.

The menu passes `KAGGLE_USERNAME` / `KAGGLE_KEY` to the Python child process only, plus
`KAGGLE_STAGING_DIR=../bme_kaggle_staging/accounts/<roll>` so accounts never share state.
With no `--as` and no Kaggle keys in `.env`, the old behaviour stays (`~/.kaggle/kaggle.json`,
default staging), so Reegan's setup and the web route are untouched.

- Never print a key or password. Never write them anywhere but `.env`. Add the key
  names (not values) to `.env.example` if one exists.
- If the installed `kaggle` package needs the newer token form, also accept
  `NNM23CS<roll>_KAGGLE_TOKEN` -> `KAGGLE_API_TOKEN`. Check against the installed version.
- Say in the docs: Kaggle allows one account per person. Each of the 4 accounts must be
  that teammate's own, phone-verified (needed for GPU and internet).

### 2.3 The 8 methods
Same 5 patient-level folds and seed everywhere. Each method has its own results folder.

| # | id | Where | What | What it tests |
|---|---|---|---|---|
| 1 | `nnunet-3d` | H200 | nnU-Net ResEnc M 3d_fullres, 100 epochs (`nnunet.sbatch 3d_fullres`) | baseline, 3D |
| 2 | `nnunet-2d` | H200 | nnU-Net ResEnc M 2d, 100 epochs (`nnunet.sbatch 2d`) | baseline, 2D |
| 3 | `unet-aug-med` | H200 | 3D U-Net, level med (`train_3d_aug.sbatch med`) | augmentation |
| 4 | `unet-aug-max` | H200 | 3D U-Net, level max (`train_3d_aug.sbatch max`) | augmentation |
| 5 | `k-unet3d` | Kaggle | `unet3d`, level med, Kaggle settings | Kaggle reference |
| 6 | `k-mednext` | Kaggle | `mednext`, level med | architecture |
| 7 | `k-orthogate` | Kaggle | `orthogate_mednext`, level med | architecture |
| 8 | `k-cnet-dual` | Kaggle | `cnet_dual_unet`, level med | architecture |

- Compare within a platform: 3 vs 4 (plus the existing no-augmentation control) is the
  augmentation study; 5 to 8 is the architecture study; 1 and 2 are the baseline every
  custom model has to beat. Do not rank a Kaggle number against an H200 number without
  saying the settings differ.
- `aug low` stays available under "More" in the menu; it is not one of the 8.
- nnU-Net is not wired into Kaggle. Do not add it in this pass.
- **Verify before building:** the last Kaggle runs used 121 cases; the H200 push sends
  only cases with a saved `.seg.nrrd` (76 locally at last count). Find out why they
  differ (`export_for_colab.py` case selection vs `neededFiles()`), and print the case
  count of each target in the data check so a mismatch is visible. If they cannot be made
  equal, state it in `docs/COMMANDS.md` and STATUS.
- The cascade (Stage 2, bone mask as input) is still not one of these; it waits for the
  results of 1 and 2.

### 2.4 One inbox folder
```
inbox/
  bme/            new BME cases                    (was data/newbme)
  nonbme-dicom/   non-BME DICOM zips               (was Non BME/3d)
  nonbme/         non-BME NRRD folders or zips     (was Non BME/new, data/newnonbme)
  team/           teammate annotation zips         (was repo root, data/exports)
  fixes/          fs_fix.zip                       (was repo root)
  outgoing/       zips made here to send           (was data/exports)
```
- **First step, before creating the folder: add `/inbox/` to `.gitignore`** in the
  patient-data block. It is a new ignore rule, not an exception. Confirm with
  `git check-ignore -v inbox/bme/x` and `git status --short`.
- `inbox/nonbme/<n>/name.json` holds patient names. It is covered by the ignore rule and
  must never be printed, exactly as today.
- Scripts read the new location first and the old one as a fallback, and say which they
  used. Nothing existing is moved or deleted automatically. A separate
  `data:inbox:migrate` shows what it would move and asks.
- `Non BME/axial` and `Non BME/new/new` (read by `swap_fs_series.py`) are raw data, not
  drop locations. Leave them.
- `data/raw`, `data/nifti`, `data/annotations` do not move.

### 2.5 Network rule for the H200
1. Try direct: `ssh -o ConnectTimeout=6 <user>@172.18.0.83 true`.
2. If that works: college network. Push and download without asking (still print the size).
3. If not: use `-J pc-server-1` (the user's ssh config supplies its user and address). Print
   "You are outside the college network. This goes through pc-server-1 and uses your
   internet data: <size>." and ask before any push or download. Status and log calls are
   small; do not ask for those.
4. If neither works: say "Cannot reach the H200. On college WiFi it connects directly;
   outside, headscale must be connected (pc-server-1)."

**Fix the askpass helper while here.** `h200-login.js` writes a script that echoes the
H200 password to any ssh prompt. With a jump host that would also answer a password
prompt from `pc-server-1`. Make it reply only when the prompt (its first argument) contains
the H200 user name, and print nothing otherwise.

### 2.6 Command naming rule
`area:action[:target]`, lowercase, one menu per area, and every menu item also reachable
directly. Areas: `data`, `train`, `runs`, `accounts`, `db`, `dev`.

| New | Does | Replaces |
|---|---|---|
| `pnpm menu` | top menu: Data, Train, Runs, Accounts | none |
| `pnpm data` | data menu (inbox import, erase, team zips) | `data:process` |
| `pnpm train` | the 8 methods, then account, data check, start/continue | `model:train:menu` |
| `pnpm train:local` | 2D / 3D on this PC | `train:2d`, `train:3d` |
| `pnpm runs` | menu: status, log, download, cancel | parts of `h200`, `kaggle:*` |
| `pnpm runs:status` | every account, both platforms, one table | `h200 status`, `kaggle-cli status` |
| `pnpm runs:log` | live log of one run | `h200 log` |
| `pnpm runs:get` | download a finished result (size shown first) | `h200 get`, `kaggle:fetch` |
| `pnpm runs:cancel` | cancel one job | `h200 cancel` |
| `pnpm accounts` | list accounts, what is missing, test each login | `kaggle:doctor`, `h200 env` |
| `pnpm accounts:setup` | first-time server setup for one H200 account | `h200 setup` |

- Keep `pnpm h200` and the `kaggle:*` scripts working as they are (teammates and the web
  route use them). Remove only exact duplicates: `remote:2d:remote`, and one of
  `train` / `model:train:menu` (keep `model:train:menu` as an alias for now).
- Team zip commands (`zipbme:<name>`, `zipnbme:<name>`, `data:share`, `data:sync`,
  `data:import:team`) keep their names; list them under `pnpm data`.
- Do not touch `db:*`, `dev`, `build`, `deploy:*`.
- Docs that mention old names: `pnpm train:3d` (6 places), `pnpm h200` (4),
  `pnpm data:process:bme` (6). Update them in the same pass.

## 3. Build steps, in order

### Step 1. Kaggle pipeline (`ml/scripts/kaggle_pipeline.py`)
All new parameters optional; defaults reproduce today's behaviour.
1. `run_launch_kernel(..., overrides=None)`: after `CONFIG_MODE` / `MODEL_ARCH`, rewrite
   any `NAME = ...` line of the config cell named in `overrides`; fail loudly on a name
   that is not in the cell. Always replace `BUNDLED_CODE_B64` in the in-memory copy with
   the current `ml/scripts/train_3d.py`, so a run can never use a stale trainer.
2. CLI `run`: `--set NAME=VALUE` (repeatable, value parsed as a Python literal),
   `--no-wait` (launch, save `run_state.json`, return), `--import-name <id>`
   (import to `data/results3d_experiments/<id>` and never to `data/results3d`).
   Store `method`, `model_arch` and the overrides in `run_state.json`.
3. New `export`: only `run_export_with_fingerprint` (local, no internet).
4. New `data-status --json`: local export hash, case count, bytes; this account's approval
   and uploaded hash; `needs_upload` true/false and why (never uploaded / changed /
   up to date). No patient IDs or local paths in the output.
5. New `whoami`: the authenticated user name, for `pnpm accounts`.
6. New `logs`: check the installed `kaggle` package for a kernel log call that works on
   a running kernel. If there is none, print the status and say plainly that Kaggle
   only releases the full log when the run ends. Do not fake a live tail.
7. Notebook: add `AUG_LEVEL = None` to cell 4; in cells 12, 14 and 20 pass
   `--aug-level` when set and then skip `--augment` and `--aug-spatial` (the trainer
   refuses the combination) while keeping `--resample-patches-each-epoch`. Re-embed the
   bundle. Write with `json.dump(indent=1, ensure_ascii=True)` plus a newline and check
   the diff touches only those cells.
8. Extend `ml/tests/test_kaggle_pipeline.py`: overrides applied, unknown name fails,
   bundle equals the file on disk, `--no-wait` returns with phase QUEUED,
   `--import-name` never writes `data/results3d`.

### Step 2. Accounts (`scripts/accounts.js`, extend `scripts/h200-login.js`)
- One reader for `.env` returning `{roll, name, h200, kaggle}` per USN.
- `pnpm accounts`: table of the 4 slots, what each is missing, and the exact line to add.
  "Test" logs in to each (H200: `true` over ssh; Kaggle: `whoami`) and reports pass/fail.
- If `kaggle` is not installed in `ml/.venv`, say so and print the one install command.
  Do not install it silently.
- Apply the network rule (2.5) and the askpass fix here, so `h200-menu.js` and the new
  menus share it.

### Step 3. Methods and the train flow (`scripts/train-methods.js`, `scripts/train-menu.js`)
Flow for `pnpm train`:
1. List the 8 methods grouped by platform, each with one line on what it tests, plus
   "More" (aug low, no-augmentation control, 2D on the H200, local training).
2. Pick the account (only accounts that have that platform's credentials; show which
   accounts already have a job).
3. Data check:
   - H200: run the existing diff; print "N cases, X MB to send" or "already up to date";
     ask only on the remote route.
   - Kaggle: `export`, then `data-status`. Up to date: continue. Otherwise print
     "This account's dataset is missing / out of date. Uploading it uses about X MB of
     internet data." and ask. Yes runs `update-dataset` (the de-identification checks
     and the approval record stay exactly as they are). No stops with nothing started.
4. Show the estimate: measured s/epoch on that account when there is one, otherwise the
   past durations from `docs/benchmark_runs.json`, and the platform limit (H200 4 h per
   job, Kaggle 12 h per run and about 30 GPU hours a week).
5. Start or continue. H200: the existing `best` / `aug` ops with `--as`. Kaggle:
   `run --confirm-launch --no-wait --mode full --model-arch <arch> --kernel-slug bme-<id>
   --import-name <id>` with `--set` for `AUG_LEVEL="med"`, `ENABLE_DATA_AUGMENTATION=False`,
   `ENABLE_AUG_SPATIAL=False`, `MAX_RUNTIME_MINUTES=660`.
6. End with the next commands: `pnpm runs:status`, `pnpm runs:log`.

A pending upload must be impossible to miss: the status table marks any account whose
dataset is out of date.

### Step 4. Runs (`scripts/runs.js`)
- `status`: for each H200 account, jobs + finished results + last log line; for each
  Kaggle account, the kernel status, the method, and whether the dataset is current.
  One unreachable account must not stop the others.
- `log`: pick a run. H200: the existing live tail. Kaggle: step 1.6.
- `get`: pick a finished run; print the download size; ask on Kaggle and on the remote
  H200 route. Kaggle uses `run --resume` (it downloads and imports under `--import-name`).
- `cancel`: H200 as today. Kaggle: only if the installed package can cancel; otherwise
  say to stop it on kaggle.com.

### Step 5. Inbox
1. `.gitignore` rule first (2.4).
2. Path changes, new location first, old as fallback:
   `ml/scripts/import_newbme.py` (`--src` default), `ml/scripts/import_newnonbme.py`
   (the two roots, near line 69), `ml/scripts/nonbme_to_nrrd.py` (source and destination),
   `ml/scripts/team_annotations.py` and `ml/scripts/export_nbme.py` (search folders and
   output folder), `ml/scripts/swap_fs_series.py` (`fs_fix.zip` location),
   `scripts/team-annotations.js` (zip lookup), and the texts in `scripts/data-menu.js`,
   `scripts/erase-3d.js`, `scripts/erase-nonbme.js`.
3. These scripts delete their source after a successful import. Do not change that
   logic; change only where they look. Run each in its dry-run mode against an empty
   inbox and against a fallback location before trusting it.
4. `pnpm data` creates the empty `inbox/*` folders on first run and prints the tree with
   one line per folder saying what to drop there.

### Step 6. Commands and docs
- `package.json` scripts per 2.6; `scripts/menu.js` as the top menu.
- New `docs/COMMANDS.md`: the full menu tree, every direct command, the `.env` block,
  the inbox tree, the network rule, the 8 methods table, and the jump-host setup below.
  This is the one file the user asked for.
- Update `docs/STATUS.md`, `docs/SUMMARY.md` and any doc using a renamed command.

### Step 7. Jump host on a new PC (goes into `docs/COMMANDS.md`)
The headscale address and how keys are issued are not in the repo. Ask the user
for them; do not guess. Skeleton:
1. Install Tailscale and join the team's headscale server
   (`tailscale up --login-server <headscale url>`), approve the node on the server.
2. Check `ping pc-server-1`.
3. Create an ssh key (`ssh-keygen -t ed25519`) and have its public key added to
   `pc-server-1` (`~/.ssh/authorized_keys` of the jump user).
4. Copy the three `Host` blocks into `~/.ssh/config`, with that PC owner's own USN.
5. Test: `ssh h200-local` on college WiFi, `ssh h200` outside.
6. `pnpm accounts`, then Test.

## 4. Guidance messages (requirement 8)
Every stop must name the cause and the next action. Minimum set:
- no account for the platform -> the `.env` line to add
- `kaggle` not installed -> the install command
- H200 unreachable -> college WiFi, or connect headscale
- dataset out of date -> the size, and that nothing starts until it is uploaded
- job hit the 4 h limit -> "choose the same method again to continue"
- run finished -> the `pnpm runs:get` line
- empty inbox folder -> which folder to put files in

## 5. Safety rules that apply to this work
- Patient data: uploads go only through the existing de-identified export with its
  checks and approval record. Do not add a path that skips them. Datasets and kernels
  stay private. The user has asked for uploads to 4 Kaggle accounts; the tool must still
  ask before each upload.
- Never print `.env` values, `name.json`, `deid_map.csv`, or the export mapping file.
- H200: no compute on the login node, jobs under 4 h, 45 GB disk guard, one GPU slice
  per job. The new menus only call the existing sbatch files.
- Laptop: no multi-GB downloads, no GPU settings, nothing deleted, stay inside the repo
  (the Kaggle staging and export folders next to the repo already exist by design).
- Git: stay on the current branch, commit and push only when asked, one-line
  conventional message, no attribution trailer.

## 6. Cannot be tested from this laptop today
- Real Kaggle calls (no package, no credentials here): test with the mocked API only,
  and say so.
- The remote H200 route (headscale down).
- Kaggle live logs (depends on the installed package).

Say exactly this in the final report instead of claiming it works.

## 7. Open items carried over
- 2 tests fail before any of this: `test_train_3d_speedups.py` (the "case_level folds"
  string) and `test_cnet_attention_unet.py` (`AttentionGate3D` vs `AttentionGate3d`).
- Reegan's commits carry the wrong `user.name`.
- The uncommitted changes listed at the top are still not committed.
