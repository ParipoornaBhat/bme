"""Scan fingerprint and annotation metadata helper for cloud annotation sync.

    python ml/scripts/annotation_sync_info.py <base> [--labels] <CASE> [<CASE> ...]

Prints one JSON object: for each case
    {"scan": <fingerprint or null>, "files": {"<file name>": {"has_bone": bool, ["labels_gz_b64": str]}}}
for every *.seg.nrrd in data/annotations/<CASE>/.
"""

from __future__ import annotations

import base64
import gzip
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import nibabel as nib  # noqa: E402

from read_seg import build_labelmap, read_segmentation, to_volume_grid  # noqa: E402
from team_annotations import has_bone, volume_fingerprint  # noqa: E402


def main():
    args = sys.argv[1:]
    with_labels = "--labels" in args
    args = [a for a in args if a != "--labels"]

    if len(args) < 1:
        sys.exit("usage: python ml/scripts/annotation_sync_info.py <base> [--labels] <CASE> [<CASE> ...]")

    base = Path(args[0])
    case_ids = args[1:]

    cache = {}
    cache_path = base / "data" / ".cache" / "scan_fingerprints.json"
    if cache_path.is_file():
        try:
            loaded = json.loads(cache_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                cache = loaded
        except Exception:
            cache = {}

    cache_dirty = False
    result: dict[str, dict] = {}

    for cid in case_ids:
        # Determine scan fingerprint (cached by case with file size and mtime)
        scan_path = base / "data" / "nifti" / cid / f"{cid}_primary.nii.gz"
        fp: str | None = None
        if scan_path.is_file():
            try:
                st = scan_path.stat()
                size = st.st_size
                mtime = st.st_mtime
                cached_entry = cache.get(cid)
                if (
                    isinstance(cached_entry, dict)
                    and cached_entry.get("size") == size
                    and abs(float(cached_entry.get("mtime", 0)) - mtime) < 1e-3
                    and "fingerprint" in cached_entry
                ):
                    fp = cached_entry["fingerprint"]
                else:
                    try:
                        fp = volume_fingerprint(scan_path)
                    except Exception:
                        fp = None
                    cache[cid] = {"size": size, "mtime": mtime, "fingerprint": fp}
                    cache_dirty = True
            except Exception:
                fp = None

        vol_img = None
        # Inspect all *.seg.nrrd annotation files for this case
        ann_dir = base / "data" / "annotations" / cid
        files_dict: dict[str, dict] = {}
        if ann_dir.is_dir():
            try:
                for p in sorted(ann_dir.glob("*.seg.nrrd")):
                    if not p.is_file():
                        continue
                    try:
                        bone = bool(has_bone(p))
                        entry: dict = {"has_bone": bone}
                    except Exception as e:
                        err_msg = str(e).strip()
                        short_reason = err_msg.splitlines()[0] if err_msg else type(e).__name__
                        files_dict[p.name] = {"has_bone": False, "error": short_reason}
                        continue

                    if with_labels:
                        try:
                            if vol_img is None:
                                if not scan_path.is_file():
                                    raise ValueError(f"no converted volume for {cid}")
                                vol_img = nib.load(str(scan_path))
                            data, header, segments = read_segmentation(p)
                            if not segments:
                                raise ValueError("no segment metadata")
                            lab, _, problems = build_labelmap(data, segments)
                            fatal = [prob for prob in problems if not prob.startswith("required segment")]
                            if fatal:
                                raise ValueError("; ".join(fatal))
                            out, _ = to_volume_grid(lab, header, vol_img)
                            raw_buf = out.ravel(order="F").tobytes()
                            gz_buf = gzip.compress(raw_buf, compresslevel=6)
                            entry["labels_gz_b64"] = base64.b64encode(gz_buf).decode("ascii")
                        except Exception as e:
                            err_msg = str(e).strip()
                            short_reason = err_msg.splitlines()[0] if err_msg else type(e).__name__
                            entry["error"] = short_reason

                    files_dict[p.name] = entry
            except Exception:
                pass

        result[cid] = {
            "scan": fp,
            "files": files_dict,
        }

    if cache_dirty:
        tmp_path = cache_path.with_name(f".tmp_scan_fingerprints_{os.getpid()}.json")
        try:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            tmp_path.write_text(json.dumps(cache, indent=2), encoding="utf-8")
            tmp_path.replace(cache_path)
        except Exception:
            try:
                if tmp_path.exists():
                    tmp_path.unlink()
            except Exception:
                pass

    print(json.dumps(result))


if __name__ == "__main__":
    main()
