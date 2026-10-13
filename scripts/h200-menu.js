import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const COMMANDS = [
  {
    script: "train-2d-remote.js",
    label: "Send 2D job",
    about: "Copy missing files to the H200 and start 2D training. Does not stop a running 3D job.",
  },
  {
    script: "copy-model-remote.js",
    label: "Copy 2D result back",
    about: "Download only the finished 2D weights and metrics.json. Scans stay on the server.",
  },
];

console.log("");
console.log("College H200");
COMMANDS.forEach((cmd, i) => {
  console.log(`  ${i + 1}. ${cmd.label}`);
  console.log(`     ${cmd.about}`);
});
console.log("");

const rl = readline.createInterface({ input, output });
const answer = (await rl.question(`Which one? [1-${COMMANDS.length}] `)).trim();
rl.close();

const picked = COMMANDS[Number(answer) - 1];
if (!picked) {
  console.error("No command chosen.");
  process.exit(1);
}

const child = spawn(process.execPath, [path.join(root, "scripts", picked.script)], {
  cwd: root,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
