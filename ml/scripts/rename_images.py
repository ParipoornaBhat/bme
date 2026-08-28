"""Pseudonymise the 2D slice images, and record the mapping.

    python ml/scripts/rename_images.py "D:/Final yr Prj/bme"           # DRY RUN
    python ml/scripts/rename_images.py "D:/Final yr Prj/bme" --apply

    BME/2d/AJAY PNG - AJAY.JPEG  ->  BME/2d/BME-2D-004.jpeg

WHY THIS IS SEPARATE FROM rename_archives.py
    Archives map one-to-one onto a case, so each could take its case ID directly.
    Images do not: several images can belong to one patient, some are the same
    picture saved twice, and the filename is the only clue as to which case they
    came from. Guessing that link would silently mislabel data.

    So these get their own sequential IDs. The mapping keeps the original name,
    which is what you would need to reconnect them to a case later — done
    deliberately by a human, not inferred here.

DUPLICATES
    Byte-identical files are detected by hash and collapsed onto one name, so
    "X PNG 1.JPEG" and "X PNG 1 - NAME.JPEG" do not become two separate IDs.

SAFETY
    Dry run by default. The mapping is written before any file moves. The
    mapping contains patient names, lives under gitignored data/, and is the
    only way to undo this.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import sys
from pathlib import Path

IMG_EXT = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"}
FOLDERS = [("BME-2D", Path("BME") / "2d"), ("NBME-2D", Path("Non BME") / "2d")]


def sha256_of(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        while (b := fh.read(1 << 22)):
            h.update(b)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    base = Path(args.base)
    plan: list[tuple[Path, Path, str, str]] = []   # src, dst, new_id, digest
    dupes: list[tuple[Path, str]] = []

    for prefix, rel in FOLDERS:
        d = base / rel
        if not d.is_dir():
            print(f"  !! missing {rel}")
            continue

        # Seed from files already pseudonymised by a previous run, so a rerun
        # recognises them instead of trying to hand out the same IDs again.
        seen: dict[str, str] = {}
        n = 0
        for p in sorted(d.iterdir()):
            if p.is_file() and p.suffix.lower() in IMG_EXT and p.stem.startswith(prefix):
                stem = p.stem.split("_copy")[0]
                seen.setdefault(sha256_of(p), stem)
                if not p.stem.count("_copy"):
                    try:
                        n = max(n, int(stem.rsplit("-", 1)[-1]))
                    except ValueError:
                        pass

        for p in sorted(d.iterdir()):
            if not p.is_file() or p.suffix.lower() not in IMG_EXT:
                continue
            if p.stem.startswith(prefix):
                continue  # already pseudonymised
            digest = sha256_of(p)
            if digest in seen:
                # Byte-identical copy. Renamed rather than deleted: it still
                # carries a patient name, and deleting someone's data to tidy
                # up filenames is not this script's call to make.
                base_id = seen[digest]
                k = 2
                while (d / f"{base_id}_copy{k}{p.suffix.lower()}").exists():
                    k += 1
                dupes.append((p, base_id))
                plan.append((p, d / f"{base_id}_copy{k}{p.suffix.lower()}", base_id, digest))
                continue
            n += 1
            new_id = f"{prefix}-{n:03d}"
            seen[digest] = new_id
            plan.append((p, d / f"{new_id}{p.suffix.lower()}", new_id, digest))

    print(f"{'DRY RUN — nothing will move' if not args.apply else 'RENAMING'}\n")
    print(f"  to rename        : {len(plan)}")
    print(f"  duplicate copies : {len(dupes)}  (identical bytes -> renamed <id>_copyN)")

    for src, dst, _, _ in plan[:8]:
        print(f"    {src.name[:44]:44s} -> {dst.name}")
    if len(plan) > 8:
        print(f"    … and {len(plan) - 8} more")
    if dupes:
        print("\n  duplicates (same image as an already-named file):")
        for p, of in dupes[:5]:
            print(f"    {p.name[:44]:44s} == {of}")

    collisions = [d for _, d, _, _ in plan if d.exists()]
    if collisions:
        sys.exit(f"\nABORT: {len(collisions)} target name(s) already exist. Nothing moved.")

    if not plan:
        print("\nnothing to do")
        return

    if not args.apply:
        print("\nRe-run with --apply. Duplicates are reported, never deleted —")
        print("removing them is your call, not this script's.")
        return

    out = base / "data" / "image_rename_map.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    rows = [{"new_id": nid, "folder": src.parent.relative_to(base).as_posix(),
             "old_name": src.name, "new_name": dst.name, "sha256": dg}
            for src, dst, nid, dg in plan]
    rows += [{"new_id": of, "folder": p.parent.relative_to(base).as_posix(),
              "old_name": p.name, "new_name": "(duplicate, not renamed)", "sha256": ""}
             for p, of in dupes]
    with open(out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["new_id", "folder", "old_name", "new_name", "sha256"])
        w.writeheader()
        w.writerows(rows)
    print(f"\n  mapping written -> {out}")

    done = 0
    for src, dst, _, _ in plan:
        try:
            src.rename(dst)
            done += 1
        except OSError as e:
            print(f"  !! {src.name}: {e}")
    print(f"  renamed {done}/{len(plan)}")
    print("\n  data/image_rename_map.csv holds patient names. Keep it local, never commit.")


if __name__ == "__main__":
    main()
