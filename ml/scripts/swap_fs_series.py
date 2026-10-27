"""Replace light-marrow (non fat-suppressed) non-BME scans with the same case's
fat-suppressed axial series, keeping every annotation already painted.

    # hub laptop (has Non BME/new/new)
    python ml/scripts/swap_fs_series.py apply <root>  [--apply]
    python ml/scripts/swap_fs_series.py zip <root>        -> <root>/fs_fix.zip

    # teammates: put fs_fix.zip in the repo root
    python ml/scripts/swap_fs_series.py install <root> [--apply]

WHY
    Edema is only visible on fat-suppressed scans: dark marrow, bright fluid.
    Two non-BME cases came in as plain T1/PD (light marrow), the opposite look
    from every other case. Inverting the picture does not turn one into the
    other, so the case's own fat-suppressed axial series is used instead.

    The list was made by eye, mid-slice of every case, 2026-10-27. A grainy
    dark-marrow look (gradient echo) was not counted: the marrow is dark there.

WHAT CHANGES, per case
    Non BME/axial/<folder>/      the light .nrrd is replaced by the dark one
    data/nifti/<case>/           every volume file rewritten from the dark one
    data/annotations/<case>/     each .seg.nrrd resampled onto the new grid
    data/worklist.csv            n_slices / slice_thickness / fat_suppressed

    Both series cover the same knee in the same slices; only the in-plane grid
    differs. Masks are moved by world position (nearest neighbour), so bone and
    edema land where they were painted. Each laptop moves its own annotations;
    the zip carries scans only.

    A case is skipped unless its current scan is exactly the light series, so
    running twice, or on a laptop where the case is a different patient, does
    nothing. Everything replaced is first copied to data/_backup_fs_<stamp>/.
    Non BME/new/new is read only. install deletes the zip once it succeeds.
"""
from __future__ import annotations

import argparse
import csv
import json
import shutil
import sys
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path

import nibabel as nib
import nrrd
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from seg2nifti import seg_affine_ras  # noqa: E402

# case -> (folder under Non BME/new/new and Non BME/axial, light file, dark file)
SWAPS = {
    "NBME-005": ("5", "201_series_1.nrrd", "601_series_5.nrrd"),
    "NBME-058": ("59", "tra-3.nrrd", "tra-2.nrrd"),
}
ZIP_NAME = "fs_fix.zip"


def resample_seg(seg_path: Path, old_aff: np.ndarray, new_aff: np.ndarray, new_shape):
    data, header = nrrd.read(str(seg_path))
    if data.ndim != 3:
        sys.exit(f"{seg_path.name}: {data.ndim}D segmentation, expected 3D; nothing written")
    if not np.allclose(seg_affine_ras(header), old_aff, atol=1e-3):
        sys.exit(f"{seg_path.name}: not on the current scan's grid; nothing written")
    idx = np.indices(new_shape).reshape(3, -1)
    world = new_aff[:3, :3] @ idx + new_aff[:3, 3:4]
    src = np.rint(np.linalg.inv(old_aff[:3, :3]) @ (world - old_aff[:3, 3:4])).astype(int)
    ok = np.all((src >= 0) & (src < np.array(data.shape)[:, None]), axis=0)
    flat = np.zeros(idx.shape[1], dtype=data.dtype)
    flat[ok] = data[src[0, ok], src[1, ok], src[2, ok]]
    return flat.reshape(new_shape), header


def write_seg(out: Path, new: np.ndarray, header: dict, dark_header: dict):
    header = dict(header)
    header["sizes"] = np.array(new.shape)
    header["space directions"] = dark_header["space directions"]
    header["space origin"] = dark_header["space origin"]
    header["space"] = dark_header.get("space", header.get("space"))
    ext = f"0 {new.shape[0] - 1} 0 {new.shape[1] - 1} 0 {new.shape[2] - 1}"
    for k in list(header):
        if k.startswith("Segment") and k.endswith("_Extent"):
            header[k] = ext
    nrrd.write(str(out), new, header)


def plan(base: Path, dark_dir) -> list[dict]:
    """dark_dir(folder) -> directory holding the dark file for that folder."""
    out = []
    for cid, (folder, light, dark) in SWAPS.items():
        dark_src = dark_dir(folder) / dark
        nifti = base / "data" / "nifti" / cid
        primary = nifti / f"{cid}_primary.nii.gz"
        if not dark_src.exists():
            print(f"  {cid}  !! {dark} not found, skipped")
            continue
        if not primary.exists():
            print(f"  {cid}  -- not on this laptop, skipped")
            continue
        old_aff = nib.load(str(primary)).affine
        dark_header = nrrd.read_header(str(dark_src))
        new_aff = seg_affine_ras(dark_header)
        if np.allclose(old_aff, new_aff, atol=1e-3):
            print(f"  {cid}  already swapped, nothing to do")
            continue
        light_src = base / "Non BME" / "axial" / folder / light
        if not light_src.exists():
            print(f"  {cid}  !! Non BME/axial/{folder}/{light} missing, cannot confirm the case; skipped")
            continue
        if not np.allclose(seg_affine_ras(nrrd.read_header(str(light_src))), old_aff, atol=1e-3):
            print(f"  {cid}  !! current scan is not Non BME/axial/{folder}/{light}; skipped")
            continue
        ann = base / "data" / "annotations" / cid
        segs = sorted(ann.glob("*.seg.nrrd")) if ann.is_dir() else []
        print(f"  {cid}  {light} -> {dark}   {len(segs)} annotation(s) moved onto the new grid")
        out.append(dict(cid=cid, folder=folder, light=light, dark=dark, dark_src=dark_src,
                        nifti=nifti, ann=ann, segs=segs, dark_header=dark_header,
                        old_aff=old_aff, new_aff=new_aff))
    return out


