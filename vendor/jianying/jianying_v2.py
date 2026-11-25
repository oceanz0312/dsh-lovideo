#!/usr/bin/env python3
"""Post-process a pyJianYingDraft draft into the "v2" layout that 剪映 10.x (Mac) opens.

Verified on 剪映专业版 Mac 10.1.0 (drafts lovideo_v2/v3/v4, 2026-10-16). Mirrors the
layout ChatCut 0.6.9 writes: identical plaintext draft_info.json / draft_content.json /
template-2.tmp, 8 empty dirs, cover, settings, draft_materials index, no empty tracks,
platform pinned to 5.9.0/windows. Paths use placeholders that the bundled install
scripts replace with the user's real draft folder.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

JY_DRAFT_PLACEHOLDER = "##_draftpath_placeholder_0E685133-18CE-45ED-8CB8-2904A212EC80_##"
ROOT_PLACEHOLDER = "##_lovideo_draft_root_##"
PLATFORM = {"app_id": 3704, "app_source": "lv", "app_version": "5.9.0", "os": "windows"}
VERSION = 360000
NEW_VERSION = "110.0.0"
EMPTY_DIRS = (".backup", "Resources", "adjust_mask", "common_attachment",
              "matting", "qr_upload", "smart_crop", "subdraft")
BODY_FILES = ("draft_info.json", "draft_content.json", "template-2.tmp")
MATERIAL_GROUPS = (0, 1, 2, 3, 6, 7, 8)
SCRIPTS_DIR = Path(__file__).with_name("jianying_install")


def bundle_media(body: dict[str, Any], draft_dir: Path) -> None:
    """Copy media into <draft>/media and point materials at the draft placeholder."""
    media_out = draft_dir / "media"
    media_out.mkdir(exist_ok=True)
    for kind in ("videos", "audios"):
        for m in (body.get("materials") or {}).get(kind) or []:
            src = m.get("path") or ""
            if src.startswith(JY_DRAFT_PLACEHOLDER):
                continue
            if os.path.isfile(src):
                dst = media_out / os.path.basename(src)
                if not dst.exists():
                    shutil.copyfile(src, dst)
                m["path"] = f"{JY_DRAFT_PLACEHOLDER}/media/{dst.name}"


def _cover(draft_dir: Path) -> bool:
    out = draft_dir / "draft_cover.jpg"
    try:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=480x270:d=1",
             "-frames:v", "1", str(out)], check=True, timeout=30)
    except Exception:
        try:
            from PIL import Image

            Image.new("RGB", (480, 270)).save(out, "JPEG")
        except Exception:
            return False
    return True


def _material_index(body: dict[str, Any]) -> list[dict[str, Any]]:
    idx = []
    mats = body.get("materials") or {}
    for kind in ("videos", "audios"):
        for m in mats.get(kind) or []:
            p = m.get("path") or ""
            metetype = "music" if kind == "audios" else (m.get("type") or "video")
            idx.append({
                "create_time": -1, "duration": int(m.get("duration") or 0),
                "extra_info": os.path.basename(p), "file_Path": p,
                "height": int(m.get("height") or 0), "id": str(uuid.uuid4()).upper(),
                "import_time": -1, "import_time_ms": -1, "item_source": 1, "md5": "",
                "metetype": metetype,
                "roughcut_time_range": {"duration": -1, "start": -1},
                "sub_time_range": {"duration": -1, "start": -1},
                "type": 0, "width": int(m.get("width") or 0),
            })
    return idx


def finalize_v2(draft_dir: Path, draft_name: str, now: float | None = None) -> dict[str, Any]:
    """Rewrite draft_dir in place into the v2 layout. Returns the final body."""
    now = time.time() if now is None else now
    body = json.loads((draft_dir / "draft_content.json").read_text(encoding="utf-8"))
    bundle_media(body, draft_dir)
    body["tracks"] = [t for t in body.get("tracks") or [] if t.get("segments")]
    body["platform"] = dict(PLATFORM)
    body["last_modified_platform"] = dict(PLATFORM)
    body["version"] = VERSION
    body["new_version"] = NEW_VERSION
    if not body.get("duration"):
        body["duration"] = max(
            (s["target_timerange"]["start"] + s["target_timerange"]["duration"]
             for t in body["tracks"] for s in t["segments"]), default=0)
    text = json.dumps(body, ensure_ascii=False, indent=4)
    for name in BODY_FILES:
        (draft_dir / name).write_text(text, encoding="utf-8")

    for d in EMPTY_DIRS:
        (draft_dir / d).mkdir(exist_ok=True)
    has_cover = _cover(draft_dir)
    sec = int(now)
    (draft_dir / "draft_settings").write_text(
        f"[General]\ndraft_create_time={sec}\ndraft_last_edit_time={sec}\n"
        "real_edit_keys=1\nreal_edit_seconds=0\n", encoding="utf-8")

    meta_path = draft_dir / "draft_meta_info.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    idx = _material_index(body)
    meta["draft_materials"] = [{"type": t, "value": idx if t == 0 else []} for t in MATERIAL_GROUPS]
    now_us = int(now * 1_000_000)
    meta.update(
        draft_id=str(uuid.uuid4()).upper(),
        draft_name=draft_name,
        draft_cover="draft_cover.jpg" if has_cover else "",
        draft_fold_path=JY_DRAFT_PLACEHOLDER,
        draft_root_path=ROOT_PLACEHOLDER,
        tm_duration=int(body["duration"]),
        tm_draft_create=now_us,
        tm_draft_modified=now_us,
    )
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=4), encoding="utf-8")
    return body


def copy_install_scripts(dest: Path) -> list[Path]:
    out = []
    for f in sorted(SCRIPTS_DIR.iterdir()):
        if f.is_file():
            target = dest / f.name
            shutil.copyfile(f, target)
            if f.suffix in (".command", ".sh"):
                target.chmod(0o755)
            out.append(target)
    return out
