import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";

/**
 * Who a suggestion job belongs to: a hash of the caller's sign-in session.
 * The middleware has already checked the caller is a team member; this only
 * keeps one person's jobs out of another's reach.
 */
export function suggestOwner(req: NextRequest): string | null {
  const c = req.cookies.getAll().find((x) => x.name.toLowerCase().endsWith("session_token"));
  return c?.value ? createHash("sha256").update(c.value).digest("hex") : null;
}
