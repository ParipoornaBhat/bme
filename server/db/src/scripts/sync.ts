/**
 * Non-destructive Local-to-Online Database Sync Script.
 *
 * Usage:
 *   pnpm db:sync
 *   pnpm db:sync --dry-run
 *   pnpm db:sync --local postgresql://bme:bme_dev_password@localhost:5434/bme --online postgresql://...
 *
 * Reads records from the local development database (e.g. annotations, patients,
 * studies, series, jobs) and synchronizes them into the online/cloud PostgreSQL
 * database.
 *
 * Guarantees:
 * - NON-DESTRUCTIVE: Never issues DELETE statements. Existing data in online DB is preserved.
 * - UPSERT / MERGE: Missing records are inserted. Existing records are updated only if local
 *   updated_at timestamp is newer, avoiding accidental overwrites.
 * - PRESERVES RELATIONS: Syncs tables in topological order (users -> rbac -> patients ->
 *   studies -> series -> annotations -> predictions -> lesions).
 */

import pg from "pg";
import * as dotenv from "dotenv";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

// Parse command-line flags
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");

function getArgValue(flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return null;
}

const localUrlArg = getArgValue("--local");
const onlineUrlArg = getArgValue("--online") || getArgValue("--target");

// Candidate local DB URLs to test if no explicit local URL was specified
const LOCAL_CANDIDATES = [
  localUrlArg,
  process.env.LOCAL_DATABASE_URL,
  process.env.DB_LOCAL,
  "postgresql://bme:bme_dev_password@localhost:5434/bme",
  "postgresql://bme:bme_dev_password@localhost:5433/bme",
  "postgresql://postgres:postgres@localhost:5432/thunder_db",
  "postgresql://postgres:postgres@localhost:5432/bme",
].filter(Boolean) as string[];

function createPool(connectionString: string): pg.Pool {
  const hasSSL =
    connectionString.includes("sslmode=require") ||
    connectionString.includes("ssl=true") ||
    connectionString.includes("supabase.co") ||
    connectionString.includes("neon.tech");

  let cleanUrl = connectionString;
  if (hasSSL) {
    cleanUrl = cleanUrl
      .replace(/([\?&])sslmode=[^&]*/, "$1")
      .replace(/([\?&])ssl=[^&]*/, "$1")
      .replace(/\?&/, "?")
      .replace(/\?$/, "");
  }

  return new pg.Pool({
    connectionString: cleanUrl,
    ssl: hasSSL ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 8000,
  });
}

async function findWorkingLocalPool(): Promise<{ pool: pg.Pool; url: string }> {
  for (const url of LOCAL_CANDIDATES) {
    const p = createPool(url);
    try {
      const client = await p.connect();
      await client.query("SELECT 1");
      client.release();
      return { pool: p, url };
    } catch {
      await p.end().catch(() => {});
    }
  }
  throw new Error(
    "Could not connect to any Local PostgreSQL database.\n" +
      "Please specify the local URL using: pnpm db:sync --local postgresql://user:pass@localhost:port/dbname\n" +
      "or set LOCAL_DATABASE_URL / DB_LOCAL in .env",
  );
}

// Ordered table dependency list (parents before children)
const TABLES_TO_SYNC = [
  { name: "user", pkeys: ["id"], hasUpdatedAt: true },
  { name: "account", pkeys: ["id"], hasUpdatedAt: true },
  { name: "role", pkeys: ["id"], hasUpdatedAt: true },
  { name: "permission", pkeys: ["id"], hasUpdatedAt: false },
  { name: "role_permission", pkeys: ["role_id", "permission_id"], hasUpdatedAt: false },
  { name: "user_role", pkeys: ["id"], hasUpdatedAt: false },
  { name: "patient", pkeys: ["id"], hasUpdatedAt: true },
  { name: "study", pkeys: ["id"], hasUpdatedAt: false },
  { name: "series", pkeys: ["id"], hasUpdatedAt: false },
  { name: "annotation", pkeys: ["id"], hasUpdatedAt: false },
  { name: "job", pkeys: ["id"], hasUpdatedAt: false },
  { name: "prediction", pkeys: ["id"], hasUpdatedAt: false },
  { name: "lesion", pkeys: ["id"], hasUpdatedAt: false },
];

