/**
 * Bring up the local dev Postgres and wire .env to it.
 *
 *   node scripts/dev-db.js up      start container, wait healthy, patch .env
 *   node scripts/dev-db.js down    stop (data survives)
 *   node scripts/dev-db.js status
 *
 * Nothing here deletes data. `down` stops the container and the bme_pgdata
 * volume survives, so starting again restores the same database. If you ever
 * genuinely need a clean slate, that is a deliberate manual step:
 *   docker compose -f docker-compose.dev.yml down -v
 *
 * You should never have to edit .env by hand for local development. This writes
 * DATABASE_URL and generates BETTER_AUTH_SECRET if it is still the placeholder.
 * Real secrets (Google OAuth, SMTP) are left alone — those are yours to fill in
 * only if you need those features.
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env");
const composeFile = path.join(root, "docker-compose.dev.yml");

// Credentials must match docker-compose.dev.yml. The port does not — it is
// chosen at runtime, because 5432 is often taken by a native Postgres and 5433
// may be taken on someone else's machine.
const DB = { user: "bme", password: "bme_dev_password", db: "bme", host: "localhost" };
const PORT_FROM = 5433;
const PORT_TO = 5460;
const urlFor = (port) =>
  `postgresql://${DB.user}:${DB.password}@${DB.host}:${port}/${DB.db}`;

const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", x: "\x1b[0m" };
const say = (m) => console.log(m);
const die = (m) => { console.error(`${c.r}${m}${c.x}`); process.exit(1); };

function dockerReady() {
  const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function compose(args, opts = {}) {
  return spawnSync("docker", ["compose", "-f", composeFile, ...args], {
    stdio: opts.quiet ? "pipe" : "inherit",
    encoding: "utf8",
    cwd: root,
  });
}

/** Set or replace a KEY="value" line, preserving everything else. */
function patchEnv(updates) {
  let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const changed = [];
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}="${value}"`;
    const re = new RegExp(`^${key}\\s*=.*$`, "m");
    if (re.test(text)) {
      const current = text.match(re)[0];
      if (current !== line) {
        text = text.replace(re, line);
        changed.push(key);
      }
    } else {
      text += (text.endsWith("\n") || text === "" ? "" : "\n") + line + "\n";
      changed.push(key);
    }
  }
  if (changed.length) fs.writeFileSync(envPath, text, "utf8");
  return changed;
}

function currentEnv(key) {
  if (!fs.existsSync(envPath)) return null;
  const m = fs.readFileSync(envPath, "utf8").match(new RegExp(`^${key}\\s*=\\s*"?([^"\n]*)"?`, "m"));
  return m ? m[1] : null;
}

function waitHealthy(timeoutMs = 90_000) {
  const started = Date.now();
  process.stdout.write("  waiting for postgres ");
  while (Date.now() - started < timeoutMs) {
    const r = spawnSync("docker", ["inspect", "-f", "{{.State.Health.Status}}", "bme-db"], { encoding: "utf8" });
    const status = (r.stdout || "").trim();
    if (status === "healthy") { say(` ${c.g}healthy${c.x}`); return true; }
    if (status === "unhealthy") { say(` ${c.r}unhealthy${c.x}`); return false; }
    process.stdout.write(".");
    execSync(process.platform === "win32" ? "ping -n 2 127.0.0.1 > NUL" : "sleep 1", { stdio: "ignore" });
  }
  say(` ${c.r}timed out${c.x}`);
  return false;
}

/** True if nothing is listening on this host port. */
function isFree(port) {
  const r = spawnSync(process.execPath, [
    "-e",
    `const n=require('net');const s=n.createServer();` +
    `s.once('error',()=>process.exit(1));` +
    `s.once('listening',()=>s.close(()=>process.exit(0)));` +
    `s.listen(${port},'0.0.0.0');`,
  ]);
  return r.status === 0;
}

/** Host port an already-created bme-db container is published on, if any. */
function existingPort() {
  const r = spawnSync("docker", ["port", "bme-db", "5432/tcp"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const m = (r.stdout || "").match(/:(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}

/** Reuse the container's port if it exists, else the remembered one, else probe. */
function choosePort() {
  const already = existingPort();
  if (already) return { port: already, reason: "existing container" };

  const remembered = Number(currentEnv("BME_DB_PORT"));
  if (remembered && isFree(remembered)) return { port: remembered, reason: "remembered" };

  for (let p = PORT_FROM; p <= PORT_TO; p++) {
    if (isFree(p)) {
      return { port: p, reason: p === PORT_FROM ? "default" : `${PORT_FROM} was busy` };
    }
  }
  die(`No free port between ${PORT_FROM} and ${PORT_TO}. Free one up and retry.`);
}

const cmd = process.argv[2] || "up";

if (cmd === "down") {
  if (!dockerReady()) die("Docker is not running.");
  compose(["down"]);
  say(`${c.g}stopped${c.x}  (data kept in the bme_pgdata volume)`);
  process.exit(0);
}

if (cmd === "status") {
  if (!dockerReady()) die("Docker is not running.");
  compose(["ps"]);
  say(`\n  DATABASE_URL in .env: ${c.d}${currentEnv("DATABASE_URL") || "(unset)"}${c.x}`);
  process.exit(0);
}

// ---- up ----
say("\nbringing up the local dev database\n");

if (!dockerReady()) {
  die(
    "Docker is installed but the daemon is not running.\n" +
    "  Start Docker Desktop, wait for the whale icon to go steady, then rerun:\n" +
    "    pnpm db:up"
  );
}

const { port, reason } = choosePort();
const DATABASE_URL = urlFor(port);
say(`  port ${c.y}${port}${c.x} ${c.d}(${reason})${c.x}`);

// docker compose reads BME_DB_PORT for the host-side port mapping.
process.env.BME_DB_PORT = String(port);

const r = compose(["up", "-d"]);
if (r.status !== 0) die("docker compose up failed — see the output above.");

if (!waitHealthy()) {
  die('Postgres did not become healthy. Inspect with:\n  docker compose -f docker-compose.dev.yml logs db');
}

const updates = { DATABASE_URL, BME_DB_PORT: String(port) };
const secret = currentEnv("BETTER_AUTH_SECRET");
if (!secret || secret.includes("some_super_secret") || secret.length < 32) {
  updates.BETTER_AUTH_SECRET = crypto.randomBytes(32).toString("hex");
}
const changed = patchEnv(updates);

say("");
say(`  ${c.g}database ready${c.x}`);
say(`  ${c.d}${DATABASE_URL}${c.x}`);
if (changed.length) say(`  ${c.d}.env updated: ${changed.join(", ")}${c.x}`);
else say(`  ${c.d}.env already correct${c.x}`);
say("");
say("  next:");
say(`    ${c.y}pnpm migrate:deploy${c.x}   apply the schema`);
say(`    ${c.y}pnpm db:seed${c.x}          seed roles + the 4 team accounts`);
say(`    ${c.y}pnpm dev${c.x}              start everything`);
say("");
