// 本机渲染环境：浏览器（画画面）、ffmpeg（编码、拼接、混音）、Python（风格包的准备脚本、剪映导出）。
// 电脑上已经有的直接用；没有的，在用户点「准备」后下载到 ~/.dsh/lovideo/runtime（约 150 MB），不会悄悄下载。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, chmodSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { delimiter, join } from 'node:path'
import { download, downloadText } from './download.js'
import { ensureDir, runtimeDir } from './paths.js'

const WIN = process.platform === 'win32'
const exe = name => (WIN ? `${name}.exe` : name)

/** 在 PATH 和几个常见目录里找一个可执行文件 */
export function which(name, extra = []) {
  const dirs = [...(process.env.PATH || '').split(delimiter), ...extra].filter(Boolean)
  for (const dir of dirs) {
    const p = join(dir, exe(name))
    if (existsSync(p)) return p
  }
  return null
}

const COMMON_BIN = WIN ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin']

function chromeCandidates() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ]
  }
  if (WIN) {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)
    return roots.flatMap(r => [
      join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(r, 'Chromium', 'Application', 'chrome.exe'),
    ])
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
    .map(n => which(n, COMMON_BIN))
    .filter(Boolean)
}

/** 下载到插件目录的 Chrome Headless Shell（电脑上没有 Chrome 时用） */
function downloadedChrome() {
  const dir = join(runtimeDir(), 'chrome')
  if (!existsSync(dir)) return null
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      // .part 是正在解压的目录，里面的浏览器还不完整
      if (e.isDirectory()) {
        if (!e.name.endsWith('.part')) stack.push(p)
      } else if (e.name === exe('chrome-headless-shell')) return p
    }
  }
  return null
}

export function findChrome() {
  if (process.env.LOVIDEO_CHROME && existsSync(process.env.LOVIDEO_CHROME)) return process.env.LOVIDEO_CHROME
  return chromeCandidates().find(p => existsSync(p)) || downloadedChrome()
}

export function findFfmpeg() {
  const local = join(runtimeDir(), 'bin', exe('ffmpeg'))
  if (existsSync(local)) return local
  return which('ffmpeg', COMMON_BIN)
}

/** DSH 桌面版自带 Python 3.12（带 Pillow、numpy）；没有时用系统的 */
export function findPython() {
  const res = process.resourcesPath || ''
  const bundled = res
    ? [
        join(res, 'runtime', 'primary-runtime', 'dependencies', 'python', 'bin', 'python3'),
        join(res, 'runtime', 'primary-runtime', 'dependencies', 'python', 'python.exe'),
      ]
    : []
  const guess = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/python/bin/python3'
  for (const p of [process.env.LOVIDEO_PYTHON, ...bundled, guess]) if (p && existsSync(p)) return p
  return which('python3', COMMON_BIN) || which('python', COMMON_BIN)
}

/**
 * 剪映导出要加载 libmediainfo（原生库）。macOS 上 DSH 自带的 Python 开了库签名校验，加载不了第三方的库，
 * 所以这里优先用系统自己的 Python，没有再退回 DSH 自带的（Windows、Linux 没有这个限制）。
 */
export function findPythonForNative() {
  if (process.env.LOVIDEO_PYTHON && existsSync(process.env.LOVIDEO_PYTHON)) return process.env.LOVIDEO_PYTHON
  const sys = [which('python3', COMMON_BIN), which('python', COMMON_BIN)].filter(p => p && !p.includes('.app/Contents/Resources/runtime'))
  return sys[0] || findPython()
}

export function runtimeStatus() {
  const chrome = findChrome()
  const ffmpeg = findFfmpeg()
  const python = findPython()
  const fonts = fontsReady()
  return {
    chrome: chrome ? { ok: true, path: chrome } : { ok: false },
    ffmpeg: ffmpeg ? { ok: true, path: ffmpeg } : { ok: false },
    python: python ? { ok: true, path: python } : { ok: false },
    fonts: { ok: fonts },
    // 字体缺了不挡开拍：第一次制作时自动下载
    ready: Boolean(chrome && ffmpeg),
    platform: `${process.platform}-${process.arch}`,
  }
}

