"""Kaggle scan batches: each new set of scans goes into its own dataset, once.

A Kaggle dataset version has to hold every file, so adding one scan to an
existing dataset would re-upload all of them. Instead each batch of new scans
becomes its own dataset (`<slug>-scans-<n>`), uploaded once and never re-sent.
A training run attaches every batch plus the annotations dataset.

A batch manifest records, per case, the sha256 of its primary scan. A scan is
new when no uploaded batch already holds the same case with the same hash.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Dict, Iterable, List, Optional

MANIFEST_NAME = "scans_manifest.json"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def scan_index(nifti_dir: Path) -> Dict[str, Path]:
    """case id -> primary scan file, for every case folder that has one."""
    out: Dict[str, Path] = {}
    if not nifti_dir.is_dir():
        return out
    for case_dir in sorted(p for p in nifti_dir.iterdir() if p.is_dir()):
        primary = case_dir / f"{case_dir.name}_primary.nii.gz"
        if primary.is_file():
            out[case_dir.name] = primary
    return out


def new_scans(local: Dict[str, Path], batches: Iterable[Dict[str, str]]) -> Dict[str, Path]:
    """Scans whose case and hash are not already in any uploaded batch.

    `batches` are the manifests of uploaded batches (case id -> sha256).
    A changed scan (same case, new hash) counts as new.
    """
    known = set()
    for manifest in batches:
        known.update((case, digest) for case, digest in manifest.items())
    result: Dict[str, Path] = {}
    for case, path in local.items():
        digest = sha256_file(path)
        if (case, digest) not in known:
            result[case] = path
    return result


def build_batch_folder(scans: Dict[str, Path], dest: Path) -> Dict[str, str]:
    """Copy the given scans into dest/nifti/<case>/ and write the batch manifest.

    Hard links are used when the filesystem allows them, so no extra disk space
    is taken. Returns the manifest (case id -> sha256).
    """
    if dest.exists():
        shutil.rmtree(dest)
    manifest: Dict[str, str] = {}
    for case, src in sorted(scans.items()):
        target_dir = dest / "nifti" / case
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / src.name
        try:
            target.hardlink_to(src)
        except (OSError, NotImplementedError):
            shutil.copy2(src, target)
        manifest[case] = sha256_file(src)
    (dest / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    return manifest


def read_manifest(folder: Path) -> Optional[Dict[str, str]]:
    path = folder / MANIFEST_NAME
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def next_batch_name(slug: str, existing_names: Iterable[str]) -> str:
    """<slug>-scans-1, -2, ... the first number not already used."""
    used = set(existing_names)
    n = 1
    while f"{slug}-scans-{n}" in used:
        n += 1
    return f"{slug}-scans-{n}"
