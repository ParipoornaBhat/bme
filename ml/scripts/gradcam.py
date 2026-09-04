"""Grad-CAM heatmaps for the already-trained 2D classifier.

    python ml/scripts/gradcam.py "D:/Final yr Prj/bme"
    python ml/scripts/gradcam.py "D:/Final yr Prj/bme" --n 24

Reads the checkpoints written by train_2d.py and explains them. It does not
train. If there are no checkpoints it says so and stops — generating heatmaps
from a freshly initialised network would produce pictures that look like an
explanation and are not one.

Writes data/results2d/gradcam/ — one overlay PNG per sampled slice, plus
gradcam.json for the UI.

WHICH MODEL EXPLAINS WHICH SLICE
    Cross-validation leaves one model per fold. Each slice is explained by the
    fold model that did *not* train on that slice's case, so every heatmap here
    comes from a model seeing that patient for the first time. Fold membership
    is recomputed with the same seed and the same index.csv, so it matches the
    assignment used during training exactly.

WHAT GRAD-CAM ACTUALLY TELLS YOU
    It shows which pixels most influenced the classifier's score. That is worth
    having, and the synopsis promises explainability. But be careful how it is
    presented:

      * It is coarse. The heatmap comes from the last convolutional block,
        which on ResNet-18 at 256px is 8x8 — every blob is ~32px wide. It
        cannot outline a lesion.
      * It explains the MODEL, not the disease. A confident-looking heatmap on
        a wrong prediction is still a wrong prediction.
      * With case-level labels, a slice with no edema is still labelled BME, so
        some heatmaps will highlight nothing meaningful. That is the label
        noise showing through, not a bug.

    The honest framing for the report: Grad-CAM is supporting evidence for the
    2D classifier. The faithful explanation is the segmentation mask, which is
    pixel-precise.
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
    from PIL import Image
except ImportError as e:
    sys.exit(f"missing dependency: {e}")

sys.path.insert(0, str(Path(__file__).parent))
from train_2d import CLASSES, build_model, eval_transform, patient_folds, SEED  # noqa: E402

CKPT_HELP = (
    "No trained classifier found.\n\n"
    "  Train one first — the Training page, or:\n"
    "    python ml/scripts/train_2d.py <base> --arch resnet18 --folds 5 --epochs 8\n\n"
    "  That writes data/results2d/checkpoints/. Grad-CAM explains those weights;\n"
    "  it does not train its own."
)


def checkpoint_dir(base: Path) -> Path:
    return base / "data" / "results2d" / "checkpoints"


def load_manifest(base: Path) -> dict:
    p = checkpoint_dir(base) / "manifest.json"
    if not p.exists():
        sys.exit(CKPT_HELP)
    return json.loads(p.read_text(encoding="utf-8"))


def load_fold(base: Path, entry: dict, device: str) -> nn.Module:
    ck = torch.load(checkpoint_dir(base) / entry["file"], map_location=device, weights_only=False)
    model = build_model(ck["arch"])
    model.load_state_dict(ck["state_dict"])
    return model.to(device).eval()


def target_layer(model: nn.Module) -> nn.Module:
    """The module whose output Grad-CAM hooks.

    The last feature-producing block, not the last Conv2d inside it. On a
    ResNet the residual add and the ReLU happen after `conv2`, so hooking
    `conv2` explains a tensor the classifier never actually consumes.
    torchvision keeps that block as `layer4` (ResNet) or `features`
    (everything else in ARCHS); the deepest Conv2d is the fallback.
    """
    for name in ("layer4", "features"):
        mod = getattr(model, name, None)
        if isinstance(mod, nn.Module):
            return mod
    conv = None
    for m in model.modules():
        if isinstance(m, nn.Conv2d):
            conv = m
    if conv is None:
        raise SystemExit("no convolutional layer to hook")
    return conv


class GradCAM:
    """Standard Grad-CAM, hooking the activation tensor rather than the module.

    A tensor hook is used for the backward pass instead of
    register_full_backward_hook: the target is often a container (Sequential),
    where module-level backward hooks have documented caveats, while a hook on
    the output tensor itself is exact in every case.
    """

    def __init__(self, model: nn.Module, layer: nn.Module):
        self.model = model
        self.acts: torch.Tensor | None = None
        self.grads: torch.Tensor | None = None
        self.handle = layer.register_forward_hook(self._fwd)

    def _fwd(self, _m, _i, out):
        self.acts = out
        if out.requires_grad:
            out.register_hook(self._save_grad)

    def _save_grad(self, g):
        self.grads = g.detach()

    def close(self):
        self.handle.remove()

    def __call__(self, x: torch.Tensor, cls: int) -> tuple[np.ndarray, float]:
        """Returns (cam in [0,1] at input resolution, P(BME))."""
        self.model.zero_grad(set_to_none=True)
        logits = self.model(x)
        prob = float(torch.softmax(logits, 1)[0, 1].detach())
        logits[0, cls].backward()

        if self.acts is None or self.grads is None:
            raise RuntimeError("Grad-CAM hooks captured nothing — wrong target layer?")

        # Channel weights = spatially averaged gradients; standard Grad-CAM.
        w = self.grads.mean(dim=(2, 3), keepdim=True)
        cam = F.relu((w * self.acts.detach()).sum(dim=1, keepdim=True))
        cam = F.interpolate(cam, size=x.shape[-2:], mode="bilinear", align_corners=False)
        cam = cam[0, 0].cpu().numpy()
        lo, hi = float(cam.min()), float(cam.max())
        return ((cam - lo) / (hi - lo) if hi > lo else np.zeros_like(cam)), prob


def overlay(gray: Image.Image, cam: np.ndarray) -> Image.Image:
    """Heat colours over the slice. Only the hot half is tinted, so the anatomy
    stays readable underneath — a full-image tint hides what you are judging.

    The slice is resampled to the CAM's own resolution, which is the resolution
    the model saw. Painting a 256px heatmap over a 900px slice would imply a
    precision the model does not have.
    """
    g = np.asarray(gray.convert("L").resize((cam.shape[1], cam.shape[0]), Image.BILINEAR),
                   dtype=np.float32) / 255.0
    rgb = np.stack([g, g, g], axis=-1)

    # blue -> red ramp, alpha rising with activation
    heat = np.zeros_like(rgb)
    heat[..., 0] = np.clip(cam * 1.6 - 0.2, 0, 1)
    heat[..., 1] = np.clip(1.4 - np.abs(cam - 0.55) * 3.4, 0, 1) * 0.75
    heat[..., 2] = np.clip(1.1 - cam * 1.9, 0, 1)

    alpha = np.clip((cam - 0.45) * 1.7, 0, 1)[..., None] * 0.62
    out = rgb * (1 - alpha) + heat * alpha
    return Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8))


def explain(model: nn.Module, img: Image.Image, device: str,
            cls: int | None = None) -> tuple[np.ndarray, float]:
    """Grad-CAM for one PIL image, using the training preprocessing.

    `cls` defaults to the class the model actually predicted — explaining the
    decision that was made rather than the one we hoped for.
    """
    x = eval_transform()(img).unsqueeze(0).to(device).requires_grad_(True)
    cam = GradCAM(model, target_layer(model))
    try:
        with torch.no_grad():
            prob = float(torch.softmax(model(x), 1)[0, 1])
        heat, _ = cam(x, cls if cls is not None else int(prob >= 0.5))
    finally:
        cam.close()
    return heat, prob


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--n", type=int, default=24, help="slices to visualise")
    args = ap.parse_args()

    base = Path(args.base)
    root = base / "data" / "slices2d"
    idx = root / "index.csv"
    if not idx.exists():
        sys.exit("no data/slices2d/index.csv — run ml/scripts/build_2d.py first")

    man = load_manifest(base)
    fold_entries = man.get("folds") or []
    if not fold_entries:
        sys.exit(CKPT_HELP)

    random.seed(SEED)
    torch.manual_seed(SEED)
    rows = list(csv.DictReader(open(idx, encoding="utf-8")))
    _, folds = patient_folds(rows, len(fold_entries))

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"{man['arch']} on {device} — {len(fold_entries)} fold checkpoint(s), no training")

    # Pick the slices first, balanced across classes, then explain each with the
    # fold model that held its case out.
    n_folds = len(fold_entries)
    picks: list[tuple[int, dict]] = []
    for j, e in enumerate(fold_entries):
        # Spread the remainder so --n 24 over 5 folds gives 24, not 20.
        per_fold = max(1, args.n // n_folds + (1 if j < args.n % n_folds else 0))
        k = e["fold"]
        va_cases = set(folds[k])
        va = [r for r in rows if r["case_id"] in va_cases]
        pos = [r for r in va if r["class"] == "bme"]
        neg = [r for r in va if r["class"] != "bme"]
        random.shuffle(pos)
        random.shuffle(neg)
        half = per_fold // 2
        picks += [(k, r) for r in pos[:half] + neg[:per_fold - half]]

    out_dir = base / "data" / "results2d" / "gradcam"
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.png"):
        old.unlink()

    entries = []
    cache: dict[int, nn.Module] = {}
    for k, r in picks:
        if k not in cache:
            cache[k] = load_fold(base, next(e for e in fold_entries if e["fold"] == k), device)
        img = Image.open(root / r["path"])
        heat, prob = explain(cache[k], img, device)

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
            "fold": k,
            "file": name,
            "thumb": "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode(),
        })

    (base / "data" / "results2d" / "gradcam.json").write_text(
        json.dumps({
            "arch": man["arch"], "device": device,
            "trained_at": man.get("created_at"),
            "classes": CLASSES,
            "n_folds": len(fold_entries), "n": len(entries), "entries": entries,
            "caveat": ("Grad-CAM resolution is the last convolutional block "
                       "(~8x8 upsampled), so it indicates region, not outline. It "
                       "explains the model, not the disease. The segmentation mask is "
                       "the pixel-precise explanation."),
        }, indent=2), encoding="utf-8")

    right = sum(1 for e in entries if e["pred"] == e["true"])
    print(f"\n{len(entries)} heatmaps -> {out_dir}")
    print(f"  agrees with the case label on {right}/{len(entries)}")
    print("  every slice was held out from the model that explained it")


if __name__ == "__main__":
    main()
