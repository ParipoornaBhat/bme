import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { decide, DecideInput } from "./annotation-sync-plan.js";

// Clean up temporary auto-generated drizzle file if present
const tempDrizzleFile = path.resolve(process.cwd(), "drizzle/0003_nosy_professor_monster.sql");
if (fs.existsSync(tempDrizzleFile)) {
  try {
    fs.unlinkSync(tempDrizzleFile);
  } catch {
    // Ignore cleanup errors
  }
}

test("rule 0 (tombstone): no local file returns none", () => {
  const remoteTombstoned = {
    sha: "sha-remote",
    hasBone: false,
    updatedAtMs: 2000,
    scanFingerprint: "fp-1",
    deletedAt: new Date(),
    deletedReason: "superseded",
    supersededBy: "DrSmith",
  };

  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local: null,
      remote: remoteTombstoned,
      state: null,
      me: "alice",
      localScanFingerprint: "fp-1",
    }),
    "none"
  );

  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local: null,
      remote: remoteTombstoned,
      state: { sha: "sha-some" },
      me: "alice",
      localScanFingerprint: "fp-1",
    }),
    "none"
  );
});

test("rule 0 (tombstone): local file exists and sha equals remote sha or state sha equals local sha returns retire-local", () => {
  const remoteTombstoned = {
    sha: "sha-remote",
    hasBone: true,
    updatedAtMs: 2000,
    scanFingerprint: "fp-1",
    deletedAt: "2026-11-15T00:00:00Z",
    deletedReason: "superseded",
    supersededBy: "radiologist1",
  };

  // 1. local sha equals remote sha (state null)
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local: { sha: "sha-remote", hasBone: true, mtimeMs: 1000 },
      remote: remoteTombstoned,
      state: null,
      me: "alice",
      localScanFingerprint: "fp-1",
    }),
    "retire-local"
  );

  // 2. local sha equals remote sha (state has different sha)
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local: { sha: "sha-remote", hasBone: true, mtimeMs: 1000 },
      remote: remoteTombstoned,
      state: { sha: "sha-old" },
      me: "alice",
      localScanFingerprint: "fp-1",
    }),
    "retire-local"
  );

  // 3. local sha differs from remote sha, but state sha equals local sha (local unchanged since last sync)
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local: { sha: "sha-local-synced", hasBone: true, mtimeMs: 1000 },
      remote: remoteTombstoned, // sha-remote
      state: { sha: "sha-local-synced" },
      me: "alice",
      localScanFingerprint: "fp-1",
    }),
    "retire-local"
  );
});

test("rule 0 (tombstone): local file exists, differs, and local changed after last sync returns conflict", () => {
  const remoteTombstoned = {
    sha: "sha-remote",
    hasBone: true,
    updatedAtMs: 2000,
    scanFingerprint: "fp-1",
    deletedAt: 1783491805077,
    deletedReason: "manual",
    supersededBy: null,
  };

  // 1. local differs from remote, and local changed after last sync (state.sha != local.sha)
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local: { sha: "sha-local-modified", hasBone: true, mtimeMs: 3000 },
      remote: remoteTombstoned,
      state: { sha: "sha-prev-sync" },
      me: "alice",
      localScanFingerprint: "fp-1",
    }),
    "conflict"
  );

  // 2. local differs from remote, and state is null (fresh work without sync state)
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local: { sha: "sha-local-new", hasBone: true, mtimeMs: 3000 },
      remote: remoteTombstoned,
      state: null,
      me: "alice",
      localScanFingerprint: "fp-1",
    }),
    "conflict"
  );
});

test("rule 1: both null returns none", () => {
  const input: DecideInput = {
    caseId: "BME-001",
    annotator: "alice",
    local: null,
    remote: null,
    state: null,
    me: "alice",
    localScanFingerprint: "scan-fp-1",
  };
  assert.equal(decide(input), "none");
});

test("rule 2: local and remote equal sha", () => {
  const baseInput: DecideInput = {
    caseId: "BME-001",
    annotator: "alice",
    local: { sha: "sha-100", hasBone: false, mtimeMs: 1000 },
    remote: { sha: "sha-100", hasBone: false, updatedAtMs: 1000, scanFingerprint: "fp-1" },
    state: null,
    me: "alice",
    localScanFingerprint: "fp-1",
  };

  // without state -> record
  assert.equal(decide(baseInput), "record");

  // with state having a different sha -> record
  assert.equal(
    decide({
      ...baseInput,
      state: { sha: "sha-old" },
    }),
    "record"
  );

  // with state already matching sha -> none
  assert.equal(
    decide({
      ...baseInput,
      state: { sha: "sha-100" },
    }),
    "none"
  );
});

