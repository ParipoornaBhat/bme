import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

let _db: any = null;

function getDb() {
  if (!_db) {
    let connectionString = process.env.DATABASE_URL || (globalThis as any).DATABASE_URL;

    if (!connectionString) {
      throw new Error("DATABASE_URL is not defined in env");
    }

    // Managed Postgres (Supabase, Neon, RDS) requires TLS, but their connection
    // strings do not always carry sslmode=require — Supabase's copy-paste URL
    // omits it entirely. Relying on the parameter alone means the pool is built
    // without SSL, every query fails, and the error surfaces with an empty
    // message, which reads like "the database is fine but returned nothing".
    // So: trust the parameter when present, otherwise infer from the host.
    let isRemote = false;
    try {
      const host = new URL(connectionString).hostname;
      isRemote = !["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host);
    } catch {
      isRemote = false;
    }

    const hasSSL =
      connectionString.includes("sslmode=require") ||
      connectionString.includes("ssl=true") ||
      isRemote;

    if (hasSSL) {
      connectionString = connectionString
        .replace(/([\?&])sslmode=[^&]*/, "$1")
        .replace(/([\?&])ssl=[^&]*/, "$1")
        .replace(/\?&/, "?")
        .replace(/\?$/, "");
    }

    // Cloudflare Workers cannot hold a socket open between requests, so the
    // template pinned maxUses:1 / idleTimeoutMillis:1 — every query gets a
    // brand new connection that is discarded immediately.
    //
    // That is survivable against a local Postgres. Against managed Postgres it
    // is not: each query then pays a fresh TCP + TLS handshake, and a
    // multi-query operation like a Better Auth sign-in has its connection torn
    // down underneath it, surfacing as "Connection terminated unexpectedly".
    //
    // So use the throwaway settings only where the runtime actually requires
    // them, and normal pooling everywhere else.
    const onWorkers =
      typeof navigator !== "undefined" &&
      (navigator as { userAgent?: string }).userAgent === "Cloudflare-Workers";

    const pool = new pg.Pool({
      connectionString,
      ssl: hasSSL || process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
      max: 10,
      ...(onWorkers
        ? { maxUses: 1, idleTimeoutMillis: 1, allowExitOnIdle: true }
        : { idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 }),
    });

    pool.on("error", (err) => {
      console.error("Database pool unexpected error:", err);
    });

    _db = drizzle(pool, { schema });
  }
  return _db;
}

// Lazy-initialized database client using a Proxy.
// This prevents top-level module evaluation crashes in Cloudflare Workers and makes sure env variables are populated first.
export const db = new Proxy({} as any, {
  get(target, prop, receiver) {
    const instance = getDb();
    const value = Reflect.get(instance, prop, receiver);
    if (typeof value === "function") {
      return value.bind(instance);
    }
    return value;
  },
  set(target, prop, value, receiver) {
    const instance = getDb();
    return Reflect.set(instance, prop, value, receiver);
  }
}) as unknown as ReturnType<typeof drizzle<typeof schema>>;

export type Database = ReturnType<typeof drizzle<typeof schema>>;
export * as schemaExports from "./schema/index.js";
