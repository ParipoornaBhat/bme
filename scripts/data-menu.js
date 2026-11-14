import fs from "node:fs";
import path from "node:path";
import { ask, root, runNode, yes } from "./lib/accounts.js";
import { choose, info, next, ok, section, stop, table, title, warn } from "./lib/ui.js";

/**
 * Data menu and command dispatcher for medical imaging datasets.
 *
 * Direct CLI invocation:
 *   node scripts/data-menu.js <key> [name|args...]
 * Interactive menu:
 *   node scripts/data-menu.js
 */

const VALID_KEYS = [
  "status",
  "sync",
  "newcases",
  "import-bme",
  "convert-nonbme",
  "import-nonbme",
  "export-bme",
  "export-nonbme",
  "export",
  "import-team",
  "combine-nonbme",
  "share",
  "fix-fs",
  "erase-3d",
  "erase-nonbme",
];

const ITEMS = [
  {
    key: "status",
    group: "Get this laptop up to date",
    label: "Show what is here",
    about: "Counts: scans, annotated cases, and inbox contents.",
  },
  {
    key: "sync",
    group: "Get this laptop up to date",
    label: "Sync from the hub",
    about: "Import a hub annotations zip and optional MRI zip.",
  },
  {
    key: "newcases",
    group: "Get this laptop up to date",
    label: "Import new cases (bundle)",
    about: "Import bme_newcases_*.zip bundle without changing existing IDs.",
  },
  {
    key: "import-bme",
    group: "Bring in new scans",
    label: "Import BME folders",
    about: "Import inbox/bme or data/newbme as BME-001 onward.",
  },
  {
    key: "convert-nonbme",
    group: "Bring in new scans",
    label: "Convert non-BME DICOM",
    about: "Turn inbox/nonbme-dicom or Non BME/3d zips into NRRD folders.",
  },
  {
    key: "import-nonbme",
    group: "Bring in new scans",
    label: "Import non-BME",
    about: "Import inbox/nonbme, Non BME/new, or data/newnonbme as NBME-001 onward.",
  },
  {
    key: "export-bme",
    group: "Share annotations",
    label: "Export my BME annotations",
    about: "Zip owned BME annotations that have bone painted.",
  },
  {
    key: "export-nonbme",
    group: "Share annotations",
    label: "Export my non-BME annotations",
    about: "Zip owned non-BME annotations patient-wise.",
  },
  {
    key: "export",
    group: "Share annotations",
    label: "Export both",
    about: "Export BME and non-BME annotations to inbox/outgoing.",
  },
  {
    key: "import-team",
    group: "Share annotations",
    label: "Hub: merge teammate zips",
    about: "Merge teammate annotation zips from inbox/team.",
  },
  {
    key: "combine-nonbme",
    group: "Share annotations",
    label: "Hub: combine all non-BME",
    about: "Bundle all 60 non-BME cases patient-wise for training.",
  },
  {
    key: "share",
    group: "Share annotations",
    label: "Hub: share the whole dataset",
    about: "Build hub MRI and annotations zips to share with team.",
  },
  {
    key: "fix-fs",
    group: "Fixes",
    label: "Install the light-marrow fix",
    about: "Swap NBME-005/058 to dark scan using fs_fix.zip.",
  },
  {
    key: "erase-3d",
    group: "Danger (asks twice, never part of any flow)",
    label: "Erase the 3D dataset",
    about: "Wipe raw, nifti, annotations, nnunet, and case database rows.",
  },
  {
    key: "erase-nonbme",
    group: "Danger (asks twice, never part of any flow)",
    label: "Erase imported non-BME",
    about: "Delete imported NBME cases only.",
  },
];

