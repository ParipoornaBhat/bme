import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * Wipe the current 3D dataset so `pnpm data:process` starts again at BME-001.
 *
 * Removes data/raw, data/nifti, data/annotations, and data/nnunet.
 * Empties the 3D rows in data/worklist.csv and data/deid_map.csv.
 * Deletes matching patient rows in Postgres; studies, series, and annotations
 * cascade with them. Users, roles, and every 2D folder stay.
 *
 * data/newbme is the folder about to be imported, so it is not touched.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = path.join(root, "data");
const CASE_ID = /^(BME|NBME)-\d{3}$/;

const DIRS = ["raw", "nifti", "annotations", "nnunet"];

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

function emptyDir(rel) {
  const dir = path.join(data, rel);
  if (!fs.existsSync(dir)) {
    console.log(`  ${rel}: absent`);
    return;
  }
  const kids = fs.readdirSync(dir);
  for (const name of kids) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  console.log(`  ${rel}: removed ${kids.length} item(s)`);
}

function keepHeader(rel) {
  const file = path.join(data, rel);
  if (!fs.existsSync(file)) {
    console.log(`  ${rel}: absent`);
    return 0;
  }
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/).filter((l, i) => i === 0 || l.trim());
  const header = lines[0] ?? "";
  const caseCol = header.split(",").findIndex((h) => h.trim() === "case_id");
  const kept = [header];
  let dropped = 0;
  for (const line of lines.slice(1)) {
    const id = (line.split(",")[caseCol] ?? "").trim();
    if (CASE_ID.test(id)) dropped++;
    else kept.push(line);
  }
  fs.writeFileSync(file, kept.filter(Boolean).join("\n") + "\n");
  console.log(`  ${rel}: removed ${dropped} case row(s)`);
  return dropped;
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
      "DELETE FROM patient WHERE case_id ~ '^(BME|NBME)-[0-9]{3}$'",
    );
    console.log(`  database: removed ${result.rowCount} patient row(s)`);
  } finally {
    await client.end();
  }
}

console.log("Erasing the 3D dataset. 2D data and data/newbme stay.\n");
for (const dir of DIRS) emptyDir(dir);
keepHeader("worklist.csv");
keepHeader("deid_map.csv");
const report = path.join(data, "newbme_import_report.csv");
if (fs.existsSync(report)) {
  fs.rmSync(report);
  console.log("  newbme_import_report.csv: removed");
}
await clearDb();
console.log("\nNext case from pnpm data:process will be BME-001.");
