"""Build the 2D dataset from the curated root folders.

    python ml/scripts/build_2d.py "D:/Final yr Prj/bme"
    python ml/scripts/build_2d.py <base> --apply

Dry run by default. --apply wipes and rebuilds the derived folders, so this is
the single source of truth for what data/slices2d and data/seg2d_ext contain --
delete them any time and run this again.

Reads only the hand-curated root folders:

    BME/2d/               ->  data/slices2d/bme/         classifier positive
    BME/2d_annotated/     ->  data/seg2d_ext/marked/     segmentation labels
    Non BME/2d/           ->  data/slices2d/non_bme/     classifier negative
    Non BME/2d_annotated/ ->  data/seg2d_ext/marked_nb/

Nothing from the 3D volumes goes in here. Slices cut from a DICOM series are a
different distribution -- same patient across 20 near-identical slices, a
different exporter, a different window -- and mixing them with these exported
2D images inflates the training set with correlated copies while the case count
barely moves.

CASE GROUPING
    A patient's id is the filename stem with any _copy2 / _1 suffix stripped,
    so BME-2D-001.jpeg and BME-2D-001_copy2.jpeg are one patient. This matters:
    those two files land in the same fold, never one in train and one in val.
    Getting this wrong is the single easiest way to publish a number that is
    quietly meaningless.

DEDUPLICATION
    Images are matched by pixel fingerprint (a 64-bit gradient hash of the
    grayscale image), not by name, so a re-encoded or renamed copy is still
    caught. Duplicates are reported and dropped.
"""

from __future__ import annotations

import argparse
import csv
import re
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

EXTS = {".png", ".jpg", ".jpeg"}


def fingerprint(im: Image.Image) -> str:
    g = im.convert("L").resize((9, 8), Image.LANCZOS)
    a = np.asarray(g, dtype=np.int16)
    return "".join("1" if b else "0" for b in (a[:, 1:] > a[:, :-1]).flatten())


def case_id(name: str) -> str:
    """Patient id from the filename, ignoring duplicate-copy suffixes."""
    s = Path(name).stem
    s = re.sub(r"[_\- ]*(copy|copia)[_\- ]*\d*$", "", s, flags=re.I)
    s = re.sub(r"_s\d+$", "", s, flags=re.I)   # slice index, not a patient
    s = re.sub(r"_\d+$", "", s)
    return s.strip()


def read(p: Path) -> Image.Image | None:
    try:
        im = Image.open(p)
        im.load()
        return im
    except Exception:
        return None


def files(d: Path) -> list[Path]:
    return sorted(p for p in d.iterdir() if p.suffix.lower() in EXTS) if d.is_dir() else []


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("base", nargs="?", default=r"D:/Final yr Prj/bme")
    ap.add_argument("--apply", action="store_true",
                    help="wipe and rebuild; without it nothing is written")
    args = ap.parse_args()

    base = Path(args.base)
    # The group decides what a file is deduplicated against. An annotated image
    # and its clean counterpart hash almost identically -- the overlay is a
    # tint, and the gradient hash is computed on grayscale -- so sharing one
    # table across both datasets silently deletes the labels.
    jobs = [
        ("BME/2d", base / "data" / "slices2d" / "bme", "bme", "cls"),
        ("Non BME/2d", base / "data" / "slices2d" / "non_bme", "non_bme", "cls"),
        ("BME/2d_annotated", base / "data" / "seg2d_ext" / "marked", "marked", "seg"),
        ("Non BME/2d_annotated", base / "data" / "seg2d_ext" / "marked_nb", "marked_nb", "seg"),
    ]

    print(f"base   {base}")
    print(f"mode   {'APPLY - derived folders are wiped and rebuilt' if args.apply else 'DRY RUN - nothing written'}\n")

    seen: dict[str, dict[str, str]] = {"cls": {}, "seg": {}}
    plan: list[tuple[Path, Path, str, str]] = []
    empty: list[str] = []

    for rel, dst, cls, group in jobs:
        src = base / rel
        got = files(src)
        if not got:
            empty.append(rel)
            print(f"{rel:24s} -> {cls:10s} EMPTY")
            continue
        cases: dict[str, int] = {}
        dups = 0
        for p in got:
            im = read(p)
            if im is None:
                continue
            f = fingerprint(im)
            if f in seen[group]:
                dups += 1
                continue
            seen[group][f] = p.name
            cid = case_id(p.name)
            k = cases.get(cid, 0)
            cases[cid] = k + 1
            plan.append((p, dst / f"{cid}_s{k:03d}.png", cid, cls))
        note = f", {dups} duplicate(s) dropped" if dups else ""
        print(f"{rel:24s} -> {cls:10s} {len(got) - dups} image(s), "
              f"{len(cases)} case(s){note}")

    if empty:
        print("\n!! empty: " + ", ".join(empty))
        print("   Nothing to build there. The segmentation model needs")
        print("   2d_annotated to be populated before it can be trained.")

    n_bme = len({c for _, _, c, k in plan if k == "bme"})
    n_nb = len({c for _, _, c, k in plan if k == "non_bme"})
    if n_bme and n_nb:
        ratio = max(n_bme, n_nb) / min(n_bme, n_nb)
        print(f"\nclassifier: {n_bme} bme case(s) vs {n_nb} non-bme case(s)"
              f"  ({ratio:.1f}:1)")
        if ratio >= 2:
            print("!! imbalanced. Use class weighting, and report per-class recall")
            print("   and AUC -- overall accuracy will look good for the wrong reason.")

    if not args.apply:
        print(f"\nDRY RUN. {len(plan)} image(s) would be written.\n"
              f"Re-run with --apply to do it.")
        return

    for _, dst, _, _ in jobs:
        if dst.exists():
            shutil.rmtree(dst)
        dst.mkdir(parents=True, exist_ok=True)
    for s, t, _, _ in plan:
        im = read(s)
        if im is None:
            continue
        im.convert("RGB").save(t)

    idx = base / "data" / "slices2d" / "index.csv"
    with idx.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["case_id", "class", "path"])
        for _, t, cid, cls in plan:
            if cls in ("bme", "non_bme"):
                w.writerow([cid, cls, f"{cls}/{t.name}"])

    print(f"\nwrote {len(plan)} image(s)")
    print(f"index.csv: {sum(1 for _, _, _, k in plan if k in ('bme', 'non_bme'))} row(s)")


if __name__ == "__main__":
    main()
