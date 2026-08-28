"""Split the annotation workload across the team, writing it into data/worklist.csv.

    python ml/scripts/assign_cases.py "D:/Final yr Prj/bme" --show
    python ml/scripts/assign_cases.py "D:/Final yr Prj/bme" \
        --to elvin --to paripoorna --to reegan --to aditi

Each person gets a contiguous, clearly-owned block so nobody annotates the same
case twice by accident. Two deliberate choices:

  * Isotropic cases are dealt out FIRST and spread evenly. There are only 14 of
    them and they produce far better 3D surfaces, so no single person should end
    up with all or none of them.

  * A small OVERLAP set is assigned to everyone. Those cases get annotated
    independently by all four, which is how you measure inter-rater Dice — the
    number that tells you the model's realistic ceiling. Without it you cannot
    say whether a Dice of 0.65 is the model underperforming or the task being
    genuinely ambiguous. It is the cheapest credibility you will get.
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

FIELDS_ADDED = ("assigned_to", "is_overlap")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--to", action="append", default=[], metavar="NAME",
                    help="annotator name; repeat once per person")
    ap.add_argument("--overlap", type=int, default=5,
                    help="cases everyone annotates, for inter-rater Dice (default 5)")
    ap.add_argument("--show", action="store_true", help="print current assignment and exit")
    args = ap.parse_args()

    base = Path(args.base)
    wl = base / "data" / "worklist.csv"
    if not wl.exists():
        sys.exit(f"no {wl} — run ml/scripts/convert.py first")

    rows = list(csv.DictReader(open(wl, encoding="utf-8")))

    if args.show or not args.to:
        by = {}
        for r in rows:
            by.setdefault(r.get("assigned_to") or "(unassigned)", []).append(r)
        print(f"{len(rows)} cases\n")
        for who in sorted(by):
            cases = by[who]
            iso = sum(1 for c in cases if c.get("isotropic") == "True")
            ov = sum(1 for c in cases if c.get("is_overlap") == "True")
            done = sum(1 for c in cases if c.get("annotated"))
            print(f"  {who:16s} {len(cases):3d} cases  ({iso} isotropic, {ov} shared)  "
                  f"{done} annotated")
        if not args.to:
            print("\nAssign with:  --to name1 --to name2 ...")
        return

    people = args.to
    iso = [r for r in rows if r.get("isotropic") == "True"]
    rest = [r for r in rows if r.get("isotropic") != "True"]

    # Overlap set: take from the isotropic pool. Everyone draws the same cases,
    # so the comparison is on the clearest data available.
    overlap = iso[: args.overlap]
    iso = iso[args.overlap:]
    ov_ids = {r["case_id"] for r in overlap}

    for r in rows:
        r["assigned_to"] = ""
        r["is_overlap"] = "True" if r["case_id"] in ov_ids else "False"
    for r in overlap:
        r["assigned_to"] = "ALL"

    # Deal isotropic first so the good cases spread evenly, then the rest.
    i = 0
    for pool in (iso, rest):
        for r in pool:
            r["assigned_to"] = people[i % len(people)]
            i += 1

    fields = list(rows[0].keys())
    for f in FIELDS_ADDED:
        if f not in fields:
            fields.append(f)
    with open(wl, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows([{k: r.get(k, "") for k in fields} for r in rows])

    print(f"{len(rows)} cases across {len(people)} annotator(s)\n")
    for who in people:
        mine = [r for r in rows if r["assigned_to"] == who]
        n_iso = sum(1 for r in mine if r.get("isotropic") == "True")
        n_bme = sum(1 for r in mine if r.get("class") == "bme")
        print(f"  {who:16s} {len(mine):3d} cases  {n_iso} isotropic  {n_bme} BME-positive")
    print(f"\n  {'ALL (shared)':16s} {len(overlap):3d} cases  <- everyone annotates these,")
    print(f"  {'':16s}     independently, for inter-rater agreement")
    print(f"       {', '.join(r['case_id'] for r in overlap)}")
    print(f"\nwritten -> {wl}")
    print("Each person filters worklist.csv by their name and works only those.")


if __name__ == "__main__":
    main()