/* ---------- 下载缺的组件 ---------- */

// ffmpeg-static 的预编译版。GitHub 在国内经常连不上或极慢，npmmirror 有同样的文件（同名、同目录结构）
const FFMPEG_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']
const ffmpegUrls = key => [
  `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-${key}.gz`,
  `https://cdn.npmmirror.com/binaries/ffmpeg-static/b6.0/ffmpeg-${key}.gz`,
  `https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.0/ffmpeg-${key}.gz`,
]

let setupState = { running: false, step: null, progress: 0, error: null }
export const setupProgress = () => ({ ...setupState })

async function downloadFfmpeg(onProgress, signal) {
  const key = `${process.platform}-${process.arch}`
  if (!FFMPEG_PLATFORMS.includes(key)) throw new Error(`没有适合 ${key} 的 ffmpeg，请自己安装 ffmpeg 后重试`)
  const out = join(ensureDir(join(runtimeDir(), 'bin')), exe('ffmpeg'))
  await download(ffmpegUrls(key), out, {
    label: 'ffmpeg ',
    hint: '请检查网络后再点一次「准备」；也可以自己安装 ffmpeg 后再点一次',
    transforms: [() => createGunzip()],
    onProgress,
    signal,
  })
  if (!WIN) chmodSync(out, 0o755)
}

/*
 * Chrome Headless Shell（电脑上没有 Chrome、Edge、Brave 时用）。版本清单和压缩包都先试 npmmirror 的镜像，
 * 再试谷歌官方（探测后谁快先用谁）。镜像有时还没同步最新版，所以再备一个钉住的版本（和 puppeteer-core 用的一致），
 * 清单拿不到、或最新版哪儿都下不到时用它。
 */
const CFT_MIRROR = 'https://cdn.npmmirror.com/binaries/chrome-for-testing'
const CFT_GOOGLE = 'https://storage.googleapis.com/chrome-for-testing-public'
const CHROME_PINNED_BUILD = '148.0.7778.97'

async function stableChromeBuild(signal) {
  try {
    const { text } = await downloadText([
      `${CFT_MIRROR}/last-known-good-versions.json`,
      'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json',
    ], { label: 'Chrome 版本清单', signal })
    return JSON.parse(text).channels?.Stable?.version || null
  } catch {
    return null
  }
}

async function downloadChrome(onProgress, signal) {
  const browsers = await import('@puppeteer/browsers')
  const { default: extractZip } = await import('extract-zip')
  const platform = browsers.detectBrowserPlatform()
  if (!platform) throw new Error(`这台电脑（${process.platform}-${process.arch}）下载不了浏览器，请装好 Chrome 或 Edge 后再点一次`)
  const builds = [...new Set([await stableChromeBuild(signal), CHROME_PINNED_BUILD].filter(Boolean))]
  const buildOf = new Map()
  const urls = builds.flatMap(build => [CFT_MIRROR, CFT_GOOGLE].map(base => {
    const url = browsers.getDownloadUrl(browsers.Browser.CHROMEHEADLESSSHELL, platform, build, base).toString()
    buildOf.set(url, build)
    return url
  }))
  const root = ensureDir(join(runtimeDir(), 'chrome', 'chrome-headless-shell'))
  const zip = join(root, 'download.zip')
  const { url } = await download(urls, zip, {
    label: '浏览器（Chrome Headless Shell）',
    hint: '请检查网络后再点一次「准备」；也可以装好 Chrome 或 Edge 浏览器后再点一次',
    onProgress,
    signal,
  })
  // 先解压到 .part 目录，完整解出来再改名：downloadedChrome() 只要找到可执行文件就会用，不能让它碰到解了一半的
  const dir = join(root, `${platform}-${buildOf.get(url)}`)
  const part = `${dir}.part`
  rmSync(part, { recursive: true, force: true })
  try {
    await extractZip(zip, { dir: part })
    rmSync(dir, { recursive: true, force: true })
    renameSync(part, dir)
  } catch (err) {
    rmSync(part, { recursive: true, force: true })
    throw new Error(`浏览器解压失败：${err.message}（可能是磁盘空间不够，清理后再点一次）`)
  } finally {
    rmSync(zip, { force: true })
  }
  const bin = downloadedChrome()
  if (!bin) throw new Error('浏览器压缩包里没有找到 chrome-headless-shell，请再点一次「准备」')
  if (!WIN) chmodSync(bin, 0o755)
}

