"""Shared post-processing for 3D Bone and Edema segmentation.

Features:
1. Probability averaging (soft consensus) vs discrete patch voting (baseline).
2. Bone gating: edema predicted outside bone is strictly suppressed.
3. Minimum component size filter in mm^3 using real scan voxel spacing.
4. Returns clean uint8 labelmap (0=background, 1=bone, 2=edema) and removal diagnostics.
5. In-plane bone mask dilation and oracle bone override for diagnostic evaluation.
"""

from __future__ import annotations

import numpy as np
import scipy.ndimage as ndi
from scipy.ndimage import label as cc_label


def in_plane_dilate(mask: np.ndarray, voxels: int = 1) -> np.ndarray:
    """Dilate mask in-plane (axes 0 and 1) leaving through-plane (axis 2) untouched."""
    if voxels <= 0:
        return mask
    struct = np.zeros((3, 3, 3), dtype=bool)
    struct[:, :, 1] = ndi.generate_binary_structure(2, 1)
    return ndi.binary_dilation(mask, structure=struct, iterations=voxels)


def postprocess_volume(
    *,
    prob_bone: np.ndarray | None = None,
    prob_bme: np.ndarray | None = None,
    votes_bone: np.ndarray | None = None,
    votes_bme: np.ndarray | None = None,
    hits: np.ndarray | None = None,
    threshold: float = 0.5,
    bone_threshold: float = 0.5,
    min_size_mm3: float = 0.0,
    spacing: tuple[float, float, float] = (1.0, 1.0, 1.0),
    prob_average: bool = True,
    bone_mask_override: np.ndarray | None = None,
    dilate_bone_in_plane: int = 0,
    skip_bone_gating: bool = False,
) -> tuple[np.ndarray, int]:
    """Post-process predicted bone and edema volumes.

    Args:
        prob_bone: Continuous average probability volume for bone (0.0 to 1.0).
        prob_bme: Continuous average probability volume for edema (0.0 to 1.0).
        votes_bone: Accumulated patch votes for bone.
        votes_bme: Accumulated patch votes for edema.
        hits: Number of patch overlapping hits per voxel.
        threshold: Decision threshold for edema (default 0.5).
        bone_threshold: Decision threshold for bone (default 0.5).
        min_size_mm3: Minimum connected component volume in mm^3 to keep.
        spacing: Voxel spacing (dx, dy, dz) in mm.
        prob_average: If True, uses continuous probability volumes;
                      if False, uses binarize-then-vote baseline consensus.
        bone_mask_override: Optional explicit boolean bone mask (for oracle diagnostics).
        dilate_bone_in_plane: Number of voxels to dilate the bone mask in-plane.
        skip_bone_gating: If True, edema is not masked by bone.

    Returns:
        (out_labelmap, lesions_removed_count)
        out_labelmap is uint8 with 0=bg, 1=bone, 2=edema.
    """
    if prob_average:
        if prob_bone is None or prob_bme is None:
            raise ValueError("prob_bone and prob_bme must be provided when prob_average=True")
        shape = prob_bone.shape
        if bone_mask_override is not None:
            bone_mask = bone_mask_override.astype(bool)
        else:
            bone_mask = prob_bone >= bone_threshold
        if dilate_bone_in_plane > 0:
            bone_mask = in_plane_dilate(bone_mask, dilate_bone_in_plane)

        if skip_bone_gating:
            bme_mask = prob_bme >= threshold
        else:
            bme_mask = (prob_bme >= threshold) & bone_mask
    else:
        if votes_bone is None or votes_bme is None or hits is None:
            raise ValueError("votes_bone, votes_bme, and hits must be provided when prob_average=False")
        shape = votes_bone.shape
        h = np.maximum(hits, 1)
        if bone_mask_override is not None:
            bone_mask = bone_mask_override.astype(bool)
        else:
            bone_mask = (votes_bone * 2) >= h
        if dilate_bone_in_plane > 0:
            bone_mask = in_plane_dilate(bone_mask, dilate_bone_in_plane)

        if skip_bone_gating:
            bme_mask = (votes_bme * 2) >= h
        else:
            bme_mask = ((votes_bme * 2) >= h) & bone_mask

    # Size filtering in mm^3
    n_removed = 0
    if min_size_mm3 > 0.0 and bme_mask.any():
        voxel_vol = float(abs(spacing[0] * spacing[1] * spacing[2]))
        labeled_bme, num_features = cc_label(bme_mask)
        if num_features > 0:
            counts = np.bincount(labeled_bme.ravel())
            keep_mask = np.zeros(num_features + 1, dtype=bool)
            for comp_idx in range(1, num_features + 1):
                vol_mm3 = counts[comp_idx] * voxel_vol
                if vol_mm3 >= min_size_mm3:
                    keep_mask[comp_idx] = True
                else:
                    n_removed += 1
            bme_mask = keep_mask[labeled_bme]

    # Assemble output volume
    out = np.zeros(shape, dtype=np.uint8)
    out[bone_mask] = 1
    out[bme_mask] = 2

    return out, n_removed
