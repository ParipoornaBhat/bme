import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_SERVER,
} from "next/constants.js";

// Next only reads .env from its own directory, but this monorepo keeps a single
// .env at the repo root (written by scripts/dev-db.js). Without this the server
// routes come up with no DATABASE_URL and the annotation ledger silently
// reports "database unreachable" on a database that is running fine.
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "..", "..", ".env") });

function extractHostPatterns(rawString) {
  if (!rawString) return [];
  const entries = rawString.split(",").map((s) => s.trim()).filter(Boolean);
  const results = [];
  for (const entry of entries) {
    let host = entry;
    if (
      host.startsWith("http://") ||
      host.startsWith("https://") ||
      host.startsWith("ws://") ||
      host.startsWith("wss://")
    ) {
      try {
        const u = new URL(host);
        host = u.host;
      } catch {
        host = host.replace(/^[a-zA-Z]+:\/\//, "");
      }
    }
    // Remove any trailing path or slash
    host = host.split("/")[0].trim();
    if (host) {
      results.push(host);
      // If it's a domain name (not localhost / IP) and doesn't start with '*', add wildcard prefix
      if (
        !host.startsWith("*") &&
        !host.includes("localhost") &&
        !host.match(/^\d+\.\d+\.\d+\.\d+/) &&
        host.includes(".")
      ) {
        const domainParts = host.split(":");
        const hostnameOnly = domainParts[0];
        const portPart = domainParts[1] ? `:${domainParts[1]}` : "";
        const parts = hostnameOnly.split(".");
        if (parts.length >= 2) {
          const rootDomain = parts.slice(-2).join(".");
          results.push(`*.${rootDomain}${portPart}`);
        }
        results.push(`*.${hostnameOnly}${portPart}`);
      }
    }
  }
  return results;
}

// Build allowedDevOrigins from environment variables and defaults
const rawEnvOrigins = [
  process.env.ALLOWED_ORIGINS,
  process.env.ALLOWED_DEV_ORIGINS,
  process.env.NEXT_PUBLIC_APP_URL,
  process.env.CLIENT_URL,
  process.env.NEXT_PUBLIC_SERVER_URL,
]
  .filter(Boolean)
  .join(",");

const defaultOrigins = [
  "localhost:3000",
  "127.0.0.1:3000",
  "*.trycloudflare.com",
];

const allowedDevOrigins = Array.from(
  new Set([...defaultOrigins, ...extractHostPatterns(rawEnvOrigins)])
);

function launchTunnelIfNeeded(phase) {
  const isServerPhase =
    phase === PHASE_DEVELOPMENT_SERVER ||
    phase === PHASE_PRODUCTION_SERVER ||
    process.env.NODE_ENV !== "production";

  const isOptedOut =
    process.env.ENABLE_TUNNEL === "false" ||
    process.env.NO_TUNNEL === "true" ||
    process.env.NO_TUNNEL === "1";

  if (
    typeof process !== "undefined" &&
    isServerPhase &&
    !isOptedOut &&
    !process.env.__CLOUDFLARE_TUNNEL_ACTIVE
  ) {
    process.env.__CLOUDFLARE_TUNNEL_ACTIVE = "true";
    const token = process.env.CLOUDFLARE_TUNNEL_TOKEN;
    const args = token
      ? ["--yes", "cloudflared", "tunnel", "run", "--token", token]
      : ["--yes", "cloudflared", "tunnel", "--url", "http://localhost:3000"];

    const tunnelProcess = spawn("npx", args, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let printed = false;
    const onData = (chunk) => {
      const text = chunk.toString();
      if (
        token &&
        !printed &&
        (text.includes("Registered tunnel connection") ||
          text.includes("Connection registered"))
      ) {
        printed = true;
        const domain =
          process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
        console.log("\n" + "=".repeat(65));
        console.log("  🌐 CLOUDFLARE TUNNEL ONLINE & READY!");
        console.log(
          `  🔗 Live Web & Collab URL: \x1b[32m\x1b[1m${domain}\x1b[0m`
        );
        console.log("=".repeat(65) + "\n");
      } else if (!token && !printed) {
        const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match) {
          printed = true;
          console.log("\n" + "=".repeat(65));
          console.log("  🌐 TEMPORARY TUNNEL READY!");
          console.log(
            `  🔗 Live Web & Collab URL: \x1b[32m\x1b[1m${match[0]}\x1b[0m`
          );
          console.log("=".repeat(65) + "\n");
        }
      }
    };

    tunnelProcess.stdout?.on("data", onData);
    tunnelProcess.stderr?.on("data", onData);

    const cleanup = () => {
      try {
        tunnelProcess.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    process.on("exit", cleanup);
    process.on("SIGINT", () => {
      cleanup();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(0);
    });
  }
}

function attachWsProxyIfNeeded() {
  // Attach upgrade proxy for /ws/collaborate from Next.js (port 3000) to Hono (port 4000)
  if (typeof process !== "undefined" && !process.env.__WS_PROXY_ATTACHED) {
    process.env.__WS_PROXY_ATTACHED = "true";

    const originalEmit = http.Server.prototype.emit;
    http.Server.prototype.emit = function (event, ...args) {
      if (event === "upgrade") {
        const [req, socket, head] = args;
        if (req.url && req.url.startsWith("/ws/collaborate")) {
          const targetPort = Number(process.env.API_PORT || 4000);
          const proxySocket = net.connect(targetPort, "localhost", () => {
            let rawReq = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
              rawReq += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
            }
            rawReq += "\r\n";
            proxySocket.write(rawReq);
            if (head && head.length > 0) {
              proxySocket.write(head);
            }
            socket.pipe(proxySocket);
            proxySocket.pipe(socket);
          });

          proxySocket.on("error", (err) => {
            console.warn("[WS Proxy Error]", err.message);
            socket.destroy();
          });
          socket.on("error", () => {
            proxySocket.destroy();
          });
          return true;
        }
      }
      return originalEmit.call(this, event, ...args);
    };
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // @bme/db ships raw TypeScript and imports with explicit ".js" extensions
  // (NodeNext style). Next's bundler resolves those literally and fails with
  // "Can't resolve './client.js'". Transpiling the workspace package and
  // aliasing the extension makes the same source resolve here.
  transpilePackages: ["@bme/db"],
  allowedDevOrigins,

  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },

  async rewrites() {
    const apiHost =
      process.env.EXPO_PUBLIC_SERVER_URL ||
      process.env.NEXT_PUBLIC_SERVER_URL ||
      "http://localhost:4000";
    return [
      {
        source: "/api/auth/:path*",
        destination: `${apiHost}/api/auth/:path*`,
      },
      {
        source: "/api/users/:path*",
        destination: `${apiHost}/api/users/:path*`,
      },
      {
        source: "/api/roles/:path*",
        destination: `${apiHost}/api/roles/:path*`,
      },
      {
        source: "/api/collaborate/:path*",
        destination: `${apiHost}/api/collaborate/:path*`,
      },
      {
        source: "/ws/:path*",
        destination: `${apiHost}/ws/:path*`,
      },
    ];
  },
};

export default (phase) => {
  launchTunnelIfNeeded(phase);
  attachWsProxyIfNeeded();
  return nextConfig;
};
