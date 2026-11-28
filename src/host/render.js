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
export function startEncoder(out, fps, signal) {
  const bin = findFfmpeg()
  if (!bin) throw new Error('还没有 ffmpeg，请先在 lovideo 里准备渲染环境')
  const child = spawn(bin, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(fps), '-movflags', '+faststart', out,
  ], { windowsHide: true })
  let err = ''
  child.stderr.on('data', d => (err += d))
  // ffmpeg 退出后再写会触发管道错误（EPIPE）；没人监听的 error 事件同样会让后端退出，失败原因由 done 报
  child.stdin.on('error', () => {})
  const done = new Promise((ok, fail) => {
    child.on('error', fail)
    child.on('close', code => (code === 0 ? ok() : fail(new Error(`编码失败：${err.trim().slice(-300)}`))))
  })
  // 编码器可能在画帧途中就退出（被取消、磁盘满、参数不对）：立刻接住记下原因，
  // 不然在 end() 之前这个拒绝没人接，DeepSeek Harness 会把它当成致命错误让整个后端退出
  let failed = null
  done.catch(e => (failed = e))
  const kill = () => child.kill('SIGKILL')
  signal?.addEventListener('abort', kill, { once: true })
  const write = buf => (failed ? Promise.reject(failed) : new Promise((ok, fail) => (child.stdin.write(buf, e => (e ? fail(failed || e) : ok())))))
  const end = () => {
    child.stdin.end()
    return done.finally(() => signal?.removeEventListener('abort', kill))
  }
  return { write, end, done }
}

// 页面舞台的范围：body 的直接子元素（画布或舞台容器）合起来的外框，零尺寸的不算（网站 lovideo_job.py 的 FILL_JS）。
// 只看直接子元素：舞台里飞入飞出的元素被舞台裁掉是正常画法。
const FILL_JS = () => {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const el of document.body ? document.body.children : []) {
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    x0 = Math.min(x0, r.left)
    y0 = Math.min(y0, r.top)
    x1 = Math.max(x1, r.right)
    y1 = Math.max(y1, r.bottom)
  }
  return x0 === Infinity ? null : [x0, y0, x1, y1]
}

/**
 * 平台通用围栏（和网站一样）：页面画的东西必须正好铺满成片画面。写死尺寸的页面换了画幅会溢出（被裁掉）
 * 或铺不满（空底），这里直接判失败，不出被裁坏的片。
 */
async function checkFill(page, film, when) {
  const box = await page.evaluate(FILL_JS)
  const near = (a, b) => Math.abs(a - b) <= 1
  if (box && !(near(box[0], 0) && near(box[1], 0) && near(box[2], film.width) && near(box[3], film.height))) {
    const spans = `(${box.map(Math.round).slice(0, 2).join(',')})-(${box.map(Math.round).slice(2).join(',')})`
    throw new Error(`the page does not fill the ${film.width}x${film.height} frame ${when}: its stage spans ${spans}; draw at the size ready(film) gives (film.width x film.height), not a fixed one`)
  }
}

// 有 advance 的页面一次走过多少帧
const ADVANCE_BATCH = 120

/**
 * 按页面合同渲染一段。
 * 页面有 advance（后面的帧依赖前面的）时，先把它在自己时钟上之前的每一帧都走一遍，再从第一帧画起。
 * pick：只画这几帧（段内帧号），不编码，返回 JPEG（交段前的检查图用）。
 * @param {{origin:string, entry:string, film:object, out?:string, poster?:string, pick?:number[], signal?:AbortSignal, onFrame?:(i:number)=>void}} o
 * @returns {Promise<Buffer[]|void>}
 */
export async function renderPage(o) {
  const { film, signal } = o
  const browser = await getBrowser()
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e.message || e).slice(0, 400)))
  const noErrors = when => {
    if (errors.length) throw new Error(`页面报错（${when}）：${errors[0]}`)
  }
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
    await checkFill(page, film, 'after ready')
    const hasAdvance = await page.evaluate(() => typeof window.lovideo.advance === 'function')
    const advance = async (a, b) => {
      if (!hasAdvance) return
      for (let n = a; n <= b; n += ADVANCE_BATCH) {
        if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })
        await page.evaluate(async ([x, y]) => { for (let k = x; k <= y; k++) await window.lovideo.advance(k) }, [n, Math.min(b, n + ADVANCE_BATCH - 1)])
        noErrors(`advancing through frame ${Math.min(b, n + ADVANCE_BATCH - 1)}`)
      }
    }
    const first = film.clock === 'unit' ? 0 : film.start
    await advance(0, first - 1)
    const drawn = o.pick ? [...new Set(o.pick)].filter(n => n >= 0 && n < film.frames).sort((a, b) => a - b) : null
    const enc = drawn ? null : startEncoder(o.out, film.fps, signal)
    const shots = []
    let mid = null
    let prev = -1
    try {
      for (const i of drawn || Array.from({ length: film.frames }, (_, k) => k)) {
        if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })
        await advance(first + prev + 1, first + i - 1)
        prev = i
        await page.evaluate(n => Promise.resolve(window.lovideo.seek(n)), first + i)
        noErrors(`at frame ${i}`)
        const shot = await page.screenshot({ type: 'jpeg', quality: 90, optimizeForSpeed: true })
        if (enc) await enc.write(shot)
        else shots.push(shot)
        if (i === Math.floor(film.frames / 2)) mid = shot
        o.onFrame?.(i + 1)
      }
    } catch (err) {
      enc?.end().catch(() => {})
      throw err
    }
    if (enc) await enc.end()
    await assertPage(page, errors)
    await checkFill(page, film, 'after the last frame')
    if (drawn) return shots
    if (o.poster && mid) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(o.poster, mid)
    }
    return undefined
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
