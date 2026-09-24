export type Plane = "axial" | "coronal" | "sagittal";

export interface TorchState {
  plane: Plane;
  a: number; // coordinate along the plane's horizontal axis
  b: number; // coordinate along the plane's vertical axis
  radius: number;
}

/**
 * Checks whether coordinate (a, b) on `currentPlane` falls inside the active torch circle.
 * Boundary pixels (distance squared === radius squared) are considered inside.
 */
export function isInTorch(
  a: number,
  b: number,
  currentPlane: Plane,
  torch: TorchState | null
): boolean {
  if (!torch || torch.plane !== currentPlane) return false;
  const da = a - torch.a;
  const db = b - torch.b;
  return da * da + db * db <= torch.radius * torch.radius;
}
