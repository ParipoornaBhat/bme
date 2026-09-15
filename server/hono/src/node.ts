/**
 * Node entry point for the API with WebSocket collaboration support.
 */

import { serve } from "@hono/node-server";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { initCollaborationWSServer } from "./lib/collab-server.js";

// The monorepo keeps one .env at the repo root; Node does not read it on its own.
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "..", "..", "..", ".env") });

const { default: app } = await import("./index.js");

const port = Number(process.env.API_PORT ?? 4000);

const server = serve({ fetch: app.fetch, port }, (info) => {
  const url = `http://localhost:${info.port}`;
  console.log(`API ready on ${url}  (Node runtime with WebSockets)`);
  if (!process.env.DATABASE_URL) {
    console.warn("!! DATABASE_URL is not set — auth and database routes will warn.");
  }
});

// Attach WebSocket server for Realtime MRI Collaboration
const wss = new WebSocketServer({ server, path: "/ws/collaborate" });
initCollaborationWSServer(wss);
console.log("Realtime Collaboration WebSocket endpoint mounted at /ws/collaborate");
