import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// pnpm zipbme:<name>          ->  team_annotations.py export <root> --who <name>
// pnpm data:share              ->  team_annotations.py share <root>
// pnpm data:sync <mri> <ann>   ->  team_annotations.py restore <root> <mri> <ann> --apply
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python =
  process.platform === "win32"
    ? path.join(root, "ml", ".venv", "Scripts", "python.exe")
    : path.join(root, "ml", ".venv", "bin", "python");
const script = path.join(root, "ml", "scripts", "team_annotations.py");

if (!fs.existsSync(python)) {
  console.error(`missing ${python}\nCreate the ml virtualenv first.`);
  process.exit(1);
}

// a bare zip name is looked up where it was typed, then in data/exports/
function zipPath(arg) {
  const here = path.resolve(process.env.INIT_CWD ?? process.cwd(), arg);
  if (fs.existsSync(here)) return here;
  const exported = path.join(root, "data", "exports", arg);
  return fs.existsSync(exported) ? exported : here;
}

const [first, ...extra] = process.argv.slice(2).filter((arg) => arg !== "--");
let args;
if (first === "share") {
  args = [script, "share", root];
} else if (first === "restore") {
  const zips = extra.filter((arg) => !arg.startsWith("--"));
  if (zips.length !== 2) {
    console.error("usage: pnpm data:sync <hub_mri zip> <hub_annotations zip>");
    process.exit(1);
  }
  args = [script, "restore", root, ...zips.map(zipPath), "--apply"];
} else if (first) {
  args = [script, "export", root, "--who", first, ...extra];
} else {
  console.error("usage: node scripts/team-annotations.js <name> | share | restore <mri> <ann>");
  process.exit(1);
}
const result = spawnSync(python, args, {
  cwd: root,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
