import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Whether this machine can actually train on the GPU.
 *
 * The answer needs Python: only torch knows if its own build has CUDA and if a
 * driver is present. Importing torch costs a second or two, which is far too
 * slow for an endpoint the training page polls every few seconds — so the
 * result is cached in module scope for the life of the server process.
 *
 * The cache is deliberately not time-based. This flips at most twice in the
 * project's life, both times because somebody reinstalled torch on purpose, and
 * a restart is a reasonable price for a correct answer. `refreshTorchDevice()`
 * clears it for the one caller that knows the environment just changed.
 */

export type TorchDevice = {
  cudaAvailable: boolean;
  deviceName: string | null;
  vramGB: number | null;
  torchVersion: string | null;
  cudaBuild: string | null;
  /** Why the GPU is unusable, in words a teammate can act on. */
  reason: string | null;
};

let cached: TorchDevice | null = null;

function projectRoot() {
  return path.resolve(process.cwd(), "..", "..");
}

function python() {
  const r = projectRoot();
  const local =
    process.platform === "win32"
      ? path.join(r, "ml", ".venv", "Scripts", "python.exe")
      : path.join(r, "ml", ".venv", "bin", "python");
  return fs.existsSync(local) ? local : process.platform === "win32" ? "python" : "python3";
}

const PROBE = `
import json
try:
    import torch
    ok = torch.cuda.is_available()
    out = {
        "cudaAvailable": ok,
        "torchVersion": torch.__version__,
        "cudaBuild": torch.version.cuda,
        "deviceName": None,
        "vramGB": None,
        "reason": None,
    }
    if ok:
        p = torch.cuda.get_device_properties(0)
        out["deviceName"] = p.name
        out["vramGB"] = round(p.total_memory / 1e9, 1)
    elif torch.version.cuda is None:
        out["reason"] = "PyTorch is a CPU-only build. Reinstall from a CUDA index to use the GPU."
    else:
        out["reason"] = "PyTorch has CUDA support but no GPU is visible - check the driver."
    print(json.dumps(out))
except Exception as e:
    print(json.dumps({"cudaAvailable": False, "torchVersion": None, "cudaBuild": None,
                      "deviceName": None, "vramGB": None,
                      "reason": f"could not query PyTorch: {e}"}))
`;

export function torchDevice(): TorchDevice {
  if (cached) return cached;
  try {
    const out = execFileSync(python(), ["-c", PROBE], {
      encoding: "utf8",
      timeout: 30_000,
    });
    cached = JSON.parse(out.trim().split(/\r?\n/).pop() ?? "{}") as TorchDevice;
  } catch (e) {
    cached = {
      cudaAvailable: false,
      deviceName: null,
      vramGB: null,
      torchVersion: null,
      cudaBuild: null,
      reason: `could not run the Python environment: ${(e as Error).message}`,
    };
  }
  return cached;
}

export function refreshTorchDevice() {
  cached = null;
}
