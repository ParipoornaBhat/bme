import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * pnpm test:ml
 * Runs every ml test script (ml/scripts/test_*.py and ml/tests/test_*.py) on synthetic
 * data, one after another, and stops at the first failure. No GPU or real scans needed.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python =
  process.platform === "win32"
    ? path.join(root, "ml", ".venv", "Scripts", "python.exe")
    : path.join(root, "ml", ".venv", "bin", "python");

if (!fs.existsSync(python)) {
  console.error(`No ml venv at ${path.relative(root, python)}. Create it first, see ml/README.md.`);
  process.exit(1);
}

const tests = ["ml/scripts", "ml/tests"]
  .flatMap((dir) =>
    fs
      .readdirSync(path.join(root, dir))
      .filter((f) => /^test_.*\.py$/.test(f))
      .sort()
      .map((f) => `${dir}/${f}`),
  );

for (const [i, test] of tests.entries()) {
  console.log(`\n[${i + 1}/${tests.length}] ${test}`);
  const r = spawnSync(python, [test], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\nFAILED: ${test}`);
    process.exit(r.status ?? 1);
  }
}
console.log(`\nAll ${tests.length} ml test scripts passed.`);
