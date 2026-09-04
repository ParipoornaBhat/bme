"""Run the trained 2D models on one image and print a JSON result.

    python ml/scripts/infer_2d.py <base> --image path/to/slice.png
    python ml/scripts/infer_2d.py <base> --image slice.png --json out.json

This is what the Model Results page calls. It loads weights; it never trains.
Three things happen to the image, in this order:

    1. preprocessing   identical to training, imported from the training
                       modules rather than reimplemented
    2. detection       the classifier -> YES / NO for "does this look like BME"
    3. localisation    Grad-CAM (where the classifier looked) and, separately,
                       the segmentation U-Net (where the edema is)

WHY EVERY MODEL IS AN ENSEMBLE OF FOLDS
    Training is 5-fold cross-validation, so it leaves five sets of weights and
    no single "final" model. Probabilities are averaged across all folds. The
    per-fold numbers are reported too: if the folds disagree wildly on an image,
    the mean is not worth much, and hiding that would be the dishonest choice.

WHAT IS NOT CLAIMED
    Areas are in pixels of the 256x256 model canvas, not mm^2. The curated 2D
    exports carry no pixel spacing, so a physical area cannot be computed and is
    not invented here.

    Detection and segmentation are separate models trained on different labels
    (case-level classes vs hand-painted masks). They can disagree. Both answers
    are shown rather than one being quietly overridden by the other.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import sys
from pathlib import Path

try:
    import numpy as np
    import torch
    from PIL import Image
except ImportError as e:
    sys.exit(json.dumps({"ok": False, "error": f"missing dependency: {e}"}))

sys.path.insert(0, str(Path(__file__).parent))
from gradcam import explain, load_fold, overlay as cam_overlay  # noqa: E402
from train_2d import CLASSES, IMG_SIZE, NORM_MEAN, NORM_STD  # noqa: E402
from train_2d_seg import CHANNELS, IMG_SIZE as SEG_SIZE, UNet  # noqa: E402

THRESHOLD = 0.5
BONE_RGB = (56, 189, 248)    # sky   — predicted bone / marrow
LESION_RGB = (244, 63, 94)   # rose  — predicted edema


def dataurl(im: Image.Image, fmt: str = "PNG") -> str:
    buf = io.BytesIO()
    im.save(buf, format=fmt, quality=90)
    return f"data:image/{fmt.lower()};base64," + base64.b64encode(buf.getvalue()).decode()


def read_manifest(p: Path) -> dict | None:
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


# ------------------------------------------------------------------ detection
def detect(base: Path, img: Image.Image, device: str) -> dict:
    man = read_manifest(base / "data" / "results2d" / "checkpoints" / "manifest.json")
    if not man or not man.get("folds"):
        return {
            "available": False,
            "reason": ("No trained classifier. Train one on the Training page, or run "
                       "ml/scripts/train_2d.py — it writes data/results2d/checkpoints/."),
        }

    per_fold, cams = [], []
    for e in man["folds"]:
        model = load_fold(base, e, device)
        heat, prob = explain(model, img, device)
        cams.append(heat)
        per_fold.append({"fold": e["fold"], "prob": round(prob, 4), "val_auc": e.get("val_auc")})

    probs = np.array([f["prob"] for f in per_fold], dtype=np.float64)
    mean = float(probs.mean())

    # The ensemble's explanation is the mean of the folds' explanations. Each
    # CAM is already normalised to [0,1], so averaging keeps regions all folds
    # agree on and fades the ones only one fold reacted to.
    cam = np.mean(np.stack(cams), axis=0)
    lo, hi = float(cam.min()), float(cam.max())
    cam = (cam - lo) / (hi - lo) if hi > lo else np.zeros_like(cam)

    return {
        "available": True,
        "label": "YES" if mean >= THRESHOLD else "NO",
        "answer": "BME present" if mean >= THRESHOLD else "No BME detected",
        "probability": round(mean, 4),
        "threshold": THRESHOLD,
        "classes": CLASSES,
        "positive_class": CLASSES[1],
        "per_fold": per_fold,
        "spread": {"min": round(float(probs.min()), 4), "max": round(float(probs.max()), 4),
                   "std": round(float(probs.std()), 4)},
        "arch": man.get("arch"),
        "n_folds": len(per_fold),
        "trained_at": man.get("created_at"),
        "case_level_auc": man.get("case_level_auc"),
        "gradcam": dataurl(cam_overlay(img, cam)),
    }


# --------------------------------------------------------------- segmentation
def segment(base: Path, img: Image.Image, device: str) -> dict:
    man = read_manifest(base / "data" / "results2dseg" / "checkpoints" / "manifest.json")
    if not man or not man.get("folds"):
        return {
            "available": False,
            "reason": ("No trained segmentation model. It needs painted masks: annotate "
                       "slices on /annotate -> 2D slices, then run segmentation training. "
                       "Nothing is drawn here without one — a mask that is not a model "
                       "output is not a result."),
        }

    ckpt_dir = base / "data" / "results2dseg" / "checkpoints"
    x = torch.from_numpy(
        np.asarray(img.convert("L").resize((SEG_SIZE, SEG_SIZE), Image.BILINEAR),
                   dtype=np.float32) / 255.0
    )[None, None].to(device)

    acc = None
    for e in man["folds"]:
        ck = torch.load(ckpt_dir / e["file"], map_location=device, weights_only=False)
        model = UNet().to(device)
        model.load_state_dict(ck["state_dict"])
        model.eval()
        with torch.no_grad():
            p = torch.sigmoid(model(x))
        acc = p if acc is None else acc + p
    prob = (acc / len(man["folds"]))[0].cpu().numpy()

    bone = prob[0] >= THRESHOLD
    # Edema outside bone is not edema. This is the same constraint the training
    # script applies when it scores a fold, so the number shown here and the
    # reported Dice measure the same thing.
    lesion = (prob[1] >= THRESHOLD) & bone

    n_bone = int(bone.sum())
    n_lesion = int(lesion.sum())

    base_gray = np.asarray(img.convert("L").resize((SEG_SIZE, SEG_SIZE), Image.BILINEAR),
                           dtype=np.float32) / 255.0
    rgb = np.stack([base_gray] * 3, axis=-1)
    for m, colour, alpha in ((bone, BONE_RGB, 0.28), (lesion, LESION_RGB, 0.55)):
        if m.any():
            tint = np.array(colour, dtype=np.float32) / 255.0
            rgb[m] = rgb[m] * (1 - alpha) + tint * alpha

    flat = np.zeros((SEG_SIZE, SEG_SIZE, 3), dtype=np.uint8)
    flat[bone] = BONE_RGB
    flat[lesion] = LESION_RGB

    indexed = np.zeros((SEG_SIZE, SEG_SIZE), dtype=np.uint8)
    indexed[bone] = 1
    indexed[lesion] = 2

    return {
        "available": True,
        "lesion_present": bool(n_lesion > 0),
        "bone_pixels": n_bone,
        "lesion_pixels": n_lesion,
        "lesion_fraction_of_bone": round(n_lesion / n_bone, 5) if n_bone else None,
        "lesion_fraction_of_image": round(n_lesion / (SEG_SIZE * SEG_SIZE), 5),
        "mean_lesion_confidence": (round(float(prob[1][lesion].mean()), 4) if n_lesion else None),
        "channels": CHANNELS,
        "threshold": THRESHOLD,
        "canvas": SEG_SIZE,
        "n_folds": len(man["folds"]),
        "trained_at": man.get("created_at"),
        "summary": man.get("summary"),
        "mask": dataurl(Image.fromarray(flat)),
        "indexed_mask": dataurl(Image.fromarray(indexed, mode="L")),
        "overlay": dataurl(Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8))),
        "note": ("Areas are pixels on the 256x256 model canvas. These 2D exports carry no "
                 "pixel spacing, so mm^2 cannot be computed and is not guessed."),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--image", required=True)
    ap.add_argument("--json", default=None, help="also write the result here")
    args = ap.parse_args()

    base = Path(args.base)
    src = Path(args.image)
    if not src.exists():
        print(json.dumps({"ok": False, "error": f"no such image: {src}"}))
        sys.exit(1)

    try:
        img = Image.open(src)
        img.load()
    except Exception as e:  # unreadable upload, not our bug to hide
        print(json.dumps({"ok": False, "error": f"cannot read image: {e}"}))
        sys.exit(1)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    det = detect(base, img, device)

    result = {
        "ok": True,
        "device": device,
        "input": {
            "filename": src.name,
            "width": img.width,
            "height": img.height,
            "mode": img.mode,
            "preview": dataurl(img.convert("RGB"), "JPEG"),
        },
        "preprocessing": {
            "steps": [
                "grayscale, replicated to 3 channels",
                f"resize to {IMG_SIZE}x{IMG_SIZE} (bilinear)",
                "scale to [0,1]",
                "normalise with the ImageNet statistics the backbone was pretrained on",
            ],
            "img_size": IMG_SIZE,
            "norm_mean": NORM_MEAN,
            "norm_std": NORM_STD,
            "note": ("Imported from train_2d.py, not reimplemented — inference and training "
                     "cannot drift apart."),
        },
        "detection": det,
        "segmentation": segment(base, img, device),
    }

    out = json.dumps(result)
    if args.json:
        Path(args.json).write_text(out, encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
