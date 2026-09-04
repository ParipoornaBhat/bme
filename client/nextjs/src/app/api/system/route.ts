import { NextResponse } from "next/server";
import os from "node:os";
import { execFileSync } from "node:child_process";

/**
 * Live CPU and GPU load for the Storage page.
 *
 * READ ONLY. nvidia-smi is called in query mode only: no clocks, no power
 * limits, no fan curves, no persistence mode. Nothing here changes a hardware
 * setting, and nothing here should ever be extended to.
 *
 * CPU temperature is deliberately absent rather than guessed. Windows exposes
 * it through MSAcpi_ThermalZoneTemperature, which consumer laptops almost never
 * implement — this machine returns "unsupported". Reporting the GPU's number as
 * if it were the CPU's, or showing a plausible constant, would be worse than
 * showing nothing.
 */

export const dynamic = "force-dynamic";

type Gpu = {
  name: string;
  utilPercent: number;
  memUsedMB: number;
  memTotalMB: number;
  tempC: number;
};

function gpu(): Gpu | null {
  try {
    const out = execFileSync(
      "nvidia-smi",
      [
        "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
        "--format=csv,noheader,nounits",
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    const line = out.trim().split(/\r?\n/)[0];
    if (!line) return null;
    const [name, util, used, total, temp] = line.split(",").map((s) => s.trim());
    return {
      name,
      utilPercent: Number(util),
      memUsedMB: Number(used),
      memTotalMB: Number(total),
      tempC: Number(temp),
    };
  } catch {
    // No NVIDIA GPU, or the driver tools are not installed. Not an error.
    return null;
  }
}

function cpuLoad(): number | null {
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average",
        ],
        { encoding: "utf8", timeout: 6000 },
      );
      const v = Number(out.trim());
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }
  // Elsewhere: 1-minute load average as a percentage of available cores.
  const cores = os.cpus().length || 1;
  return Math.min(100, Math.round((os.loadavg()[0] / cores) * 100));
}

export async function GET() {
  const g = gpu();
  return NextResponse.json({
    cpu: {
      loadPercent: cpuLoad(),
      cores: os.cpus().length,
      model: os.cpus()[0]?.model ?? null,
      // Not available through Windows' standard interface on this hardware.
      tempC: null,
      tempNote: "CPU temperature is not exposed by this machine's firmware.",
    },
    gpu: g,
    memory: {
      totalGB: Math.round((os.totalmem() / 1e9) * 10) / 10,
      freeGB: Math.round((os.freemem() / 1e9) * 10) / 10,
    },
    note: "Read-only telemetry. No hardware settings are changed.",
  });
}
