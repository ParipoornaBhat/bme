"""Run the 3D model on one NRRD scan.

    python ml/scripts/infer_3d.py <base> <scan.nrrd> <out.json>

Writes edema present or not, volume in mm3, lesion count, and axial, coronal,
and sagittal views with the predicted mask. Prediction is a sliding window on
the scan's own voxel grid. Edema outside the predicted bone is removed.
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import numpy as np
import SimpleITK as sitk
import torch
from scipy.ndimage import label as cc_label

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_3d import UNet3D, guard_device, normalize, predict_volume  # noqa: E402


def read_nrrd(path: Path):
    """ITK stores NRRD in LPS. The annotation viewer uses a RAS affine, same as NIfTI."""
    img = sitk.ReadImage(str(path))
    arr = np.transpose(sitk.GetArrayFromImage(img), (2, 1, 0))
    spacing = np.array([float(abs(s)) or 1.0 for s in img.GetSpacing()[:3]])
    direction = np.array(img.GetDirection(), dtype=float).reshape(3, 3)
    origin = np.array(img.GetOrigin(), dtype=float)
    lps_to_ras = np.diag([-1.0, -1.0, 1.0])
    aff = np.eye(4)
    aff[:3, :3] = (lps_to_ras @ direction) * spacing
    aff[:3, 3] = lps_to_ras @ origin
    return arr, spacing, aff


def pack(vol: np.ndarray) -> str:
    """i fastest, matching the annotation viewer index i + nx*(j + ny*k)."""
    return base64.b64encode(np.asfortranarray(vol).ravel(order="F").tobytes()).decode("ascii")


def main():
    if len(sys.argv) < 4:
        raise SystemExit(__doc__)
    base, src, dest = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    ckpts = sorted((base / "data" / "results3d").glob("fold_*.pt"))
    if not ckpts:
        raise SystemExit("No 3D weights yet. Train the 3D model on the Training page first.")

    raw, spacing, affine = read_nrrd(src)
    norm = normalize(raw)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    guard_device(device)
    model = UNet3D().to(device)
    masks = []
    for ck in ckpts:
        blob = torch.load(ck, map_location=device, weights_only=False)
        model.load_state_dict(blob["state"])
        masks.append(predict_volume(model, norm, device))
    # Majority across folds, then drop edema that is not inside bone in that vote.
    bone_votes = sum((m > 0).astype(np.uint8) for m in masks)
    bme_votes = sum((m == 2).astype(np.uint8) for m in masks)
    need = max(1, (len(masks) + 1) // 2)
    mask = np.zeros(raw.shape, dtype=np.uint8)
    mask[bone_votes >= need] = 1
    mask[(bme_votes >= need) & (mask == 1)] = 2

    vox = float(spacing[0] * spacing[1] * spacing[2])
    bme_n = int((mask == 2).sum())
    bone_n = int(((mask == 1) | (mask == 2)).sum())
    _, n_lesions = cc_label(mask == 2)
    if bme_n:
        cursor = [int(v) for v in np.argwhere(mask == 2).mean(axis=0)]
    else:
        cursor = [s // 2 for s in mask.shape]

    image_u8 = np.clip(np.rint(norm * 255), 0, 255).astype(np.uint8)
    out = {
        "ok": True,
        "device": device,
        "folds": len(ckpts),
        "edema_present": bme_n > 0,
        "volume_mm3": round(bme_n * vox, 1),
        "volume_cm3": round(bme_n * vox / 1000, 3),
        "bone_mm3": round(bone_n * vox, 1),
        "bone_voxels": bone_n,
        "bme_voxels": bme_n,
        "fraction_of_bone": round(bme_n / bone_n, 4) if bone_n else None,
        "lesion_count": int(n_lesions),
        "shape": [int(s) for s in raw.shape],
        "spacing_mm": [round(float(s), 4) for s in spacing],
        "affine": [[round(float(v), 6) for v in row] for row in affine],
        "cursor": cursor,
        "image": pack(image_u8),
        "mask": pack(mask),
        "note": (
            "The scan's NRRD direction is converted to the same RAS axes as the annotation viewer, "
            "so axial, coronal, and sagittal follow how the volume was acquired. "
            "Edema outside the predicted bone is removed. "
            "Volume is predicted edema voxels times the scan spacing."
        ),
    }
    dest.write_text(json.dumps(out), encoding="utf-8")
    print(
        f"edema={'yes' if out['edema_present'] else 'no'}  "
        f"volume={out['volume_mm3']} mm3  lesions={out['lesion_count']}",
        flush=True,
    )


if __name__ == "__main__":
    main()
