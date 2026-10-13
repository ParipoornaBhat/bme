import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const COMMANDS = [
  {
    script: "import-newbme.js",
    label: "Import BME",
    about: "Import data/newbme as BME-001 onward. Deletes each source only after it is written.",
  },
  {
    script: "erase-3d.js",
    label: "Erase 3D dataset",
    about: "Wipe nifti, annotations, and BME/NBME database rows so the next import starts at BME-001.",
  },
  {
    script: "nonbme-to-nrrd.js",
    label: "Convert non-BME DICOM",
    about: "Turn Non BME/3d zip files into NRRD folders under Non BME/new.",
  },
  {
    script: "import-newnonbme.js",
    label: "Import non-BME",
    about: "Import Non BME/new and data/newnonbme as NBME-001 onward.",
  },
  {
    script: "erase-nonbme.js",
    label: "Erase imported non-BME",
    about: "Delete imported NBME cases only. Does not touch Non BME/new or data/newnonbme.",
  },
  {
    script: "team-annotations.js",
    args: ["share"],
    label: "Share hub zip",
    about: "Build the annotations zip to send to the rest of the team.",
  },
  {
    script: "team-annotations.js",
    args: ["restore"],
    ask: "Annotations zip file name: ",
    label: "Sync hub zip",
    about: "Import a hub annotations zip. Does not replace your scans.",
  },
];

console.log("");
console.log("Data");
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

const extra = [];
if (picked.ask) {
  const again = readline.createInterface({ input, output });
  const zip = (await again.question(picked.ask)).trim();
  again.close();
  if (!zip) {
    console.error("No zip name given.");
    process.exit(1);
  }
  extra.push(zip);
}

const child = spawn(process.execPath, [path.join(root, "scripts", picked.script), ...(picked.args ?? []), ...extra], {
  cwd: root,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
