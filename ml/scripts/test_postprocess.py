import sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from postprocess import postprocess_volume


def test_bone_gating():
    # Edema outside bone must be removed
    shape = (20, 20, 10)
    prob_bone = np.zeros(shape, dtype=np.float32)
    prob_bme = np.zeros(shape, dtype=np.float32)

    # Bone in region [5:15, 5:15, 2:8]
    prob_bone[5:15, 5:15, 2:8] = 0.9

    # Edema inside bone [6:10, 6:10, 3:5]
    prob_bme[6:10, 6:10, 3:5] = 0.8
    # Edema OUTSIDE bone [0:3, 0:3, 0:3]
    prob_bme[0:3, 0:3, 0:3] = 0.85

    out, removed = postprocess_volume(
        prob_bone=prob_bone,
        prob_bme=prob_bme,
        threshold=0.5,
        min_size_mm3=0.0,
        prob_average=True,
    )

    # Outside edema must NOT be present
    assert not (out[0:3, 0:3, 0:3] == 2).any(), "Edema outside bone was not gated!"
    # Inside edema must be present
    assert (out[6:10, 6:10, 3:5] == 2).all(), "Edema inside bone was dropped!"
    # Non-edema bone must be 1
    assert (out[11:14, 11:14, 4:6] == 1).all()


def test_thresholding():
    shape = (10, 10, 10)
    prob_bone = np.ones(shape, dtype=np.float32)
    prob_bme = np.zeros(shape, dtype=np.float32)

    prob_bme[2:5, 2:5, 2:5] = 0.65

    # At threshold 0.60, edema should remain
    out1, _ = postprocess_volume(
        prob_bone=prob_bone,
        prob_bme=prob_bme,
        threshold=0.60,
        prob_average=True,
    )
    assert (out1[2:5, 2:5, 2:5] == 2).all()

    # At threshold 0.70, edema should be excluded
    out2, _ = postprocess_volume(
        prob_bone=prob_bone,
        prob_bme=prob_bme,
        threshold=0.70,
        prob_average=True,
    )
    assert not (out2 == 2).any()


def test_size_filter_mm3():
    shape = (20, 20, 20)
    prob_bone = np.ones(shape, dtype=np.float32)
    prob_bme = np.zeros(shape, dtype=np.float32)

    # Spacing: 1 x 2 x 3 mm -> voxel volume = 6 mm^3
    spacing = (1.0, 2.0, 3.0)

    # Small lesion: 2 voxels -> 12 mm^3
    prob_bme[2, 2, 2] = 0.9
    prob_bme[2, 2, 3] = 0.9

    # Large lesion: 10 voxels -> 60 mm^3
    prob_bme[10, 10, 0:10] = 0.9

    # Filter with min_size_mm3 = 30.0 mm^3
    out, n_removed = postprocess_volume(
        prob_bone=prob_bone,
        prob_bme=prob_bme,
        threshold=0.5,
        min_size_mm3=30.0,
        spacing=spacing,
        prob_average=True,
    )

    assert n_removed == 1, f"Expected 1 lesion removed, got {n_removed}"
    # Small lesion (12 mm^3) should be filtered out
    assert not (out[2, 2, 2:4] == 2).any()
    # Large lesion (60 mm^3) should be preserved
    assert (out[10, 10, 0:10] == 2).all()


def test_binarize_vote_mode():
    shape = (10, 10, 10)
    votes_bone = np.zeros(shape, dtype=np.uint16)
    votes_bme = np.zeros(shape, dtype=np.uint16)
    hits = np.full(shape, 4, dtype=np.uint16)

    # Bone has 3 votes out of 4 (>= 50%)
    votes_bone[2:6, 2:6, 2:6] = 3
    # BME has 2 votes out of 4 (>= 50%) inside bone
    votes_bme[2:4, 2:4, 2:4] = 2

    out, _ = postprocess_volume(
        votes_bone=votes_bone,
        votes_bme=votes_bme,
        hits=hits,
        prob_average=False,
    )

    assert (out[2:4, 2:4, 2:4] == 2).all()
    assert (out[4:6, 4:6, 4:6] == 1).all()
    assert (out[0, 0, 0] == 0)


if __name__ == "__main__":
    test_bone_gating()
    test_thresholding()
    test_size_filter_mm3()
    test_binarize_vote_mode()
    print("All synthetic unit tests PASSED successfully!")
