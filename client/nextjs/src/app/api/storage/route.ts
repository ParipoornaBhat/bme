import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

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

function entry(
  root: string,
  rel: string,
  label: string,
  group: string,
  extra?: { reason?: string; removable?: string },
) {
  const p = path.join(root, rel);
  const exists = fs.existsSync(p);
  const { bytes, files } = exists ? walk(p) : { bytes: 0, files: 0 };
  return { label, group, path: rel, exists, bytes, files, ...extra };
}

// site-packages sits inside .venv, which the walker skips by name. These are
// addressed directly so the CUDA download is visible and accountable rather
// than hidden inside an excluded directory.
const SITE =
  process.platform === "win32"
    ? "ml/.venv/Lib/site-packages"
    : "ml/.venv/lib/python3/site-packages";

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

    entry(root, `${SITE}/torch`, "PyTorch (CUDA build)", "GPU support", {
      reason:
        "Installed to train on the RTX 4050 instead of the CPU. Segmentation is roughly 20-40x faster on the GPU. The bulk of this is the bundled CUDA runtime (cuDNN, cuBLAS), not PyTorch itself.",
      removable: "cpu-torch",
    }),
    entry(root, `${SITE}/nvidia`, "NVIDIA CUDA libraries", "GPU support", {
      reason:
        "CUDA runtime shipped as separate packages. Present only on some platforms; on Windows these libraries are usually bundled inside PyTorch above.",
      removable: "cpu-torch",
    }),
    entry(root, `${SITE}/torchvision`, "torchvision", "GPU support", {
      reason:
        "Image models and transforms. Reinstalled alongside PyTorch so the two builds match - a CUDA torch with a CPU torchvision fails at import.",
      removable: "cpu-torch",
    }),

    entry(root, "client", "Web client", "Code"),
    entry(root, "server", "API & database code", "Code"),
    entry(root, "ml", "Python pipeline", "Code"),
    entry(root, "docs", "Documentation", "Code"),
  ];

  // Group totals, in a fixed order so the UI does not reshuffle between polls.
  const order = ["Source data", "Processed — 3D", "Processed — 2D", "Models & results", "GPU support", "Code"];
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

/**
 * Revert to the CPU-only PyTorch, freeing the CUDA runtime.
 *
 * Deliberately a reinstall rather than a delete. Removing the CUDA DLLs from
 * inside the package would free the same space and leave an import error
 * behind; swapping the wheel leaves a working environment that simply trains
 * on the CPU again. The CPU wheel is a fraction of the CUDA one, so this is a
 * net saving even though it downloads.
 *
 * Runs detached and returns immediately: pip takes minutes and an HTTP request
 * should not be held open for it.
 */
export async function DELETE() {
  const root = path.resolve(process.cwd(), "..", "..");
  const py =
    process.platform === "win32"
      ? path.join(root, "ml", ".venv", "Scripts", "python.exe")
      : path.join(root, "ml", ".venv", "bin", "python");
  if (!fs.existsSync(py)) {
    return NextResponse.json({ error: "python environment not found" }, { status: 400 });
  }

  const logPath = path.join(root, "data", "results2d", "torch-revert.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.openSync(logPath, "w");

  const child = spawn(
    py,
    ["-m", "pip", "install", "--index-url", "https://download.pytorch.org/whl/cpu",
     "torch==2.13.0", "torchvision==0.28.0", "--force-reinstall"],
    { cwd: root, detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();

  return NextResponse.json({
    ok: true,
    started: true,
    note: "Switching back to CPU-only PyTorch. This takes a few minutes; restart the dev server afterwards so the GPU check re-runs.",
    log: "data/results2d/torch-revert.log",
  });
}
