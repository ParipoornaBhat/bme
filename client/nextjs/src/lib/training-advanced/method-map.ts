/**
 * One model, one augmentation, one split: the Start form works with these
 * platform-neutral run ids, and this file turns them into what each kind of
 * account runs. Any model can go to any account that can run it; the same
 * trainer (ml/scripts/train_3d.py) sits behind the H200 and Kaggle routes.
 *
 * neutral ids:
 *   nnunet-3d  nnunet-3d-noaug  nnunet-2d  nnunet-2d-noaug      (H200 only)
 *   unet-aug-low|med|max  unet-noaug  unet-holdout[-none|-low|-max]
 *   arch-<mednext|orthogate|cnet>-<none|low|med|max>
 *   selftest-aug  selftest-plain                                  (H200 only)
 */

export type Aug = "builtin" | "none" | "low" | "med" | "max";
export type Level = "none" | "low" | "med" | "max";

export const ARCH_KEYS = ["mednext", "orthogate", "cnet"] as const;
export type ArchKey = (typeof ARCH_KEYS)[number];

/** The Kaggle method id for each architecture (scripts/lib/methods.js). */
export const KAGGLE_ID: Record<ArchKey | "unet3d", string> = {
  unet3d: "k-unet3d",
  mednext: "k-mednext",
  orthogate: "k-orthogate",
  cnet: "k-cnet-dual",
};

const LEVELS: Level[] = ["none", "low", "med", "max"];
const isLevel = (x: string): x is Level => (LEVELS as string[]).includes(x);

export function parseMethod(mid: string): { model: string; aug: Aug; holdout: boolean } {
  if (mid.startsWith("nnunet-")) {
    return { model: mid.includes("2d") ? "nnunet-2d" : "nnunet-3d", aug: mid.endsWith("-noaug") ? "none" : "builtin", holdout: false };
  }
  if (mid.startsWith("unet-holdout")) {
    const l = mid.replace("unet-holdout", "").replace("-", "") || "med";
    return { model: "unet3d", aug: isLevel(l) ? l : "med", holdout: true };
  }
  if (mid === "unet-noaug") return { model: "unet3d", aug: "none", holdout: false };
  if (mid.startsWith("unet-aug-")) {
    const l = mid.replace("unet-aug-", "");
    return { model: "unet3d", aug: isLevel(l) ? l : "med", holdout: false };
  }
  if (mid.startsWith("arch-")) {
    const [, key = "mednext", l = "med"] = mid.split("-");
    return { model: key, aug: isLevel(l) ? l : "med", holdout: false };
  }
  if (mid.startsWith("selftest-")) return { model: "selftest", aug: mid === "selftest-plain" ? "none" : "max", holdout: false };
  // Older Kaggle ids.
  const k = (Object.entries(KAGGLE_ID).find(([, v]) => v === mid) || [])[0];
  if (k) return { model: k, aug: "med", holdout: false };
  return { model: mid, aug: "med", holdout: false };
}

export function methodIdFor(model: string, aug: Aug, holdout: boolean): string {
  if (model.startsWith("nnunet-")) return aug === "none" ? `${model}-noaug` : model;
  if (model === "selftest") return aug === "none" ? "selftest-plain" : "selftest-aug";
  if (model === "unet3d") {
    const l = aug === "builtin" ? "med" : aug;
    if (holdout) return l === "med" ? "unet-holdout" : `unet-holdout-${l}`;
    return l === "none" ? "unet-noaug" : `unet-aug-${l}`;
  }
  if ((ARCH_KEYS as readonly string[]).includes(model)) return `arch-${model}-${aug === "builtin" ? "med" : aug}`;
  return model;
}

/** What to send for this kind of account, or null when it cannot run there. */
export function toPlatform(
  mid: string,
  platform: string,
): { methodId: string; augLevel?: Level } | null {
  const p = parseMethod(mid);
  const level: Level = p.aug === "builtin" ? "med" : p.aug;
  if (platform === "kaggle") {
    if (p.holdout || p.model.startsWith("nnunet-") || p.model === "selftest") return null;
    const id = KAGGLE_ID[p.model as ArchKey | "unet3d"];
    return id ? { methodId: id, augLevel: level } : null;
  }
  if (platform === "h200") {
    if (mid.startsWith("k-")) return { methodId: methodIdFor(p.model, "med", false) };
    return { methodId: mid };
  }
  return { methodId: mid };
}
