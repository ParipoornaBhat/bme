"""Grad-CAM heatmaps for the 2D classifier.

    python ml/scripts/gradcam.py "D:/Final yr Prj/bme"
    python ml/scripts/gradcam.py "D:/Final yr Prj/bme" --arch resnet18 --n 24

Writes data/results2d/gradcam/ — one overlay PNG per sampled slice, plus
gradcam.json for the UI.

WHAT GRAD-CAM ACTUALLY TELLS YOU
    It shows which pixels most influenced the classifier's score. That is worth
    having, and the synopsis promises explainability. But be careful how it is
    presented:

      * It is coarse. The heatmap comes from the last conv layer, which on
        ResNet-18 at 256px is 8x8 — every blob is ~32px wide. It cannot outline
        a lesion.
      * It explains the MODEL, not the disease. A confident-looking heatmap on
        a wrong prediction is still a wrong prediction.
      * With case-level labels, a slice with no edema is still labelled BME, so
        some heatmaps will highlight nothing meaningful. That is the label
        noise showing through, not a bug.

    The honest framing for the report: Grad-CAM is supporting evidence for the
    2D baseline. The real explanation is the 3D segmentation mask, which is
    voxel-precise and inherently faithful.
"""

from __future__ import annotations

import argparse
import base64
import csv
import io
import json
import random
import sys
from pathlib import Path

try:
    import numpy as np
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    import torchvision.transforms as T
    from PIL import Image
except ImportError as e:
    sys.exit(f"missing dependency: {e}")

sys.path.insert(0, str(Path(__file__).parent))
from train_2d import ARCHS, build_model, patient_folds, SEED  # noqa: E402


def last_conv(model: nn.Module) -> nn.Module:
    """Deepest Conv2d in the network — the layer Grad-CAM hooks."""
    conv = None
    for m in model.modules():
        if isinstance(m, nn.Conv2d):
            conv = m
    if conv is None:
        raise SystemExit("no Conv2d layer found")
    return conv


class GradCAM:
    def __init__(self, model: nn.Module, layer: nn.Module):
        self.model = model
        self.acts = None
        self.grads = None
        layer.register_forward_hook(self._fwd)
        layer.register_full_backward_hook(self._bwd)

    def _fwd(self, _m, _i, out):
        self.acts = out.detach()

    def _bwd(self, _m, _gi, gout):
        self.grads = gout[0].detach()

    def __call__(self, x: torch.Tensor, cls: int) -> np.ndarray:
        self.model.zero_grad()
        logits = self.model(x)
        logits[0, cls].backward()

        # Channel weights = spatially averaged gradients; standard Grad-CAM.
        w = self.grads.mean(dim=(2, 3), keepdim=True)
        cam = F.relu((w * self.acts).sum(dim=1, keepdim=True))
        cam = F.interpolate(cam, size=x.shape[-2:], mode="bilinear", align_corners=False)
        cam = cam[0, 0].cpu().numpy()
        lo, hi = float(cam.min()), float(cam.max())
        return (cam - lo) / (hi - lo) if hi > lo else np.zeros_like(cam)


