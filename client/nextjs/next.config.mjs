import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Next only reads .env from its own directory, but this monorepo keeps a single
// .env at the repo root (written by scripts/dev-db.js). Without this the server
// routes come up with no DATABASE_URL and the annotation ledger silently
// reports "database unreachable" on a database that is running fine.
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "..", "..", ".env") });

import http from "node:http";
import net from "node:net";

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

/** @type {import('next').NextConfig} */
const nextConfig = {
  // @bme/db ships raw TypeScript and imports with explicit ".js" extensions
  // (NodeNext style). Next's bundler resolves those literally and fails with
  // "Can't resolve './client.js'". Transpiling the workspace package and
  // aliasing the extension makes the same source resolve here.
  transpilePackages: ["@bme/db"],
  allowedDevOrigins: ["*.trycloudflare.com", "localhost:3000", "127.0.0.1:3000"],

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

export default nextConfig;