/* ---------- 平台字体 ----------
 * 和网站制作机器的 /work/fonts 完全一样（lovideo 仓库 scripts/job-bundle.ts 的 FONTS，同样钉在这两个提交上）：
 * 风格的渲染命令用 --mount /pf/=/work/fonts 加载它们，大部分官方风格的中文靠 Noto Sans/Serif SC。
 */
const FONTS_REF = 'e7db6ca603fd4862010383ff17ffd6cc4ffac1c0'
const NOTO_CJK_REF = 'f8d157532fbfaeda587e826d4cd5b21a49186f7c'
const gf = (file, dir, source, license = 'OFL.txt') => ({ file, repo: 'google/fonts', ref: FONTS_REF, path: `${dir}/${source}`, license: { name: `${file.replace(/\.[^.]+$/, '')}-${license}`, path: `${dir}/${license}` } })
const noto = (family, weight) => ({ file: `Noto${family}SC-${weight}.otf`, repo: 'notofonts/noto-cjk', ref: NOTO_CJK_REF, path: `${family}/SubsetOTF/SC/Noto${family}SC-${weight}.otf`, license: { name: `Noto${family}SC-OFL.txt`, path: `${family}/LICENSE` } })
export const FONTS = [
  gf('ReenieBeanie.ttf', 'ofl/reeniebeanie', 'ReenieBeanie.ttf'),
  gf('NothingYouCouldDo.ttf', 'ofl/nothingyoucoulddo', 'NothingYouCouldDo.ttf'),
  gf('HomemadeApple.ttf', 'apache/homemadeapple', 'HomemadeApple-Regular.ttf', 'LICENSE.txt'),
  gf('Caveat.ttf', 'ofl/caveat', 'Caveat%5Bwght%5D.ttf'),
  gf('DancingScript.ttf', 'ofl/dancingscript', 'DancingScript%5Bwght%5D.ttf'),
  gf('Kalam.ttf', 'ofl/kalam', 'Kalam-Regular.ttf'),
  gf('MaShanZheng.ttf', 'ofl/mashanzheng', 'MaShanZheng-Regular.ttf'),
  noto('Sans', 'Regular'),
  noto('Sans', 'Bold'),
  noto('Serif', 'Regular'),
  noto('Serif', 'Bold'),
]
export const fontsDir = () => process.env.LOVIDEO_FONTS_DIR || join(runtimeDir(), 'fonts')
export const fontsReady = () => FONTS.every(f => existsSync(join(fontsDir(), f.file)))

// GitHub 连不上时走 jsDelivr（cdn 和 fastly 两个入口，国内一般至少一个能通）
const pinnedUrls = (repo, ref, path) => [
  `https://raw.githubusercontent.com/${repo}/${ref}/${path}`,
  `https://cdn.jsdelivr.net/gh/${repo}@${ref}/${path}`,
  `https://fastly.jsdelivr.net/gh/${repo}@${ref}/${path}`,
]
const fetchPinned = (repo, ref, path, dest) =>
  download(pinnedUrls(repo, ref, path), dest, { label: `字体（${decodeURIComponent(path.split('/').pop())}）`, hint: '请检查网络后再试一次' })

let fontsJob = null
/** 补齐缺的平台字体（几十 MB，只下一次）；并发调用共用同一次下载 */
export function ensureFonts(onProgress = () => {}) {
  if (fontsReady()) return Promise.resolve()
  fontsJob ??= (async () => {
    const dir = ensureDir(fontsDir())
    const lic = ensureDir(join(dir, 'licenses'))
    const todo = FONTS.filter(f => !existsSync(join(dir, f.file)))
    let done = 0
    for (const f of todo) {
      await fetchPinned(f.repo, f.ref, f.license.path, join(lic, f.license.name))
      await fetchPinned(f.repo, f.ref, f.path, join(dir, f.file))
      onProgress(++done / todo.length)
    }
  })().finally(() => {
    fontsJob = null
  })
  return fontsJob
}