def overlay(gray: Image.Image, cam: np.ndarray) -> Image.Image:
    """Heat colours over the slice. Only the hot half is tinted, so the anatomy
    stays readable underneath — a full-image tint hides what you are judging."""
    g = np.asarray(gray.convert("L")).astype(np.float32) / 255.0
    rgb = np.stack([g, g, g], axis=-1)

    # blue -> red ramp, alpha rising with activation
    heat = np.zeros_like(rgb)
    heat[..., 0] = np.clip(cam * 1.6 - 0.2, 0, 1)
    heat[..., 1] = np.clip(1.4 - np.abs(cam - 0.55) * 3.4, 0, 1) * 0.75
    heat[..., 2] = np.clip(1.1 - cam * 1.9, 0, 1)

    alpha = np.clip((cam - 0.45) * 1.7, 0, 1)[..., None] * 0.62
    out = rgb * (1 - alpha) + heat * alpha
    return Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--arch", default=None, choices=sorted(ARCHS))
    ap.add_argument("--n", type=int, default=24, help="slices to visualise")
    ap.add_argument("--epochs", type=int, default=3)
    args = ap.parse_args()

    base = Path(args.base)
    root = base / "data" / "slices2d"
    idx = root / "index.csv"
    if not idx.exists():
        sys.exit("no data/slices2d/index.csv — run ml/scripts/make_2d.py first")

    # Reuse the architecture of the last run unless told otherwise.
    arch = args.arch
    mpath = base / "data" / "results2d" / "metrics.json"
    if arch is None and mpath.exists():
        arch = json.loads(mpath.read_text(encoding="utf-8")).get("arch", "resnet18")
    arch = arch or "resnet18"

    random.seed(SEED)
    torch.manual_seed(SEED)
    rows = list(csv.DictReader(open(idx, encoding="utf-8")))
    by_case, folds = patient_folds(rows, 5)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"arch {arch} on {device}")

    # Hold out fold 0, train on the rest — the heatmaps must come from slices
    # the model has never seen, or they show memorisation rather than reasoning.
    val_cases = set(folds[0])
    tr = [r for r in rows if r["case_id"] not in val_cases]
    va = [r for r in rows if r["case_id"] in val_cases]
    print(f"train {len(tr)} slices / explain {len(va)} slices")

    tf_train = T.Compose([T.Grayscale(3), T.RandomHorizontalFlip(), T.ToTensor(),
                          T.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])
    tf_eval = T.Compose([T.Grayscale(3), T.ToTensor(),
                         T.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])

    model = build_model(arch).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=3e-4, weight_decay=1e-4)
    crit = nn.CrossEntropyLoss()

    model.train()
    for ep in range(args.epochs):
        random.shuffle(tr)
        tot = 0.0
        for i in range(0, len(tr), 32):
            batch = tr[i:i + 32]
            x = torch.stack([tf_train(Image.open(root / r["path"])) for r in batch]).to(device)
            y = torch.tensor([1 if r["class"] == "bme" else 0 for r in batch]).to(device)
            opt.zero_grad()
            loss = crit(model(x), y)
            loss.backward()
            opt.step()
            tot += loss.item() * len(batch)
        print(f"  epoch {ep + 1}/{args.epochs}  loss={tot / len(tr):.4f}")

    model.eval()
    cam = GradCAM(model, last_conv(model))

    out_dir = base / "data" / "results2d" / "gradcam"
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.png"):
        old.unlink()

    # Balanced sample so the page is not all one class.
    pos = [r for r in va if r["class"] == "bme"]
    neg = [r for r in va if r["class"] != "bme"]
    random.shuffle(pos); random.shuffle(neg)
    pick = pos[: args.n // 2] + neg[: args.n - args.n // 2]

    entries = []
    for r in pick:
        img = Image.open(root / r["path"])
        x = tf_eval(img).unsqueeze(0).to(device)
        with torch.no_grad():
            prob = torch.softmax(model(x), 1)[0, 1].item()
        heat = cam(x.requires_grad_(True), 1 if prob >= 0.5 else 0)

        vis = overlay(img, heat)
        name = Path(r["path"]).stem + ".png"
        vis.save(out_dir / name)

        buf = io.BytesIO()
        vis.resize((196, 196)).save(buf, format="JPEG", quality=72)
        entries.append({
            "case_id": r["case_id"],
            "true": 1 if r["class"] == "bme" else 0,
            "pred": int(prob >= 0.5),
            "prob": round(prob, 4),
            "file": name,
            "thumb": "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode(),
        })

    (base / "data" / "results2d" / "gradcam.json").write_text(
        json.dumps({
            "arch": arch, "device": device, "epochs": args.epochs,
            "held_out_fold": 0, "n": len(entries), "entries": entries,
            "caveat": ("Grad-CAM resolution is the last conv layer (~8x8 upsampled), so it "
                       "indicates region, not outline. It explains the model, not the disease. "
                       "The 3D segmentation mask is the faithful explanation."),
        }, indent=2), encoding="utf-8")

    right = sum(1 for e in entries if e["pred"] == e["true"])
    print(f"\n{len(entries)} heatmaps -> {out_dir}")
    print(f"  correct on this sample: {right}/{len(entries)}")
    print("  these are held-out slices — the model never trained on them")


if __name__ == "__main__":
    main()
