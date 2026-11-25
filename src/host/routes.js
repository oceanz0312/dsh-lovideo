// /lovideo/api/*：管理页和对话卡片调的接口。和工具调的是同一组函数。
// DSH 的 web 服务不替插件鉴权，每个请求都先走 connection.requestRejection；写操作再拒绝跨站请求。
import { createReadStream, existsSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname, extname, join, resolve } from 'node:path'
import { assertId, isInside } from './paths.js'
import { deleteWork, events, getWork, listWorks, requireWork, updateWork, workDir } from './works.js'
import { listStyles, mineDir, removeMine, installPlatformStyle, platformCatalog } from './styles.js'
import { pauseProduction, startProduction, isRunning } from './produce.js'
import { reviseFilm } from './edit.js'
import { openInJianying, startExport } from './export.js'
import { jianyingStatus } from './jianying.js'
import { localVoiceStatus, startSetup as startLocalVoiceSetup } from './localvoice.js'
import { saveDistilled, startDistill } from './distill.js'
import { runtimeStatus, setupProgress, setupRuntime } from './runtime.js'
import { publicSettings, readSettings, updateSettings } from './settings.js'
import { listModels, modelInfo } from './llm.js'
import { loginState, logout, startLogin, siteUrl } from './site.js'
import { speak } from './tts.js'
import { tmpDir, ensureDir } from './paths.js'
import { notices, notify } from './notices.js'

export const BASE = '/lovideo/api'
const MAX_JSON = 2_000_000
const MIME = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.wav': 'audio/wav', '.webp': 'image/webp', '.json': 'application/json' }

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > MAX_JSON) throw Object.assign(new Error('内容太大'), { status: 413 })
    chunks.push(c)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw Object.assign(new Error('请求不是有效的 JSON'), { status: 400 })
  }
}

/** 支持 Range，视频才能拖动 */
function sendFile(req, res, file) {
  if (!existsSync(file)) return json(res, 404, { error: '文件不存在' })
  const info = statSync(file)
  res.setHeader('content-type', MIME[extname(file).toLowerCase()] || 'application/octet-stream')
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('cache-control', 'private, max-age=60')
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, info.size - Number(m[2]))
    const end = m[1] && m[2] ? Math.min(Number(m[2]), info.size - 1) : info.size - 1
    if (start >= info.size || start > end) {
      res.statusCode = 416
      res.setHeader('content-range', `bytes */${info.size}`)
      return res.end()
    }
    res.statusCode = 206
    res.setHeader('content-range', `bytes ${start}-${end}/${info.size}`)
    res.setHeader('content-length', end - start + 1)
    return createReadStream(file, { start, end }).pipe(res)
  }
  res.statusCode = 200
  res.setHeader('content-length', info.size)
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

/** 卡片和列表用的作品摘要（不带时间线和大字段） */
export function summary(w) {
  return {
    id: w.id, title: w.title, status: w.status, updatedAt: w.updatedAt, createdAt: w.createdAt, aspect: w.aspect,
    style: w.style, scenes: w.plan?.scenes?.length || 0, revision: w.plan?.revision || 0,
    duration: w.film?.duration || null, poster: w.film ? `works/${w.id}/file/${w.film.poster}?v=${w.film.version}` : null,
    progress: w.job?.progress ?? 0, sessionId: w.sessionId || null,
  }
}

/** 一部作品的完整视图：给卡片和管理页 */
export function view(w) {
  const file = p => (p ? `works/${w.id}/file/${p}${w.film?.version ? `?v=${w.film.version}` : ''}` : null)
  return {
    ...summary(w),
    voice: w.voice, plan: w.plan,
    job: w.job ? { ...w.job, segments: (w.job.segments || []).map(s => ({ ...s, poster: s.state === 'done' ? file(s.poster) : null, video: s.state === 'done' ? file(s.file) : null, voiceUrl: s.state === 'done' && s.voice?.file ? file(s.voice.file) : null })) } : null,
    film: w.film ? { ...w.film, url: file(w.film.file), posterUrl: file(w.film.poster) } : null,
    subtitles: (w.timeline?.tracks.find(t => t.type === 'subtitle')?.clips || []).map(c => ({ start: c.start, end: c.start + c.dur, text: c.text })),
    subtitlesHidden: Boolean(w.timeline?.tracks.find(t => t.type === 'subtitle')?.hidden),
    exporting: w.exporting || null, exports: w.exports || [], edits: (w.edits || []).slice(-5), running: isRunning(w.id),
    dir: workDir(w.id),
  }
}

