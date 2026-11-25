#!/usr/bin/env python3
"""timeline.json → 剪映 draft (pyJianYingDraft), packaged for the export job."""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any


def _stage_media(doc: dict[str, Any], media_dir: Path) -> dict[str, str]:
    """Link each asset's local file into media_dir; return assetId → absolute path.

    Files are named by asset id: keys from different jobs share file names
    (jobs/<a>/shots/01.mp4, jobs/<b>/shots/01.mp4), asset ids never collide, and
    the draft bundles media by file name.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from export_media import checked_assets, media_ext

    staged: dict[str, str] = {}
    # 素材 id 已限定为字母、数字、- 和 _，扩展名只取白名单，拼出的文件名留在 media_dir 里
    for aid, asset in checked_assets(doc).items():
        src = asset.get("localPath")
        if not src or not os.path.isfile(src) or os.path.getsize(src) == 0:
            continue
        dest = media_dir / f"{aid}{media_ext(asset)}"
        try:
            os.link(src, dest)
        except OSError:
            shutil.copy2(src, dest)
        staged[aid] = str(dest.resolve())
    return staged


def export_jianying(doc: dict[str, Any], out: Path, media: dict[str, str]) -> None:
    import pyJianYingDraft as jy

    output = doc.get("output") or {}
    width = int(output.get("width") or 1080)
    height = int(output.get("height") or 1920)
    fps = int(output.get("fps") or 30)

    jy_root = out / "jianying_draft"
    jy_root.mkdir(parents=True, exist_ok=True)
    folder = jy.DraftFolder(str(jy_root))
    draft_name = "lovideo_timeline"
    if folder.has_draft(draft_name):
        folder.remove(draft_name)
    script = folder.create_draft(
        draft_name, width, height, fps, allow_replace=True
    )

    assets = doc.get("assets") or {}

    def _is_bgm_clip_jy(clip: dict[str, Any]) -> bool:
        label = str(clip.get("label") or "").lower()
        aid = str(clip.get("asset") or "")
        if "bgm" in label or "a_bgm" in aid:
            return True
        meta = assets.get(aid) or {}
        r2 = str(meta.get("r2") or "").lower()
        return r2.endswith((".mp3", ".wav", ".m4a", ".aac")) and "bgm" in r2

    sys.path.insert(0, str(Path(__file__).resolve().parent / "adapters" / "jianying"))
    from jianying_map import build_script

    report = build_script(jy, script, doc, media.get, _is_bgm_clip_jy)
    (out / "jianying_report.json").write_text(
        json.dumps(
            {"degraded": report.degraded, "experimental": report.experimental,
             "mapped": report.mapped},
            ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    script.save()

    draft_dir = jy_root / draft_name
    # v2 layout (verified on 剪映 Mac 10.1): media bundled under the draft with path
    # placeholders, identical draft_info/draft_content/template-2.tmp, no empty tracks.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from jianying_v2 import copy_install_scripts, finalize_v2
    from jianying_validate import validate_draft_dir

    finalize_v2(draft_dir, draft_name)
    errors = validate_draft_dir(draft_dir)
    if errors:
        raise RuntimeError("剪映 draft validation failed: " + "; ".join(errors[:10]))
    scripts = copy_install_scripts(jy_root)
    zip_path = out / "jianying_draft.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(draft_dir):
            rel_root = os.path.relpath(root, jy_root)
            if not files and not dirs:
                zf.writestr(rel_root.replace(os.sep, "/") + "/", "")
            for fn in files:
                full = Path(root) / fn
                zf.write(full, os.path.relpath(full, jy_root))
        for sp in scripts:
            info = zipfile.ZipInfo(sp.name)
            info.external_attr = (0o755 if sp.suffix == ".command" else 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, sp.read_bytes())


README = """# Lovideo project package

The finished film is the MP4 you download from the workspace. This package holds the
same timeline as an editable 剪映专业版 (Jianying Pro) draft.

## 剪映专业版 (Jianying Pro)
1. Unzip `jianying_draft.zip`.
2. Quit 剪映, then run the import script next to `lovideo_timeline` (do NOT copy the folder by hand;
   media paths are placeholders the script fills in):
   - **macOS**: double-click `install_mac.command` (or `./install_mac.command <draft name>`)
   - **Windows**: double-click `install_windows.bat`
3. Reopen 剪映 and find the draft in the draft list. Media is bundled inside the draft.
4. Format: pyJianYingDraft 0.3.1 + v2 layout, verified on 剪映专业版 Mac 10.1.0.

`jianying_report.json` lists the effects that were approximated or dropped in the draft.
"""


def main() -> None:
    doc_path, out_dir = sys.argv[1], sys.argv[2]
    doc = json.load(open(doc_path, encoding="utf-8"))
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "README.md").write_text(README, encoding="utf-8")
    with tempfile.TemporaryDirectory() as media_dir:
        export_jianying(doc, out, _stage_media(doc, Path(media_dir)))


if __name__ == "__main__":
    main()
