import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ask, h200Route, loadDotEnv, pickAccount, UNREACHABLE } from "./lib/accounts.js";

/**
 * Who logs in to the H200, and by which route. Passwords live in .env as
 * NNM23CS<roll>_H200=... (see scripts/lib/accounts.js). The password is never
 * printed, and the helper ssh calls only answers the H200's own password
 * prompt, never the jump host's.
 */

export { loadDotEnv, ask };

// Windows' own ssh.exe reads piped input in small chunks (about 1-2 MB/s even
// on gigabit LAN). Git for Windows ships a full OpenSSH that streams at line
// speed, so it is used when present.
const GIT_SSH = "C:/Program Files/Git/usr/bin/ssh.exe";
export const SSH_BIN =
  process.env.BME_SSH_BIN || (process.platform === "win32" && fs.existsSync(GIT_SSH) ? GIT_SSH : "ssh");
const POSIX_ASKPASS = process.platform !== "win32" || SSH_BIN !== "ssh";

function writeAskpass() {
  if (!POSIX_ASKPASS) {
    const file = path.join(os.tmpdir(), `bme-ssh-askpass-${process.pid}.cmd`);
    fs.writeFileSync(
      file,
      '@echo off\r\necho(%~1| findstr /L /C:"%BME_SSH_USER%@" >nul && echo(%BME_SSH_PASS%\r\n',
    );
    return file;
  }
  const file = path.join(os.tmpdir(), `bme-ssh-askpass-${process.pid}.sh`);
  fs.writeFileSync(file, '#!/bin/sh\ncase "$1" in *"$BME_SSH_USER@"*) printf \'%s\\n\' "$BME_SSH_PASS" ;; esac\n', { mode: 0o700 });
  return file.split(path.sep).join("/");
}

/** want: a roll number or name ("149", "reegan") to skip the menu, as `--as 149` does. */
export async function chooseH200(root, want = "") {
  const account = await pickAccount("h200", want);
  const route = await h200Route();
  console.log(`H200 as ${account.label}: ${route.label}.`);
  if (route.remote) console.log("Copies over this route use your internet data; each one asks first.");
  const askpass = writeAskpass();
  return {
    user: account.h200.user,
    label: account.label,
    roll: account.roll,
    target: `${account.h200.user}@${route.host}`,
    remote: route.remote,
    sshOpts: route.sshOpts,
    sshBin: SSH_BIN,
    unreachable: UNREACHABLE,
    env: {
      ...process.env,
      SSH_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: process.env.DISPLAY || "localhost:0",
      BME_SSH_USER: account.h200.user,
      BME_SSH_PASS: account.h200.password,
    },
    close() {
      try { fs.unlinkSync(askpass); } catch { /* already gone */ }
    },
  };
}
