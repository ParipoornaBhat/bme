#!/usr/bin/env node
import { spawn } from "node:child_process";

const cmd = process.argv[2] || "build";
const isWin = process.platform === "win32";
const pnpmCmd = isWin ? "pnpm.cmd" : "pnpm";

const child = spawn(pnpmCmd, ["--filter", "nextjs", cmd], {
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    APP_MODE: "review",
    NEXT_PUBLIC_APP_MODE: "review",
  },
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
