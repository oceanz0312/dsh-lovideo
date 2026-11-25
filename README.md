# dsh-lovideo

lovideo 的 DeepSeek Harness 插件：在 DSH 的对话里用一句话做出任意风格的讲解视频。

- **导演**：一个 agent 预设（「lovideo 导演」）加一个 Skill，用的是 DSH 里选的模型。
- **制作**：在用户自己的电脑上进行。模型写每一镜的画面代码，本机 Chrome 逐帧渲染，再用 ffmpeg 拼成片。
- **风格**：官方风格从 lovideo.ai 下载（登录后免费），用户也可以把参考视频蒸馏成「我的风格」。
- **作品管理**：侧栏「lovideo 视频」里有作品、官方风格、我的风格和设置。对话里的卡片和管理页读的是同一份本机数据。
- **配音**：默认系统自带语音；可以一键下载离线配音（默认 Kokoro，哪台电脑都能跑），设置页按这台电脑的配置给每个模型标推荐 / 流畅 / 吃力 / 跑不动，用户自己选下载、切换模型和声音。用的那个配一部片子预计超过 3 分钟时，这部片子换成更快的，都来不及就退回系统语音。
- **配乐**：和配音分开设置。默认离线配乐（Stable Audio 3 Small，纯器乐，Mac 上一首几秒做好），也可以用自己的火山或 ElevenLabs key。
- **时长、配音、配乐、字幕**：和网站一样，片长 30 秒到 5 分钟、30 秒一档，每镜至少 15 秒；导演每次给出建议（配乐附中文说明和给模型的英文描述），用户在分镜卡上改，改过的导演再出分镜时照用户的来，改时长会自动请导演重出。成片下面三个开关随时切换，关掉的不播放、不进 MP4 和剪映工程。
- **导出**：MP4（可以把字幕烧进画面），或者在剪映专业版里直接打开。

用户看到的说明在 [docs/DETAIL.md](docs/DETAIL.md)。和网站保持一致的约定在 [docs/PROTOCOL.md](docs/PROTOCOL.md)。

## 目录

| 路径 | 作用 |
| --- | --- |
| `src/host/` | 在 DSH 主机（Node）里运行：工具、本机接口（`/lovideo/api`）、制作、导出、蒸馏 |
| `src/client/` | 在 DSH 页面里运行：对话卡片、工具行、管理页（React 18，用 DSH 自带的 React） |
| `skills/lovideo-director/` | 导演的做法 |
| `cordis.patch.yml` | 注册插件和「lovideo 导演」预设 |
| `vendor/base-style/` | 蒸馏风格用的通用画布引擎和页面约定 |
| `vendor/jianying/` | 剪映导出器，从网站原样拷贝 |
| `vendor/tts/worker.py` | 离线配音、配乐的常驻进程（Apple 芯片用 mlx-audio，其他用 PyTorch；配乐的 PyTorch 版单独一个环境） |
| `test/` | 集成测试：用假模型和网站仓库里的一个风格，跑一遍制作和导出 |

本机数据放在 `~/.dsh/lovideo/`：`works/` 是作品，`styles/` 是风格，`runtime/` 放浏览器、ffmpeg、字体、剪映依赖和离线配音、配乐（`runtime/tts/`），`settings.json` 的权限是 0600。

## 开发

```bash
npm install
npm test               # 集成测试，约 30 秒，需要本机有 Chrome 和 ffmpeg
```

### 在 DeepSeek Harness 桌面版里热更开发

```bash
npm run dev:desktop    # 一次性：桌面版配置链接到本仓库，并打开后端热重载
npm run dev            # 开着：客户端改了自动重新打包
```

- **前端**（`src/client`）：存盘后约 1 秒，已打开的页面自动换上新插件，不用刷新（插件里的 React 状态会重置）。
- **后端**（`src/host`）：存盘后几秒内 DeepSeek Harness 在同一个进程里换上新代码。正在做的片子会先暂停，重载后点「继续」。
- 第一次打开开发模式时，如果桌面版已经开着，重启它一次；之后改代码都不用重启。
- `npm run dev:desktop:status` 查看当前状态；`--profile <名字>` 换别的配置（默认 desktop）。
- 原理：桌面版的插件依赖改成 `link:` 到本仓库；profile 的 `cordis.patch.yml` 里加一段带标记的 `hmr` 配置，监听 `src/host`。客户端靠 DeepSeek Harness 轮询 `dist/client.js`；打包脚本先写临时文件再改名，保证它读到的永远是完整文件。

### 发版

在开发模式下把改动在桌面版里走通之后再发：

1. `npm test`
2. 把 `package.json` 的版本号加一，打包：`npm pack`
3. 按用户的装法再验一遍：`npm run dev:desktop:off -- --tgz dsh-lovideo-<版本>.tgz`，重启桌面版，把改到的地方点一遍
4. 发布：`npm_config_registry=https://registry.npmjs.org/ npm publish dsh-lovideo-<版本>.tgz --access public`
   （需要登录 npmjs.com 的账号；新包第一次发布时，会先出现一个 `0.0.0-stage` 占位版本，约一分钟后才是正式版本）
5. 提交并推送到 GitHub，然后 `npm run dev:desktop` 回到开发模式

需要 DSH `>=0.2.2-rc.3 <0.3.0`。支持 macOS、Windows、Linux：电脑上没有 Chrome 或 ffmpeg 时，插件会下载 chrome-headless-shell 和静态版 ffmpeg。

## 需要注意的 DSH 约定

- 给导演发通知（`agent.followup`）时，消息必须带 `id` 和 `role: 'user'`。缺了这两个字段，会话历史会坏，DSH 会把这个会话从工作区里去掉。
- 后端不能留下没人接的 promise（比如单独写 `p.finally(...)` 而不处理它的拒绝）：DeepSeek Harness 把没人接的拒绝当成致命错误，整个后端会退出、桌面版要重启。后台任务一律用 `p.then(done, done)` 或自己 `catch`。
- 卡片挂在 `conversation.chat.turnTail` 上，所以工具行折叠起来以后卡片也看得见。工具行本身只显示一行（`tool.call.toolview`）。
- 打开外部网址（比如登录页）一律在页面里用 `window.open` 或 `target="_blank"` 的链接：桌面版会交给系统默认浏览器，网页版开新标签。不要让插件后端去跑 `open` / `explorer`：Windows 的 `explorer` 收到带 `?`、`&` 的网址可能打开文件夹，网页版远程访问时还会在跑 DSH 的那台电脑上打开。
- 客户端只用 DSH 的主题变量（`--dsw-alias-*`），不引用 DSH 的 UI 组件包。
