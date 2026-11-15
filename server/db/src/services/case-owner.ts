/**
 * Case ownership ranges agreed by the team.
 * Mirrors `TEAM` in `ml/scripts/team_annotations.py` and `NBME_TEAM` in `ml/scripts/export_nbme.py`.
 *
 * Case number n (from BME-n and NBME-n):
 *   1-15:  Paripoorna
 *   16-30: Elvin
 *   31-45: Aditi
 *   46-61: Reegan (NBME has only up to 60)
 *
 * Every other case (e.g. BME-062 to BME-085) has no default team owner (returns null).
 */

export interface CaseOwnerRange {
  readonly name: string;
  readonly start: number;
  readonly endBme: number;
  readonly endNbme: number;
}

export const CASE_OWNER_RANGES: readonly CaseOwnerRange[] = [
  { name: "Paripoorna", start: 1, endBme: 15, endNbme: 15 },
  { name: "Elvin", start: 16, endBme: 30, endNbme: 30 },
  { name: "Aditi", start: 31, endBme: 45, endNbme: 45 },
  { name: "Reegan", start: 46, endBme: 61, endNbme: 60 },
] as const;

const CASE_ID_RE = /^(BME|NBME)-(\d+)$/i;

/**
 * Returns the default team owner name for a case ID based on agreed ranges,
 * or null if unassigned / out of range.
 */
export function ownerForCase(caseId: string): string | null {
  if (!caseId || typeof caseId !== "string") {
    return null;
  }
  const match = caseId.trim().match(CASE_ID_RE);
  if (!match) {
    return null;
  }

  const prefix = match[1].toUpperCase();
  const n = parseInt(match[2], 10);
  if (Number.isNaN(n) || n < 1) {
    return null;
  }

  const isNbme = prefix === "NBME";

  // BME-062 to 085: from the one personal annotation copy each case has (2026-11-15)
  if (!isNbme) {
    if (n === 62) {
      return "Elvin";
    }
    if (n >= 63 && n <= 64) {
      return "Aditi";
    }
    if (n >= 65 && n <= 75) {
      return "Paripoorna";
    }
    if (n >= 76 && n <= 81) {
      return "Aditi";
    }
    if (n >= 82 && n <= 85) {
      return "Reegan";
    }
  }

  for (const range of CASE_OWNER_RANGES) {
    const end = isNbme ? range.endNbme : range.endBme;
    if (n >= range.start && n <= end) {
      return range.name;
    }
  }

  return null;
}
