import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  hashPassword,
  verifyPassword,
  parseReviewAccounts,
} from "./review-accounts.js";

// Clean up temporary auto-generated drizzle file if present
const tempDrizzleFile = path.resolve(process.cwd(), "drizzle/0004_nebulous_pandemic.sql");
if (fs.existsSync(tempDrizzleFile)) {
  try {
    fs.unlinkSync(tempDrizzleFile);
  } catch {
    // Ignore cleanup errors
  }
}

test("hash/verify round trip", () => {
  const password = "mySecretPassword123!";
  const hash = hashPassword(password);

  assert.ok(hash.startsWith("scrypt$"), "Hash should start with scrypt$");
  const parts = hash.split("$");
  assert.equal(parts.length, 3, "Hash should contain prefix, salt, and key");
  assert.equal(parts[1].length, 32, "Salt should be 16 bytes (32 hex characters)");
  assert.equal(parts[2].length, 128, "Hash should be 64 bytes (128 hex characters)");

  assert.equal(verifyPassword(password, hash), true, "Password should verify successfully");
});

test("wrong password fails", () => {
  const password = "correctPassword";
  const hash = hashPassword(password);

  assert.equal(verifyPassword("wrongPassword", hash), false, "Wrong password must fail");
  assert.equal(verifyPassword("", hash), false, "Empty password must fail");
  assert.equal(verifyPassword(password, "invalid-hash-string"), false, "Malformed hash must fail");
  assert.equal(verifyPassword(password, "scrypt$invalid$hash"), false, "Non-hex hash parts must fail");
  assert.equal(verifyPassword(password, ""), false, "Empty hash must fail");
});

test("parse with and without role", () => {
  const envString = "Alice:pass1,Bob:pass2:team,Carol:pass3:reviewer";
  const parsed = parseReviewAccounts(envString);

  assert.deepEqual(parsed, [
    { username: "alice", displayName: "Alice", password: "pass1", role: "reviewer" },
    { username: "bob", displayName: "Bob", password: "pass2", role: "team" },
    { username: "carol", displayName: "Carol", password: "pass3", role: "reviewer" },
  ]);

  // Also test when passing an object like process.env
  const parsedObj = parseReviewAccounts({
    REVIEW_ACCOUNTS: "DrSmith:pass4,NurseJoy:pass5:team",
  });

  assert.deepEqual(parsedObj, [
    { username: "drsmith", displayName: "DrSmith", password: "pass4", role: "reviewer" },
    { username: "nursejoy", displayName: "NurseJoy", password: "pass5", role: "team" },
  ]);
});

test("bad entries refused", () => {
  // Empty or non-string inputs
  assert.deepEqual(parseReviewAccounts(""), []);
  assert.deepEqual(parseReviewAccounts("   "), []);
  assert.deepEqual(parseReviewAccounts(undefined), []);
  assert.deepEqual(parseReviewAccounts(null), []);

  // Malformed individual entries
  assert.deepEqual(parseReviewAccounts("no_colon"), []);
  assert.deepEqual(parseReviewAccounts(":nopassword"), []);
  assert.deepEqual(parseReviewAccounts("nouser:"), []);
  assert.deepEqual(parseReviewAccounts("alice:pass:invalidrole"), []);
  assert.deepEqual(parseReviewAccounts("alice:pass:team:extra_field"), []);
  assert.deepEqual(parseReviewAccounts("alice:pass:"), []);
  assert.deepEqual(parseReviewAccounts(`${"a".repeat(45)}:password`), []);

  // Mixed string with valid and invalid entries: bad entries are refused, valid entries returned
  const mixed = parseReviewAccounts(
    "Alice:pass1,bad_entry,Bob:pass2:team,:empty_user,Charlie:pass3:badrole,Eve:pass4",
  );
  assert.equal(mixed.length, 3);
  assert.deepEqual(mixed, [
    { username: "alice", displayName: "Alice", password: "pass1", role: "reviewer" },
    { username: "bob", displayName: "Bob", password: "pass2", role: "team" },
    { username: "eve", displayName: "Eve", password: "pass4", role: "reviewer" },
  ]);
});
