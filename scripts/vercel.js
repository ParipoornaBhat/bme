import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const isWin = process.platform === "win32";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vercelCli = "vercel@65.16.0";

const COMMAND_LIST = [
  "pnpm vercel:login",
  "pnpm vercel:link",
  "pnpm vercel:secrets",
  "pnpm vercel:deploy",
  "pnpm vercel:status",
];

function printCommandList() {
  for (const cmd of COMMAND_LIST) {
    console.log(cmd);
  }
}

function runVercel(args, options = {}) {
  return spawnSync("pnpm", ["dlx", vercelCli, ...args], {
    cwd: rootDir,
    shell: isWin,
    ...options,
  });
}

function isProjectLinked() {
  return fs.existsSync(path.join(rootDir, ".vercel", "project.json"));
}

function parseDotEnv(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) {
    return env;
  }
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let val = match[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[match[1]] = val;
  }
  return env;
}

function isLocalhost(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0"
    ) {
      return true;
    }
  } catch {
    // Non-standard URL fallback
  }
  return /(?:@|\/\/)(?:localhost|127\.0\.0\.1|::1|0\.0\.0\.0)(?::|\/|$)/i.test(
    urlStr
  );
}

function handleLogin() {
  const res = runVercel(["login"], {
    stdio: "inherit",
  });
  process.exit(res.status ?? 0);
}

function handleLink() {
  const res = runVercel(["link"], {
    stdio: "inherit",
  });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
  console.log("");
  console.log("Project settings to configure in Vercel if not detected:");
  console.log("  Root Directory: client/nextjs");
  console.log("  Include files outside the root directory: on");
  console.log("  Framework: Next.js");
  console.log("  Install Command: pnpm install --frozen-lockfile");
  console.log("  Build Command: pnpm build");
  console.log("  Node: 22 or later");
  process.exit(0);
}

function handleSecrets() {
  if (!isProjectLinked()) {
    console.error("Project is not linked. Run 'pnpm vercel:link' first.");
    process.exit(1);
  }

  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) {
    console.error(".env file not found in repo root.");
    process.exit(1);
  }

  const env = parseDotEnv(envPath);

  if (!env.DATABASE_URL) {
    console.error("Refusing to push secrets: DATABASE_URL is missing in .env.");
    process.exit(1);
  }

  if (isLocalhost(env.DATABASE_URL)) {
    console.error(
      "Refusing to push secrets: DATABASE_URL points to localhost. A remote database is required for production."
    );
    process.exit(1);
  }

  if (!env.REVIEW_SESSION_SECRET) {
    console.error(
      "Refusing to push secrets: REVIEW_SESSION_SECRET is missing in .env."
    );
    process.exit(1);
  }

  console.log("Skipping REVIEW_ACCOUNTS: accounts live in the database.");

  const varsToPush = [
    { name: "DATABASE_URL", value: env.DATABASE_URL },
    { name: "REVIEW_SESSION_SECRET", value: env.REVIEW_SESSION_SECRET },
    { name: "APP_MODE", value: "review" },
    { name: "NEXT_PUBLIC_APP_MODE", value: "review" },
  ];

  for (const { name, value } of varsToPush) {
    console.log(`Setting production secret: ${name}`);
    runVercel(["env", "rm", name, "production", "--yes"], {
      stdio: "ignore",
    });

    const res = runVercel(["env", "add", name, "production"], {
      input: `${value}\n`,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (res.status !== 0) {
      console.error(`Failed to set environment variable: ${name}`);
      if (res.stderr) {
        const sanitized = res.stderr
          .toString()
          .split(value)
          .join("[REDACTED]");
        console.error(sanitized.trim());
      }
      process.exit(res.status ?? 1);
    }
  }

  console.log("All production environment variables configured successfully.");
  process.exit(0);
}

function handleDeploy() {
  if (!isProjectLinked()) {
    console.error("Project is not linked. Run 'pnpm vercel:link' first.");
    process.exit(1);
  }

  const res = runVercel(["deploy", "--prod"], {
    stdio: "inherit",
  });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }

  console.log("");
  console.log("Deployment complete. Next steps:");
  console.log("  1. Open the deployment URL above.");
  console.log("  2. Sign in with a reviewer or team account.");
  process.exit(0);
}

function handleStatus() {
  if (!isProjectLinked()) {
    console.error("Project is not linked. Run 'pnpm vercel:link' first.");
    process.exit(1);
  }

  const res = runVercel(["ls"], {
    stdio: "inherit",
  });
  process.exit(res.status ?? 0);
}

const command = process.argv[2];

switch (command) {
  case "login":
    handleLogin();
    break;
  case "link":
    handleLink();
    break;
  case "secrets":
    handleSecrets();
    break;
  case "deploy":
    handleDeploy();
    break;
  case "status":
    handleStatus();
    break;
  default:
    printCommandList();
    process.exit(command ? 1 : 0);
}