/*
 * 准备渲染环境的这一次「运行」。每个下载都有超时，正常不会卡住；万一哪一步超过 STUCK_MS 没有任何动静，
 * 用户再点「准备」就放弃那一次、重新开始（旧的那次被取消，它的结果不会再改状态）。
 */
const STUCK_MS = 3 * 60_000
let setupRun = null
let setupActive = 0

/** 现在点「准备」会不会真的开始：没在准备，或者正在准备但已经卡住 */
export const setupCanStart = () => !setupState.running || Date.now() - setupActive > STUCK_MS

/** 下载电脑上缺的组件；已有的跳过。返回最新状态（被后来的一次顶替时返回那一次的状态，running 为 true） */
export async function setupRuntime() {
  if (!setupCanStart()) return setupProgress()
  setupRun?.abort()
  const ac = new AbortController()
  setupRun = ac
  const mine = () => setupRun === ac
  const step = name => {
    if (!mine()) throw Object.assign(new Error('已取消'), { name: 'AbortError' })
    setupState.step = name
    setupState.progress = 0
    setupActive = Date.now()
  }
  const progress = p => {
    if (!mine()) return
    setupState.progress = p
    setupActive = Date.now()
  }
  setupState = { running: true, step: null, progress: 0, error: null }
  setupActive = Date.now()
  try {
    if (!findFfmpeg()) {
      step('ffmpeg')
      await downloadFfmpeg(progress, ac.signal)
    }
    if (!findChrome()) {
      step('chrome')
      await downloadChrome(progress, ac.signal)
    }
    if (!fontsReady()) {
      step('fonts')
      await ensureFonts(progress)
    }
    if (mine()) setupState = { running: false, step: 'done', progress: 1, error: null }
  } catch (err) {
    if (mine()) setupState = { running: false, step: setupState.step, progress: setupState.progress, error: err.message }
  } finally {
    if (mine()) setupRun = null
  }
  return setupProgress()
}

/* ---------- 跑命令 ---------- */

/** 跑一个子进程（不经过 shell），收集输出；超时或 signal 取消时杀掉 */
export function run(cmd, args, { cwd, input, timeoutMs = 600_000, signal, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += d).length > 2e6 && (out = out.slice(-1e6)))
    child.stderr.on('data', d => (err += d).length > 2e6 && (err = err.slice(-1e6)))
    const kill = () => child.kill('SIGKILL')
    const timer = setTimeout(kill, timeoutMs)
    signal?.addEventListener('abort', kill, { once: true })
    child.on('error', e => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', kill)
      if (signal?.aborted) return reject(Object.assign(new Error('已取消'), { name: 'AbortError' }))
      resolve({ code, stdout: out, stderr: err })
    })
    // 子进程提前退出时往它写会触发管道错误；结果看退出码，这里只防止没人监听的 error 事件拖垮后端
    child.stdin.on('error', () => {})
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

export async function ffmpeg(args, opts = {}) {
  const bin = findFfmpeg()
  if (!bin) throw new Error('还没有 ffmpeg，请先在 lovideo 里准备渲染环境')
  const r = await run(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeoutMs: 1_800_000, ...opts })
  if (r.code !== 0) throw new Error(`ffmpeg 出错：${r.stderr.trim().split('\n').slice(-3).join(' ')}`)
  return r
}

/** 媒体时长（秒）：读 ffmpeg 的 Duration 行，不依赖 ffprobe */
export function mediaSeconds(file) {
  const bin = findFfmpeg()
  const r = spawnSync(bin, ['-hide_banner', '-i', file], { encoding: 'utf8', windowsHide: true })
  const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(r.stderr || '')
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0
}
