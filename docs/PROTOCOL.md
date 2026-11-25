# 和 lovideo 网站对齐的约定

插件和 lovideo 网站（私有仓库）分仓开发、各自发版。下表「网站那边的权威来源」里的路径都在网站仓库里。两边靠下面这几条约定保持一致：
网站改了其中任何一条，插件要跟着改。除此之外，两边可以自由迭代。

| 约定 | 网站那边的权威来源 | 插件这边的实现 |
| --- | --- | --- |
| 登录和站点接口 | `docs/PLUGIN-API.md`（设备码登录、Better Auth 的 `/api/auth/get-session`、`/api/v1/styles`、风格包下载） | `src/host/site.js`、`src/host/styles.js` |
| 风格包格式 | `docs/STYLE-SKILL-CONTRACT.md` | `src/host/render.js`、`src/host/produce.js` |
| 平台字体 | `scripts/job-bundle.ts` 的 `FONTS` 和两个提交号 | `src/host/runtime.js` 的 `FONTS` |
| 制作输入 `job.json` | 沙箱 `workers/sandbox/job`（风格的 `scripts/setup.py` 读它） | `src/host/produce.js` 的 `writeJobJson` |
| 时间线（schema 2） | 编辑器的时间线文档 | `src/host/assemble.js` |
| 剪映导出 | `workers/sandbox/job/timeline_export.py` 等 | `vendor/jianying/`（原样拷贝） |

## 1. 登录和站点接口

- 客户端 id 固定为 `dsh-lovideo`。拿到的 `access_token` 就是网站的会话 token，插件用 `Authorization: Bearer` 调接口。
- 账号信息用 Better Auth 自带的 `/api/auth/get-session`（带 Bearer）；返回 `null` 表示 token 已失效。
- 桌面版打开确认页时在链接后加 `app=desktop`，网站允许后给一个打开 `dsh://open` 的「回到 DeepSeek Harness」按钮；网页版不加。
- 收到 401 时插件清掉本机账号，提示用户重新登录。
- 风格包按内容寻址：下载后的 sha256 必须等于列表里的 `revision`，不相等就不装。
- 插件只读不写：不付费、不改账号，也不把作品传回网站。

## 2. 风格包

插件在本机执行风格包的方式和网站沙箱一致：

- `SKILL.md` 里的 `lovideo-job render ...` 命令决定页面入口、挂载目录（`--mount 前缀=目录`）和时钟。`{skill}` 是风格目录，`{project}` 是这部片子的工程目录。
- `--mount /pf/=/work/fonts` 里的 `/work/fonts` 换成本机的平台字体目录（见第 3 条）。
- 有 `scripts/setup.py` 的风格，开拍前执行 `python3 -I setup.py --job job.json --project <工程目录> --unit <段 id,...>`。
- 页面按 `window.lovideo.ready(film)`、`seek(frame)`、`assert()` 逐帧渲染。启动失败时抛出的错误会原样交给模型修。
- 没有准备脚本、但用通用画布引擎（`/engine/canvas.js`）的风格（用户自己蒸馏的），用 `vendor/base-style/assets/draft-scene.js` 作为草稿。

## 3. 平台字体

网站的制作机器给每个任务都放了一份固定的字体（`/work/fonts`）：手写体 7 个，加上 Noto Sans SC 和 Noto Serif SC 的常规体与粗体。大部分官方风格的中文都依赖它们，缺了页面会直接报错。

插件第一次准备环境（或第一次开拍）时，按同样两个提交号下载这 11 个字体和许可证，放到 `~/.dsh/lovideo/runtime/fonts`，GitHub 连不上就走 jsDelivr。网站改了字体列表或提交号，要同步改 `runtime.js` 的 `FONTS`。

## 4. job.json

插件写的是网站 `job.json` 的一个子集，字段含义相同：

- `jobId`、`kind: "generate"`、`fps`、`width`、`height`
- `confirmed.inputs`、`confirmed.params`（`aspect`、`durationSec`、`fps`、`width`、`height`、`subtitles`）
- `segments[]`：`idx`、`id`、`title`、`description`、`copy`、`media`、`narration.sentences[]`（`unitSeconds` 是这一段里口播的起止秒）、`label`、`frames`、`start`

风格的 `setup.py` 只能依赖这些字段。网站往 `job.json` 里加了风格要用的新字段，插件要补上。

## 5. 时间线和剪映

- 成片按 schema 2 时间线拼接：画面、口播、字幕、配乐四类轨道。素材的 `uri` 是作品目录里的相对路径。
- 剪映工程直接用网站的导出器（`vendor/jianying`，从 `workers/sandbox/job` 原样拷贝）。导出前，插件给每个素材补上本机绝对路径 `localPath`。
- 网站改了导出器，重新拷贝整个目录，然后跑一遍 `npm test`（里面会导出一次剪映工程）。
- 和网站不同的地方：插件把导出结果直接放在文件夹里，不打 zip。电脑上装了剪映的话，插件会直接把草稿放进剪映的草稿列表。

## 6. 只在插件里有、和网站有意不同的地方

- **模型**：用 DeepSeek Harness 里选的模型，插件不存模型密钥，也不扣积分。
- **算力**：在用户自己的电脑上渲染，不连网站的沙箱和 GPU。
- **配音**：默认用系统语音，可以一键下载离线配音，也可以在设置里填自己的豆包、OpenAI 兼容或 ElevenLabs 密钥。密钥只存在本机。
- **配乐**：网站在画面做完后按开关生成；插件在配音定下段长后就和画面同时生成（本机几秒做好），默认离线模型（Stable Audio 3 Small），也可以用火山 `GenBGMForTime`（和网站同一个接口、同一套签名）或 ElevenLabs Music。
- **时长和开关**：片长档位（30–300 秒，每 30 秒一档）、每镜至少 15 秒、配音/配乐/字幕开关对应时间线轨道的 `hidden`，都和网站一致；开关状态另外记在作品的 `voice` / `music` / `subtitles.enabled` 上，换分镜重建时间线时照它打 `hidden`。
- **对话**：用 DeepSeek Harness 的聊天。导演的做法写在 `skills/lovideo-director/SKILL.md`。
- **剪辑**：只做基本操作（裁短、换顺序、改字幕、重画某一镜）。要精剪就导出剪映工程。
