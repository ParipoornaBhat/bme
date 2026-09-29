"""Turn Non BME DICOM zips into lightweight NRRD folders.

    python ml/scripts/nonbme_to_nrrd.py "D:/Final yr Prj/bme"
    python ml/scripts/nonbme_to_nrrd.py "D:/Final yr Prj/bme" --apply

Reads every .zip in `Non BME/3d`. Each zip is one patient. The DICOM series
inside are written as compressed .nrrd files under:

    Non BME/new/1/name.json
    Non BME/new/1/<series>.nrrd
    Non BME/new/2/...

name.json holds the zip filename, which is the patient name. It stays inside
`Non BME/`, which is gitignored. A zip is deleted only after its nrrd files
are written. Without --apply, nothing is written and nothing is deleted.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

try:
    import SimpleITK as sitk
except ImportError:
    sys.exit("SimpleITK missing.  pip install SimpleITK")

try:
    import pydicom
except ImportError:
    sys.exit("pydicom missing.  pip install pydicom")


def slug(text: str, fallback: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "_", text.strip().lower()).strip("_")
    return (cleaned or fallback)[:48]


def plane_of(image) -> str:
    """Which way the slices were acquired. The other two views are rebuilt from these."""
    d = image.GetDirection()
    axis = [abs(d[2]), abs(d[5]), abs(d[8])]
    return ["sag", "cor", "tra"][axis.index(max(axis))]


def read_group(files: list[str]):
    if len(files) == 1:
        return sitk.ReadImage(files[0])
    reader = sitk.ImageSeriesReader()
    reader.SetFileNames(files)
    return reader.Execute()


def read_series(files: list[str]) -> list:
    """Every slice is kept. Different sizes in one series become separate volumes."""
    groups: dict[tuple[int, int], list[str]] = {}
    unread = []
    for f in files:
        try:
            ds = pydicom.dcmread(f, stop_before_pixels=True, force=True)
            key = (int(getattr(ds, "Rows", 0) or 0), int(getattr(ds, "Columns", 0) or 0))
        except Exception:
            unread.append(f)
            continue
        groups.setdefault(key, []).append(f)
    images = []
    for group in list(groups.values()) + ([[f] for f in unread]):
        try:
            images.append(read_group(group))
        except Exception:
            for one in group:
                try:
                    images.append(sitk.ReadImage(one))
                except Exception:
                    pass
    return images


def name_images(images) -> list[tuple[str, object]]:
    """tra, cor, sag. A second scan of the same direction becomes tra-1, cor-1."""
    buckets: dict[str, list] = {"tra": [], "cor": [], "sag": []}
    for image in images:
        buckets[plane_of(image)].append(image)
    named = []
    for plane, group in buckets.items():
        group.sort(key=lambda im: im.GetSize()[2], reverse=True)
        for i, image in enumerate(group):
            named.append((plane if i == 0 else f"{plane}-{i}", image))
    return named


def relabel_existing(dest_root: Path) -> int:
    """Rename nrrds already written as series_N, using the image orientation."""
    changed = 0
    if not dest_root.is_dir():
        return 0
    for folder in sorted(p for p in dest_root.iterdir() if p.is_dir() and p.name.isdigit()):
        files = list(folder.glob("*.nrrd"))
        if not files or all(p.stem.split("-")[0] in ("tra", "cor", "sag") for p in files):
            continue
        named = name_images([sitk.ReadImage(str(p)) for p in files])
        temps = []
        for name, image in named:
            tmp = folder / f".tmp-{name}.nrrd"
            sitk.WriteImage(image, str(tmp), useCompression=True)
            temps.append(tmp)
        for old in files:
            old.unlink()
        finals = []
        for tmp in temps:
            final = folder / (tmp.name.removeprefix(".tmp-"))
            if final.exists():
                final.unlink()
            tmp.rename(final)
            finals.append(final.name)
        changed += 1
        print(f"  new/{folder.name}  {' '.join(finals)}")
    return changed


def next_number(dest: Path) -> int:
    highest = 0
    if dest.is_dir():
        for child in dest.iterdir():
            if child.is_dir() and child.name.isdigit():
                highest = max(highest, int(child.name))
    return highest + 1


def dicom_dirs(root: Path) -> list[Path]:
    found = []
    for folder in [root, *root.rglob("*")]:
        if not folder.is_dir():
            continue
        if any(folder.glob("*.dcm")) or any(folder.glob("*.DCM")):
            found.append(folder)
    return found


def convert_zip(zip_path: Path, out_dir: Path) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    with tempfile.TemporaryDirectory(prefix="bme-nonbme-") as tmp:
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(tmp)
        seen = set()
        images = []
        for folder in dicom_dirs(Path(tmp)):
            ids = sitk.ImageSeriesReader.GetGDCMSeriesIDs(str(folder)) or []
            for sid in ids:
                if sid in seen:
                    continue
                seen.add(sid)
                files = sitk.ImageSeriesReader.GetGDCMSeriesFileNames(str(folder), sid)
                images.extend(read_series(list(files)))
        for name, image in name_images(images):
            target = out_dir / f"{name}.nrrd"
            sitk.WriteImage(image, str(target), useCompression=True)
            written.append(target.name)
    if not written:
        shutil.rmtree(out_dir, ignore_errors=True)
        raise RuntimeError("no DICOM series in the zip")
    (out_dir / "name.json").write_text(
        json.dumps({"name": zip_path.stem}, indent=2),
        encoding="utf-8",
    )
    return len(written)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--relabel", action="store_true", help="rename nrrds already written in Non BME/new")
    args = ap.parse_args()

    root = Path(args.base) / "Non BME" / "3d"
    dest_root = Path(args.base) / "Non BME" / "new"
    if not root.is_dir():
        sys.exit(f"missing {root}")
    zips = sorted(p for p in root.iterdir() if p.is_file() and p.suffix.lower() == ".zip")
    if not zips:
        sys.exit(f"no zip files in {root}")

    print(f"{len(zips)} zip(s) in Non BME/3d")
    if args.relabel:
        n = relabel_existing(dest_root)
        print(f"renamed {n} folder(s)")
        if not args.apply:
            return
    if not args.apply:
        print(f"would write Non BME/new/{next_number(dest_root)} onward, then delete each zip")
        print("dry run: nothing written and nothing deleted. Add --apply to convert.")
        return

    number = next_number(dest_root)
    done = 0
    for zip_path in zips:
        out = dest_root / str(number)
        try:
            count = convert_zip(zip_path, out)
        except (zipfile.BadZipFile, RuntimeError, OSError) as e:
            print(f"  new/{number}  skipped: {e}")
            continue
        zip_path.unlink()
        print(f"  new/{number}  {count} nrrd, zip removed")
        done += 1
        number += 1
    print(f"\nconverted {done}. Names stay in Non BME/new/<n>/name.json only.")


if __name__ == "__main__":
    main()
