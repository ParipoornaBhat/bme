import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const COMMANDS = [
  {
    script: "train-model.js",
    args: ["2d"],
    label: "Train 2D",
    about: "Pick U-Net or Attention U-Net, then train on this PC's GPU. Builds the axial slices first.",
  },
  {
    script: "train-model.js",
    args: ["3d"],
    label: "Train 3D",
    about: "Pick 3D U-Net or 3D Attention U-Net, then train on this PC's GPU from the saved volumes.",
  },
];

console.log("");
console.log("Training on this PC");
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

const child = spawn(process.execPath, [path.join(root, "scripts", picked.script), ...picked.args], {
  cwd: root,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
