#!/usr/bin/env python3
"""Validate draft_content.json matches pyJianYingDraft output shape."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any


REQUIRED_TOP = {
    "canvas_config",
    "duration",
    "fps",
    "materials",
    "tracks",
    "version",
}


def validate_draft_content(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for key in REQUIRED_TOP:
        if key not in data:
            errors.append(f"missing top-level key: {key}")
    if "fps" in data and not isinstance(data["fps"], (int, float)):
        errors.append("fps must be numeric")
    if "duration" in data and not isinstance(data["duration"], (int, float)):
        errors.append("duration must be numeric")
    if "tracks" in data:
        if not isinstance(data["tracks"], list):
            errors.append("tracks must be a list")
        else:
            for i, tr in enumerate(data["tracks"]):
                if not isinstance(tr, dict):
                    errors.append(f"tracks[{i}] must be object")
                    continue
                if "type" not in tr:
                    errors.append(f"tracks[{i}] missing type")
                if "segments" not in tr:
                    errors.append(f"tracks[{i}] missing segments")
    mats = data.get("materials")
    if mats is not None and not isinstance(mats, dict):
        errors.append("materials must be object")
    return errors


V2_BODY_FILES = ("draft_info.json", "draft_content.json", "template-2.tmp")
V2_DIRS = (".backup", "Resources", "adjust_mask", "common_attachment",
           "matting", "qr_upload", "smart_crop", "subdraft")
V2_PLATFORM = {"app_id": 3704, "app_source": "lv", "app_version": "5.9.0", "os": "windows"}
PLACEHOLDER_PREFIX = "##_draftpath_placeholder_"


def validate_draft_dir(draft_dir: Path, *, installed: bool = False) -> list[str]:
    """Check the v2 layout that 剪映 Mac 10.1 accepts.

    installed=False: zip form (paths must be placeholders, media bundled).
    installed=True: after the install script (no placeholders left, absolute paths exist).
    """
    errors: list[str] = []
    texts = {}
    for name in V2_BODY_FILES:
        p = draft_dir / name
        if not p.is_file():
            errors.append(f"missing {name}")
        else:
            texts[name] = p.read_text(encoding="utf-8")
    if len(set(texts.values())) > 1:
        errors.append("draft_info.json / draft_content.json / template-2.tmp differ")
    for d in V2_DIRS:
        if not (draft_dir / d).is_dir():
            errors.append(f"missing dir {d}/")
    for f in ("draft_meta_info.json", "draft_settings"):
        if not (draft_dir / f).is_file():
            errors.append(f"missing {f}")
    if not texts.get("draft_content.json"):
        return errors
    body = json.loads(texts["draft_content.json"])
    errors += validate_draft_content(body)
    if body.get("platform") != V2_PLATFORM or body.get("last_modified_platform") != V2_PLATFORM:
        errors.append("platform/last_modified_platform must be 5.9.0/windows")
    if body.get("version") != 360000 or body.get("new_version") != "110.0.0":
        errors.append("version must be 360000 / new_version 110.0.0")
    if not isinstance(body.get("duration"), int) or body["duration"] <= 0:
        errors.append("duration must be positive int microseconds")
    mats = body.get("materials") or {}
    ids = {m.get("id") for v in mats.values() if isinstance(v, list) for m in v if isinstance(m, dict)}
    paths = []
    for kind in ("videos", "audios"):
        for m in mats.get(kind) or []:
            paths.append(m.get("path") or "")
    for i, tr in enumerate(body.get("tracks") or []):
        segs = tr.get("segments") or []
        if not segs:
            errors.append(f"tracks[{i}] ({tr.get('type')}) is empty")
        for s in segs:
            if s.get("material_id") not in ids:
                errors.append(f"tracks[{i}] segment {s.get('id')} -> unknown material")
            tr_ = s.get("target_timerange") or {}
            if not all(isinstance(tr_.get(k), int) for k in ("start", "duration")):
                errors.append(f"tracks[{i}] segment {s.get('id')} timerange not int us")
    for p in paths:
        if installed:
            if PLACEHOLDER_PREFIX in p or not os.path.isabs(p) or not os.path.isfile(p):
                errors.append(f"media path not resolved: {p}")
        else:
            if not p.startswith(PLACEHOLDER_PREFIX):
                errors.append(f"media path is not a draft placeholder: {p}")
            elif not (draft_dir / p.split("/", 1)[1]).is_file():
                errors.append(f"bundled media missing: {p}")
    meta_p = draft_dir / "draft_meta_info.json"
    if meta_p.is_file():
        meta = json.loads(meta_p.read_text(encoding="utf-8"))
        if not meta.get("draft_name"):
            errors.append("meta.draft_name empty")
        if meta.get("tm_duration") != body.get("duration"):
            errors.append("meta.tm_duration != duration")
        groups = {g.get("type"): g.get("value") for g in meta.get("draft_materials") or []}
        if len(groups.get(0) or []) != len(paths):
            errors.append("meta.draft_materials[0] does not list every media file")
    return errors


def main() -> None:
    path = Path(sys.argv[1])
    installed = "--installed" in sys.argv[2:]
    if path.is_dir():
        errors = validate_draft_dir(path, installed=installed)
    else:
        data = json.loads(path.read_text(encoding="utf-8"))
        errors = validate_draft_content(data)
    if errors:
        for e in errors:
            print(e, file=sys.stderr)
        sys.exit(1)
    print("ok")


if __name__ == "__main__":
    main()
