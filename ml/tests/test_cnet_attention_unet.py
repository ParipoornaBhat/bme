"""Unit tests for C-Net + 3D Attention U-Net architecture and gating."""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
ML_SCRIPTS = REPO_ROOT / "ml" / "scripts"
if str(ML_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(ML_SCRIPTS))

from train_3d import (  # noqa: E402
    AttentionGate3D,
    CNetHead3D,
    CNetDualUNet3D,
    CNetAttentionUNet3D,
    MedNeXtBlock3D,
    MedNeXt3D,
    UNet3D,
    build_model,
    predict_volume,
)
from verify_and_import_weights import verify_pt_file  # noqa: E402


def test_attention_gate_3d():
    ag = AttentionGate3D(f_g=32, f_l=32, f_int=16)
    g = torch.randn(2, 32, 8, 8, 4)
    x = torch.randn(2, 32, 8, 8, 4)
    out = ag(g, x)
    assert out.shape == x.shape, f"Expected {x.shape}, got {out.shape}"
    # Verify values are scaled
    assert not torch.allclose(out, x), "Attention gate should modulate features"
    print("[PASS] test_attention_gate_3d")


def test_cnet_head_3d():
    head = CNetHead3D(in_channels=64)
    x = torch.randn(2, 64, 6, 6, 3)
    logit = head(x)
    assert logit.shape == (2,), f"Expected shape (2,), got {logit.shape}"
    print("[PASS] test_cnet_head_3d")


def test_cnet_dual_unet_forward():
    model = CNetDualUNet3D(base_channels=8, double_conv=False)
    assert model.model_arch == "cnet_dual_unet"
    assert hasattr(model, "cnet")
    # Verify attention gates are removed (clean direct skip connections)
    assert not hasattr(model, "ag1")
    assert not hasattr(model, "ag2")

    # Input patch (batch=1, channel=1, depth=16, height=32, width=32)
    # UNet has 2 downsampling steps (stride 4 total), so dimensions divisible by 4
    x = torch.randn(1, 1, 16, 32, 32)

    # Standard forward: dual channel output (channel 0: bone, channel 1: edema)
    seg = model(x)
    assert seg.shape == (1, 2, 16, 32, 32), f"Expected (1, 2, 16, 32, 32), got {seg.shape}"

    # Forward with C-Net logit
    seg, cnet_logit = model(x, return_cnet=True)
    assert seg.shape == (1, 2, 16, 32, 32)
    assert cnet_logit.shape == (1,), f"Expected (1,), got {cnet_logit.shape}"
    print("[PASS] test_cnet_dual_unet_forward")


def test_build_model_factory():
    m_std = build_model("unet3d", base_channels=16, double_conv=False)
    assert isinstance(m_std, UNet3D)
    assert not hasattr(m_std, "cnet")

    m_cnet = build_model("cnet_dual_unet", base_channels=16, double_conv=True)
    assert isinstance(m_cnet, CNetDualUNet3D)
    assert hasattr(m_cnet, "cnet")
    assert m_cnet.double_conv is True

    # Check alias compatibility
    m_cnet_alias = build_model("cnet_attention_unet", base_channels=16, double_conv=True)
    assert isinstance(m_cnet_alias, CNetDualUNet3D)
    print("[PASS] test_build_model_factory")