def swap(base: Path, p: dict, backup: Path):
    axial = base / "Non BME" / "axial" / p["folder"]
    for d, name in ((p["nifti"], "nifti"), (p["ann"], "annotations"), (axial, "axial")):
        if d.is_dir():
            shutil.copytree(d, backup / name / d.name)

    data, _ = nrrd.read(str(p["dark_src"]))
    moved = [(s, *resample_seg(s, p["old_aff"], p["new_aff"], data.shape)) for s in p["segs"]]
    for s, new, header in moved:
        write_seg(s, new, header, p["dark_header"])

    img = nib.Nifti1Image(data, p["new_aff"])
    for f in p["nifti"].glob(f"{p['cid']}_*.nii.gz"):
        nib.save(img, str(f))

    axial.mkdir(parents=True, exist_ok=True)
    if p["dark_src"].resolve() != (axial / p["dark"]).resolve():
        shutil.copy2(p["dark_src"], axial / p["dark"])
    if (axial / p["light"]).exists():
        (axial / p["light"]).unlink()

    wl = base / "data" / "worklist.csv"
    if wl.exists():
        with wl.open(newline="", encoding="utf-8") as fh:
            r = csv.DictReader(fh)
            fields, rows = r.fieldnames, list(r)
        spacing = np.linalg.norm(p["new_aff"][:3, :3], axis=0)
        for row in rows:
            if row["case_id"] == p["cid"]:
                row["n_slices"] = str(data.shape[2])
                row["slice_thickness"] = f"{spacing[2]:.4f}"
                row["fat_suppressed"] = "True"
        with wl.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=fields)
            w.writeheader()
            w.writerows(rows)
    print(f"  {p['cid']}  swapped; {len(moved)} annotation(s) resampled")


def run(base: Path, plans: list[dict], apply: bool) -> bool:
    if not apply:
        print(f"\nDRY RUN. Re-run with --apply to swap {len(plans)} case(s).")
        return False
    backup = base / "data" / f"_backup_fs_{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    for p in plans:
        swap(base, p, backup)
    if plans:
        print(f"\ndone. Old files are in {backup.relative_to(base)}")
    return True


def cmd_apply(base: Path, apply: bool):
    src = base / "Non BME" / "new" / "new"
    if not src.is_dir():
        sys.exit("Non BME/new/new not found. Teammates: use `install` with the zip instead.")
    run(base, plan(base, lambda f: src / f), apply)


def cmd_zip(base: Path):
    out = base / ZIP_NAME
    files = []
    for cid, (folder, light, dark) in SWAPS.items():
        f = base / "Non BME" / "axial" / folder / dark
        if not f.exists():
            sys.exit(f"{f.relative_to(base)} missing -- run `apply --apply` first")
        files.append((f, f"{folder}/{dark}"))
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps({"kind": "fs_fix", "swaps": SWAPS}, indent=1))
        for f, arc in files:
            z.write(f, arc)
    print(f"wrote {out.name}  ({out.stat().st_size / 1e6:.1f} MB, {len(files)} scan(s), no annotations)")
    print("Share it privately. Teammates put it in the repo root and run: pnpm data:nonbme:fix-fs:install")


def cmd_install(base: Path, apply: bool):
    zp = base / ZIP_NAME
    if not zp.exists():
        sys.exit(f"{ZIP_NAME} not found in {base}. Download it and put it in the repo root.")
    with tempfile.TemporaryDirectory() as tmp:
        with zipfile.ZipFile(zp) as z:
            man = json.loads(z.read("manifest.json"))
            if man.get("kind") != "fs_fix" or man.get("swaps") != {k: list(v) for k, v in SWAPS.items()}:
                sys.exit(f"{ZIP_NAME} does not match this version of the script; git pull first")
            for name in z.namelist():
                if name != "manifest.json" and (".." in name or name.startswith("/")):
                    sys.exit(f"unsafe path in zip: {name}")
            z.extractall(tmp)
        done = run(base, plan(base, lambda f: Path(tmp) / f), apply)
    if done:
        zp.unlink()
        print(f"{ZIP_NAME} deleted")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["apply", "zip", "install"])
    ap.add_argument("root", type=Path)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    base = args.root.resolve()
    if args.cmd != "zip":
        print(f"mode    {'APPLY' if args.apply else 'DRY RUN - nothing written'}\n")
    {"apply": lambda: cmd_apply(base, args.apply),
     "zip": lambda: cmd_zip(base),
     "install": lambda: cmd_install(base, args.apply)}[args.cmd]()


if __name__ == "__main__":
    main()
