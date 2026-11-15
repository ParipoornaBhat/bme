import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const isWin = process.platform === "win32";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function unescapeHtml(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function getDriveFolderId(rootDir) {
  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) {
    console.error("Missing .env file in repository root");
    process.exit(1);
  }
  const content = fs.readFileSync(envPath, "utf8");
  let folderUrl = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^REVIEW_DRIVE_FOLDER_URL\s*=\s*(.*)$/);
    if (match) {
      let val = match[1].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      folderUrl = val;
      break;
    }
  }

  if (!folderUrl) {
    console.error("Missing REVIEW_DRIVE_FOLDER_URL in .env");
    process.exit(1);
  }

  const match = folderUrl.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (!match || !match[1]) {
    console.error("Cannot extract folder ID from REVIEW_DRIVE_FOLDER_URL in .env");
    process.exit(1);
  }

  return match[1];
}

function getLocalCases(rootDir) {
  const niftiDir = path.join(rootDir, "data", "nifti");
  const cases = [];
  if (fs.existsSync(niftiDir)) {
    const entries = fs.readdirSync(niftiDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && /^(BME|NBME)-\d{3}$/.test(entry.name)) {
        const caseId = entry.name;
        const primaryPath = path.join(niftiDir, caseId, `${caseId}_primary.nii.gz`);
        if (fs.existsSync(primaryPath)) {
          cases.push(caseId);
        }
      }
    }
  }
  return cases.sort();
}

async function fetchDriveListing(folderId) {
  const url = `https://drive.google.com/embeddedfolderview?id=${folderId}`;
  let html = "";
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
      signal: AbortSignal.timeout(40000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    html = await res.text();
  } catch {
    console.error("cannot read the Drive folder (offline?)");
    process.exit(1);
  }

  const entryRegex = /https:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)\/view(?:(?!https:\/\/drive\.google\.com\/file\/d\/)[\s\S])*?flip-entry-title">([^<]+)</g;
  const parsed = [];
  let m;
  while ((m = entryRegex.exec(html)) !== null) {
    const fileId = m[1];
    const rawName = m[2];
    const name = unescapeHtml(rawName).trim();
    const nameMatch = name.match(/^((?:N)?BME-\d{3})_primary\.nii\.gz$/);
    if (nameMatch) {
      parsed.push({ fileId, name, caseId: nameMatch[1] });
    }
  }

  const caseToIds = new Map();
  for (const item of parsed) {
    if (!caseToIds.has(item.caseId)) {
      caseToIds.set(item.caseId, []);
    }
    caseToIds.get(item.caseId).push(item.fileId);
  }

  const driveMap = new Map();
  const duplicates = [];

  for (const [caseId, ids] of caseToIds.entries()) {
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length > 1) {
      duplicates.push({ caseId, ids: uniqueIds });
    } else {
      driveMap.set(caseId, uniqueIds[0]);
    }
  }

  return { driveMap, duplicates };
}

async function runFinish({ rootDir, driveMap, localCases, dry }) {
  console.log("Review scans (finish)");

  if (!driveMap) {
    const folderId = getDriveFolderId(rootDir);
    const listing = await fetchDriveListing(folderId);
    driveMap = listing.driveMap;
  }
  if (!localCases) {
    localCases = getLocalCases(rootDir);
  }

  const targetPath = path.join(rootDir, "data", "review_scan_ids.json");
  let currentData = {};
  if (fs.existsSync(targetPath)) {
    try {
      currentData = JSON.parse(fs.readFileSync(targetPath, "utf8"));
    } catch (err) {
      console.error(`Cannot parse ${targetPath}: ${err.message}`);
      process.exit(1);
    }
  }

  const merged = { ...currentData };
  const toAdd = [];
  const toUpdate = [];

  for (const [caseId, driveId] of driveMap.entries()) {
    if (!(caseId in currentData)) {
      toAdd.push(caseId);
      merged[caseId] = driveId;
    } else if (currentData[caseId] !== driveId) {
      toUpdate.push(caseId);
      merged[caseId] = driveId;
    }
  }

  toAdd.sort();
  toUpdate.sort();

  console.log(`Target: ${targetPath}`);
  console.log(`To add: ${toAdd.length}${toAdd.length > 0 ? ` (${toAdd.join(", ")})` : ""}`);
  console.log(`To update: ${toUpdate.length}${toUpdate.length > 0 ? ` (${toUpdate.join(", ")})` : ""}`);

  if (toAdd.length > 0 || toUpdate.length > 0) {
    if (dry) {
      console.log("[dry-run] Would write updated mapping atomically to data/review_scan_ids.json");
    } else {
      const sortedMerged = {};
      for (const k of Object.keys(merged).sort()) {
        sortedMerged[k] = merged[k];
      }
      const tmpPath = path.join(rootDir, "data", `.review_scan_ids.json.tmp.${Date.now()}`);
      fs.writeFileSync(tmpPath, JSON.stringify(sortedMerged, null, 2) + "\n", "utf8");
      fs.renameSync(tmpPath, targetPath);
    }
  } else {
    console.log("Mapping is already up to date.");
  }

  if (dry) {
    console.log("[dry-run] Would run: pnpm review:setup");
  } else {
    console.log("Running pnpm review:setup...");
    const res = spawnSync("pnpm", ["review:setup"], {
      cwd: rootDir,
      shell: isWin,
      stdio: "inherit",
    });
    if (res.status !== 0) {
      console.error("pnpm review:setup failed");
      process.exit(res.status ?? 1);
    }
  }

  const uploadDir = path.join(rootDir, "drive-upload");
  const removed = [];
  if (fs.existsSync(uploadDir)) {
    const files = fs.readdirSync(uploadDir);
    for (const file of files) {
      const match = file.match(/^((?:N)?BME-\d{3})_primary\.nii\.gz$/);
      if (match) {
        const caseId = match[1];
        if (merged[caseId]) {
          removed.push(file);
          if (!dry) {
            const filePath = path.join(uploadDir, file);
            fs.unlinkSync(filePath);
          }
        }
      }
    }

    if (removed.length > 0) {
      if (dry) {
        console.log(`[dry-run] Would remove ${removed.length} uploaded link(s) from drive-upload/`);
      } else {
        console.log(`Removed ${removed.length} uploaded link(s) from drive-upload/`);
      }
    } else {
      console.log("Nothing to remove from drive-upload/");
    }

    if (!dry) {
      if (fs.existsSync(uploadDir) && fs.readdirSync(uploadDir).length === 0) {
        fs.rmdirSync(uploadDir);
        console.log("Removed empty drive-upload/ folder");
      }
    }
  }

  const totalSiteCases = Object.keys(merged).length;
  const stillMissing = localCases.filter((c) => !merged[c]);
  console.log(`Result: ${totalSiteCases} cases on the site`);
  if (stillMissing.length > 0) {
    console.log(`Still missing on Drive: ${stillMissing.length} (${stillMissing.join(", ")})`);
  } else {
    console.log("All local cases are on the site.");
  }
}

