import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

/**
 * Case list for the annotation workspace.
 *
 * PHI NOTE — read before changing this.
 * The original archive filenames are patient names ("--MOHAMMED-FAIZ.zip"). They
 * are returned ONLY when SHOW_SOURCE_NAMES=true is set in the local .env, which
 * is gitignored and off by default. Without it the API returns pseudonymous IDs
 * and nothing else, so a screenshot, a deployed build, or a shared browser
 * session cannot leak identities. Do not remove the flag to "make it simpler".
 */

export const dynamic = "force-dynamic";

const SHOW_NAMES = process.env.SHOW_SOURCE_NAMES === "true";

function projectRoot() {
  return path.resolve(process.cwd(), "..", "..");
}

function parseCsv(rel: string): Record<string, string>[] {
  const p = path.join(projectRoot(), rel);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const head = lines[0].split(",");
  return lines.slice(1).map((line) => {
    // naive split is fine: these files are written by our own scripts and
    // contain no quoted commas in the columns we read
    const cells = line.split(",");
    const row: Record<string, string> = {};
    head.forEach((h, i) => (row[h.trim()] = (cells[i] ?? "").trim()));
    return row;
  });
}

export async function GET() {
  const root = projectRoot();
  const worklist = parseCsv("data/worklist.csv");
  const deid = SHOW_NAMES ? parseCsv("data/deid_map.csv") : [];
  const nameFor = new Map(
    deid.map((r) => [r.case_id, (r.source_archive ?? "").split("/").pop() ?? ""]),
  );

  const cases = worklist.map((r) => {
    const id = r.case_id;
    const annDir = path.join(root, "data", "annotations", id);
    const segPath = path.join(annDir, `${id}.seg.nrrd`);
    const hasSeg = fs.existsSync(segPath);
    let savedAt: string | null = null;
    if (hasSeg) {
      try {
        savedAt = fs.statSync(segPath).mtime.toISOString();
      } catch {
        savedAt = null;
      }
    }

    return {
      id,
      cls: r.class,                       // "bme" | "non_bme"
      assignedTo: r.assigned_to || "",
      isOverlap: r.is_overlap === "True",
      isotropic: r.isotropic === "True",
      slices: Number(r.n_slices || 0),
      thickness: Number(r.slice_thickness || 0),
      plane: r.plane || "",
      hasT1: r.has_t1 === "True",
      annotated: hasSeg,
      savedAt,
      // null unless the local flag is on
      sourceName: SHOW_NAMES ? nameFor.get(id) ?? null : null,
    };
  });

  return NextResponse.json({
    cases,
    showSourceNames: SHOW_NAMES,
    annotators: [...new Set(cases.map((c) => c.assignedTo).filter(Boolean))].sort(),
    counts: {
      total: cases.length,
      annotated: cases.filter((c) => c.annotated).length,
      bme: cases.filter((c) => c.cls === "bme").length,
    },
  });
}