test("rule 3: remote only", () => {
  const remote = {
    sha: "sha-remote",
    hasBone: false,
    updatedAtMs: 2000,
    scanFingerprint: "fp-case-1",
  };

  // 3a: state exists and state.sha == remote.sha -> none (local delete respected)
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local: null,
      remote,
      state: { sha: "sha-remote" },
      me: "alice",
      localScanFingerprint: "fp-case-1",
    }),
    "none"
  );

  // 3b: localScanFingerprint null -> skip-no-scan
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local: null,
      remote,
      state: null,
      me: "alice",
      localScanFingerprint: null,
    }),
    "skip-no-scan"
  );

  // 3c: remote.scanFingerprint set and != localScanFingerprint -> skip-scan-mismatch
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local: null,
      remote: { ...remote, scanFingerprint: "fp-case-1" },
      state: null,
      me: "alice",
      localScanFingerprint: "fp-case-OTHER",
    }),
    "skip-scan-mismatch"
  );

  // 3d: else pull-new (fingerprints match)
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local: null,
      remote: { ...remote, scanFingerprint: "fp-case-1" },
      state: null,
      me: "alice",
      localScanFingerprint: "fp-case-1",
    }),
    "pull-new"
  );

  // 3e: else pull-new (remote has no scan fingerprint)
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local: null,
      remote: { ...remote, scanFingerprint: null },
      state: null,
      me: "alice",
      localScanFingerprint: "fp-case-1",
    }),
    "pull-new"
  );
});

test("rule 4: local only returns push-insert", () => {
  const local = { sha: "sha-local", hasBone: false, mtimeMs: 1500 };

  // any annotator
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local,
      remote: null,
      state: null,
      me: "alice",
      localScanFingerprint: "fp-1",
    }),
    "push-insert"
  );

  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "bob",
      local,
      remote: null,
      state: null,
      me: "alice",
      localScanFingerprint: null,
    }),
    "push-insert"
  );

  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "_main",
      local,
      remote: null,
      state: null,
      me: null,
      localScanFingerprint: null,
    }),
    "push-insert"
  );
});

test("rule 5: both exist and differ", () => {
  const local = { sha: "sha-local", hasBone: false, mtimeMs: 2000 };
  const remote = {
    sha: "sha-remote",
    hasBone: false,
    updatedAtMs: 2500,
    scanFingerprint: "fp-scan-remote",
  };

  // 5a: remote.scanFingerprint set, localScanFingerprint set, and they differ -> skip-scan-mismatch
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local,
      remote: { ...remote, scanFingerprint: "fp-1" },
      state: { sha: "sha-local" },
      me: "alice",
      localScanFingerprint: "fp-2",
    }),
    "skip-scan-mismatch"
  );

  // 5b: state.sha == local.sha -> pull-update
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local,
      remote: { ...remote, scanFingerprint: "fp-1" },
      state: { sha: "sha-local" },
      me: "alice",
      localScanFingerprint: "fp-1",
    }),
    "pull-update"
  );

  // 5c: state.sha == remote.sha (remote unchanged, local changed)
  // annotator == me -> push-update
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local,
      remote: { ...remote, scanFingerprint: "fp-1" },
      state: { sha: "sha-remote" },
      me: "alice",
      localScanFingerprint: "fp-1",
    }),
    "push-update"
  );

  // annotator == _main -> push-update
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "_main",
      local,
      remote: { ...remote, scanFingerprint: "fp-1" },
      state: { sha: "sha-remote" },
      me: "bob",
      localScanFingerprint: "fp-1",
    }),
    "push-update"
  );

  // annotator != me and != _main -> skip-not-owner
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "charlie",
      local,
      remote: { ...remote, scanFingerprint: "fp-1" },
      state: { sha: "sha-remote" },
      me: "bob",
      localScanFingerprint: "fp-1",
    }),
    "skip-not-owner"
  );

  // 5d: no state, local has no bone and remote has bone -> pull-update
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local: { ...local, hasBone: false },
      remote: { ...remote, hasBone: true, scanFingerprint: "fp-1" },
      state: null,
      me: "alice",
      localScanFingerprint: "fp-1",
    }),
    "pull-update"
  );

  // 5e: no state, remote has no bone and local has bone
  // annotator == me -> push-update
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local: { ...local, hasBone: true },
      remote: { ...remote, hasBone: false, scanFingerprint: "fp-1" },
      state: null,
      me: "alice",
      localScanFingerprint: "fp-1",
    }),
    "push-update"
  );

  // annotator == _main -> push-update
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "_main",
      local: { ...local, hasBone: true },
      remote: { ...remote, hasBone: false, scanFingerprint: "fp-1" },
      state: null,
      me: "charlie",
      localScanFingerprint: "fp-1",
    }),
    "push-update"
  );

  // annotator not me and not _main -> conflict
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local: { ...local, hasBone: true },
      remote: { ...remote, hasBone: false, scanFingerprint: "fp-1" },
      state: null,
      me: "bob",
      localScanFingerprint: "fp-1",
    }),
    "conflict"
  );

  // 5f: anything else -> conflict
  // no state, both have bone
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local: { ...local, hasBone: true },
      remote: { ...remote, hasBone: true, scanFingerprint: "fp-1" },
      state: null,
      me: "alice",
      localScanFingerprint: "fp-1",
    }),
    "conflict"
  );

  // no state, neither has bone
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local: { ...local, hasBone: false },
      remote: { ...remote, hasBone: false, scanFingerprint: "fp-1" },
      state: null,
      me: "alice",
      localScanFingerprint: "fp-1",
    }),
    "conflict"
  );

  // state exists, but both local and remote changed since last sync
  assert.equal(
    decide({
      caseId: "BME-001",
      annotator: "alice",
      local,
      remote: { ...remote, scanFingerprint: "fp-1" },
      state: { sha: "sha-ancient" },
      me: "alice",
      localScanFingerprint: "fp-1",
    }),
    "conflict"
  );
});
