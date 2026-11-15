import nodeCrypto from "node:crypto";
import { type NextRequest } from "next/server";
import { sql, eq, and } from "drizzle-orm";
import { pgTable, varchar, timestamp, uuid, text } from "drizzle-orm/pg-core";
import { db } from "@bme/db";
import * as BmeDb from "@bme/db";

// ---------------------------------------------------------------- schemas
// Fallback table definitions if not yet exported from @bme/db by R1.

export const reviewScan =
  (BmeDb as any).reviewScan ??
  pgTable("review_scan", {
    caseId: varchar("case_id", { length: 32 }).primaryKey(),
    driveFileId: varchar("drive_file_id", { length: 128 }).notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  });

export const reviewAccount =
  (BmeDb as any).reviewAccount ??
  pgTable("review_account", {
    id: uuid("id").defaultRandom().primaryKey(),
    username: varchar("username", { length: 40 }).notNull().unique(),
    displayName: varchar("display_name", { length: 64 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    role: varchar("role", { length: 16 }).notNull().default("reviewer"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  });

export const reviewEdit =
  (BmeDb as any).reviewEdit ??
  pgTable("review_edit", {
    id: uuid("id").defaultRandom().primaryKey(),
    caseId: varchar("case_id", { length: 32 }).notNull(),
    reviewer: varchar("reviewer", { length: 40 }).notNull(),
    baseAnnotator: varchar("base_annotator", { length: 64 }),
    labelsGzB64: text("labels_gz_b64").notNull(),
    note: text("note"),
    status: varchar("status", { length: 16 }).notNull().default("open"),
    kind: varchar("kind", { length: 16 }).notNull().default("review"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    appliedAt: timestamp("applied_at"),
  });

// ---------------------------------------------------------------- password
/**
 * Verifies scrypt password hash format: scrypt$<saltHex>$<hashHex>
 * Constant-time hash comparison.
 */
export function verifyPassword(password: string, hash: string): boolean {
  if (typeof (BmeDb as any).verifyPassword === "function") {
    return (BmeDb as any).verifyPassword(password, hash);
  }
  try {
    if (!hash || !hash.startsWith("scrypt$")) return false;
    const parts = hash.split("$");
    if (parts.length !== 3) return false;
    const [, saltHex, hashHex] = parts;
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const derived = nodeCrypto.scryptSync(password, salt, 64);
    if (derived.length !== expected.length) return false;
    return nodeCrypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- sanitization
export function safeAnnotator(name: string | null | undefined): string {
  if (!name) return "reviewer";
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  return safe || "reviewer";
}

// ---------------------------------------------------------------- cookies & web crypto
import { verifyReviewCookie, signReviewCookie } from "./review-cookie";
export { verifyReviewCookie, signReviewCookie };

// ---------------------------------------------------------------- session user
function extractCookie(req: Request | NextRequest, name: string): string | null {
  if ("cookies" in req && typeof (req as NextRequest).cookies?.get === "function") {
    const c = (req as NextRequest).cookies.get(name);
    if (c?.value) return c.value;
  }
  const header = req.headers.get("cookie");
  if (!header) return null;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export type ReviewRole = "radiologist" | "reviewer" | "team";

export interface ReviewUser {
  username: string;
  displayName: string;
  role: ReviewRole;
}

export async function getReviewUser(
  req: Request | NextRequest,
): Promise<ReviewUser | null> {
  const token = extractCookie(req, "bme_review");
  if (!token) return null;
  const verified = await verifyReviewCookie(token);
  if (!verified) return null;

  try {
    const [row] = await db
      .select()
      .from(reviewAccount)
      .where(sql`lower(${reviewAccount.username}) = lower(${verified.username})`)
      .limit(1);

    if (!row) return null;
    return {
      username: row.username,
      displayName: row.displayName,
      role: (row.role as ReviewRole) || "reviewer",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- rate limiter
const failedAttempts = new Map<string, number[]>();
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_FAILED_ATTEMPTS = 5;

export function isLoginRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = (failedAttempts.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  failedAttempts.set(ip, timestamps);
  return timestamps.length >= MAX_FAILED_ATTEMPTS;
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const timestamps = (failedAttempts.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  timestamps.push(now);
  failedAttempts.set(ip, timestamps);
}

export function clearLoginFailures(ip: string): void {
  failedAttempts.delete(ip);
}
