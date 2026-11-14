#!/usr/bin/env node
/**
 * Cloud annotation sync CLI.
 *
 * Calls the running app's /api/annotation-sync endpoint to synchronize local
 * annotations with the online Postgres database.
 *
 * Authentication:
 * On localhost, requests are allowed via the local loopback interface bypass in
 * Next.js middleware. When calling a remote deployment over the network or tunnel,
 * the route requires an active team-member session cookie (`session_token` with
 * admin role). Collaborator and guest tokens cannot access this endpoint.
 *
 * Flags:
 *   --apply       Run the sync for real (default is dry-run)
 *   --backfill    Fill labels_gz_b64 for existing cloud rows that lack it
 *   --as <name>   Annotator name to sync as (sanitized automatically)
 *   --port <n>    Local port for Next.js app (default: 3000)
 */

const args = process.argv.slice(2);
let apply = false;
let backfill = false;
let asName = "";
let port = 3000;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--apply") {
    apply = true;
  } else if (arg === "--backfill") {
    backfill = true;
  } else if (arg === "--as" && i + 1 < args.length) {
    asName = args[++i];
  } else if (arg === "--port" && i + 1 < args.length) {
    const parsedPort = parseInt(args[++i], 10);
    if (!Number.isNaN(parsedPort) && parsedPort > 0) {
      port = parsedPort;
    }
  }
}

const query = new URLSearchParams();
if (!apply) {
  query.set("dry", "1");
}
if (asName) {
  query.set("by", asName);
}
if (backfill) {
  query.set("backfill", "1");
}
const queryString = query.toString();
const url = `http://localhost:${port}/api/annotation-sync${queryString ? `?${queryString}` : ""}`;

async function main() {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
    });
  } catch (_err) {
    console.error("start the app first (pnpm dev)");
    process.exit(1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`HTTP ${res.status}: ${text || res.statusText}`);
    process.exit(1);
  }

  let report;
  try {
    report = await res.json();
  } catch (err) {
    console.error(`Invalid response: ${err}`);
    process.exit(1);
  }

  if (!report.ok) {
    console.error(`Sync failed: ${report.reason || "unknown error"}`);
    process.exit(1);
  }

  const mode = report.dryRun ? "dry run" : "applied";
  console.log(`Cloud Annotation Sync (${mode})`);
  console.log(`  pushed: ${report.pushed}, pulled: ${report.pulled}, recorded: ${report.recorded}`);

  if (Array.isArray(report.conflicts) && report.conflicts.length > 0) {
    console.log(`Conflicts (${report.conflicts.length}):`);
    for (const c of report.conflicts) {
      console.log(`  ${c.caseId}/${c.annotator}: conflict`);
    }
  }

  if (Array.isArray(report.skipped) && report.skipped.length > 0) {
    console.log(`Skipped (${report.skipped.length}):`);
    for (const s of report.skipped) {
      console.log(`  ${s.caseId}/${s.annotator}: ${s.why}`);
    }
  }

  if (Array.isArray(report.changedCases) && report.changedCases.length > 0) {
    console.log(`Changed cases (${report.changedCases.length}): ${report.changedCases.join(", ")}`);
  }
}

main();