function getTeamMembers() {
  const fallback = ["paripoorna", "elvin", "aditi", "reegan"];
  try {
    const file = path.join(root, "ml", "scripts", "team_annotations.py");
    if (!fs.existsSync(file)) return fallback;
    const text = fs.readFileSync(file, "utf8");
    const m = text.match(/TEAM\s*=\s*\{([^}]+)\}/);
    if (!m) return fallback;
    const names = [];
    for (const match of m[1].matchAll(/["']([a-zA-Z0-9_-]+)["']\s*:/g)) {
      names.push(match[1]);
    }
    return names.length ? names : fallback;
  } catch {
    return fallback;
  }
}

async function pickTeammate(givenName) {
  if (givenName) return givenName;
  const team = getTeamMembers();
  const items = team.map((name) => ({ label: name }));
  const picked = await choose("Whose annotations?", items, { prompt: "Teammate" });
  if (!picked) return null;
  return picked.label;
}

async function showStatus() {
  title("Data Status", "Scans, annotations, and what waits in the inbox.");

  section("Dataset");
  let niftiCount = 0;
  const niftiDir = path.join(root, "data", "nifti");
  if (fs.existsSync(niftiDir)) {
    niftiCount = fs.readdirSync(niftiDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .length;
  }

  let annotCount = 0;
  const annotDir = path.join(root, "data", "annotations");
  if (fs.existsSync(annotDir)) {
    const subdirs = fs.readdirSync(annotDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());
    for (const dir of subdirs) {
      const segFile = path.join(annotDir, dir.name, `${dir.name}.seg.nrrd`);
      if (fs.existsSync(segFile)) {
        annotCount++;
      }
    }
  }

  info(`Scans in data/nifti: ${niftiCount}`);
  info(`Annotated cases in data/annotations: ${annotCount}`);

  section("Inbox");
  const inboxDir = path.join(root, "inbox");
  const inboxHandlers = [
    { dir: "bme", cmd: "pnpm data:import:bme" },
    { dir: "bundles", cmd: "pnpm data:import:newcases" },
    { dir: "nonbme-dicom", cmd: "pnpm data:convert:nonbme" },
    { dir: "nonbme", cmd: "pnpm data:import:nonbme" },
    { dir: "team", cmd: "pnpm data:import:team" },
    { dir: "fixes", cmd: "pnpm data:fix:fs" },
    { dir: "outgoing", cmd: "(ready to send)" },
  ];

  const inboxRows = inboxHandlers.map(({ dir, cmd }) => {
    const p = path.join(inboxDir, dir);
    const count = fs.existsSync(p)
      ? fs.readdirSync(p, { withFileTypes: true }).length
      : 0;
    return [`inbox/${dir}`, `${count} item(s)`, cmd];
  });
  table(inboxRows, ["folder", "waiting", "handled by"]);

  next("pnpm data               open the data menu", "pnpm train              start training");
  return 0;
}

async function runItem(key, extraArgs) {
  switch (key) {
    case "status":
      return await showStatus();

    case "sync": {
      let zips = [...extraArgs];
      if (!zips.length) {
        const zip = await ask("Annotations zip file name: ");
        if (!zip) stop("No zip name given.");
        zips = [zip];
      }
      const code = runNode("team-annotations.js", ["restore", ...zips]);
      if (code === 0) next("pnpm data:status        check updated scan and annotation counts");
      return code;
    }

    case "newcases": {
      const code = runNode("import-newbme.js", ["--bundle", ...extraArgs]);
      if (code === 0) next("pnpm data:status        check updated scan counts", "pnpm train:split        update training split if needed");
      return code;
    }

    case "import-bme": {
      console.log("");
      warn("The source zip or folder in inbox/bme or data/newbme will be removed after each case is written.");
      const remove = await yes("Remove the source?");
      const flags = [...extraArgs];
      if (!remove) {
        flags.push("--keep");
        info("Source will be kept. Import continues.");
      } else {
        info("Source will be removed after a successful write.");
      }
      const code = runNode("import-newbme.js", flags);
      if (code === 0) next("pnpm data:status        check updated scan counts");
      return code;
    }

    case "convert-nonbme": {
      console.log("");
      warn("Each zip in inbox/nonbme-dicom or Non BME/3d will be removed after its NRRD files are written.");
      const remove = await yes("Remove the source?");
      const flags = [...extraArgs];
      if (!remove) {
        flags.push("--keep");
        info("Source will be kept. Conversion continues.");
      } else {
        info("Source will be removed after its NRRD files are written.");
      }
      const code = runNode("nonbme-to-nrrd.js", flags);
      if (code === 0) next("pnpm data:import:nonbme import the converted NRRD folders");
      return code;
    }

    case "import-nonbme": {
      console.log("");
      warn("The source folder or zip in inbox/nonbme, Non BME/new, or data/newnonbme will be removed after each case is written.");
      const remove = await yes("Remove the source?");
      const flags = [...extraArgs];
      if (!remove) {
        flags.push("--keep");
        info("Source will be kept. Import continues.");
      } else {
        info("Source will be removed after a successful write.");
      }
      const code = runNode("import-newnonbme.js", flags);
      if (code === 0) next("pnpm data:status        check updated scan counts");
      return code;
    }

    case "export-bme": {
      const who = await pickTeammate(extraArgs[0]);
      if (!who) return 0;
      const flags = extraArgs.slice(1);
      const code = runNode("team-annotations.js", [who, ...flags]);
      if (code === 0) next("The zip is in inbox/outgoing/. Send it to the hub laptop.", "pnpm data:import:team    (on hub) merge teammate zips");
      return code;
    }

    case "export-nonbme": {
      const who = await pickTeammate(extraArgs[0]);
      if (!who) return 0;
      const flags = extraArgs.slice(1);
      const code = runNode("team-annotations.js", ["export-nbme", who, ...flags]);
      if (code === 0) next("The zip is in inbox/outgoing/. Send it to the hub laptop.", "pnpm data:import:team    (on hub) merge teammate zips");
      return code;
    }

    case "export": {
      const who = await pickTeammate(extraArgs[0]);
      if (!who) return 0;
      const flags = extraArgs.slice(1);
      info(`Exporting BME annotations for ${who}...`);
      const codeBme = runNode("team-annotations.js", [who, ...flags]);
      if (codeBme !== 0) return codeBme;
      info(`Exporting non-BME annotations for ${who}...`);
      const codeNbme = runNode("team-annotations.js", ["export-nbme", who, ...flags]);
      if (codeNbme !== 0) return codeNbme;
      next("The zips are in inbox/outgoing/. Send them to the hub laptop.", "pnpm data:import:team    (on hub) merge teammate zips");
      return 0;
    }

    case "import-team": {
      const code = runNode("team-annotations.js", ["import-all", ...extraArgs]);
      if (code === 0) next("pnpm data:status        check updated annotation counts", "pnpm train:split        update training split if needed");
      return code;
    }

    case "combine-nonbme": {
      const code = runNode("team-annotations.js", ["combine-nbme", ...extraArgs]);
      if (code === 0) next("The combined zip is in inbox/outgoing/. Use it for training.");
      return code;
    }

    case "share": {
      const code = runNode("team-annotations.js", ["share", ...extraArgs]);
      if (code === 0) next("The hub zips are in inbox/outgoing/. Share them with the team.");
      return code;
    }

    case "fix-fs": {
      const code = runNode("swap-fs.js", ["install", "--apply", ...extraArgs]);
      if (code === 0) next("pnpm data:status        check updated scan counts");
      return code;
    }

    case "erase-3d": {
      console.log("");
      warn("This deletes data/raw, data/nifti, data/annotations, data/nnunet, and the BME/NBME database rows. data/newbme and inbox/bme stay.");
      const confirm1 = await yes("Delete these?");
      if (!confirm1) {
        console.log("Cancelled. Nothing was deleted.");
        return 0;
      }
      const typed = await ask("Type erase to confirm deletion: ");
      if (typed !== "erase") {
        console.log("Cancelled. Nothing was deleted.");
        return 0;
      }
      const code = runNode("erase-3d.js", extraArgs);
      if (code === 0) next("pnpm data:import:bme    import cases starting from BME-001");
      return code;
    }

    case "erase-nonbme": {
      console.log("");
      warn("This deletes imported NBME volumes, annotations, and database rows. Non BME/new, data/newnonbme, and inbox/nonbme stay.");
      const confirm1 = await yes("Delete these?");
      if (!confirm1) {
        console.log("Cancelled. Nothing was deleted.");
        return 0;
      }
      const typed = await ask("Type erase to confirm deletion: ");
      if (typed !== "erase") {
        console.log("Cancelled. Nothing was deleted.");
        return 0;
      }
      const code = runNode("erase-nonbme.js", extraArgs);
      if (code === 0) next("pnpm data:import:nonbme import non-BME cases starting from NBME-001");
      return code;
    }

    default:
      stop(`Unknown key "${key}".`, `Valid keys: ${VALID_KEYS.join(", ")}`);
      return 1;
  }
}

const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (!args.length) {
  title("Data", "Manage scans, annotations, team sync, and exports.");
  const picked = await choose(null, ITEMS, { prompt: "Which one" });
  if (!picked) process.exit(0);
  const code = await runItem(picked.key, []);
  process.exit(code);
}

const [key, ...extra] = args;
if (!VALID_KEYS.includes(key)) {
  stop(`Unknown key "${key}".`, `Valid keys: ${VALID_KEYS.join(", ")}`);
}

const code = await runItem(key, extra);
process.exit(code);
