#!/usr/bin/env python3
"""剪映导出的素材落地：校验素材 id，按平台生成的文件名下载到本地。

用法：export_media.py <timeline.json> <job.json> <media 目录> <输出的 timeline.enriched.json>

时间线里的素材 id 和 R2 key 都来自用户可编辑的文档，绝不拼进本地路径：
- 素材 id 只许字母、数字、- 和 _（与站点 src/features/editor/timeline/types.ts 同一规则），
  不合规整份导出失败；
- 本地文件名按序号生成（asset-0000.mp4），扩展名只从媒体白名单里取。
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
from typing import Any

ASSET_ID = re.compile(r"[A-Za-z0-9_-]{1,100}")
MEDIA_EXTS = frozenset({
    ".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi",
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".avif",
    ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac",
})
KIND_EXT = {"video": ".mp4", "image": ".jpg", "audio": ".m4a"}


def is_asset_id(aid: Any) -> bool:
    return isinstance(aid, str) and ASSET_ID.fullmatch(aid) is not None


def media_ext(meta: dict[str, Any]) -> str:
    """素材本地文件的扩展名：R2 key 的扩展名在白名单里才用，否则按素材类型给默认值。"""
    ext = os.path.splitext(str(meta.get("r2") or ""))[1].lower()
    if ext in MEDIA_EXTS:
        return ext
    return KIND_EXT.get(str(meta.get("kind")), ".bin")


def checked_assets(doc: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """返回文档的素材表；有任何不合规的 id 或条目就抛 ValueError。"""
    assets = doc.get("assets") or {}
    if not isinstance(assets, dict):
        raise ValueError("timeline assets must be an object")
    for n, (aid, meta) in enumerate(assets.items()):
        if not is_asset_id(aid) or not isinstance(meta, dict):
            raise ValueError(f"invalid asset id at #{n}")
    return assets


def stage(doc: dict[str, Any], urls: dict[str, Any], media_dir: str) -> None:
    """下载每个素材到 media_dir 下平台生成的文件名，并把路径写回 localPath。"""
    for n, (aid, meta) in enumerate(checked_assets(doc).items()):
        path = os.path.join(media_dir, f"asset-{n:04d}{media_ext(meta)}")
        url = urls.get(aid)
        if isinstance(url, str) and url.startswith(("https://", "http://")):
            urllib.request.urlretrieve(url, path)
        meta["localPath"] = path


def main() -> None:
    timeline_path, job_path, media_dir, out_path = sys.argv[1:5]
    doc = json.load(open(timeline_path, encoding="utf-8"))
    job = json.load(open(job_path, encoding="utf-8"))
    # 可选的预签名表：{ 素材 id: url }
    urls = job.get("assetUrls") or {}
    if not isinstance(urls, dict):
        raise ValueError("assetUrls must be an object")
    os.makedirs(media_dir, exist_ok=True)
    try:
        stage(doc, urls, media_dir)
    except ValueError as e:
        sys.exit(str(e))
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(doc, f)


if __name__ == "__main__":
    main()
