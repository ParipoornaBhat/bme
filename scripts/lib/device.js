import { spawnSync } from "node:child_process";
import { python } from "./accounts.js";

const PROBE = `
import json, torch
d = {"torch": torch.__version__, "kind": "cpu", "name": "CPU", "mib": 0}
if torch.cuda.is_available():
    p = torch.cuda.get_device_properties(0)
    d.update(kind="cuda", name=p.name, mib=int(p.total_memory / 2**20))
elif getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
    d.update(kind="mps", name="Apple GPU (MPS)")
elif torch.version.cuda is None:
    d["why"] = "this PyTorch is a CPU-only build"
else:
    d["why"] = "PyTorch cannot see an NVIDIA GPU"
print(json.dumps(d))
`;

/** What this PC can train on, as PyTorch sees it: cuda (NVIDIA), mps (Apple) or cpu. */
export function detectDevice() {
  const r = spawnSync(python, ["-c", PROBE], { encoding: "utf8", windowsHide: true });
  const line = (r.stdout || "").trim().split(/\r?\n/).pop() || "";
  try {
    return JSON.parse(line);
  } catch {
    return { kind: "cpu", name: "CPU", mib: 0, why: "PyTorch did not start in ml/.venv" };
  }
}

export function describeDevice(d) {
  if (d.kind === "cuda") return `${d.name}, ${(d.mib / 1024).toFixed(0)} GB (CUDA)`;
  if (d.kind === "mps") return d.name;
  return `CPU only (${d.why || "no GPU"})`;
}

/** Extra environment for the training process on this device. */
export function deviceEnv(d) {
  const env = {
    OMP_NUM_THREADS: "1",
    MKL_NUM_THREADS: "1",
    OPENBLAS_NUM_THREADS: "1",
    NUMEXPR_NUM_THREADS: "1",
  };
  if (d.kind === "cuda") env.PYTORCH_CUDA_ALLOC_CONF = "max_split_size_mb:128";
  if (d.kind === "mps") env.PYTORCH_ENABLE_MPS_FALLBACK = "1";
  return env;
}
