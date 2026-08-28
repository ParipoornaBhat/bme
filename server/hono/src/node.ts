/**
 * Node entry point for the API.
 *
 * WHY THIS EXISTS
 * The app is deployed to Cloudflare Workers, and `wrangler dev` runs it locally
 * in workerd to match. That works against a local Postgres, but not against
 * managed Postgres: workerd cannot hold a direct TLS connection to Supabase's
 * db.*.supabase.co:5432 endpoint, and every query dies with
 * "Connection terminated unexpectedly" — including Better Auth's sign-in.
 *
 * The same code, same connection string and same queries work fine under Node,
 * which is what this file provides. Local development therefore runs on Node;
 * `pnpm --filter server dev:workers` still runs workerd when you need to verify
 * Workers-specific behaviour before deploying.
 *
 * Nothing about the app changes — `app` is the identical Hono instance that
 * wrangler serves.
 */

import { serve } from "@hono/node-server";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The monorepo keeps one .env at the repo root; Node does not read it on its own.
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "..", "..", "..", ".env") });

const { default: app } = await import("./index.js");

const port = Number(process.env.API_PORT ?? 4000);

serve({ fetch: app.fetch, port }, (info) => {
  const url = `http://localhost:${info.port}`;
  console.log(`API ready on ${url}  (Node runtime)`);
  if (!process.env.DATABASE_URL) {
    console.warn("!! DATABASE_URL is not set — auth and every database route will fail.");
  }
});