async function runPrepare({ rootDir, dry }) {
  console.log("Review scans (prepare)");

  const folderId = getDriveFolderId(rootDir);
  const localCases = getLocalCases(rootDir);
  const { driveMap, duplicates } = await fetchDriveListing(folderId);

  const missingOnDrive = localCases.filter((c) => !driveMap.has(c));
  const onDriveNotHere = Array.from(driveMap.keys())
    .filter((c) => !localCases.includes(c))
    .sort();

  console.log(`On this laptop:      ${localCases.length}`);
  console.log(`On Drive:            ${driveMap.size}`);
  console.log(`Missing on Drive:    ${missingOnDrive.length}${missingOnDrive.length > 0 ? ` (${missingOnDrive.join(", ")})` : ""}`);
  console.log(`On Drive not here:   ${onDriveNotHere.length}${onDriveNotHere.length > 0 ? ` (${onDriveNotHere.join(", ")})` : ""}`);
  console.log(`Duplicates on Drive: ${duplicates.length}`);

  for (const dup of duplicates) {
    console.log(`Warning: Duplicate entries for ${dup.caseId} on Drive (${dup.ids.join(", ")}). Skipped (cannot determine newest).`);
  }

  if (missingOnDrive.length === 0) {
    console.log("No scans missing on Drive. Proceeding to finish.");
    await runFinish({ rootDir, driveMap, localCases, dry });
    return;
  }

  const uploadDir = path.join(rootDir, "drive-upload");
  let totalSizeBytes = 0;
  let count = 0;

  if (!dry) {
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
  }

  for (const caseId of missingOnDrive) {
    const src = path.join(rootDir, "data", "nifti", caseId, `${caseId}_primary.nii.gz`);
    const dst = path.join(uploadDir, `${caseId}_primary.nii.gz`);

    if (fs.existsSync(src)) {
      totalSizeBytes += fs.statSync(src).size;
      count++;
    }

    if (fs.existsSync(dst)) {
      continue;
    }

    if (dry) {
      console.log(`[dry-run] Would link ${caseId}_primary.nii.gz -> drive-upload/`);
    } else {
      try {
        fs.linkSync(src, dst);
      } catch (err) {
        console.error(`Failed to create hard link for ${caseId}: ${err.message}`);
        console.error("Hard links are required. Refusing to copy.");
        process.exit(1);
      }
    }
  }

  const sizeMb = (totalSizeBytes / (1024 * 1024)).toFixed(1);
  console.log(`Prepared ${count} file(s) in drive-upload/ (${sizeMb} MB)`);
  console.log("Next: Upload the files in drive-upload/ to the Drive folder (drag and drop), then run: pnpm review:scans --finish");
}

function printHelp() {
  console.log("Usage: pnpm review:scans [options]");
  console.log("");
  console.log("Options:");
  console.log("  --finish   Sync Drive IDs into database and clean up staged uploads");
  console.log("  --dry      Print plan only without writing, linking, removing, or running setup");
  console.log("  --help     Show this help message");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const dry = args.includes("--dry");
  const finish = args.includes("--finish");

  if (finish) {
    await runFinish({ rootDir, dry });
  } else {
    await runPrepare({ rootDir, dry });
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
