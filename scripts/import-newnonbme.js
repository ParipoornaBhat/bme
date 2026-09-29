import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python =
  process.platform === "win32"
    ? path.join(root, "ml", ".venv", "Scripts", "python.exe")
    : path.join(root, "ml", ".venv", "bin", "python");
const script = path.join(root, "ml", "scripts", "import_newnonbme.py");

if (!fs.existsSync(python)) {
  console.error(`missing ${python}\nCreate the ml virtualenv first.`);
  process.exit(1);
}

const result = spawnSync(python, [script, root, "--apply", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
