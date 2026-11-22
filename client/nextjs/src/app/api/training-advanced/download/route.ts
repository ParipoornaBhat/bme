import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import path from "node:path";
import { isReviewMode } from "~/lib/app-mode";
import { root } from "~/lib/training-advanced/server";

export const dynamic = "force-dynamic";

function run(args: string[], env: Record<string, string>) {
  return new Promise<{ ok: boolean; output: string }>((resolve) => {
    execFile(
      process.execPath,
      [path.join(root, "scripts", "h200-menu.js"), "get", ...args],
      { cwd: root, timeout: 600000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, BME_NO_PROMPT: "1", ...env } },
      (error, stdout, stderr) => {
        const output = `${stdout || ""}${stderr || ""}`.trim();
        resolve({ ok: !error, output });
      },
    );
  });
}

/**
 * POST { roll, folder, mode: "results" | "weights", plan?: boolean, confirmed?: boolean }
 * plan: returns the file count and size only (nothing is copied).
 * confirmed: copies it, after the dashboard's confirmation.
 */
export async function POST(req: NextRequest) {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }
  const body = await req.json().catch(() => ({}));
  const roll = String(body.roll || "");
  const folder = String(body.folder || "");
  const mode = body.mode === "weights" ? "weights" : "results";
  if (!/^\d{3}$/.test(roll)) return NextResponse.json({ error: "Unknown account" }, { status: 400 });
  if (!/^results[\w.-]*$/.test(folder)) return NextResponse.json({ error: "Unknown result folder" }, { status: 400 });

  if (body.plan) {
    const r = await run(["--as", roll, mode, folder], { BME_PLAN: "1" });
    const line = r.output.split(/\r?\n/).find((l) => l.startsWith("PLAN "));
    if (!line) return NextResponse.json({ error: r.output.split(/\r?\n/).pop() || "Could not check the result" }, { status: 502 });
    return NextResponse.json({ plan: JSON.parse(line.slice(5)) });
  }
  if (!body.confirmed) return NextResponse.json({ error: "Confirm first" }, { status: 400 });
  const r = await run(["--as", roll, mode, folder, "--yes"], { BME_PLAN: "0" });
  if (!r.ok) return NextResponse.json({ error: r.output.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ") || "Download failed" }, { status: 502 });
  return NextResponse.json({ ok: true, output: r.output.split(/\r?\n/).slice(-4).join("\n") });
}
