// 从几个候选地址里下载一个文件：国内经常连不上 GitHub、谷歌，或者连上了却极慢、半路卡住。
// 做法：先并行发一个很小的探测，几秒内谁先回应就先用谁；下载时用两段超时，
// 等响应头太久、或下载中太久没有新数据，就放弃这个地址换下一个。不用总时长超时，大文件在慢网里也能下完。
// 全部失败时把每个地址和原因写成一句中文，用户能看懂、也知道下一步怎么办。
import { createWriteStream, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const DEFAULTS = { headerTimeoutMs: 20_000, stallTimeoutMs: 30_000, probeMs: 4_000 }

/* ---------- 探测：哪个地址先回应 ---------- */

// 探测结果按站点（origin）记 10 分钟：一次准备要下好几个文件（字体有 22 个），不用每个都探一遍
const PROBE_TTL = 10 * 60_000
const probeCache = new Map()
const originOf = url => {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/** 测试用：清掉探测缓存 */
export const clearProbeCache = () => probeCache.clear()

/** 探一个地址：回应了返回 { ms, status }，没回应 ms 是 Infinity */
async function probeOne(url, ms, signal) {
  const ac = new AbortController()
  const stop = () => ac.abort()
  const timer = setTimeout(stop, ms)
  signal?.addEventListener('abort', stop, { once: true })
  const t0 = Date.now()
  try {
    // 只要 1 个字节：服务器不认 Range 也没关系，拿到响应头就断开
    const res = await fetch(url, { redirect: 'follow', headers: { Range: 'bytes=0-0' }, signal: ac.signal })
    ac.abort()
    return { ms: Date.now() - t0, status: res.status }
  } catch {
    return { ms: Infinity, status: 0 }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
  }
}

/**
 * 按探测结果排序：probeMs 内回应了（且不是 4xx/5xx）的按快慢排在前面，其余保持原来的顺序排在后面。
 * 后面的地址不会被丢掉：探测时没回应不代表真下载一定不行。
 * 缓存只记站点快不快；某个文件在这个站点上没有（404）只影响这一次排序。
 */
export async function fasterFirst(urls, { probeMs = DEFAULTS.probeMs, signal } = {}) {
  const list = [...new Set(urls)]
  if (list.length < 2) return list
  const now = Date.now()
  const missing = new Set()
  await Promise.all(list.map(async url => {
    const hit = probeCache.get(originOf(url))
    if (hit && now - hit.at < PROBE_TTL) return
    const r = await probeOne(url, probeMs, signal)
    // 同一个站点这一轮探了好几个地址时，记最快的那次
    const old = probeCache.get(originOf(url))
    if (!old || old.at < now || r.ms < old.ms) probeCache.set(originOf(url), { ms: r.ms, at: Date.now() })
    if (r.status >= 400) missing.add(url)
  }))
  // 按站点快慢排，同一个站点上的地址保持给的顺序（毫秒级的抖动不该把排在后面的备用版本换到前面）
  const rank = url => (missing.has(url) ? Infinity : probeCache.get(originOf(url))?.ms ?? Infinity)
  return list.map((url, i) => ({ url, i, ms: rank(url) })).sort((a, b) => a.ms - b.ms || a.i - b.i).map(x => x.url)
}

/* ---------- 下载一个地址 ---------- */

const mb = n => `${(n / 1024 / 1024).toFixed(1)} MB`
const sec = ms => `${Math.round(ms / 1000)} 秒`

/** 把网络错误翻成大白话 */
function reasonOf(err) {
  if (err?.lovideoReason) return err.lovideoReason
  const code = err?.cause?.code || err?.code || ''
  const map = {
    ENOTFOUND: '找不到这个网站（域名解析失败）',
    EAI_AGAIN: '域名解析失败，网络可能断了',
    ECONNREFUSED: '连接被拒绝',
    ECONNRESET: '连接被中途断开',
    ETIMEDOUT: '连接超时',
    EHOSTUNREACH: '连不到这台服务器',
    ENETUNREACH: '网络不通',
    UND_ERR_CONNECT_TIMEOUT: '连接超时',
    UND_ERR_SOCKET: '连接被中途断开',
    CERT_HAS_EXPIRED: '网站证书已过期',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: '网站证书校验失败',
    SELF_SIGNED_CERT_IN_CHAIN: '网站证书校验失败（可能被代理或防火墙拦截）',
    ENOSPC: '磁盘空间不够',
  }
  if (map[code]) return map[code]
  return err?.message ? String(err.message).slice(0, 120) : '网络不通'
}

const fail = reason => Object.assign(new Error(reason), { lovideoReason: reason })

/**
 * 下载一个地址到 part 文件。超时、断线、HTTP 错误都抛出带 lovideoReason 的错误；用户取消抛 AbortError。
 * transforms 是写盘前要经过的处理（比如解压 .gz），按顺序串起来。
 */
async function fetchOne(url, part, { headerTimeoutMs, stallTimeoutMs, onProgress, signal, transforms = [] }) {
  const ac = new AbortController()
  let why = null
  const abort = reason => {
    why ??= reason
    ac.abort()
  }
  const onUserAbort = () => abort(null)
  signal?.addEventListener('abort', onUserAbort, { once: true })
  let timer = setTimeout(() => abort(`等了 ${sec(headerTimeoutMs)}没有回应`), headerTimeoutMs)
  let got = 0
  try {
    let res
    try {
      // 不要压缩传输：.gz 这类文件要原样写盘，进度也按 content-length 算
      res = await fetch(url, { redirect: 'follow', headers: { 'accept-encoding': 'identity' }, signal: ac.signal })
    } catch (err) {
      throw why ? fail(why) : err
    }
    if (!res.ok || !res.body) {
      res.body?.cancel().catch(() => {})
      throw fail(res.status === 404 ? 'HTTP 404（这里没有这个文件）' : `HTTP ${res.status}`)
    }
    clearTimeout(timer)
    const total = Number(res.headers.get('content-length')) || 0
    const stall = () => abort(`下载到 ${mb(got)} 后 ${sec(stallTimeoutMs)}没有新数据`)
    timer = setTimeout(stall, stallTimeoutMs)
    // 数一数收到多少字节；每来一块数据就重新计时，太久没有新数据就判定卡住
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        got += chunk.length
        clearTimeout(timer)
        timer = setTimeout(stall, stallTimeoutMs)
        if (total) onProgress?.(Math.min(1, got / total), got, total)
        cb(null, chunk)
      },
    })
    try {
      await pipeline(Readable.fromWeb(res.body), meter, ...transforms.map(make => make()), createWriteStream(part), { signal: ac.signal })
    } catch (err) {
      throw why ? fail(why) : err
    }
    if (total && got < total) throw fail(`只下载到 ${mb(got)}，共 ${mb(total)}，连接提前断了`)
  } catch (err) {
    if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })
    throw err
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onUserAbort)
  }
}

