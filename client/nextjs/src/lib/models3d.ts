/** The two 3D models from `pnpm train:3d`. CLI and the Training page write the same folders. */

export const MODELS_3D = [
  {
    id: "unet",
    label: "3D U-Net",
    out: "results3d",
    kind: "segmentation3d",
    hours: "about 15–20 minutes",
  },
  {
    id: "attention-unet",
    label: "3D Attention U-Net",
    out: "results3d-attn",
    kind: "segmentation3dAttn",
    hours: "about 20–30 minutes",
  },
] as const;

export type Model3DId = (typeof MODELS_3D)[number]["id"];

export function model3d(value: unknown): Model3DId {
  return value === "attention-unet" ? "attention-unet" : "unet";
}

export function model3dInfo(id: Model3DId) {
  return MODELS_3D.find((m) => m.id === id) ?? MODELS_3D[0];
}
