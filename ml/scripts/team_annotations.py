"""Move 3D annotations between the team's laptops without losing anyone's work.

Everyone paints on their own laptop; one laptop (the hub) collects the work and
trains. Annotations are gitignored, so they travel as a zip.

    # every laptop, once: write who owns which case into data/worklist.csv
    python ml/scripts/team_annotations.py assign .            (dry run)
    python ml/scripts/team_annotations.py assign . --apply

    # a teammate's laptop: zip the cases they own that have bone painted
    python ml/scripts/team_annotations.py export . --who paripoorna
    #   -> data/exports/annotations_paripoorna_<stamp>.zip   (send it to the hub)

    # the hub: merge one or more zips
    python ml/scripts/team_annotations.py import . <zip> [<zip> ...]            (dry run)
    python ml/scripts/team_annotations.py import . <zip> [<zip> ...] --apply

WHAT AN EXPORT CONTAINS
    data/annotations/<CASE>/*.seg.nrrd for each owned case whose canonical
    <CASE>.seg.nrrd has bone_marrow painted -- the main file and every
    <CASE>__<name>.seg.nrrd copy. A case still carrying only the Slicer edema is
    left out, so an untouched copy can never travel back over finished work.
    manifest.json records a fingerprint of the scan each case was painted on.

HOW AN IMPORT DECIDES, per file
    no local file, or local has no bone   -> take the incoming file
    byte-identical                        -> nothing to do
    both have bone and differ             -> CONFLICT, left alone unless
                                             --prefer-incoming
    Anything replaced is first copied to data/annotations_backup/<stamp>/, so an
    import can be undone by copying that folder back.

    A case is refused outright if the incoming scan fingerprint differs from
    the local scan (the two laptops gave that ID to different scans), or if the
    zip's owner does not own the case (pass --any-owner to allow it).

GIVING A TEAMMATE THE HUB'S WHOLE DATASET
    # the hub: two zips into data/exports/
    python ml/scripts/team_annotations.py share .
    #   -> hub_mri_<stamp>.zip           data/worklist.csv + data/nifti/<CASE>/*
    #   -> hub_annotations_<stamp>.zip   data/annotations/<CASE>/* for every case

    # the teammate's laptop: both zips in one command (or pnpm data:sync <a> <b>)
    python ml/scripts/team_annotations.py restore . <mri zip> <annotations zip>            (dry run)
    python ml/scripts/team_annotations.py restore . <mri zip> <annotations zip> --apply

    # a laptop that already has the scans (pnpm data:process): annotations only
    python ml/scripts/team_annotations.py restore . <annotations zip> --apply

    Restore makes the laptop match the hub. A scan with the same voxels and
    affine is left alone; any other file that differs is copied to
    data/sync_backup/<stamp>/ before it is replaced, so unexported paint on
    the teammate's laptop is never lost. Local files the hub does not have
    are not touched. Given the annotations zip alone, a case is skipped when
    the laptop's scan differs from the hub's, because the paint would not sit
    on it.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import shutil
import sys
import zipfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import nibabel as nib  # noqa: E402
import numpy as np  # noqa: E402

from seg2nifti import build_labelmap, read_segmentation  # noqa: E402

# Owner of every case, 1-based numbers of BME-xxx. Agreed by the team; the
# cases each person finished before the split (1-5, 60-61) belong to whoever
# painted them, not to whoever's range they would otherwise fall in.
TEAM = {
    "aditi": "6-26,46-47",
    "paripoorna": "1-5,58-59",
    "reegan": "27-45,55-57,60-61",
    "elvin": "48-53",
}


def parse_ranges(spec: str) -> list[str]:
    ids = []
    for part in spec.split(","):
        lo, _, hi = part.partition("-")
        for n in range(int(lo), int(hi or lo) + 1):
            ids.append(f"BME-{n:03d}")
    return ids


def owners() -> dict[str, str]:
    out = {}
    for who, spec in TEAM.items():
        for cid in parse_ranges(spec):
            if cid in out:
                sys.exit(f"{cid} is assigned to both {out[cid]} and {who} -- fix TEAM")
            out[cid] = who
    return out


def has_bone(path: Path) -> bool:
    data, _, segments = read_segmentation(path)
    _, found, _ = build_labelmap(data, segments)
    return "bone_marrow" in found


def scan_fingerprint(base: Path, cid: str) -> str | None:
    """Hash of the primary scan's voxels and affine, not its file bytes: gzip
    stamps a time into the file, so two identical conversions differ on disk."""
    return volume_fingerprint(base / "data" / "nifti" / cid / f"{cid}_primary.nii.gz")


def volume_fingerprint(vp: Path) -> str | None:
    if not vp.exists():
        return None
    img = nib.load(str(vp))
    if not isinstance(img, nib.spatialimages.SpatialImage) or img.affine is None:
        return None
    h = hashlib.sha256()
    h.update(str(img.shape).encode())
    h.update(np.round(img.affine, 3).tobytes())
    h.update(np.ascontiguousarray(np.asanyarray(img.dataobj)).tobytes())
    return h.hexdigest()


def cmd_assign(base: Path, apply: bool):
    path = base / "data" / "worklist.csv"
    with open(path, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        fields = list(reader.fieldnames or [])
        rows = list(reader)
    for f in ("assigned_to", "is_overlap"):
        if f not in fields:
            fields.append(f)

    own = owners()
    present = {r["case_id"] for r in rows}
    changed = 0
    for r in rows:
        who = own.get(r["case_id"])
        if who is None:
            continue
        if r.get("assigned_to") != who:
            changed += 1
        r["assigned_to"] = who
        r["is_overlap"] = "False"

    for who, spec in TEAM.items():
        n = sum(1 for c in parse_ranges(spec) if c in present)
        print(f"  {who:12s} {spec:12s} {n:3d} case(s)")
    unowned = sorted(c for c in present if c.startswith("BME-") and c not in own)
    missing = sorted(c for c in own if c not in present)
    if unowned:
        print(f"  no owner     : {', '.join(unowned)}")
    if missing:
        print(f"  not on disk  : {', '.join(missing)}")
    print(f"\n{changed} row(s) change in {path}")

    if not apply:
        print("dry run -- add --apply to write")
        return
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    print("written")


def cmd_export(base: Path, who: str):
    if who not in TEAM:
        sys.exit(f"unknown name {who!r}; expected one of {sorted(TEAM)}")
    ann = base / "data" / "annotations"
    out_dir = base / "data" / "exports"
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    out = out_dir / f"annotations_{who}_{stamp}.zip"

    manifest = {"who": who, "created": stamp, "cases": {}}
    files: list[Path] = []
    for cid in parse_ranges(TEAM[who]):
        main = ann / cid / f"{cid}.seg.nrrd"
        if not main.exists():
            print(f"  {cid}  -- no annotation")
            continue
        if not has_bone(main):
            print(f"  {cid}  -- no bone painted yet, left out")
            continue
        fp = scan_fingerprint(base, cid)
        if fp is None:
            print(f"  {cid}  !! no data/nifti/{cid}/{cid}_primary.nii.gz, left out")
            continue
        segs = sorted(ann.joinpath(cid).glob(f"{cid}*.seg.nrrd"))
        manifest["cases"][cid] = {"scan": fp, "files": [p.name for p in segs]}
        files.extend(segs)
        print(f"  {cid}  {len(segs)} file(s)")

    if not files:
        sys.exit("\nnothing to export")
    print(f"\nwriting {out}")
    out_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, indent=2))
        for p in files:
            z.write(p, f"{p.parent.name}/{p.name}")
    print(f"{len(manifest['cases'])} case(s), {len(files)} file(s). Send this zip to the hub laptop.")


def cmd_import(base: Path, zips: list[Path], apply: bool, prefer_incoming: bool, any_owner: bool):
    ann = base / "data" / "annotations"
    backup = base / "data" / "annotations_backup" / datetime.now().strftime("%Y%m%d-%H%M%S")
    own = owners()
    plan: list[tuple[bytes, Path, bool]] = []  # (content, destination, back up first)
    conflicts = refused = 0

    for zp in zips:
        with zipfile.ZipFile(zp) as z:
            man = json.loads(z.read("manifest.json"))
            who = man.get("who", "?")
            print(f"\n{zp.name}  (from {who})")
            for cid, info in man["cases"].items():
                if own.get(cid) != who and not any_owner:
                    print(f"  {cid}  !! owned by {own.get(cid, 'nobody')}, not {who}; refused")
                    refused += 1
                    continue
                local_fp = scan_fingerprint(base, cid)
                if local_fp is None:
                    print(f"  {cid}  !! no local scan for this case; refused")
                    refused += 1
                    continue
                if local_fp != info["scan"]:
                    print(f"  {cid}  !! painted on a different scan than this laptop's {cid}; refused")
                    refused += 1
                    continue
                for name in info["files"]:
                    data = z.read(f"{cid}/{name}")
                    dest = ann / cid / name
                    if not dest.exists():
                        print(f"  {cid}  {name}: new")
                        plan.append((data, dest, False))
                        continue
                    if dest.read_bytes() == data:
                        continue
                    if not has_bone(dest):
                        print(f"  {cid}  {name}: replaces a local file with no bone")
                        plan.append((data, dest, True))
                        continue
                    if prefer_incoming:
                        print(f"  {cid}  {name}: CONFLICT, taking incoming (--prefer-incoming)")
                        plan.append((data, dest, True))
                    else:
                        print(f"  {cid}  {name}: CONFLICT, both painted and they differ; kept local")
                        conflicts += 1

    print("\n" + "=" * 60)
    print(f"write    : {len(plan)} file(s) into {ann}")
    print(f"back up  : {sum(1 for p in plan if p[2])} file(s) into {backup}")
    print(f"conflict : {conflicts}   refused: {refused}")
    print("=" * 60)
    if not apply:
        print("dry run -- add --apply to write")
        return

    for data, dest, back in plan:
        if back:
            keep = backup / dest.parent.name / dest.name
            keep.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dest, keep)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        tmp.write_bytes(data)
        tmp.replace(dest)
    print("written. Next: python ml/scripts/seg2nifti.py . --check-only")


def cmd_share(base: Path):
    data = base / "data"
    with open(data / "worklist.csv", newline="", encoding="utf-8") as fh:
        cases = [r["case_id"] for r in csv.DictReader(fh)]
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    out_dir = data / "exports"
    mri_zip = out_dir / f"hub_mri_{stamp}.zip"
    ann_zip = out_dir / f"hub_annotations_{stamp}.zip"

    scans = [p for cid in cases for p in sorted((data / "nifti" / cid).glob("*")) if p.is_file()]
    anns = [p for cid in cases for p in sorted((data / "annotations" / cid).glob("*")) if p.is_file()]
    no_scan = [cid for cid in cases if not (data / "nifti" / cid / f"{cid}_primary.nii.gz").exists()]
    if no_scan:
        sys.exit(f"worklist cases with no primary scan: {', '.join(no_scan)}")
    print(f"{len(cases)} case(s) in data/worklist.csv")
    print(f"  {mri_zip}  worklist.csv + {len(scans)} scan file(s)")
    print(f"  {ann_zip}  {len(anns)} annotation file(s)")

    # lets a laptop that converted its own scans take the annotations alone
    fingerprints = {cid: scan_fingerprint(base, cid) for cid in cases}

    out_dir.mkdir(parents=True, exist_ok=True)
    # scans are already gzip; storing them saves minutes and almost no space
    for out, kind, files, method in (
        (mri_zip, "mri", [data / "worklist.csv", *scans], zipfile.ZIP_STORED),
        (ann_zip, "annotations", anns, zipfile.ZIP_DEFLATED),
    ):
        tmp = out.with_suffix(".zip.part")
        with zipfile.ZipFile(tmp, "w", method) as z:
            man = {"kind": kind, "created": stamp, "cases": cases}
            if kind == "annotations":
                man["scans"] = fingerprints
            z.writestr("manifest.json", json.dumps(man, indent=2))
            for p in files:
                z.write(p, p.relative_to(data).as_posix())
        tmp.replace(out)
    print("written. On the teammate's laptop:")
    print(f"  pnpm data:sync {mri_zip.name} {ann_zip.name}")
    print("  or, if it already has the scans:")
    print(f"  pnpm data:sync {ann_zip.name}")


def cmd_restore(base: Path, zips: list[Path], apply: bool):
    data = base / "data"
    backup = data / "sync_backup" / datetime.now().strftime("%Y%m%d-%H%M%S")
    by_kind: dict[str, Path] = {}
    for zp in zips:
        with zipfile.ZipFile(zp) as z:
            kind = json.loads(z.read("manifest.json")).get("kind") if "manifest.json" in z.namelist() else None
        if kind not in ("mri", "annotations"):
            sys.exit(f"{zp} is not a hub_mri / hub_annotations zip (made by `share`)")
        if kind in by_kind:
            sys.exit(f"two {kind} zips given: {by_kind[kind]} and {zp}")
        by_kind[kind] = zp
    if "annotations" not in by_kind:
        sys.exit("give the hub_annotations zip, with or without the hub_mri one")

    # without the hub's scans, paint is only safe on a scan identical to the hub's
    skip: set[str] = set()
    if "mri" not in by_kind:
        with zipfile.ZipFile(by_kind["annotations"]) as z:
            hub_scans = json.loads(z.read("manifest.json")).get("scans")
        if hub_scans is None:
            sys.exit("this annotations zip has no scan fingerprints; give the hub_mri zip too, "
                     "or ask the hub for a fresh `pnpm data:share`")
        print("checking local scans against the hub's")
        for cid, fp in hub_scans.items():
            local = scan_fingerprint(base, cid)
            if local is None:
                print(f"  {cid}  !! no local scan; skipped")
                skip.add(cid)
            elif local != fp:
                print(f"  {cid}  !! this laptop's scan differs from the hub's; skipped")
                skip.add(cid)

    new = same = replace = 0
    for kind in ("mri", "annotations"):
        if kind not in by_kind:
            continue
        zp = by_kind[kind]
        print(f"\n{zp.name}")
        with zipfile.ZipFile(zp) as z:
            for info in z.infolist():
                rel = info.filename
                if rel == "manifest.json" or rel.endswith("/"):
                    continue
                if rel.startswith("/") or ".." in Path(rel).parts or rel.split("/")[0] not in (
                    "worklist.csv", "nifti", "annotations",
                ):
                    sys.exit(f"unexpected path in {zp.name}: {rel}")
                if rel.startswith("annotations/") and rel.split("/")[1] in skip:
                    continue
                dest = data / rel
                tmp = dest.with_name(f".incoming-{dest.name}")  # keeps .nii.gz for nibabel
                if apply:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with z.open(info) as src, open(tmp, "wb") as dst:
                        shutil.copyfileobj(src, dst)
                if not dest.exists():
                    action = "new"
                elif dest.stat().st_size == info.file_size and _same_bytes(dest, z, info):
                    action = "same"
                elif rel.endswith(".nii.gz") and apply and volume_fingerprint(dest) == volume_fingerprint(tmp):
                    action = "same"
                elif rel.endswith(".nii.gz") and not apply and _same_volume(dest, z, info):
                    action = "same"
                else:
                    action = "replace"

                if action == "same":
                    same += 1
                    if apply:
                        tmp.unlink()
                    continue
                print(f"  {rel}: {action}")
                if action == "new":
                    new += 1
                else:
                    replace += 1
                if apply:
                    if action == "replace":
                        keep = backup / rel
                        keep.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(dest, keep)
                    tmp.replace(dest)

    print("\n" + "=" * 60)
    print(f"new      : {new} file(s) into {data}")
    print(f"replace  : {replace} file(s), local copies backed up to {backup}")
    print(f"same     : {same} file(s) already match")
    if skip:
        print(f"skipped  : {len(skip)} case(s), scan differs or missing: {', '.join(sorted(skip))}")
    print("=" * 60)
    if not apply:
        print("dry run -- add --apply to write")
        return
    print("written. Restart the web app if it is running.")


def _same_bytes(path: Path, z: zipfile.ZipFile, info: zipfile.ZipInfo) -> bool:
    with open(path, "rb") as a, z.open(info) as b:
        while True:
            x, y = a.read(1 << 20), b.read(1 << 20)
            if x != y:
                return False
            if not x:
                return True


def _same_volume(path: Path, z: zipfile.ZipFile, info: zipfile.ZipInfo) -> bool:
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / Path(info.filename).name
        with z.open(info) as src, open(tmp, "wb") as dst:
            shutil.copyfileobj(src, dst)
        return volume_fingerprint(path) == volume_fingerprint(tmp)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("assign")
    a.add_argument("base")
    a.add_argument("--apply", action="store_true")

    e = sub.add_parser("export")
    e.add_argument("base")
    e.add_argument("--who", required=True, choices=sorted(TEAM))

    i = sub.add_parser("import")
    i.add_argument("base")
    i.add_argument("zips", nargs="+", type=Path)
    i.add_argument("--apply", action="store_true")
    i.add_argument("--prefer-incoming", action="store_true")
    i.add_argument("--any-owner", action="store_true")

    sh = sub.add_parser("share")
    sh.add_argument("base")

    r = sub.add_parser("restore")
    r.add_argument("base")
    r.add_argument("zips", nargs="+", type=Path)
    r.add_argument("--apply", action="store_true")

    args = ap.parse_args()
    base = Path(args.base)
    if args.cmd == "assign":
        cmd_assign(base, args.apply)
    elif args.cmd == "export":
        cmd_export(base, args.who)
    elif args.cmd == "share":
        cmd_share(base)
    elif args.cmd == "restore":
        cmd_restore(base, args.zips, args.apply)
    else:
        cmd_import(base, args.zips, args.apply, args.prefer_incoming, args.any_owner)


if __name__ == "__main__":
    main()
