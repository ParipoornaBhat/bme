"""Rename the case archives to their pseudonymous IDs, and record the mapping.

    python ml/scripts/rename_archives.py "D:/Final yr Prj/bme"            # DRY RUN
    python ml/scripts/rename_archives.py "D:/Final yr Prj/bme" --apply    # do it

    BME/--MOHAMMED-FAIZ.zip          ->  BME/BME-004.zip
    Non BME/3d/62 MAMTA J SHENOY.zip ->  Non BME/3d/NBME-041.zip

WHY
    Filenames are the last place patient names survive in this project. Renaming
    removes that exposure and, as a side effect, makes case IDs identical on
    every machine without anyone having to sync a registry.

THE MAPPING FILE IS PHI
    data/rename_map.csv holds old name -> new name, so it contains patient names.
    It lives under data/, which is gitignored, and must never be committed,
    pasted into chat, or copied to a shared drive. It is also the ONLY way to
    undo this, so do not delete it.

SAFETY
    Dry run by default. Nothing moves until --apply. The mapping is written
    before any file is touched, so an interruption mid-rename is recoverable.
    Existing IDs come from ml/case_registry.csv (matched by content hash), so a
    file already renamed is left alone and re-running is harmless.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import sys
from pathlib import Path

SOURCES = [("BME", Path("BME") / "3d"), ("NBME", Path("Non BME") / "3d")]


def sha256_of(path: Path, chunk=4 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            b = fh.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--apply", action="store_true", help="actually rename (default: dry run)")
    args = ap.parse_args()

    base = Path(args.base)
    reg_path = base / "ml" / "case_registry.csv"
    if not reg_path.exists():
        sys.exit("no ml/case_registry.csv — run ml/scripts/case_registry.py first")

    registry = {r["sha256"]: r["case_id"] for r in csv.DictReader(open(reg_path, encoding="utf-8"))}

    plan, already, unknown = [], [], []
    for prefix, rel in SOURCES:
        d = base / rel
        if not d.is_dir():
            print(f"  !! missing {rel}")
            continue
        for z in sorted(d.glob("*.zip")):
            cid = registry.get(sha256_of(z))
            if cid is None:
                unknown.append(z)
                continue
            target = z.with_name(f"{cid}.zip")
            if z.name == target.name:
                already.append(cid)
            else:
                plan.append((z, target, cid, rel.as_posix()))

    print(f"{'DRY RUN — nothing will move' if not args.apply else 'RENAMING'}\n")
    print(f"  to rename       : {len(plan)}")
    print(f"  already renamed : {len(already)}")
    print(f"  not in registry : {len(unknown)}")
    if unknown:
        print("    (run case_registry.py again to register these)")

    for src, dst, cid, _ in plan[:10]:
        print(f"    {src.name[:44]:44s} -> {dst.name}")
    if len(plan) > 10:
        print(f"    … and {len(plan) - 10} more")

    collisions = [d for _, d, _, _ in plan if d.exists()]
    if collisions:
        sys.exit(f"\nABORT: {len(collisions)} target name(s) already exist. Nothing moved.")

    if not plan:
        print("\nnothing to do")
        return

    if not args.apply:
        print("\nRe-run with --apply to perform the rename.")
        print("The mapping is written to data/rename_map.csv at that point —")
        print("it contains patient names, so keep it local and never commit it.")
        return

    # Write the mapping BEFORE moving anything, so an interruption is recoverable.
    out = base / "data" / "rename_map.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    existing = []
    if out.exists():
        existing = list(csv.DictReader(open(out, encoding="utf-8")))
    rows = existing + [
        {"case_id": cid, "folder": folder, "old_name": src.name, "new_name": dst.name}
        for src, dst, cid, folder in plan
    ]
    with open(out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["case_id", "folder", "old_name", "new_name"])
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
    print("\n  data/rename_map.csv is the ONLY way to undo this. Keep it. Never commit it.")


if __name__ == "__main__":
    main()