/* ---------- 对外：多个地址轮流试 ---------- */

/**
 * 从候选地址下载文件到 dest（先写 dest.part，下完再改名，半截文件不会被当成好的）。
 * @param {string[]} urls 候选地址，排在前面的优先（探测后按快慢重排）
 * @param {string} dest 目标文件
 * @param {object} [opts]
 * @param {string} [opts.label] 下载的是什么，用在错误信息里，比如「ffmpeg」
 * @param {string} [opts.hint] 全部失败时给用户的建议
 * @param {(fraction: number, got: number, total: number) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @param {Array<() => import('node:stream').Transform>} [opts.transforms] 写盘前的处理，比如 () => createGunzip()
 * @param {number} [opts.headerTimeoutMs] 等响应头最多多久
 * @param {number} [opts.stallTimeoutMs] 下载中多久没有新数据算卡住
 * @param {number} [opts.probeMs] 探测最多等多久；0 表示不探测，按给的顺序试
 * @returns {Promise<{ url: string, file: string }>} 实际用的地址
 */
export async function download(urls, dest, opts = {}) {
  const { label = '文件', hint, signal, probeMs = DEFAULTS.probeMs } = opts
  const o = { headerTimeoutMs: DEFAULTS.headerTimeoutMs, stallTimeoutMs: DEFAULTS.stallTimeoutMs, ...opts }
  const order = probeMs > 0 ? await fasterFirst(urls, { probeMs, signal }) : [...new Set(urls)]
  const part = `${dest}.part`
  const tried = []
  for (const url of order) {
    if (signal?.aborted) break
    o.onProgress?.(0, 0, 0)
    try {
      await fetchOne(url, part, o)
      renameSync(part, dest)
      return { url, file: dest }
    } catch (err) {
      rmSync(part, { force: true })
      if (err.name === 'AbortError') throw err
      tried.push({ url, reason: reasonOf(err) })
      // 这个站点不行了，下次探测重新测，免得别的文件还先排它
      probeCache.delete(originOf(url))
    }
  }
  if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })
  throw downloadError(label, tried, hint)
}

/** 全部地址都失败时的错误：建议放前面（页面提示条会截断长消息），后面列出每个地址和原因 */
export function downloadError(label, tried, hint) {
  const list = tried.map((t, i) => `${i + 1}. ${t.url}：${t.reason}`).join('；')
  const tip = hint || '请检查网络后再点一次'
  return Object.assign(new Error(`${label}下载失败，试了 ${tried.length} 个地址都不行。${tip}。各地址的情况：${list}`), { tried })
}

/** 下载一个小文件（版本清单、包索引）并读成文字；规则和 download 一样 */
export async function downloadText(urls, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lovideo-dl-'))
  try {
    const { url, file } = await download(urls, join(dir, 'body'), opts)
    return { url, text: readFileSync(file, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
