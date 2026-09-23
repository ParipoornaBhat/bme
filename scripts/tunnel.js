import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const rootEnv = path.join(rootDir, ".env");

// Parse .env directly if present
let token = process.env.CLOUDFLARE_TUNNEL_TOKEN;
if (!token && fs.existsSync(rootEnv)) {
  const envContent = fs.readFileSync(rootEnv, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("CLOUDFLARE_TUNNEL_TOKEN=")) {
      token = trimmed.split("=")[1].replace(/^["']|["']$/g, "");
      break;
    }
  }
}

if (token) {
  console.log("\n🚀 Starting Cloudflare Named Tunnel...");
  console.log("📡 Connecting with persistent token...\n");
  startTunnel("npx", ["--yes", "cloudflared", "tunnel", "run", "--token", token]);
} else {
  // Target port (defaults to Next.js port 3000)
  const portArgIndex = process.argv.indexOf("--port");
  const port = portArgIndex !== -1 && process.argv[portArgIndex + 1]
    ? process.argv[portArgIndex + 1]
    : process.env.PORT || "3000";

  const targetUrl = `http://localhost:${port}`;

  console.log("\n🚀 Starting Cloudflare Tunnel for BME platform...");
  console.log(`📡 Forwarding to local app: ${targetUrl}\n`);
  startTunnel("npx", ["--yes", "cloudflared", "tunnel", "--url", targetUrl]);
}

function startTunnel(cmd, args) {
  const child = spawn(cmd, args, {
    shell: true,
    stdio: ["inherit", "pipe", "pipe"],
  });

  let printedUrl = false;

  const handleData = (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text);

    // Look for trycloudflare.com URL pattern if temporary
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match && !printedUrl) {
      printedUrl = true;
      const publicUrl = match[0];
      console.log("\n" + "=".repeat(65));
      console.log("  🌐 CLOUDFLARE TUNNEL IS LIVE!");
      console.log(`  🔗 Public URL : \x1b[32m\x1b[1m${publicUrl}\x1b[0m`);
      console.log(`  🩺 Radiologist Collab Link: \x1b[36m${publicUrl}/collaborate/<session_token>\x1b[0m`);
      console.log("=".repeat(65) + "\n");
    }
  };

  child.stdout.on("data", handleData);
  child.stderr.on("data", handleData);

  child.on("error", (err) => {
    console.error("❌ Failed to start Cloudflare tunnel:", err.message);
  });

  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.log(`\n⚠️ Tunnel process exited with code ${code}`);
    }
  });

  process.on("SIGINT", () => {
    child.kill("SIGINT");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    child.kill("SIGTERM");
    process.exit(0);
  });
}
