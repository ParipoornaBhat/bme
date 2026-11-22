#!/usr/bin/env node
/**
 * pnpm data:pull         show the new scans on Drive this PC does not have, ask, download, then sync annotations
 * pnpm data:pull --yes   the same without asking
 *
 * For teammates after new cases were added: downloads the missing scans (from the
 * Drive folder the hosted site uses) into data/nifti, adds them to data/worklist.csv,
 * then runs the cloud annotation sync so their annotations arrive too.
 * Needs the app running on this PC (pnpm dev or pnpm start), like pnpm data:cloud.
 */

import readline from "node:readline/promises";

const port = Number((process.argv.find((a) => a.startsWith("--port=")) || "").split("=")[1]) || 3000;
const yes = process.argv.includes("--yes") || process.argv.includes("-y");
const base = `http://localhost:${port}`;
const mb = (b) => `${Math.round(b / (1024 * 1024))} MB`;

async function json(res) {
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `${res.status}`);
  return j;
}

try {
  const plan = await json(await fetch(`${base}/api/data-pull`));
  if (!plan.missing.length) {
    console.log(`This PC has every scan the team database knows (${plan.inDatabase}).`);
  } else {
    console.log(`${plan.missing.length} new scan(s) on Drive, about ${mb(plan.estimateBytes)}:`);
    console.log("  " + plan.missing.join(" "));
    console.log("They go to data/nifti/<case>/ and are added to data/worklist.csv. Existing files are never changed.");
    let go = yes;
    if (!go) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      go = (await rl.question("Download them? [y/N] ")).trim().toLowerCase() === "y";
      rl.close();
    }
    if (go) {
      console.log("Downloading...");
      const r = await json(
        await fetch(`${base}/api/data-pull`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmed: true }),
        }),
      );
      console.log(`Downloaded ${r.downloaded.length} (${mb(r.bytes)}), added ${r.worklistRows} worklist row(s).`);
      for (const f of r.failed) console.log(`  not downloaded: ${f.id} (${f.why})`);
    }
  }
  console.log("Syncing annotations...");
  const s = await json(await fetch(`${base}/api/annotation-sync`, { method: "POST" }));
  console.log(s.ok ? "Annotations are up to date." : `Annotation sync: ${s.reason || "not finished"}`);
} catch (e) {
  console.error(`Could not reach the app on port ${port} (${e.message}). Start it with pnpm dev or pnpm start, then run this again.`);
  process.exit(1);
}
