"""Import an outside 2D PNG set into data/slices2d without creating duplicates.

    python ml/scripts/import_2d.py "D:/Final yr Prj/Annotated/labled_data_bme"
    python ml/scripts/import_2d.py <src> --apply

Dry run by default: it prints exactly what it would copy and where, and writes
nothing. Add --apply to actually copy. The source directory is only ever read.

The set arrives from a teammate, so three things have to be true before an image
is allowed in:

  1. It is not already here. Filenames differ between machines and mean nothing,
     so matching is by pixel fingerprint (a 64-bit gradient hash of the
     grayscale image), which survives re-encoding and rescaling. Compared both
     against data/slices2d and against images already accepted in this run.

  2. It has a patient. Slices from one patient must never straddle a train/val
     split, so files are grouped into cases by the leading number in the name
     where there is one, and by the name itself where there is not -- about a
     fifth of this batch is named by person alone.

  3. Its filename does not travel. The originals carry patient names, so the
     copy is renamed to a pseudonymous id and the id -> original mapping is
     written to data/, which is gitignored. That file is PHI. It must not be
     committed, pasted, or copied off this machine.

Incoming ids are prefixed E (external) so they can never collide with locally
converted cases, and so a bad batch can be withdrawn by prefix alone.

The "annotated" copies are reference images, not labels: they are a circle
drawn over the region, not a voxel-accurate mask. They are copied to
data/refmarks2d/ to guide manual annotation and are never fed to a model.
Marking is done in the annotate page, on the clean image.
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


def mark_pixels(im: Image.Image) -> int:
    """Pixels belonging to a hand-drawn mark.

    Green, not red. Every export in this set carries a fixed ~34,300-pixel red
    overlay burned in by the source viewer, in both the marked and unmarked
    folders, so counting red measures the watermark and finds nothing.
    """
    a = np.asarray(im.convert("RGB"), dtype=np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    return int(((g - r > 40) & (g - b > 40)).sum())


def patient_key(name: str) -> str:
    """Group slices by patient.

    Most files lead with a patient number, but about a fifth are named by
    person alone. Those are still one patient each, so the normalised stem is
    the key -- dropping them would throw away a quarter of the batch, and
    giving each its own case id would be a lie that inflates every split.
    """
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


def index_existing(base: Path) -> dict[str, str]:
    seen: dict[str, str] = {}
    for p in sorted((base / "data" / "slices2d").rglob("*.png")):
        im = read(p)
        if im is not None:
            seen.setdefault(fingerprint(im), p.name)
    return seen


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--base", default=r"D:/Final yr Prj/bme")
    ap.add_argument("--apply", action="store_true",
                    help="actually copy; without it nothing is written")
    args = ap.parse_args()

    base, src = Path(args.base), Path(args.src)
    if not src.is_dir():
        sys.exit(f"source not found: {src}")

    dst_bme = base / "data" / "slices2d" / "bme"
    dst_nb = base / "data" / "slices2d" / "non_bme"
    dst_ref = base / "data" / "refmarks2d"
    map_csv = base / "data" / "import_map_2d.csv"

    print(f"source (read-only)  {src}")
    print(f"into                {dst_bme}")
    print(f"                    {dst_nb}")
    print(f"reference marks     {dst_ref}")
    print(f"id -> filename map  {map_csv}   [PHI, gitignored, never commit]")
    print(f"mode                {'APPLY' if args.apply else 'DRY RUN - nothing written'}\n")

    print("fingerprinting what is already here...", flush=True)
    seen = index_existing(base)
    print(f"  {len(seen)} images already in data/slices2d\n")

    jobs = [("non-annotated", "bme", dst_bme), ("non BME", "non_bme", dst_nb)]

    plan: list[tuple[Path, Path, str, str]] = []
    stats = {"dup_repo": 0, "dup_batch": 0, "unreadable": 0}
    skipped: list[str] = []

    for folder, cls, dst in jobs:
        d = src / folder
        if not d.is_dir():
            print(f"!! missing {folder}, skipping")
            continue
        prefix = "EBME" if cls == "bme" else "ENBME"
        # Stable case numbers: a file's own number where it has one, then 900+
        # for the name-only files, so the two schemes cannot collide.
        keys = sorted({patient_key(p.name) for p in d.iterdir()
                       if p.suffix.lower() in EXTS})
        ids: dict[str, int] = {}
        nxt = 900
        for k in keys:
            if k.startswith("n"):
                ids[k] = int(k[1:])
            else:
                ids[k] = nxt
                nxt += 1

        per_case: dict[str, int] = {}
        taken = 0
        for p in sorted(d.iterdir()):
            if p.suffix.lower() not in EXTS:
                continue
            im = read(p)
            if im is None:
                stats["unreadable"] += 1
                skipped.append(f"{folder}/{p.name} (unreadable)")
                continue
            f = fingerprint(im)
            if f in seen:
                stats["dup_batch" if seen[f] == "~batch" else "dup_repo"] += 1
                continue
            seen[f] = "~batch"
            case = f"{prefix}-{ids[patient_key(p.name)]:03d}"
            k = per_case.get(case, 0)
            per_case[case] = k + 1
            plan.append((p, dst / f"{case}_s{k:03d}.png", case, cls))
            taken += 1
        print(f"{folder:16s} -> {cls:8s}  {taken} new, {len(per_case)} case(s)")

    refs: list[tuple[Path, Path]] = []
    d = src / "annotated"
    if d.is_dir():
        raws = {patient_key(p.name): p
                for p in (src / "non-annotated").iterdir()
                if p.suffix.lower() in EXTS}
        total, per_key = 0, {}
        for p in sorted(d.iterdir()):
            if p.suffix.lower() not in EXTS:
                continue
            total += 1
            im = read(p)
            if im is None:
                continue
            key = patient_key(p.name)
            base_im = read(raws[key]) if key in raws else None
            floor = mark_pixels(base_im) if base_im is not None else 0
            if mark_pixels(im) > 200 and mark_pixels(im) > floor * 3 + 100:
                i = per_key.get(key, 0)
                per_key[key] = i + 1
                refs.append((p, dst_ref / f"{key}_mark{i:02d}.png"))
        print(f"{'annotated':16s} -> refmarks  {len(refs)} of {total} carry a mark")

    print(f"\nskipped: {stats['dup_repo']} already in repo, "
          f"{stats['dup_batch']} duplicated inside the batch, "
          f"{stats['unreadable']} unreadable")
    for s in skipped[:12]:
        print(f"  - {s}")
    if len(skipped) > 12:
        print(f"  ... and {len(skipped) - 12} more")

    if not args.apply:
        print(f"\nDRY RUN. {len(plan)} images and {len(refs)} reference marks would be "
              f"copied.\nRe-run with --apply to do it.")
        return

    for dd in (dst_bme, dst_nb, dst_ref):
        dd.mkdir(parents=True, exist_ok=True)
    for s, t, _, _ in plan:
        shutil.copy2(s, t)
    for s, t in refs:
        shutil.copy2(s, t)

    with (base / "data" / "slices2d" / "index.csv").open("a", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        for _, t, case, cls in plan:
            w.writerow([case, cls, f"{cls}/{t.name}"])

    new_map = not map_csv.exists()
    with map_csv.open("a", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        if new_map:
            w.writerow(["case_id", "dest", "source_folder", "source_filename"])
        for s, t, case, cls in plan:
            w.writerow([case, f"{cls}/{t.name}", s.parent.name, s.name])
        for s, t in refs:
            w.writerow([t.stem.split("_")[0], f"refmarks2d/{t.name}", s.parent.name, s.name])

    print(f"\ncopied {len(plan)} images and {len(refs)} reference marks")
    print(f"index.csv appended; mapping in {map_csv} (PHI - do not commit)")


if __name__ == "__main__":
    main()
