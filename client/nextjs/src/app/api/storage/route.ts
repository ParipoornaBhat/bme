import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

/**
 * Storage breakdown across the project.
 *
 * Walks directories on demand rather than caching: the numbers change every
 * time someone converts, trains or annotates, and a stale figure is worse than
 * a one-second wait. node_modules and .git are skipped — they dominate the
 * total and tell you nothing about the dataset.
 */

export const dynamic = "force-dynamic";

const SKIP = new Set([".git", "node_modules", ".next", ".turbo", ".venv", "__pycache__"]);

function walk(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { bytes: 0, files: 0 };
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = walk(p);
      bytes += sub.bytes;
      files += sub.files;
    } else if (e.isFile()) {
      try {
        bytes += fs.statSync(p).size;
        files++;
      } catch { /* vanished mid-walk */ }
    }
  }
  return { bytes, files };
}

function entry(root: string, rel: string, label: string, group: string) {
  const p = path.join(root, rel);
  const exists = fs.existsSync(p);
  const { bytes, files } = exists ? walk(p) : { bytes: 0, files: 0 };
  return { label, group, path: rel, exists, bytes, files };
}

export async function GET() {
  const root = path.resolve(process.cwd(), "..", "..");

  const items = [
    entry(root, "BME/3d", "BME archives (raw)", "Source data"),
    entry(root, "Non BME/3d", "Non-BME archives (raw)", "Source data"),
    entry(root, "Non BME/2d", "Non-BME slice images", "Source data"),
    entry(root, "BME/2d", "BME slice images", "Source data"),
    entry(root, "BME/3d_annotated", "BME annotations (filed)", "Processed — 3D"),
    entry(root, "Non BME/3d_annotated", "Non-BME annotations (filed)", "Processed — 3D"),

    entry(root, "data/raw", "De-identified DICOM", "Processed — 3D"),
    entry(root, "data/nifti", "NIfTI volumes", "Processed — 3D"),
    entry(root, "data/annotations", "Annotations (.seg.nrrd)", "Processed — 3D"),
    entry(root, "data/nnunet", "nnU-Net datasets", "Processed — 3D"),

    entry(root, "data/slices2d", "2D slice images", "Processed — 2D"),
    entry(root, "data/results2d", "2D results & run history", "Models & results"),
    entry(root, "models", "Saved model weights", "Models & results"),

    entry(root, "client", "Web client", "Code"),
    entry(root, "server", "API & database code", "Code"),
    entry(root, "ml", "Python pipeline", "Code"),
    entry(root, "docs", "Documentation", "Code"),
  ];

  // Group totals, in a fixed order so the UI does not reshuffle between polls.
  const order = ["Source data", "Processed — 3D", "Processed — 2D", "Models & results", "Code"];
  const groups = order.map((g) => {
    const rows = items.filter((i) => i.group === g);
    return {
      name: g,
      bytes: rows.reduce((s, i) => s + i.bytes, 0),
      files: rows.reduce((s, i) => s + i.files, 0),
      items: rows,
    };
  });

  let disk: { total: number; free: number } | null = null;
  try {
    const s = fs.statfsSync(root);
    disk = { total: s.blocks * s.bsize, free: s.bfree * s.bsize };
  } catch {
    disk = null; // statfsSync is not on every Node build
  }

  return NextResponse.json({
    groups,
    total: items.reduce((s, i) => s + i.bytes, 0),
    totalFiles: items.reduce((s, i) => s + i.files, 0),
    disk,
    note: "node_modules, .git and virtualenvs excluded.",
  });
}
