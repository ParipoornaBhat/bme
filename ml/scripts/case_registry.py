"""Pin every case to a stable ID that is identical on all four machines.

    python ml/scripts/case_registry.py "D:/Final yr Prj/bme"          # update
    python ml/scripts/case_registry.py "D:/Final yr Prj/bme" --check   # verify only

THE PROBLEM THIS SOLVES
    IDs used to be handed out in alphabetical order of the archive filename. Add
    one archive that sorts earlier and every later ID shifts by one — so BME-005
    on your machine becomes a different patient than BME-005 on a teammate's.
    Annotations, worklist assignments and the trained model would all silently
    disagree about who is who.

THE FIX
    A case's ID is tied to the SHA-256 of its archive, recorded in
    ml/case_registry.csv. That file IS committed to git — it holds only hashes,
    IDs and class labels, never a filename or a patient name, so it carries no
    PHI. Everyone pulls the same registry and therefore resolves the same IDs,
    in any order, with any subset of the data present.

    New archives get the next free number and are appended. Existing IDs are
    never renumbered.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import sys
from pathlib import Path

REGISTRY = Path("ml") / "case_registry.csv"
FIELDS = ["case_id", "class", "sha256", "size_bytes"]
SOURCES = [("BME", Path("BME") / "3d"), ("NBME", Path("Non BME") / "3d")]


def sha256_of(path: Path, chunk=4 << 20) -> tuple[str, int]:
    h = hashlib.sha256()
    total = 0
    with open(path, "rb") as fh:
        while True:
            b = fh.read(chunk)
            if not b:
                break
            h.update(b)
            total += len(b)
    return h.hexdigest(), total


def load(base: Path) -> list[dict]:
    p = base / REGISTRY
    if not p.exists():
        return []
    with open(p, encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def save(base: Path, rows: list[dict]) -> None:
    p = base / REGISTRY
    p.parent.mkdir(parents=True, exist_ok=True)
    rows = sorted(rows, key=lambda r: r["case_id"])
    with open(p, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        w.writeheader()
        w.writerows([{k: r.get(k, "") for k in FIELDS} for r in rows])


def next_id(prefix: str, taken: set[str]) -> str:
    n = 1
    while f"{prefix}-{n:03d}" in taken:
        n += 1
    return f"{prefix}-{n:03d}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--check", action="store_true",
                    help="report drift without writing anything")
    args = ap.parse_args()

    base = Path(args.base)
    rows = load(base)
    by_hash = {r["sha256"]: r for r in rows}
    taken = {r["case_id"] for r in rows}

    print(f"registry: {len(rows)} known case(s)\n")

    added, seen = [], set()
    for prefix, rel in SOURCES:
        d = base / rel
        if not d.is_dir():
            print(f"  !! missing {rel}")
            continue
        for z in sorted(d.glob("*.zip")):
            digest, size = sha256_of(z)
            seen.add(digest)
            hit = by_hash.get(digest)
            if hit:
                continue
            cid = next_id(prefix, taken)
            taken.add(cid)
            row = {"case_id": cid, "class": prefix, "sha256": digest,
                   "size_bytes": str(size)}
            rows.append(row)
            by_hash[digest] = row
            added.append((cid, z.name))

    missing = [r for r in rows if r["sha256"] not in seen]

    if added:
        print(f"  {len(added)} new case(s):")
        for cid, name in added[:10]:
            # name printed only locally, never written to the registry
            print(f"    {cid}  <- {name[:40]}")
    else:
        print("  no new archives")

    if missing:
        print(f"\n  {len(missing)} registered case(s) not present on this machine:")
        print("    " + ", ".join(r["case_id"] for r in missing[:12]))
        print("    Their IDs stay reserved, so nothing gets renumbered.")

    if args.check:
        print("\n--check: nothing written")
        return

    if added:
        save(base, rows)
        print(f"\nwritten -> {REGISTRY}")
        print("COMMIT THIS FILE. It is how everyone agrees on which case is which.")
    print(f"\ntotal registered: {len(rows)}")


if __name__ == "__main__":
    main()
