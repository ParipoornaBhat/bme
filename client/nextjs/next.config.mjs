import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Next only reads .env from its own directory, but this monorepo keeps a single
// .env at the repo root (written by scripts/dev-db.js). Without this the server
// routes come up with no DATABASE_URL and the annotation ledger silently
// reports "database unreachable" on a database that is running fine.
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "..", "..", ".env") });

/** @type {import('next').NextConfig} */
const nextConfig = {
  // @bme/db ships raw TypeScript and imports with explicit ".js" extensions
  // (NodeNext style). Next's bundler resolves those literally and fails with
  // "Can't resolve './client.js'". Transpiling the workspace package and
  // aliasing the extension makes the same source resolve here.
  transpilePackages: ["@bme/db"],

  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
