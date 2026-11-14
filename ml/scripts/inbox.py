"""Inbox layout for dropped datasets, bundles, teammate zips, and outgoing bundles.

Keeps all incoming and outgoing artifacts under a single gitignored inbox/ tree
in the repo root, while falling back to legacy drop locations so existing workflows
and unmigrated directories continue to work.
"""

from __future__ import annotations

from pathlib import Path

INBOX = "inbox"

SUBDIRS: dict[str, str] = {
    "bme": "bme",
    "bundles": "bundles",
    "nonbme-dicom": "nonbme-dicom",
    "nonbme": "nonbme",
    "team": "team",
    "fixes": "fixes",
    "outgoing": "outgoing",
}

# Legacy drop locations in order of priority (relative to repo root)
LEGACY_DIRS: dict[str, list[str]] = {
    "bme": ["data/newbme"],
    "bundles": ["", "data", "data/exports"],
    "nonbme-dicom": ["Non BME/3d"],
    "nonbme": ["Non BME/new", "data/newnonbme"],
    "team": ["", "data/exports"],
    "fixes": [""],
    "outgoing": ["data/exports"],
}


def drop_dirs(base: Path | str, kind: str) -> list[Path]:
    """Return drop directories for a given kind: new inbox folder first, then existing legacy locations.

    The first path (the inbox subfolder) is always returned even if it does not yet exist.
    Subsequent legacy locations are only returned if they exist on disk.
    """
    base_path = Path(base)
    subdir = SUBDIRS.get(kind, kind)
    new_dir = base_path / INBOX / subdir
    results: list[Path] = [new_dir]

    for legacy in LEGACY_DIRS.get(kind, []):
        legacy_dir = (base_path / legacy).resolve() if legacy else base_path.resolve()
        if legacy_dir.is_dir() and legacy_dir not in [r.resolve() for r in results]:
            results.append(base_path / legacy if legacy else base_path)

    return results


def outgoing(base: Path | str) -> Path:
    """Return the inbox/outgoing directory, creating it if it does not exist."""
    base_path = Path(base)
    out = base_path / INBOX / SUBDIRS["outgoing"]
    out.mkdir(parents=True, exist_ok=True)
    return out


def ensure(base: Path | str) -> list[Path]:
    """Create the full inbox tree under base if folders do not exist.

    Returns the list of newly created directory paths.
    """
    base_path = Path(base)
    created: list[Path] = []
    for subdir in SUBDIRS.values():
        p = base_path / INBOX / subdir
        if not p.exists():
            p.mkdir(parents=True, exist_ok=True)
            created.append(p)
    return created