def test_cnet_presence_gating_in_predict_volume():
    """Verify C-Net presence gatekeeper zeroes out edema votes when presence prob < threshold."""
    # Create a dummy model with a mock cnet that outputs very negative logit (< threshold)
    class MockCNetModel(nn.Module):
        def __init__(self, cnet_prob: float):
            super().__init__()
            self.cnet = nn.Identity()
            self.cnet_prob = cnet_prob

        def forward(self, x, return_cnet=False):
            b, c, d, h, w = x.shape
            # Predict bone everywhere, edema everywhere
            seg = torch.zeros(b, 2, d, h, w)
            seg[:, 0] = 5.0  # bone sigmoid >= 0.5
            seg[:, 1] = 5.0  # edema sigmoid >= 0.5
            if return_cnet:
                # Invert sigmoid to get logit
                logit_val = np.log(self.cnet_prob / (1.0 - self.cnet_prob + 1e-7))
                cnet_logit = torch.tensor([logit_val] * b)
                return seg, cnet_logit
            return seg

    mock_scan = np.random.uniform(0, 1, size=(96, 96, 12)).astype(np.float32)

    # 1. Low C-Net probability (e.g. 0.05, below threshold 0.40) -> edema must be completely 0
    neg_model = MockCNetModel(cnet_prob=0.05)
    pred_neg = predict_volume(neg_model, mock_scan, device="cpu", min_bme_voxels=0, cnet_threshold=0.40)
    assert (pred_neg == 2).sum() == 0, f"Expected 0 edema voxels when gated out, got {(pred_neg == 2).sum()}"
    assert (pred_neg == 1).sum() > 0, "Bone should remain predicted even when edema is gated out"

    # 2. High C-Net probability (e.g. 0.85, above threshold 0.40) -> edema preserved
    pos_model = MockCNetModel(cnet_prob=0.85)
    pred_pos = predict_volume(pos_model, mock_scan, device="cpu", min_bme_voxels=0, cnet_threshold=0.40)
    assert (pred_pos == 2).sum() > 0, "Edema should be predicted when C-Net score >= threshold"
    print("[PASS] test_cnet_presence_gating_in_predict_volume")


def test_verify_pt_file_supports_both_architectures():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)

        # 1. Standard UNet3D checkpoint
        m_unet = UNet3D(base_channels=16, double_conv=False)
        p_unet = tmp / "fold_0.pt"
        torch.save({"state": m_unet.state_dict(), "model_arch": "unet3d"}, str(p_unet))
        ok, msg = verify_pt_file(p_unet)
        assert ok, f"UNet3D verification failed: {msg}"

        # 2. C-Net Attention UNet checkpoint
        m_cnet = CNetAttentionUNet3D(base_channels=16, double_conv=False)
        p_cnet = tmp / "fold_1.pt"
        torch.save({"state": m_cnet.state_dict(), "model_arch": "cnet_attention_unet"}, str(p_cnet))
        ok_c, msg_c = verify_pt_file(p_cnet)
        assert ok_c, f"CNetAttentionUNet verification failed: {msg_c}"

        # 3. MedNeXt 3D checkpoint
        m_med = MedNeXt3D(base_channels=16)
        p_med = tmp / "fold_2.pt"
        torch.save({"state": m_med.state_dict(), "model_arch": "mednext"}, str(p_med))
        ok_m, msg_m = verify_pt_file(p_med)
        assert ok_m, f"MedNeXt3D verification failed: {msg_m}"
        print("[PASS] test_verify_pt_file_supports_all_architectures")


def test_mednext_block_and_forward():
    # 1. MedNeXt Block
    blk = MedNeXtBlock3D(in_channels=16, out_channels=16, exp_ratio=2, kernel_size=5)
    x = torch.randn(2, 16, 8, 8, 8)
    out = blk(x)
    assert out.shape == x.shape, f"Expected {x.shape}, got {out.shape}"
    assert not torch.allclose(out, x), "MedNeXt block should transform input"

    # 2. Full MedNeXt3D Forward
    model = MedNeXt3D(base_channels=8, exp_ratio=2, kernel_size=5)
    inp = torch.randn(1, 1, 16, 32, 32)
    seg = model(inp)
    assert seg.shape == (1, 2, 16, 32, 32), f"Expected (1, 2, 16, 32, 32), got {seg.shape}"

    # Factory build test
    m_built = build_model("mednext", base_channels=8)
    assert isinstance(m_built, MedNeXt3D)
    assert m_built.model_arch == "mednext"
    print("[PASS] test_mednext_block_and_forward")


def main():
    test_attention_gate_3d()
    test_cnet_head_3d()
    test_cnet_dual_unet_forward()
    test_build_model_factory()
    test_cnet_presence_gating_in_predict_volume()
    test_verify_pt_file_supports_both_architectures()
    test_mednext_block_and_forward()
    print("\nALL ARCHITECTURE TESTS (MEDNEXT + C-NET + UNET3D) PASSED!")


if __name__ == "__main__":
    main()
