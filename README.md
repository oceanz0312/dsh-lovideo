# dsh-lovideo

lovideo 的 DeepSeek Harness 插件：在 DSH 的对话里用一句话做出任意风格的讲解视频。

- **导演**：一个 agent 预设（「lovideo 导演」）加一个 Skill，用的是 DSH 里选的模型。
- **制作**：在用户自己的电脑上进行。模型写每一镜的画面代码，本机 Chrome 逐帧渲染，再用 ffmpeg 拼成片。
- **风格**：官方风格从 lovideo.ai 下载（登录后免费），用户也可以把参考视频蒸馏成「我的风格」。
- **作品管理**：侧栏「lovideo 视频」里有作品、官方风格、我的风格和设置。对话里的卡片和管理页读的是同一份本机数据。
- **导出**：MP4（可以把字幕烧进画面），或者剪映专业版工程。

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
| `test/` | 集成测试：用假模型和网站仓库里的一个风格，跑一遍制作和导出 |

本机数据放在 `~/.dsh/lovideo/`：`works/` 是作品，`styles/` 是风格，`runtime/` 放浏览器、ffmpeg、字体和剪映依赖，`settings.json` 的权限是 0600。

## 开发

```bash
npm install
npm run build          # 打包客户端到 dist/client.js（加 -- --dev 不压缩，加 -- --watch 监听）
npm test               # 集成测试，约 30 秒，需要本机有 Chrome 和 ffmpeg
```

装进本机的 DSH：在 DSH 配置目录的 `package.json` 里加一行
`"dsh-lovideo": "link:/path/to/dsh-lovideo"`，然后重启 DSH。配置目录在 `~/.dsh/profiles/desktop` 或 `~/.dsh/profiles/<名字>`。

需要 DSH `>=0.2.2-rc.3 <0.3.0`。支持 macOS、Windows、Linux：电脑上没有 Chrome 或 ffmpeg 时，插件会下载 chrome-headless-shell 和静态版 ffmpeg。

## 需要注意的 DSH 约定

- 给导演发通知（`agent.followup`）时，消息必须带 `id` 和 `role: 'user'`。缺了这两个字段，会话历史会坏，DSH 会把这个会话从工作区里去掉。
- 卡片挂在 `conversation.chat.turnTail` 上，所以工具行折叠起来以后卡片也看得见。工具行本身只显示一行（`tool.call.toolview`）。
- 打开外部网址（比如登录页）一律在页面里用 `window.open` 或 `target="_blank"` 的链接：桌面版会交给系统默认浏览器，网页版开新标签。不要让插件后端去跑 `open` / `explorer`：Windows 的 `explorer` 收到带 `?`、`&` 的网址可能打开文件夹，网页版远程访问时还会在跑 DSH 的那台电脑上打开。
- 客户端只用 DSH 的主题变量（`--dsw-alias-*`），不引用 DSH 的 UI 组件包。
