import { NextResponse } from "next/server";
import { isReviewMode } from "~/lib/app-mode";
import { fetchAccounts, fetchRuns, fetchDatasetStatus } from "~/lib/training-advanced/server";

export const dynamic = "force-dynamic";

const METHODS = [
  {
    n: 1,
    id: "nnunet-3d",
    where: "h200",
    label: "nnU-Net ResEnc M, 3D",
    tests: "the baseline every custom model has to beat (3D)",
    needsMib: 9000,
  },
  {
    n: 2,
    id: "nnunet-2d",
    where: "h200",
    label: "nnU-Net ResEnc M, 2D",
    tests: "the same baseline, slice by slice (2D)",
    needsMib: 9000,
  },
  {
    n: 3,
    id: "unet-aug-med",
    where: "h200",
    label: "3D U-Net, augmentation med",
    tests: "augmentation strength (compare with 4 and no-augmentation control)",
    localSupported: true,
  },
  {
    n: 4,
    id: "unet-aug-max",
    where: "h200",
    label: "3D U-Net, augmentation max",
    tests: "augmentation strength (compare with 3)",
    localSupported: true,
  },
  {
    n: 5,
    id: "unet-holdout",
    where: "h200",
    label: "3D U-Net, one round on fixed 80/20 split",
    tests: "no folds: one model, scored on a validation set that never changes",
    localSupported: true,
  },
  {
    n: 6,
    id: "k-unet3d",
    where: "kaggle",
    label: "3D U-Net (Kaggle settings), augmentation med",
    tests: "the Kaggle reference for 7-9",
    arch: "unet3d",
    localSupported: true,
  },
  {
    n: 7,
    id: "k-mednext",
    where: "kaggle",
    label: "MedNeXt, augmentation med",
    tests: "architecture (compare with 6)",
    arch: "mednext",
    localSupported: true,
  },
  {
    n: 8,
    id: "k-orthogate",
    where: "kaggle",
    label: "OrthoGate-MedNeXt, augmentation med",
    tests: "architecture (compare with 6)",
    arch: "orthogate_mednext",
    localSupported: true,
  },
  {
    n: 9,
    id: "k-cnet-dual",
    where: "kaggle",
    label: "C-Net dual U-Net, augmentation med",
    tests: "architecture (compare with 6)",
    arch: "cnet_dual_unet",
    localSupported: true,
  },
];

export async function GET() {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  try {
    const [accountsData, runs, datasetData] = await Promise.all([
      fetchAccounts().catch(() => ({ cards: [], route: null })),
      fetchRuns().catch(() => []),
      fetchDatasetStatus().catch(() => ({ localExport: null, targets: [] })),
    ]);

    return NextResponse.json({
      cards: accountsData.cards,
      route: accountsData.route,
      runs,
      dataset: datasetData,
      methods: METHODS,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to load advanced training data" }, { status: 500 });
  }
}
