// 本机渲染器：和 lovideo 网站沙箱里的 `lovideo-job render` 是同一套合同（docs/STYLE-SKILL-CONTRACT.md）。
//   --page ENTRY --mount /prefix/=DIR：Chromium 打开本地只读站点，页面设好 window.lovideo.ready/seek，逐帧截图
//   --command CMD：在工程目录跑一次段命令，写 {frames_dir}/NNNNN.png
// 风格包写在 SKILL.md 里的渲染命令原样解析，所以平台风格不用改就能在本机画。
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { findChrome, findFfmpeg, run } from './runtime.js'
import { isInside } from './paths.js'

/* ---------- 解析 SKILL.md 里的渲染命令 ---------- */

/** 按 shell 的引号规则把命令拆成词（不做变量展开） */
export function shellSplit(text) {
  const out = []
  let cur = ''
  let quote = null
  let any = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < text.length) cur += text[++i]
      else cur += c
    } else if (c === "'" || c === '"') {
      quote = c
      any = true
    } else if (c === '\\' && text[i + 1] === '\n') i++
    else if (/\s/.test(c)) {
      if (cur || any) out.push(cur)
      cur = ''
      any = false
    } else cur += c
  }
  if (cur || any) out.push(cur)
  return out
}

/** 从 SKILL.md 找出第一条 `lovideo-job render` 命令，返回渲染器参数 */
export function parseRenderCommand(skillMd) {
  const at = skillMd.indexOf('lovideo-job render')
  if (at < 0) return null
  // 命令可能用行尾的反斜杠续行
  const lines = skillMd.slice(at).split('\n')
  let text = ''
  for (const line of lines) {
    const t = line.trimEnd()
    if (t.endsWith('\\')) text += `${t.slice(0, -1)} `
    else {
      text += t
      break
    }
  }
  const words = shellSplit(text)
  const spec = { page: null, command: null, mounts: [], clock: 'film', checkExit: [] }
  for (let i = 2; i < words.length; i++) {
    const w = words[i]
    const next = () => words[++i]
    if (w === '--page') spec.page = next()
    else if (w === '--command') spec.command = next()
    else if (w === '--mount') spec.mounts.push(next())
    else if (w === '--clock') spec.clock = next()
    else if (w === '--check-exit') spec.checkExit = next().split(',').map(Number)
    else if (w === '--unit' || w === '--project' || w === '--jobs') i++
  }
  if (!spec.page && !spec.command) return null
  return spec
}

export function fill(text, vars) {
  return text.replace(/\{([a-zA-Z_]+)\}/g, (all, k) => (vars[k] === undefined ? all : String(vars[k])))
}

/* ---------- 本地只读站点（页面渲染用） ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8',
}

/** mounts: [{prefix:'/p/', dir}]，最长前缀优先 */
export function startSite(mounts) {
  const sorted = [...mounts].sort((a, b) => b.prefix.length - a.prefix.length)
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const mount = sorted.find(m => path.startsWith(m.prefix) || `${path}/` === m.prefix)
    if (!mount) return res.writeHead(404).end()
    const rel = path.slice(mount.prefix.length)
    let file = resolve(mount.dir, rel || 'index.html')
    if (!isInside(mount.dir, file)) return res.writeHead(403).end()
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    if (!existsSync(file)) return res.writeHead(404).end()
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    })
    createReadStream(file).pipe(res)
  })
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ server, origin: `http://127.0.0.1:${server.address().port}` })))
}

/* ---------- 浏览器 ---------- */

let browserPromise = null

export async function getBrowser() {
  // 几段同时渲染时共用一个浏览器：先占住 promise 再等，避免同时启动两个
  const current = browserPromise
  if (current) {
    const b = await current.catch(() => null)
    if (b && b.connected) return b
    if (browserPromise !== current) return getBrowser()
  }
  browserPromise = launchBrowser()
  return browserPromise
}

async function launchBrowser() {
  const exe = findChrome()
  if (!exe) throw new Error('还没有可用的浏览器，请先在 lovideo 里准备渲染环境')
  const puppeteer = (await import('puppeteer-core')).default
  return puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: [
      '--hide-scrollbars', '--mute-audio', '--force-device-scale-factor=1', '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    ],
    protocolTimeout: 180_000,
  })
}

export async function closeBrowser() {
  const b = await browserPromise?.catch(() => null)
  browserPromise = null
  await b?.close().catch(() => {})
}

/* ---------- 编码 ---------- */

