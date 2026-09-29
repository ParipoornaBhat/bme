import fs from "node:fs";
import path from "node:path";

/**
 * Review flags ("Not Sure", "Needs Expert Review", ...) kept as small JSON
 * files under data/, which is gitignored. 2D flags are keyed `${caseId}/${stem}`
 * in annotations2d_flags.json; 3D flags are keyed by case id in
 * annotations3d_flags.json.
 */

export type FlagRecord = {
  flagged: boolean;
  reason?: string;
  note?: string;
  flaggedAt?: string;
  /** 3D only: the view and slice the flag was raised on. */
  where?: string;
};

export type FlagFile = "annotations2d_flags.json" | "annotations3d_flags.json";

function flagsPath(file: FlagFile) {
  return path.join(path.resolve(process.cwd(), "..", ".."), "data", file);
}

export function readFlags(file: FlagFile): Record<string, FlagRecord> {
  try {
    const p = flagsPath(file);
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

/** Set or clear one flag and return what is now stored for it. */
export function writeFlag(
  file: FlagFile,
  key: string,
  flag: { flagged: boolean; reason?: string; note?: string; where?: string },
): FlagRecord | null {
  const flags = readFlags(file);
  if (flag.flagged === false) {
    delete flags[key];
  } else {
    flags[key] = {
      flagged: true,
      reason: flag.reason || "Not Sure",
      note: flag.note || "",
      flaggedAt: new Date().toISOString(),
      ...(flag.where ? { where: flag.where } : {}),
    };
  }
  const p = flagsPath(file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(flags, null, 2), "utf8");
  return flags[key] ?? null;
}