async function sync() {
  console.log("=================================================================");
  console.log("🔄 BME Database Synchronizer (Local DB -> Online DB)");
  console.log("   Mode:", isDryRun ? "DRY RUN (Preview only, no writes)" : "LIVE SYNC");
  console.log("=================================================================\n");

  const onlineUrl = onlineUrlArg || process.env.ONLINE_DATABASE_URL || process.env.DATABASE_URL;
  if (!onlineUrl) {
    console.error("❌ Target Online DATABASE_URL is not defined in env or passed via --online");
    process.exit(1);
  }

  // Connect to local
  console.log("🔌 Connecting to Local Database...");
  let localPool: pg.Pool;
  let localUrlUsed: string;
  try {
    const localInfo = await findWorkingLocalPool();
    localPool = localInfo.pool;
    localUrlUsed = localInfo.url;
    console.log(`  ✅ Connected to Local DB: ${localUrlUsed.replace(/:[^:@]+@/, ":****@")}\n`);
  } catch (err: any) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  // Connect to online
  console.log("☁️  Connecting to Online Database...");
  const onlinePool = createPool(onlineUrl);
  try {
    const client = await onlinePool.connect();
    await client.query("SELECT 1");
    client.release();
    console.log(`  ✅ Connected to Online DB: ${onlineUrl.replace(/:[^:@]+@/, ":****@")}\n`);
  } catch (err: any) {
    console.error(`❌ Failed to connect to Online DB: ${err.message}`);
    await localPool.end();
    process.exit(1);
  }

  const summary: Array<{
    table: string;
    localCount: number;
    inserted: number;
    updated: number;
    unchanged: number;
  }> = [];

  try {
    for (const tableConfig of TABLES_TO_SYNC) {
      const { name, pkeys, hasUpdatedAt } = tableConfig;

      // Check if table exists in local DB
      const localTableCheck = await localPool.query(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1)`,
        [name],
      );
      if (!localTableCheck.rows[0]?.exists) {
        continue;
      }

      // Check if table exists in online DB
      const onlineTableCheck = await onlinePool.query(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1)`,
        [name],
      );
      if (!onlineTableCheck.rows[0]?.exists) {
        console.warn(`  ⚠️  Table "${name}" does not exist in online DB (skipping).`);
        continue;
      }

      // Fetch columns common to both databases
      const colQuery = `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`;
      const localColsRes = await localPool.query(colQuery, [name]);
      const onlineColsRes = await onlinePool.query(colQuery, [name]);

      const onlineColSet = new Set(onlineColsRes.rows.map((r) => r.column_name));
      const commonCols = localColsRes.rows
        .map((r) => r.column_name)
        .filter((c) => onlineColSet.has(c));

      if (commonCols.length === 0) continue;

      // Read all rows from local table
      const localRowsRes = await localPool.query(`SELECT * FROM "${name}"`);
      const localRows = localRowsRes.rows;

      let insertedCount = 0;
      let updatedCount = 0;
      let unchangedCount = 0;

      for (const row of localRows) {
        // Build conflict match condition
        const pkeyConditions = pkeys.map((k, idx) => `"${k}" = $${idx + 1}`).join(" AND ");
        const pkeyValues = pkeys.map((k) => row[k]);

        // Check if row already exists online
        const existingOnlineRes = await onlinePool.query(
          `SELECT * FROM "${name}" WHERE ${pkeyConditions} LIMIT 1`,
          pkeyValues,
        );

        const existingRow = existingOnlineRes.rows[0];

        if (!existingRow) {
          // Row does not exist online: INSERT
          insertedCount++;
          if (!isDryRun) {
            const colsList = commonCols.map((c) => `"${c}"`).join(", ");
            const placeholders = commonCols.map((_, i) => `$${i + 1}`).join(", ");
            const vals = commonCols.map((c) => row[c]);
            await onlinePool.query(
              `INSERT INTO "${name}" (${colsList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
              vals,
            );
          }
        } else {
          // Row exists online: Check if local is newer or has updates
          let shouldUpdate = false;
          if (hasUpdatedAt && row.updated_at && existingRow.updated_at) {
            const localDate = new Date(row.updated_at).getTime();
            const onlineDate = new Date(existingRow.updated_at).getTime();
            if (localDate > onlineDate) {
              shouldUpdate = true;
            }
          }

          if (shouldUpdate) {
            updatedCount++;
            if (!isDryRun) {
              const nonPkeyCols = commonCols.filter((c) => !pkeys.includes(c));
              if (nonPkeyCols.length > 0) {
                const setClauses = nonPkeyCols.map((c, i) => `"${c}" = $${i + 1}`).join(", ");
                const setVals = nonPkeyCols.map((c) => row[c]);
                const offset = nonPkeyCols.length;
                const whereClauses = pkeys
                  .map((k, i) => `"${k}" = $${offset + i + 1}`)
                  .join(" AND ");
                await onlinePool.query(
                  `UPDATE "${name}" SET ${setClauses} WHERE ${whereClauses}`,
                  [...setVals, ...pkeyValues],
                );
              }
            }
          } else {
            unchangedCount++;
          }
        }
      }

      summary.push({
        table: name,
        localCount: localRows.length,
        inserted: insertedCount,
        updated: updatedCount,
        unchanged: unchangedCount,
      });

      console.log(
        `  📦 Table ${name.padEnd(16)} Local: ${String(localRows.length).padStart(4)} | ` +
          `+${insertedCount} to insert | ~${updatedCount} to update | ${unchangedCount} unchanged`,
      );
    }

    console.log("\n=================================================================");
    console.log("📊 SYNC SUMMARY RESULT" + (isDryRun ? " (DRY RUN - NOTHING WRITTEN)" : ""));
    console.log("=================================================================");
    console.table(
      summary.map((s) => ({
        Table: s.table,
        "Local Rows": s.localCount,
        "New / Inserted": s.inserted,
        Updated: s.updated,
        Unchanged: s.unchanged,
      })),
    );

    if (isDryRun) {
      console.log("\n💡 Dry run complete. To apply changes to Online DB, run without --dry-run:");
      console.log("   pnpm db:sync");
    } else {
      console.log("\n🎉 Online Database successfully updated! All data preserved without deletions.");
    }
  } finally {
    await localPool.end().catch(() => {});
    await onlinePool.end().catch(() => {});
  }
}

sync().catch((err) => {
  console.error("\n❌ Database sync failed:", err);
  process.exit(1);
});
