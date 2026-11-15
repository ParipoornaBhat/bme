# Commands: training, runs, accounts

Run everything from the repo root. Every menu item is also a direct command.

## 1. Start here

```bash
pnpm menu            # top menu: accounts, data, train, runs
pnpm accounts        # what is set up for each teammate (never shows a password)
pnpm accounts --test # log in to every account now
```

## 2. Accounts (.env)

One block per teammate, keyed by USN. Add only your own.

```
NNM23CS124_NAME=paripoorna
NNM23CS124_H200=<college H200 password>
NNM23CS124_KAGGLE_USER=<kaggle username>
NNM23CS124_KAGGLE_KEY=<kaggle API key>
KAGGLE_DATASET_OWNER=124        # the account that holds the shared private dataset
```

`--as` takes a USN or a name: `pnpm train 3 --as paripoorna`.

### Several Kaggle accounts per person
Add extra accounts for the same person as numbered blocks: `<USN>_2_KAGGLE_USER` and `<USN>_2_KAGGLE_KEY` (or `_TOKEN`), then `_3_`, `_4_`, with no upper limit. The unnumbered block is slot 1 (default). Numbered blocks share the same teammate name and H200 login.
`--as` accepts a USN (`NNM23CS124`), a name (`paripoorna`), a Kaggle username, or `USN:slot` (`NNM23CS124:2`).
`pnpm accounts` lists every Kaggle slot, and `pnpm accounts --test` tests each slot.

### New-style Kaggle tokens (KGAT_)
Kaggle's new UI issues tokens starting with `KGAT_`. If the key starts with `KGAT_` (or is placed in `_KAGGLE_TOKEN`), it is passed as `KAGGLE_API_TOKEN` instead of `KAGGLE_KEY` (with `KAGGLE_USERNAME` kept). Classic keys keep working as before.

### Kaggle: a fresh account, step by step
1. Sign in at kaggle.com and verify your phone number (Settings). GPU and internet need it.
2. Profile picture > Settings > **API** > **Create New Token** (the label may differ).
   Kaggle gives you a `kaggle.json` file (username and key) or a token string.
3. Copy only the username and key into `.env`. Do not paste the file into chat.
4. Delete the downloaded `kaggle.json` (the pipeline refuses one inside the repo).
5. `pnpm accounts --test` to check the login.

### Sharing one dataset between teammates
One account uploads the private dataset (`KAGGLE_DATASET_OWNER`). Each other account
trains on it after the owner shares it on kaggle.com: Your Work > Datasets >
bme-3d-dataset > Settings > Sharing, add the teammate's username as *can view*, keep it
**Private**. The launch checks this first and stops with these steps if it is missing.

## 3. Train

```bash
pnpm train                 # pick a method, then where it trains
pnpm train 3               # method 3 directly (asks where)
pnpm train:split           # show, make or remake the fixed 80/20 split
pnpm train:local           # train on this PC (NVIDIA CUDA or Apple MPS)
```

| # | Method | Where | Tests |
|---|---|---|---|
| 1 | nnU-Net ResEnc M, 3D | H200 | baseline |
| 2 | nnU-Net ResEnc M, 2D | H200 | baseline, 2D |
| 3 | 3D U-Net, augmentation med | H200 | augmentation |
| 4 | 3D U-Net, augmentation max | H200 | augmentation |
| 5 | 3D U-Net, one round on the fixed 80/20 split | H200 | no folds |
| 6 | 3D U-Net, Kaggle settings | Kaggle | Kaggle reference |
| 7 | MedNeXt | Kaggle | architecture |
| 8 | OrthoGate-MedNeXt | Kaggle | architecture |
| 9 | C-Net dual U-Net | Kaggle | architecture |

Compare within one platform. Same seed (1337) and the same patient-level folds everywhere.

### Continuing
- **H200**: each job stops itself at 3 h 45. Choose the method again: it continues.
- **Kaggle**: the 12 h limit. If a run stopped before every fold finished, choose it
  again and it offers to continue from its checkpoints.
- **This PC**: Ctrl+C is safe. Choose the method again to continue.

### Starting on a PC without a usable GPU
The menu says which device it found and asks before a CPU run (20-40x slower).
To fix it: install a CUDA build of PyTorch in `ml/.venv` for NVIDIA, or use an
Apple Silicon Mac (MPS is used automatically).

## 4. Runs

```bash
pnpm runs              # menu
pnpm runs:status       # every account on the H200 and Kaggle, and this PC
pnpm runs:log          # one run's log (H200 live; Kaggle when the run has ended)
pnpm runs:get          # download a finished run (shows the size first)
pnpm runs:compare      # finished runs side by side (edema Dice on scans with edema)
pnpm runs:cancel       # stop an H200 job (Kaggle: stop it on kaggle.com)
```

## 5. Network to the H200

- On college WiFi or LAN: connects directly. Nothing asks, nothing uses internet data.
- Outside college: through `pc-server-1`. Every upload or download shows its size and asks
  first, because it uses your internet data.
- Cannot reach it: connect headscale (tailscale), then check `ssh h200` in a terminal.

## 6. Data

```bash
pnpm data              # menu: import new scans, teammate zips, the fixed split
```

Full data guide, inbox tree, team sync, and all data commands: [docs/DATA.md](DATA.md).

## 7. Old names

These still work: `pnpm h200`, `pnpm kaggle:doctor`, `pnpm kaggle:onetap`, `pnpm kaggle:run`,
`pnpm kaggle:fetch`, `pnpm model:train:menu`, `pnpm train:2d`, `pnpm train:3d`, the team zip commands.

## 8. Jump host (pc-server-1) on a new PC

1. Install Tailscale and join the team's headscale server: `tailscale up --login-server <headscale-url>`.
   The admin approves the node.
2. Check: `ping pc-server-1`.
3. Create a key: `ssh-keygen -t ed25519`. Ask the admin to add the public key to `pc-server-1`.
4. Put the three `Host` blocks from the team's `~/.ssh/config` (h200-local, h200, h200-remote)
   into your `~/.ssh/config`.
5. Test: `ssh h200-local` on college WiFi; `ssh h200` from outside.
6. `pnpm accounts --test`.

## 9. Laptop GPU (PyTorch)

Check: `pnpm train:local` prints the device it found. An NVIDIA card needs a CUDA PyTorch
build in `ml/.venv`. Apple Silicon uses MPS with no setup.
