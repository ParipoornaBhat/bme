"""Unit tests for 3D Boundary Loss and Signed Distance Field (SDF) margin smoothing."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import torch

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
ML_SCRIPTS = REPO_ROOT / "ml" / "scripts"
if str(ML_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(ML_SCRIPTS))

from train_3d import compute_sdf_3d, dice_focal, pad_volume  # noqa: E402


def test_compute_sdf_3d_empty():
    """Empty masks (negative control scans) must return all +127 (pure penalty)."""
    empty = np.zeros((16, 32, 32), dtype=bool)
    sdf = compute_sdf_3d(empty)
    assert sdf.dtype == np.int8
    assert sdf.shape == (16, 32, 32)
    assert (sdf == 127).all(), "Empty mask SDF must be filled with 127 (+1.0 normalized)"
    print("[PASS] test_compute_sdf_3d_empty")


def test_compute_sdf_3d_geometry():
    """Inside voxels must be negative, outside positive, border near zero."""
    mask = np.zeros((16, 32, 32), dtype=bool)
    mask[4:12, 10:22, 10:22] = True  # 8x12x12 cuboid lesion

    sdf_q = compute_sdf_3d(mask, max_dist=10.0)
    sdf = sdf_q.astype(np.float32) / 127.0

    # Inside voxels: negative
    inside_vals = sdf[mask]
    assert (inside_vals <= 0.0).all(), "All inside voxels must have non-positive SDF"
    assert inside_vals.min() < -0.2, "Deep inside lesion must have significantly negative SDF"

    # Outside voxels: positive
    outside_vals = sdf[~mask]
    assert (outside_vals >= 0.0).all(), "All outside voxels must have non-negative SDF"
    assert outside_vals.max() > 0.5, "Far outside lesion must have significantly positive SDF"

    # Voxels right next to the boundary (1 voxel outside)
    border_outside = (sdf > 0.0) & (sdf <= 0.15)
    assert border_outside.any(), "Boundary transition zone must exist"
    print("[PASS] test_compute_sdf_3d_geometry")


def test_dice_focal_with_boundary_loss():
    """Loss computation with Boundary Loss + Soft Margin must be finite and backprop cleanly."""
    torch.manual_seed(42)
    logits = torch.randn(2, 16, 32, 32, requires_grad=True)

    # Ground truth: Channel 0 = Bone, Channel 1 = BME
    mask_bone = torch.zeros(16, 32, 32)
    mask_bone[2:14, 6:26, 6:26] = 1.0

    mask_bme = torch.zeros(16, 32, 32)
    mask_bme[4:10, 10:18, 10:18] = 1.0

    target = torch.stack([mask_bone, mask_bme], dim=0)
    valid = torch.ones(16, 32, 32)

    sdf_q = compute_sdf_3d(mask_bme.numpy().astype(bool), max_dist=10.0)
    sdf = torch.from_numpy(sdf_q.astype(np.float32) / 127.0)

    loss = dice_focal(
        logits=logits,
        target=target,
        valid=valid,
        bme_weight=2.5,
        tversky_alpha=0.3,
        tversky_beta=0.7,
        sdf=sdf,
        boundary_weight=0.25,
        soft_margin=True,
    )

    assert torch.isfinite(loss).all(), f"Loss must be finite, got {loss.item()}"
    loss.backward()
    assert logits.grad is not None
    assert torch.isfinite(logits.grad).all(), "Gradients must be strictly finite (no NaNs or Infs)"
    assert not torch.allclose(logits.grad, torch.zeros_like(logits.grad)), "Gradients must not be zero"
    print("[PASS] test_dice_focal_with_boundary_loss")


def test_boundary_loss_directional_penalty():
    """Predictions matching ground truth must have substantially lower loss than inverted predictions."""
    mask_bme = np.zeros((16, 32, 32), dtype=bool)
    mask_bme[4:12, 8:24, 8:24] = True

    sdf_q = compute_sdf_3d(mask_bme, max_dist=10.0)
    sdf = torch.from_numpy(sdf_q.astype(np.float32) / 127.0)

    # Perfect prediction: very high logits inside, very low outside
    logits_perfect = torch.full((2, 16, 32, 32), -10.0)
    logits_perfect[1, mask_bme] = 10.0
    logits_perfect[0, 2:14, 6:26, 6:26] = 10.0  # bone

    # Inverted prediction: very low inside, very high outside
    logits_inverted = torch.full((2, 16, 32, 32), 10.0)
    logits_inverted[1, mask_bme] = -10.0

    target = torch.stack([torch.ones(16, 32, 32), torch.from_numpy(mask_bme.astype(np.float32))], dim=0)
    valid = torch.ones(16, 32, 32)

    loss_perfect = dice_focal(logits_perfect, target, valid, sdf=sdf, boundary_weight=0.5, soft_margin=True)
    loss_inverted = dice_focal(logits_inverted, target, valid, sdf=sdf, boundary_weight=0.5, soft_margin=True)

    assert loss_perfect.item() < loss_inverted.item(), (
        f"Perfect loss ({loss_perfect.item():.4f}) must be strictly less than inverted ({loss_inverted.item():.4f})"
    )
    print(f"[PASS] test_boundary_loss_directional_penalty: perfect={loss_perfect.item():.4f} vs inverted={loss_inverted.item():.4f}")


def test_pad_volume_constant_values():
    """pad_volume with constant_values must correctly fill the border."""
    vol = np.zeros((10, 20, 20), dtype=np.int8)
    padded = pad_volume(vol, patch=(16, 32, 32), constant_values=127)
    assert padded.shape == (16, 32, 32)
    # The padded z-region (indices 10 to 15) must be 127
    assert (padded[10:, :, :] == 127).all()
    assert (padded[:, 20:, :] == 127).all()
    assert (padded[:, :, 20:] == 127).all()
    # The original region remains 0
    assert (padded[:10, :20, :20] == 0).all()
    print("[PASS] test_pad_volume_constant_values")


if __name__ == "__main__":
    test_compute_sdf_3d_empty()
    test_compute_sdf_3d_geometry()
    test_dice_focal_with_boundary_loss()
    test_boundary_loss_directional_penalty()
    test_pad_volume_constant_values()
    print("\nALL 5 BOUNDARY LOSS UNIT TESTS PASSED SUCCESSFULLY!")

