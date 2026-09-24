/**
 * Decides whether a pixel can be painted given its current label, the target
 * brush label, and the active painting constraints.
 *
 * Rules:
 * 1. Erasing is always allowed.
 * 2. "Only inside bone": non-bone brushes (target !== 1) can only paint onto
 *    bone marrow pixels (existing === 1) or pixels already of the same label (existing === target).
 *    In 2D, this restriction applies only when bone marrow exists on the slice.
 * 3. "Protect lesion": the bone marrow brush (target === 1) cannot overwrite an
 *    existing BME lesion (existing === 2).
 */
export function canPaint(
  existing: number,
  target: number,
  o: {
    erasing: boolean;
    insideBone: boolean;
    hasBone: boolean;
    protectLesion: boolean;
  }
): boolean {
  if (o.erasing) return true;
  if (o.insideBone && o.hasBone && target !== 1 && existing !== 1 && existing !== target) {
    return false;
  }
  if (o.protectLesion && target === 1 && existing === 2) {
    return false;
  }
  return true;
}
