import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * Remove imported NBME cases so the next `pnpm data:nonbme:process` starts at NBME-001.
 *
 * Deletes data/nifti/NBME-* and data/annotations/NBME-*, and the matching rows
 * in data/worklist.csv, data/deid_map.csv, and the Postgres patient table.
 * Does not touch Non BME/new, data/newnonbme, BME cases, or 2D data.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = path.join(root, "data");
const CASE_ID = /^NBME-\d{3}$/;

function readEnvUrl() {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^DATABASE_URL=(.*)$/);
    if (!m) continue;
    return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

function removeCaseDirs(rel) {
  const dir = path.join(data, rel);
  if (!fs.existsSync(dir)) {
    console.log(`  ${rel}: absent`);
    return;
  }
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!CASE_ID.test(name)) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    n++;
  }
  console.log(`  ${rel}: removed ${n} NBME folder(s)`);
}

function keepHeader(rel) {
  const file = path.join(data, rel);
  if (!fs.existsSync(file)) {
    console.log(`  ${rel}: absent`);
    return;
  }
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const header = lines[0] ?? "";
  const caseCol = header.split(",").findIndex((h) => h.trim() === "case_id");
  const kept = [header];
  let dropped = 0;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const id = (line.split(",")[caseCol] ?? "").trim();
    if (CASE_ID.test(id)) dropped++;
    else kept.push(line);
  }
  fs.writeFileSync(file, kept.join("\n") + "\n");
  console.log(`  ${rel}: removed ${dropped} NBME row(s)`);
}

async function clearDb() {
  const url = readEnvUrl();
  if (!url) {
    console.log("  database: DATABASE_URL is not set, skipped");
    return;
  }
  const require = createRequire(path.join(root, "server", "db", "package.json"));
  const pg = require("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query(
      "DELETE FROM patient WHERE case_id ~ '^NBME-[0-9]{3}$'",
    );
    console.log(`  database: removed ${result.rowCount} NBME patient row(s)`);
  } finally {
    await client.end();
  }
}

console.log("Erasing imported NBME cases. Non BME/new and data/newnonbme stay.\n");
removeCaseDirs("nifti");
removeCaseDirs("annotations");
keepHeader("worklist.csv");
keepHeader("deid_map.csv");
await clearDb();
console.log("\nNext case from pnpm data:nonbme:process will be NBME-001.");
