"""Append one training run to data/training_log.csv.

Both the 2D and 3D trainers call this after metrics.json is written, so one
sheet holds every run. Missing numbers stay blank. Case ids are not written.
"""

from __future__ import annotations

import csv
from datetime import datetime
from pathlib import Path

FIELDS = [
    "finished_at",
    "task",
    "model",
    "device",
    "out_dir",
    "folds",
    "epochs",
    "n_cases",
    "n_slices",
    "n_bme",
    "n_negative",
    "bone_dice_mean",
    "bone_dice_std",
    "bone_precision_mean",
    "bone_precision_std",
    "bone_recall_mean",
    "bone_recall_std",
    "bone_f1_mean",
    "bone_f1_std",
    "bone_iou_mean",
    "bone_iou_std",
    "edema_dice_mean",
    "edema_dice_std",
    "edema_precision_mean",
    "edema_precision_std",
    "edema_recall_mean",
    "edema_recall_std",
    "edema_f1_mean",
    "edema_f1_std",
    "edema_iou_mean",
    "edema_iou_std",
    "lesion_sensitivity_mean",
    "lesion_sensitivity_std",
    "fp_mean",
    "fp_std",
    "fp_unit",
    "presence_correct",
    "presence_n",
    "patch",
]


def _num(summary: dict | None, key: str, part: str) -> str:
    if not summary:
        return ""
    block = summary.get(key)
    if not isinstance(block, dict) or block.get(part) is None:
        return ""
    return f"{float(block[part]):.6f}"


def append_run(base: Path, row: dict) -> Path:
    path = base / "data" / "training_log.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    record = {k: "" if row.get(k) is None else row.get(k) for k in FIELDS}
    record["finished_at"] = record["finished_at"] or datetime.now().isoformat(timespec="seconds")
    try:
        with path.open("a", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=FIELDS)
            if new:
                writer.writeheader()
            writer.writerow(record)
        return path
    except PermissionError:
        # The sheet is often open in the editor. Keep the row rather than fail the run.
        fallback = path.with_name("training_log.pending.csv")
        fresh = not fallback.exists()
        with fallback.open("a", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=FIELDS)
            if fresh:
                writer.writeheader()
            writer.writerow(record)
        print(f"training_log.csv is locked. Row saved to {fallback}", flush=True)
        return fallback


def from_summary(base: Path, *, task: str, model: str, device: str, out_dir: str,
                 folds, epochs, n_cases, summary: dict, n_slices="", n_bme="",
                 n_negative="", fp_key="fp_per_case", fp_unit="", presence_correct="",
                 presence_n="", patch="") -> Path:
    edema_key = "bme_dice" if "bme_dice" in (summary or {}) else "lesion_dice"
    return append_run(base, {
        "task": task,
        "model": model,
        "device": device,
        "out_dir": out_dir,
        "folds": folds,
        "epochs": epochs,
        "n_cases": n_cases,
        "n_slices": n_slices,
        "n_bme": n_bme,
        "n_negative": n_negative,
        "bone_dice_mean": _num(summary, "bone_dice", "mean"),
        "bone_dice_std": _num(summary, "bone_dice", "std"),
        "bone_precision_mean": _num(summary, "bone_precision", "mean"),
        "bone_precision_std": _num(summary, "bone_precision", "std"),
        "bone_recall_mean": _num(summary, "bone_recall", "mean"),
        "bone_recall_std": _num(summary, "bone_recall", "std"),
        "bone_f1_mean": _num(summary, "bone_f1", "mean"),
        "bone_f1_std": _num(summary, "bone_f1", "std"),
        "bone_iou_mean": _num(summary, "bone_iou", "mean"),
        "bone_iou_std": _num(summary, "bone_iou", "std"),
        "edema_dice_mean": _num(summary, edema_key, "mean"),
        "edema_dice_std": _num(summary, edema_key, "std"),
        "edema_precision_mean": _num(summary, "edema_precision", "mean"),
        "edema_precision_std": _num(summary, "edema_precision", "std"),
        "edema_recall_mean": _num(summary, "edema_recall", "mean"),
        "edema_recall_std": _num(summary, "edema_recall", "std"),
        "edema_f1_mean": _num(summary, "edema_f1", "mean"),
        "edema_f1_std": _num(summary, "edema_f1", "std"),
        "edema_iou_mean": _num(summary, "edema_iou", "mean"),
        "edema_iou_std": _num(summary, "edema_iou", "std"),
        "lesion_sensitivity_mean": _num(summary, "lesion_sensitivity", "mean"),
        "lesion_sensitivity_std": _num(summary, "lesion_sensitivity", "std"),
        "fp_mean": _num(summary, fp_key, "mean"),
        "fp_std": _num(summary, fp_key, "std"),
        "fp_unit": fp_unit,
        "presence_correct": presence_correct,
        "presence_n": presence_n,
        "patch": patch,
    })