/** 起一个 ffmpeg，从 stdin 收 JPEG 帧，编成 H.264 */
function startEncoder(out, fps, signal) {
  const bin = findFfmpeg()
  if (!bin) throw new Error('还没有 ffmpeg，请先在 lovideo 里准备渲染环境')
  const child = spawn(bin, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(fps), '-movflags', '+faststart', out,
  ], { windowsHide: true })
  let err = ''
  child.stderr.on('data', d => (err += d))
  const done = new Promise((ok, fail) => {
    child.on('error', fail)
    child.on('close', code => (code === 0 ? ok() : fail(new Error(`编码失败：${err.trim().slice(-300)}`))))
  })
  const kill = () => child.kill('SIGKILL')
  signal?.addEventListener('abort', kill, { once: true })
  const write = buf => new Promise((ok, fail) => (child.stdin.write(buf, e => (e ? fail(e) : ok()))))
  const end = () => {
    child.stdin.end()
    return done.finally(() => signal?.removeEventListener('abort', kill))
  }
  return { write, end, done }
}

/**
 * 按页面合同渲染一段。
 * @param {{origin:string, entry:string, film:object, out:string, poster?:string, signal?:AbortSignal, onFrame?:(i:number)=>void}} o
 */
export async function renderPage(o) {
  const { film, signal } = o
  const browser = await getBrowser()
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e.message || e).slice(0, 400)))
  try {
    await page.setViewport({ width: film.width, height: film.height, deviceScaleFactor: 1 })
    const url = new URL(o.entry, o.origin).href
    await page.goto(url, { waitUntil: 'load', timeout: 60_000 })
    await page.waitForFunction(() => window.lovideo && typeof window.lovideo.ready === 'function' && typeof window.lovideo.seek === 'function', { timeout: 5_000 })
      .catch(() => { throw new Error(`页面 5 秒内没有设置 window.lovideo.ready / seek${errors.length ? `：${errors[0]}` : ''}`) })
    await page.evaluate(f => Promise.race([
      window.lovideo.ready(f),
      new Promise((_, no) => setTimeout(() => no(new Error('ready() 120 秒没有完成')), 120_000)),
    ]), film).catch(e => { throw new Error(`页面启动失败：${errors[0] || e.message}`) })
    await assertPage(page, errors)
    const enc = startEncoder(o.out, film.fps, signal)
    const first = film.clock === 'unit' ? 0 : film.start
    let mid = null
    try {
      for (let i = 0; i < film.frames; i++) {
        if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })
        await page.evaluate(n => Promise.resolve(window.lovideo.seek(n)), first + i)
        if (errors.length) throw new Error(`第 ${i} 帧出错：${errors[0]}`)
        const shot = await page.screenshot({ type: 'jpeg', quality: 90, optimizeForSpeed: true })
        await enc.write(shot)
        if (i === Math.floor(film.frames / 2)) mid = shot
        o.onFrame?.(i + 1)
      }
    } catch (err) {
      enc.end().catch(() => {})
      throw err
    }
    await enc.end()
    await assertPage(page, errors)
    if (o.poster && mid) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(o.poster, mid)
    }
  } finally {
    await page.close().catch(() => {})
  }
}

async function assertPage(page, errors) {
  const r = await page.evaluate(async () => {
    if (typeof window.lovideo.assert !== 'function') return true
    try {
      return Boolean(await window.lovideo.assert())
    } catch (e) {
      return String(e && e.message ? e.message : e)
    }
  })
  if (r !== true) throw new Error(`页面自检没通过${typeof r === 'string' ? `：${r}` : ''}${errors.length ? `（${errors[0]}）` : ''}`)
}

/** 段命令渲染：在工程目录跑命令，收 {frames_dir}/NNNNN.png 编成视频 */
export async function renderCommand(o) {
  const { film, vars, signal } = o
  const framesDir = vars.frames_dir
  rmSync(vars.unit_dir, { recursive: true, force: true })
  mkdirSync(framesDir, { recursive: true })
  const words = shellSplit(o.command).map(w => fill(w, vars))
  const tryOnce = () => run(words[0], words.slice(1), { cwd: vars.project, timeoutMs: 900_000, signal })
  let r = await tryOnce()
  if (r.code !== 0 && !(o.checkExit || []).includes(r.code)) r = await tryOnce()
  if (r.code !== 0 && !(o.checkExit || []).includes(r.code)) throw new Error(`段命令失败（退出 ${r.code}）：${(r.stderr || r.stdout).trim().slice(-400)}`)
  const pngs = readdirSync(framesDir).filter(f => /^\d+\.png$/.test(f)).sort()
  if (pngs.length < film.frames) throw new Error(`段命令只写了 ${pngs.length}/${film.frames} 帧`)
  const bin = findFfmpeg()
  const first = Number(pngs[0].slice(0, -4))
  const r2 = await run(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(film.fps), '-start_number', String(first),
    '-i', join(framesDir, '%05d.png'), '-frames:v', String(film.frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', o.out], { signal })
  if (r2.code !== 0) throw new Error(`编码失败：${r2.stderr.slice(-300)}`)
  if (o.poster) {
    const mid = join(framesDir, pngs[Math.floor(pngs.length / 2)])
    await run(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-i', mid, '-q:v', '3', o.poster])
  }
}
