import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// pnpm zipbme:<name>          ->  team_annotations.py export <root> --who <name>
// pnpm zipnbme:<name>         ->  export_nbme.py <root> --who <name>
// pnpm zipnbme:combine        ->  export_nbme.py <root> --combine
// pnpm data:share              ->  team_annotations.py share <root>
// pnpm data:sync [<mri>] <ann> ->  team_annotations.py restore <root> [<mri>] <ann> --apply
// pnpm data:import:team        ->  team_annotations.py import-all <root>, then --apply on a yes
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let python =
  process.platform === "win32"
    ? path.join(root, "ml", ".venv", "Scripts", "python.exe")
    : path.join(root, "ml", ".venv", "bin", "python");

if (!fs.existsSync(python)) {
  python = process.platform === "win32" ? "python" : "python3";
}

const scriptBme = path.join(root, "ml", "scripts", "team_annotations.py");
const scriptNbme = path.join(root, "ml", "scripts", "export_nbme.py");

// a bare zip name is looked up where it was typed, then in data/exports/
function zipPath(arg) {
  const here = path.resolve(process.env.INIT_CWD ?? process.cwd(), arg);
  if (fs.existsSync(here)) return here;
  const exported = path.join(root, "data", "exports", arg);
  return fs.existsSync(exported) ? exported : here;
}

const [first, second, ...extra] = process.argv.slice(2).filter((arg) => arg !== "--");
let args;
if (first === "export-nbme") {
  if (!second) {
    console.error("usage: node scripts/team-annotations.js export-nbme <name>");
    process.exit(1);
  }
  args = [scriptNbme, root, "--who", second, ...extra];
} else if (first === "combine-nbme") {
  args = [scriptNbme, root, "--combine", second, ...extra].filter(Boolean);
} else if (first === "import-all") {
  const dry = spawnSync(python, [scriptBme, "import-all", root], { cwd: root, stdio: "inherit" });
  if (dry.status !== 0) process.exit(dry.status ?? 1);
  const rl = readline.createInterface({ input, output });
  const yes = (await rl.question("\nImport these? Nothing local is overwritten. [y/N] ")).trim().toLowerCase();
  rl.close();
  if (yes !== "y") {
    console.log("Nothing written.");
    process.exit(0);
  }
  args = [scriptBme, "import-all", root, "--apply"];
} else if (first === "share") {
  args = [scriptBme, "share", root];
} else if (first === "restore") {
  const zips = [second, ...extra].filter((arg) => arg && !arg.startsWith("--"));
  if (zips.length < 1 || zips.length > 2) {
    console.error("usage: pnpm data:sync [<hub_mri zip>] <hub_annotations zip>");
    process.exit(1);
  }
  args = [scriptBme, "restore", root, ...zips.map(zipPath), "--apply"];
} else if (first) {
  args = [scriptBme, "export", root, "--who", first, second, ...extra].filter(Boolean);
} else {
  console.error("usage: node scripts/team-annotations.js <name> | export-nbme <name> | combine-nbme | share | restore <mri> <ann>");
  process.exit(1);
}
const result = spawnSync(python, args, {
  cwd: root,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
