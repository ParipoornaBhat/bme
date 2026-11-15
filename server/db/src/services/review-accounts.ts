import crypto from "node:crypto";

export type ReviewRole = "radiologist" | "reviewer" | "team" | "mentor";

export interface ReviewAccountConfig {
  username: string;
  displayName: string;
  password: string;
  role: ReviewRole;
}

const VALID_USERNAME_RE = /^[a-z0-9_-]{1,40}$/;

/**
 * Hash a password using scrypt with a 16-byte random salt.
 * Stored format: scrypt$<saltHex>$<hashHex>
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/**
 * Verify a plaintext password against a stored scrypt hash string in constant time.
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  if (!password || !storedHash || typeof password !== "string" || typeof storedHash !== "string") {
    return false;
  }
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }
  const [, saltHex, hashHex] = parts;
  if (!saltHex || !hashHex) {
    return false;
  }
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    if (salt.length !== 16 || expected.length !== 64) {
      return false;
    }
    const derived = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Parse REVIEW_ACCOUNTS from env (string or object with REVIEW_ACCOUNTS property).
 * Format: Name:Password:role (role optional, default "reviewer").
 * Refuses malformed entries, returning valid accounts only.
 */
export function parseReviewAccounts(
  env?: string | Record<string, string | undefined> | null,
): ReviewAccountConfig[] {
  const raw = typeof env === "object" && env !== null ? env.REVIEW_ACCOUNTS : env;
  if (!raw || typeof raw !== "string") {
    return [];
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  const results: ReviewAccountConfig[] = [];
  const entries = trimmed.split(",");

  for (const item of entries) {
    const entry = item.trim();
    if (!entry) continue;

    const parts = entry.split(":");
    if (parts.length < 2 || parts.length > 3) {
      continue;
    }

    const rawName = parts[0].trim();
    const password = parts[1];
    if (!rawName || !password) {
      continue;
    }

    if (rawName.length > 64) {
      continue;
    }

    let role: ReviewRole = "reviewer";
    if (parts.length === 3) {
      const roleStr = parts[2].trim().toLowerCase();
      if (
        roleStr === "radiologist" ||
        roleStr === "reviewer" ||
        roleStr === "team" ||
        roleStr === "mentor"
      ) {
        role = roleStr;
      } else {
        // Bad role, refuse entry
        continue;
      }
    }

    const username = rawName.toLowerCase();
    if (!VALID_USERNAME_RE.test(username)) {
      continue;
    }

    results.push({
      username,
      displayName: rawName,
      password,
      role,
    });
  }

  return results;
}
