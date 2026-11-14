#!/usr/bin/env node

/**
 * Review Inbox CLI.
 *
 * Talks to the running local Next.js app at http://localhost:<port> (default 3000).
 *
 * Commands:
 *   node scripts/review-inbox.js [--port 3000]
 *   node scripts/review-inbox.js apply <id> [--main] [--port 3000]
 *   node scripts/review-inbox.js dismiss <id> [--port 3000]
 */

const args = process.argv.slice(2);

let port = 3000;
let command = "list";
let id = null;
let main = false;

const positional = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--port") {
    port = parseInt(args[++i], 10);
  } else if (arg.startsWith("--port=")) {
    port = parseInt(arg.split("=")[1], 10);
  } else if (arg === "--main") {
    main = true;
  } else if (arg === "-h" || arg === "--help") {
    console.log(`Usage:
  node scripts/review-inbox.js [--port 3000]
  node scripts/review-inbox.js apply <id> [--main] [--port 3000]
  node scripts/review-inbox.js dismiss <id> [--port 3000]`);
    process.exit(0);
  } else {
    positional.push(arg);
  }
}

if (positional.length > 0) {
  if (positional[0] === "apply") {
    command = "apply";
    id = positional[1];
  } else if (positional[0] === "dismiss") {
    command = "dismiss";
    id = positional[1];
  } else if (positional[0] === "list") {
    command = "list";
  } else {
    console.error(`Unknown subcommand: ${positional[0]}`);
    process.exit(1);
  }
}

if ((command === "apply" || command === "dismiss") && !id) {
  console.error(`Error: missing <id> for ${command}`);
  process.exit(1);
}

async function run() {
  const baseUrl = `http://localhost:${port}`;
  try {
    if (command === "list") {
      const res = await fetch(`${baseUrl}/api/review-inbox`);
      if (!res.ok) {
        const text = await res.text();
        console.error(`Error (${res.status}): ${text}`);
        process.exit(1);
      }
      const data = await res.json();
      const edits = Array.isArray(data) ? data : data.edits || [];
      if (edits.length === 0) {
        console.log("No open review edits.");
        return;
      }
      console.log(`Open review edits (${edits.length}):\n`);
      for (const edit of edits) {
        const d = edit.createdAt
          ? new Date(edit.createdAt).toISOString().replace("T", " ").slice(0, 19)
          : "unknown date";
        const note = edit.note ? ` - "${edit.note}"` : "";
        console.log(`  ${String(edit.caseId).padEnd(10)} by ${String(edit.reviewer).padEnd(16)} on ${d}${note}`);
        console.log(`    id: ${edit.id}`);
      }
    } else if (command === "apply") {
      const res = await fetch(`${baseUrl}/api/review-inbox`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "apply", main }),
      });
      const data = await res.json();
      if (!res.ok) {
        console.error(`Error (${res.status}): ${data.error || JSON.stringify(data)}`);
        process.exit(1);
      }
      console.log(`Applied review edit ${id}${main ? " (main file updated)" : ""}.`);
      if (data.details) {
        console.log(`  ${data.details}`);
      }
    } else if (command === "dismiss") {
      const res = await fetch(`${baseUrl}/api/review-inbox`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "dismiss" }),
      });
      const data = await res.json();
      if (!res.ok) {
        console.error(`Error (${res.status}): ${data.error || JSON.stringify(data)}`);
        process.exit(1);
      }
      console.log(`Dismissed review edit ${id}.`);
    }
  } catch (err) {
    if (err && (err.code === "ECONNREFUSED" || err.cause?.code === "ECONNREFUSED")) {
      console.error(`Could not connect to local app at ${baseUrl}. Is Next.js running on port ${port}?`);
    } else {
      console.error(`Request failed: ${err.message || err}`);
    }
    process.exit(1);
  }
}

run();
