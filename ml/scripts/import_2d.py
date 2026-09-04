"""Move an outside 2D PNG set into the repo's 2D datasets.

    python ml/scripts/import_2d.py "D:/Final yr Prj/Annotated/labled_data_bme"
    python ml/scripts/import_2d.py <src> --apply

Dry run by default: prints every move it would make and writes nothing. Add
--apply to do it. Files are MOVED, not copied -- the source folder is left
empty, so there is exactly one copy of each image and no chance of a second
import creating duplicates. Pass --copy to leave the source intact.

Three folders arrive and go to two different datasets:

    non-annotated/  ->  data/slices2d/bme/        classifier: has edema
    non BME/        ->  data/slices2d/non_bme/    classifier: does not
    annotated/      ->  data/seg2d_ext/marked/    segmentation labels

The annotated files carry a semi-transparent green region mask painted over the
scan by the annotator. They are real pixel-level labels, not sketches, so they
belong to the segmentation dataset -- but the mask is burned into the image,
which means a model trained on these files directly would just learn to find
the green patch. marks_to_seg2d.py splits each one into a clean image and a
binary mask; until that runs, nothing here is trainable.

Guards, each of which drops a file rather than guessing:

  1. Not already here. Filenames differ between machines and mean nothing, so
     matching is by pixel fingerprint (a 64-bit gradient hash of the grayscale
     image), checked against data/slices2d and against files already accepted
     in this run.

  2. Has a patient. Slices from one patient must never straddle a train/val
     split, so files are grouped into cases by the leading number in the name
     where there is one and by the name itself where there is not -- about a
     fifth of this batch is named by person alone. The id map is built once
     across annotated/ and non-annotated/ together so the same patient gets the
     same number in both.

  3. Its filename does not travel. The originals carry patient names, so the
     destination name is a pseudonymous id and the mapping goes to
     data/import_map_2d.csv, which is gitignored. That file is PHI: never
     commit it, never paste it, never copy it off this machine.

Ids are prefixed E (external) so they cannot collide with locally converted
cases and a bad batch can be withdrawn by prefix alone.
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

# The overlay is alpha-blended, so it is a tint rather than pure green. At 20 it
# selects 150 of 156 annotated files and 0 of 156 clean ones -- a clean split.
# At 40 it caught only 120: the earlier threshold was discarding real labels.
GREEN_THR = 20
MIN_MARK_PX = 300


def fingerprint(im: Image.Image) -> str:
    g = im.convert("L").resize((9, 8), Image.LANCZOS)
    a = np.asarray(g, dtype=np.int16)
    return "".join("1" if b else "0" for b in (a[:, 1:] > a[:, :-1]).flatten())


def mark_pixels(im: Image.Image) -> int:
    """Pixels covered by the annotator's green region mask.

    Green, not red. Every export carries a fixed ~34,300-pixel red viewer bar
    across the top in both the marked and unmarked folders, so counting red
    measures the chrome and finds nothing.
    """
    a = np.asarray(im.convert("RGB"), dtype=np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    return int(((g - r > GREEN_THR) & (g - b > GREEN_THR)).sum())


def patient_key(name: str) -> str:
    s = Path(name).stem.strip().lower()
    m = re.match(r"^(\d+)", s)
    if m:
        return f"n{int(m.group(1)):03d}"
    s = re.sub(r"\b(axial|axials|coronal|sagittal|png|jpeg|jpg|copy)\b", " ", s)
    s = re.sub(r"[^a-z]+", "", s)
    return f"s{s}" if s else "sunknown"


def read(p: Path) -> Image.Image | None:
    try:
        im = Image.open(p)
        im.load()
        return im
    except Exception:
        return None


def files(d: Path) -> list[Path]:
    return sorted(p for p in d.iterdir() if p.suffix.lower() in EXTS) if d.is_dir() else []


def build_ids(dirs: list[Path], start: int = 900) -> dict[str, int]:
    """One id per patient, shared across folders.

    Numbered files keep their own number; name-only files are allocated from
    900 up, so the two schemes cannot collide. Built over every folder at once
    so a patient who appears in both annotated/ and non-annotated/ gets one id.
    """
    keys = sorted({patient_key(p.name) for d in dirs for p in files(d)})
    ids, nxt = {}, start
    for k in keys:
        if k.startswith("n"):
            ids[k] = int(k[1:])
        else:
            ids[k] = nxt
            nxt += 1
    return ids


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--base", default=r"D:/Final yr Prj/bme")
    ap.add_argument("--apply", action="store_true",
                    help="actually move; without it nothing is written")
    ap.add_argument("--copy", action="store_true",
                    help="copy instead of moving, leaving the source intact")
    args = ap.parse_args()

    base, src = Path(args.base), Path(args.src)
    if not src.is_dir():
        sys.exit(f"source not found: {src}")

    dst_bme = base / "data" / "slices2d" / "bme"
    dst_nb = base / "data" / "slices2d" / "non_bme"
    dst_mark = base / "data" / "seg2d_ext" / "marked"
    dst_plain = base / "data" / "seg2d_ext" / "unmarked"
    map_csv = base / "data" / "import_map_2d.csv"
    verb = "copy" if args.copy else "move"

    print(f"source              {src}")
    print(f"classifier          {dst_bme}")
    print(f"                    {dst_nb}")
    print(f"segmentation labels {dst_mark}")
    print(f"id -> filename map  {map_csv}   [PHI, gitignored, never commit]")
    print(f"mode                {'APPLY' if args.apply else 'DRY RUN - nothing written'}"
          f" ({verb})\n")

    print("fingerprinting what is already here...", flush=True)
    seen: dict[str, str] = {}
    for p in sorted((base / "data" / "slices2d").rglob("*.png")):
        im = read(p)
        if im is not None:
            seen.setdefault(fingerprint(im), p.name)
    print(f"  {len(seen)} images already in data/slices2d\n")

    ids = build_ids([src / "annotated", src / "non-annotated"])
    ids_nb = build_ids([src / "non BME"])

    plan: list[tuple[Path, Path, str, str]] = []
    stats = {"dup_repo": 0, "dup_batch": 0, "unreadable": 0}

    for folder, cls, dst, idmap in [
        ("non-annotated", "bme", dst_bme, ids),
        ("non BME", "non_bme", dst_nb, ids_nb),
    ]:
        prefix = "EBME" if cls == "bme" else "ENBME"
        per_case: dict[str, int] = {}
        taken = 0
        for p in files(src / folder):
            im = read(p)
            if im is None:
                stats["unreadable"] += 1
                continue
            f = fingerprint(im)
            if f in seen:
                stats["dup_batch" if seen[f] == "~batch" else "dup_repo"] += 1
                continue
            seen[f] = "~batch"
            case = f"{prefix}-{idmap[patient_key(p.name)]:03d}"
            k = per_case.get(case, 0)
            per_case[case] = k + 1
            plan.append((p, dst / f"{case}_s{k:03d}.png", case, cls))
            taken += 1
        print(f"{folder:16s} -> {cls:10s} {taken} file(s), {len(per_case)} case(s)")

    marks: list[tuple[Path, Path, str, int]] = []
    per_case = {}
    n_plain = 0
    for p in files(src / "annotated"):
        im = read(p)
        if im is None:
            stats["unreadable"] += 1
            continue
        px = mark_pixels(im)
        case = f"EBME-{ids[patient_key(p.name)]:03d}"
        k = per_case.get(case, 0)
        per_case[case] = k + 1
        target = dst_mark if px >= MIN_MARK_PX else dst_plain
        if px < MIN_MARK_PX:
            n_plain += 1
        marks.append((p, target / f"{case}_m{k:03d}.png", case, px))
    print(f"{'annotated':16s} -> {'seg2d_ext':10s} {len(marks) - n_plain} with a mask, "
          f"{n_plain} without ({len(per_case)} case(s))")

    print(f"\nskipped: {stats['dup_repo']} already in repo, "
          f"{stats['dup_batch']} duplicated inside the batch, "
          f"{stats['unreadable']} unreadable")

    if not args.apply:
        print(f"\nDRY RUN. {len(plan)} classifier images and {len(marks)} annotated "
              f"images would be {verb}d.\nRe-run with --apply to do it.")
        return

    for dd in (dst_bme, dst_nb, dst_mark, dst_plain):
        dd.mkdir(parents=True, exist_ok=True)
    act = shutil.copy2 if args.copy else shutil.move
    for s, t, _, _ in plan:
        act(str(s), str(t))
    for s, t, _, _ in marks:
        act(str(s), str(t))

    with (base / "data" / "slices2d" / "index.csv").open("a", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        for _, t, case, cls in plan:
            w.writerow([case, cls, f"{cls}/{t.name}"])

    seg_idx = base / "data" / "seg2d_ext" / "index.csv"
    with seg_idx.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["case_id", "file", "mask_px", "has_mask"])
        for _, t, case, px in marks:
            w.writerow([case, f"{t.parent.name}/{t.name}", px, int(px >= MIN_MARK_PX)])

    new_map = not map_csv.exists()
    with map_csv.open("a", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        if new_map:
            w.writerow(["case_id", "dest", "source_folder", "source_filename"])
        for s, t, case, cls in plan:
            w.writerow([case, f"{cls}/{t.name}", s.parent.name, s.name])
        for s, t, case, _ in marks:
            w.writerow([case, f"seg2d_ext/{t.parent.name}/{t.name}", s.parent.name, s.name])

    print(f"\n{verb}d {len(plan)} classifier images and {len(marks)} annotated images")
    print(f"index.csv appended; {seg_idx.name} written; mapping in {map_csv} (PHI)")
    print("\nNext: ml/scripts/marks_to_seg2d.py to split the marked images into\n"
          "clean image + binary mask. They are not trainable until that runs.")


if __name__ == "__main__":
    main()
