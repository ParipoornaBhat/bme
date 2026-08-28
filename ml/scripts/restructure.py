"""Reorganise the source folders into a 2D / 3D layout.

    python ml/scripts/restructure.py "D:/Final yr Prj/bme"           # DRY RUN
    python ml/scripts/restructure.py "D:/Final yr Prj/bme" --apply

TARGET LAYOUT
    BME/
      3d/                 case archives (.zip)
      2d/                 slice images (.png/.jpg)
      3d_annotated/       .seg.nrrd from Slicer or the web editor
      2d_annotated/       2D masks, if 2D segmentation is ever added
    Non BME/
      3d/                 case archives  (already here)
      2d/                 slice images   (renamed from Slices/)
      3d_annotated/
      2d_annotated/

WHY THE ANNOTATED FOLDERS STAY EMPTY FOR NOW
    The pipeline writes annotations to data/annotations/<CASE_ID>/, keyed by
    pseudonymous ID, and every script reads them from there. These folders are
    created for your own filing; moving the pipeline to write into them would
    mean re-pointing seg2nifti, build_dataset and the web editor, and would put
    annotations back beside patient-named files. Left as-is deliberately.

SAFETY
    Dry run by default. Only moves files between folders — never deletes,
    never overwrites. Anything already in the right place is left alone.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

IMG = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"}
ARCHIVE = {".zip"}
SEG = {".nrrd", ".seg.nrrd", ".mrb"}


def classify(p: Path) -> str | None:
    name = p.name.lower()
    if name.endswith(".seg.nrrd"):
        return "3d_annotated"
    ext = p.suffix.lower()
    if ext in ARCHIVE:
        return "3d"
    if ext in IMG:
        return "2d"
    if ext in SEG:
        return "3d_annotated"
    return None


def plan_for(base: Path, root_rel: str) -> list[tuple[Path, Path]]:
    """Files to move, as (source, destination)."""
    root = base / root_rel
    if not root.is_dir():
        return []
    subs = {"2d", "3d", "2d_annotated", "3d_annotated"}
    moves: list[tuple[Path, Path]] = []

    for p in root.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(root)
        top = rel.parts[0] if len(rel.parts) > 1 else ""
        if top in subs:
            continue  # already filed
        kind = classify(p)
        if kind is None:
            continue
        moves.append((p, root / kind / p.name))
    return moves


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    base = Path(args.base)
    all_moves: dict[str, list[tuple[Path, Path]]] = {}
    for rel in ("BME", "Non BME"):
        all_moves[rel] = plan_for(base, rel)

    total = sum(len(v) for v in all_moves.values())
    print(f"{'DRY RUN — nothing will move' if not args.apply else 'MOVING FILES'}\n")

    for rel, moves in all_moves.items():
        by_kind: dict[str, int] = {}
        for _, dst in moves:
            by_kind[dst.parent.name] = by_kind.get(dst.parent.name, 0) + 1
        print(f"  {rel}/")
        if not moves:
            print("     nothing to move")
        for kind, n in sorted(by_kind.items()):
            print(f"     -> {kind:16s} {n:4d} file(s)")
        for src, dst in moves[:3]:
            print(f"        e.g. {src.name[:38]:38s} -> {dst.parent.name}/")
        print()

    # Refuse rather than overwrite: a name collision means two different files
    # would end up sharing a path, and one would be lost.
    collisions = [d for mv in all_moves.values() for _, d in mv if d.exists()]
    if collisions:
        print(f"ABORT: {len(collisions)} destination(s) already exist. Nothing moved.")
        for c in collisions[:5]:
            print(f"   {c.relative_to(base)}")
        sys.exit(1)

    if not args.apply:
        print(f"{total} file(s) would move. Re-run with --apply to do it.")
        print("Folders are created either way only when --apply is passed.")
        return

    made = 0
    for rel, moves in all_moves.items():
        for kind in ("2d", "3d", "2d_annotated", "3d_annotated"):
            d = base / rel / kind
            if not d.exists():
                d.mkdir(parents=True, exist_ok=True)
                made += 1
        for src, dst in moves:
            try:
                shutil.move(str(src), str(dst))
            except OSError as e:
                print(f"  !! {src.name}: {e}")

    print(f"created {made} folder(s), moved {total} file(s)")
    print("\nNOTE: scripts read case archives from BME/ and 'Non BME/3d'.")
    print("After this, update the SOURCES paths in ml/scripts/case_registry.py")
    print("and ml/scripts/deid.py to point at the new 3d/ folders.")


if __name__ == "__main__":
    main()
