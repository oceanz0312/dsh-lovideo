#!/bin/bash
# lovideo → 剪映专业版 (macOS) 一键导入。用法：双击，或 ./install_mac.command [草稿名]
# 会把同目录下的 lovideo_timeline 复制进剪映草稿目录，并把路径占位符替换为真实路径。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/lovideo_timeline"
NAME="${1:-lovideo_$(date +%m%d_%H%M%S)}"
ROOT="${JIANYING_DRAFT_ROOT:-$HOME/Movies/JianyingPro/User Data/Projects/com.lveditor.draft}"
PH='##_draftpath_placeholder_0E685133-18CE-45ED-8CB8-2904A212EC80_##'
RPH='##_lovideo_draft_root_##'
[ -d "$SRC" ] || { echo "找不到 ${SRC}（请先解压 zip）"; exit 1; }
[ -d "$ROOT" ] || { echo "找不到剪映草稿目录：${ROOT}（请先安装并打开一次剪映专业版）"; exit 1; }
case "$NAME" in */*|*\\*|"") echo "草稿名不合法：$NAME"; exit 1;; esac
DEST="$ROOT/$NAME"
[ -e "$DEST" ] && { echo "已存在同名草稿：$DEST，请换个名字"; exit 1; }
if pgrep -x VideoFusion-macOS >/dev/null 2>&1; then
  echo "提示：剪映正在运行，建议先退出（⌘Q）再导入，导入后重新打开剪映。"
fi
cp -R "$SRC" "$DEST"
esc() { printf '%s' "$1" | sed -e 's/[\/&|]/\\&/g'; }
D_ESC=$(esc "$DEST"); R_ESC=$(esc "$ROOT"); N_ESC=$(esc "$NAME")
for f in draft_info.json draft_content.json template-2.tmp draft_meta_info.json; do
  [ -f "$DEST/$f" ] || continue
  LC_ALL=C sed -i '' -e "s|$PH|$D_ESC|g" -e "s|$RPH|$R_ESC|g" "$DEST/$f"
done
LC_ALL=C sed -i '' -E "s|(\"draft_name\": *\")[^\"]*\"|\\1$N_ESC\"|" "$DEST/draft_meta_info.json"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
echo "已导入：$DEST"
echo "请重新打开剪映专业版，在草稿列表中找到「${NAME}」。"
