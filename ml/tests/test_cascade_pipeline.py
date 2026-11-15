"""Unit tests for Option B: Two-Stage Cascaded 3D Pipeline.
Verifies Stage 1 GlobalContextNet3D and Stage 2 OrthoGateMedNeXt3D (2-channel).
"""

import sys
from pathlib import Path
import torch
import torch.nn.functional as F

ROOT_DIR = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT_DIR / "ml" / "scripts"))

from train_3d import build_model, GlobalContextNet3D, OrthoGateMedNeXt3D, dice_focal


def test_stage1_global_context_net():
    """Verify Stage 1 GlobalContextNet3D accepts downsampled volume and outputs 2 channels."""
    model = build_model("global_context_net", width=16, aniso=True)
    model.eval()

    # Input: 1-channel downsampled whole knee (B=1, C=1, D=32, H=128, W=128)
    x = torch.randn(1, 1, 32, 128, 128)
    with torch.no_grad():
        out, cnet = model(x, return_cnet=True)

    assert out.shape == (1, 2, 32, 128, 128), f"Expected (1, 2, 32, 128, 128), got {out.shape}"
    assert cnet.shape == (1,), f"Expected (1,), got {cnet.shape}"
    print("[PASS] test_stage1_global_context_net")


def test_stage2_orthogate_mednext_2ch():
    """Verify Stage 2 OrthoGateMedNeXt3D accepts 2-channel input (MRI + Stage 1 coarse heatmap)."""
    model = build_model("orthogate_mednext", width=16, in_channels=2, aniso=True)
    model.eval()

    # Input: 2 channels (B=1, C=2, D=16, H=128, W=128)
    x = torch.randn(1, 2, 16, 128, 128)
    with torch.no_grad():
        out = model(x)

    assert out.shape == (1, 2, 16, 128, 128), f"Expected (1, 2, 16, 128, 128), got {out.shape}"
    print("[PASS] test_stage2_orthogate_mednext_2ch")


def test_cascade_guidance_fusion():
    """Verify interpolation of Stage 1 guidance map into high-resolution patch coordinate space."""
    # Stage 1 coarse prediction (D=32, H=128, W=128)
    stage1_coarse = torch.sigmoid(torch.randn(1, 1, 32, 128, 128))

    # High-resolution patch extracted from full-res volume (D=16, H=128, W=128)
    high_res_mri = torch.randn(1, 1, 16, 128, 128)

    # Upsample Stage 1 guidance to match high-res spatial dimension
    guidance_resampled = F.interpolate(
        stage1_coarse,
        size=(16, 128, 128),
        mode="trilinear",
        align_corners=False,
    )

    # Stack: Channel 0 = MRI, Channel 1 = Stage 1 Edema Heatmap
    two_channel_input = torch.cat([high_res_mri, guidance_resampled], dim=1)
    assert two_channel_input.shape == (1, 2, 16, 128, 128)

    # Forward through Stage 2
    stage2_model = build_model("orthogate_mednext", width=16, in_channels=2, aniso=True)
    refined_logits = stage2_model(two_channel_input)
    assert refined_logits.shape == (1, 2, 16, 128, 128)

    # Ensure gradients flow through Stage 2
    loss = refined_logits.sum()
    loss.backward()
    assert stage2_model.stem[0].weight.grad is not None
    assert stage2_model.stem[0].weight.grad.shape[1] == 2
    print("[PASS] test_cascade_guidance_fusion")


if __name__ == "__main__":
    test_stage1_global_context_net()
    test_stage2_orthogate_mednext_2ch()
    test_cascade_guidance_fusion()
    print("\nALL CASCADE PIPELINE UNIT TESTS PASSED SUCCESSFULLY!")
