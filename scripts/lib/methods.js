/**
 * The training methods to compare. Same seed (1337) and the same patient-level
 * folds everywhere, except holdout, which is one fixed 80/20 round.
 * Compare within a platform: the Kaggle settings (width 20, 0.5 mm grid, N4,
 * TTA) are not the H200 ones, so a Kaggle score is not ranked against an H200 one.
 */

export const KAGGLE_SETTINGS = [
  "--set", 'AUG_LEVEL="med"',
  "--set", "ENABLE_DATA_AUGMENTATION=False",
  "--set", "ENABLE_AUG_SPATIAL=False",
  "--set", "MAX_RUNTIME_MINUTES=660",
];

export const METHODS = [
  {
    n: 1, id: "nnunet-3d", where: "h200", label: "nnU-Net ResEnc M, 3D",
    tests: "the baseline every custom model has to beat (3D)",
    h200: ["best", "3d"], out: "results-nnunet-3d_fullres", needsMib: 9000,
  },
  {
    n: 2, id: "nnunet-2d", where: "h200", label: "nnU-Net ResEnc M, 2D",
    tests: "the same baseline, slice by slice (2D)",
    h200: ["best", "2d"], out: "results-nnunet-2d", needsMib: 9000,
  },
  {
    n: 3, id: "unet-aug-med", where: "h200", label: "3D U-Net, augmentation med",
    tests: "augmentation strength (compare with 4 and the no-augmentation control)",
    h200: ["aug", "med"], out: "results3d-aug-med", local: { arch: "unet3d", aug: "med" },
  },
  {
    n: 4, id: "unet-aug-max", where: "h200", label: "3D U-Net, augmentation max",
    tests: "augmentation strength (compare with 3)",
    h200: ["aug", "max"], out: "results3d-aug-max", local: { arch: "unet3d", aug: "max" },
  },
  {
    n: 5, id: "unet-holdout", where: "h200", label: "3D U-Net, one round on the fixed 80/20 split",
    tests: "no folds: one model, scored on a validation set that never changes",
    h200: ["holdout"], out: "results3d-holdout", local: { arch: "unet3d", aug: "med", holdout: true },
  },
  {
    n: 6, id: "k-unet3d", where: "kaggle", label: "3D U-Net (Kaggle settings), augmentation med",
    tests: "the Kaggle reference for 7-9", arch: "unet3d", local: { arch: "unet3d", aug: "med" },
  },
  {
    n: 7, id: "k-mednext", where: "kaggle", label: "MedNeXt, augmentation med",
    tests: "architecture (compare with 6)", arch: "mednext", local: { arch: "mednext", aug: "med" },
  },
  {
    n: 8, id: "k-orthogate", where: "kaggle", label: "OrthoGate-MedNeXt, augmentation med",
    tests: "architecture (compare with 6)", arch: "orthogate_mednext", local: { arch: "orthogate_mednext", aug: "med" },
  },
  {
    n: 9, id: "k-cnet-dual", where: "kaggle", label: "C-Net dual U-Net, augmentation med",
    tests: "architecture (compare with 6)", arch: "cnet_dual_unet", local: { arch: "cnet_dual_unet", aug: "med" },
  },
];

export const MORE_H200 = [
  { label: "3D U-Net, augmentation low", h200: ["aug", "low"], about: "the mildest level, for the augmentation study" },
  { label: "3D U-Net, no augmentation (control)", h200: ["train3dplain"], about: "the control the levels are compared with" },
  { label: "Continue the no-augmentation control", h200: ["resume3dplain"], about: "after the 4 h limit stopped it" },
  { label: "2D U-Net", h200: ["train2d"], about: "the slice model the app's Test page uses" },
];

export const PLATFORM = {
  h200: { name: "College H200", limit: "4 h per job; it saves and stops itself at 3 h 45, choosing it again continues" },
  kaggle: { name: "Kaggle", limit: "12 h per run (it saves at 11 h), about 30 GPU hours a week per account" },
  local: { name: "This PC", limit: "no time limit; Ctrl+C stops it, starting it again continues" },
};