/**
 * 在系统文件管理器里显示：文件就选中它所在的位置，文件夹就打开它。
 * macOS 用 open -R；Windows 用 explorer /select,（直接 explorer 文件会用默认程序打开它）；
 * Linux 没有通用的「选中」，打开所在文件夹。
 */
function reveal(path) {
  const isFile = existsSync(path) && statSync(path).isFile()
  if (process.platform === 'darwin') execFile('open', isFile ? ['-R', path] : [path], () => {})
  // explorer 只认 /select,"路径" 这种写法（引号在逗号后面），所以自己拼参数、不让 Node 再加引号；Windows 路径里不会有双引号
  else if (process.platform === 'win32') execFile('explorer.exe', [isFile ? `/select,"${path}"` : `"${path}"`], { windowsVerbatimArguments: true }, () => {})
  else execFile('xdg-open', [isFile ? dirname(path) : path], () => {})
}

function state() {
  return {
    settings: publicSettings(),
    runtime: { ...runtimeStatus(), setup: setupProgress() },
    login: loginState(),
    model: modelInfo(),
    site: siteUrl(),
  }
}

export async function route(req, res) {
  const url = new URL(req.url || '/', 'http://x')
  const path = decodeURIComponent(url.pathname.slice(BASE.length)).replace(/^\/+/, '')
  const method = req.method || 'GET'
  let m

  if (method === 'GET' || method === 'HEAD') {
    if (path === 'state') return json(res, 200, state())
    if (path === 'models') return json(res, 200, { models: await listModels(), current: modelInfo() })
    if (path === 'works') return json(res, 200, { works: listWorks().filter(w => !w.hidden).map(summary) })
    if ((m = /^works\/([\w-]+)$/.exec(path))) {
      const w = getWork(assertId(m[1]))
      return w ? json(res, 200, view(w)) : json(res, 404, { error: '作品不存在' })
    }
    if ((m = /^works\/([\w-]+)\/file\/(.+)$/.exec(path))) {
      const dir = workDir(assertId(m[1]))
      const file = resolve(dir, m[2])
      return isInside(dir, file) ? sendFile(req, res, file) : json(res, 403, { error: '路径不合法' })
    }
    if (path === 'styles') return json(res, 200, await listStyles(url.searchParams.get('lang') || 'zh'))
    if ((m = /^styles\/mine\/([\w-]+)\/file\/(.+)$/.exec(path))) {
      const dir = mineDir(m[1])
      const file = resolve(dir, m[2])
      return isInside(dir, file) ? sendFile(req, res, file) : json(res, 403, { error: '路径不合法' })
    }
    if ((m = /^tmp\/(.+)$/.exec(path))) {
      const file = resolve(tmpDir(), m[1])
      return isInside(tmpDir(), file) ? sendFile(req, res, file) : json(res, 403, { error: '路径不合法' })
    }
    // 「在剪映中打开」之前的检查：装没装、草稿目录、能不能写、是不是正开着
    if (path === 'jianying/status') return json(res, 200, jianyingStatus())
    // 本机配音：电脑配置、能跑哪些模型、装好的测速结果、下载进度
    if (path === 'local-voice') return json(res, 200, localVoiceStatus())
    if (path === 'events') return sse(req, res)
    return json(res, 404, { error: '接口不存在' })
  }

  if (method !== 'POST') return json(res, 405, { error: '不支持的方法' })
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return json(res, 403, { error: '拒绝跨站请求' })
  const body = await readBody(req)

  if ((m = /^works\/([\w-]+)\/(produce|revise|export|open-jianying|delete|reveal|rename)$/.exec(path))) {
    const id = assertId(m[1])
    const w = requireWork(id)
    switch (m[2]) {
      case 'produce':
        if (body.action === 'pause') pauseProduction(id)
        else await startProduction(id)
        return json(res, 200, view(requireWork(id)))
      case 'revise':
        return json(res, 200, view((await reviseFilm(id, body.ops)).work))
      case 'export':
        return json(res, 200, view(await startExport(id, body)))
      case 'open-jianying':
        return json(res, 200, await openInJianying(id, { restart: Boolean(body.restart) }))
      case 'delete':
        pauseProduction(id)
        deleteWork(id)
        return json(res, 200, { ok: true })
      case 'reveal': {
        // 只打开作品目录或导出记录里的路径，不接受任意路径
        const target = body.path && (w.exports || []).some(e => e.path === body.path) ? body.path : w.film ? join(workDir(id), w.film.file) : workDir(id)
        reveal(target)
        return json(res, 200, { path: target })
      }
      case 'rename':
        return json(res, 200, view(await updateWork(id, x => ((x.title = String(body.title || x.title).slice(0, 60)), x))))
    }
  }
  if ((m = /^styles\/([\w-]+)\/install$/.exec(path))) {
    const entry = (await platformCatalog('zh')).find(s => s.slug === m[1])
    if (!entry) return json(res, 404, { error: '没有这个风格' })
    await installPlatformStyle(entry)
    return json(res, 200, { ok: true })
  }
  if ((m = /^styles\/mine\/([\w-]+)\/(delete|save)$/.exec(path))) {
    if (m[2] === 'delete') removeMine(m[1])
    else saveDistilled(m[1])
    return json(res, 200, await listStyles('zh'))
  }
  if (path === 'distill') return json(res, 200, await startDistill(body))
  if (path === 'runtime/setup') {
    // 下载完（或失败）时给页面一条提示；正在准备时重复点不会重复提示
    if (!setupProgress().running) {
      setupRuntime().then(p => notify(p.error
        ? { kind: 'runtime-failed', tone: 'warning', text: `渲染环境没准备好：${p.error}`.slice(0, 160) }
        : { kind: 'runtime-ready', tone: 'success', text: '渲染环境准备好了，可以开拍' }), () => {})
    }
    return json(res, 200, state())
  }
  if (path === 'login') return json(res, 200, await startLogin())
  if (path === 'logout') return json(res, 200, logout())
  if (path === 'settings') {
    updateSettings(body)
    return json(res, 200, state())
  }
  if (path === 'settings/test-voice') {
    const file = join(ensureDir(tmpDir()), `voice-test-${Date.now()}.wav`)
    const sec = await speak(body.text || '你好，这是 lovideo 的配音试听。', file, readSettings().voice)
    return json(res, 200, { seconds: sec, url: `tmp/${file.split(/[\\/]/).pop()}` })
  }
  if (path === 'local-voice/setup') return json(res, 200, startLocalVoiceSetup(String(body.model || '')))
  return json(res, 404, { error: '接口不存在' })
}

/** 作品有变化就推给页面（卡片和管理页据此刷新，不用轮询） */
function sse(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  res.write(': ok\n\n')
  const onChange = ({ id, work }) => res.write(`data: ${JSON.stringify({ id, status: work?.status ?? null, progress: work?.job?.progress ?? null })}\n\n`)
  const onNotice = notice => res.write(`data: ${JSON.stringify({ type: 'notice', ...notice })}\n\n`)
  events.on('change', onChange)
  notices.on('notice', onNotice)
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
  req.on('close', () => {
    clearInterval(ping)
    events.off('change', onChange)
    notices.off('notice', onNotice)
  })
}
