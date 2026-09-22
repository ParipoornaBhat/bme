import { spawn } from "node:child_process";

// Target port (defaults to Next.js port 3000)
const portArgIndex = process.argv.indexOf("--port");
const port = portArgIndex !== -1 && process.argv[portArgIndex + 1]
  ? process.argv[portArgIndex + 1]
  : process.env.PORT || "3000";

const targetUrl = `http://localhost:${port}`;

console.log("\n🚀 Starting Cloudflare Tunnel for BME platform...");
console.log(`📡 Forwarding to local app: ${targetUrl}\n`);

function startTunnel(cmd, args) {
  const child = spawn(cmd, args, {
    shell: true,
    stdio: ["inherit", "pipe", "pipe"],
  });

  let printedUrl = false;

  const handleData = (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text);

    // Look for trycloudflare.com URL pattern
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
    if (cmd === "cloudflared") {
      console.log("⚠️ 'cloudflared' command not found directly, falling back to 'npx cloudflared'...");
      startTunnel("npx", ["--yes", "cloudflared", "tunnel", "--url", targetUrl]);
    } else {
      console.error("❌ Failed to start Cloudflare tunnel:", err.message);
    }
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

startTunnel("cloudflared", ["tunnel", "--url", targetUrl]);
