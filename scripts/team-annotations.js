import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// pnpm zipbme:<name>  ->  team_annotations.py export <root> --who <name>
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

const [who, ...extra] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!who) {
  console.error("usage: node scripts/team-annotations.js <name>");
  process.exit(1);
}
const result = spawnSync(python, [script, "export", root, "--who", who, ...extra], {
  cwd: root,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
