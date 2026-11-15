"""Compute marked vs total axial slices and identify duplicate annotations.

Usage:
    python ml/scripts/annotation_slices.py <base> <CASE>

Prints ONE JSON object to stdout:
    {
        "<file name>": {
            "marked": int | null,
            "total": int | null,
            "identical_to": str | null,
            "error"?: str
        }
    }
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import nrrd


def determine_slice_axis(header: dict, shape: tuple[int, ...]) -> int:
    sd = header.get("space directions")
    if sd is not None:
        try:
            lengths = []
            for item in sd:
                if item is None:
                    lengths.append(0.0)
                    continue
                arr = np.array(item, dtype=float)
                if np.isnan(arr).any():
                    lengths.append(0.0)
                else:
                    norm = float(np.linalg.norm(arr))
                    lengths.append(norm)
            if lengths and any(l > 0 for l in lengths):
                max_l = max(lengths)
                min_l = min(lengths)
                if max_l > min_l + 1e-6:
                    axis = int(np.argmax(lengths))
                    if axis < len(shape):
                        return axis
                return int(np.argmax(shape))
        except Exception:
            pass
    return int(np.argmax(shape))


def compute_file_slices(file_path: Path) -> tuple[int, int, str, tuple[int, ...]]:
    data, header = nrrd.read(str(file_path))
    shape = tuple(int(s) for s in data.shape)
    axis = determine_slice_axis(header, shape)
    total = int(shape[axis])

    if data.ndim == 1:
        marked = int(np.count_nonzero(data != 0))
    else:
        reduce_axes = tuple(i for i in range(data.ndim) if i != axis)
        has_paint = np.any(data != 0, axis=reduce_axes)
        marked = int(np.count_nonzero(has_paint))

    # Fast hash of the array bytes for equality comparison
    data_hash = hashlib.sha256(data.tobytes()).hexdigest()
    return marked, total, data_hash, shape


def main() -> None:
    if len(sys.argv) < 3:
        print(json.dumps({}))
        sys.exit(0)

    base = Path(sys.argv[1])
    case_id = sys.argv[2]

    case_dir = base / "data" / "annotations" / case_id
    if not case_dir.exists():
        print(json.dumps({}))
        sys.exit(0)

    # Find all <CASE>*.seg.nrrd in data/annotations/<CASE>/
    files = sorted(
        [
            p for p in case_dir.iterdir()
            if p.is_file() and p.name.startswith(case_id) and p.name.endswith(".seg.nrrd")
        ],
        key=lambda p: p.name,
    )

    if not files:
        print(json.dumps({}))
        sys.exit(0)

    cache_file = base / "data" / ".cache" / "slices.json"
    cache: dict[str, dict] = {}
    if cache_file.exists():
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                loaded = json.load(f)
                if isinstance(loaded, dict):
                    cache = loaded
        except Exception:
            cache = {}

    cache_dirty = False
    processed: dict[str, dict] = {}

    for p in files:
        try:
            st = p.stat()
            size = st.st_size
            mtime = st.st_mtime
        except Exception as e:
            processed[p.name] = {
                "marked": None,
                "total": None,
                "error": str(e),
                "hash": None,
                "shape": None,
            }
            continue

        cached_entry = cache.get(p.name)
        if (
            isinstance(cached_entry, dict)
            and cached_entry.get("size") == size
            and abs(cached_entry.get("mtime", 0) - mtime) < 1e-4
        ):
            processed[p.name] = cached_entry
            continue

        try:
            marked, total, data_hash, shape = compute_file_slices(p)
            entry = {
                "size": size,
                "mtime": mtime,
                "marked": marked,
                "total": total,
                "hash": data_hash,
                "shape": list(shape),
                "error": None,
            }
            processed[p.name] = entry
            cache[p.name] = entry
            cache_dirty = True
        except Exception as e:
            err_entry = {
                "size": size,
                "mtime": mtime,
                "marked": None,
                "total": None,
                "hash": None,
                "shape": None,
                "error": str(e)[:120],
            }
            processed[p.name] = err_entry
            cache[p.name] = err_entry
            cache_dirty = True

    # Check identical arrays between files in the same case
    main_file_name = f"{case_id}.seg.nrrd"
    result: dict[str, dict] = {}

    for p in files:
        info = processed.get(p.name, {})
        if info.get("error") is not None or info.get("hash") is None:
            result[p.name] = {
                "marked": None,
                "total": None,
                "identical_to": None,
                "error": info.get("error") or "Unreadable file",
            }
            continue

        p_hash = info["hash"]
        p_shape = info.get("shape")

        # Find matching candidates
        matching: list[str] = []
        for other_p in files:
            if other_p.name == p.name:
                continue
            other_info = processed.get(other_p.name, {})
            if (
                other_info.get("error") is None
                and other_info.get("hash") == p_hash
                and other_info.get("shape") == p_shape
            ):
                matching.append(other_p.name)

        identical_to: str | None = None
        if matching:
            person_copies = [name for name in matching if name != main_file_name]
            if person_copies:
                identical_to = sorted(person_copies)[0]
            elif main_file_name in matching:
                identical_to = main_file_name
            else:
                identical_to = sorted(matching)[0]

        result[p.name] = {
            "marked": info["marked"],
            "total": info["total"],
            "identical_to": identical_to,
        }

    # Atomically persist updated cache
    if cache_dirty:
        try:
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            temp_cache = cache_file.with_name(f"slices.{os.getpid()}.{time.time()}.tmp")
            with open(temp_cache, "w", encoding="utf-8") as f:
                json.dump(cache, f, indent=2)
            temp_cache.replace(cache_file)
        except Exception:
            try:
                if "temp_cache" in locals() and temp_cache.exists():
                    temp_cache.unlink()
            except Exception:
                pass

    print(json.dumps(result))
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({}))
        sys.exit(0)
