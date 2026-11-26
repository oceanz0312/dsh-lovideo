// 风格总览图：把所有风格的封面拼成几张带编号的图，导演挑风格时一起看。
// 一张图最多 16 个风格（4 × 4），每格是封面 + 「编号 名字」；编号和文字列表里的一致。
// 用渲染用的那个浏览器拼图；同一批风格拼过就直接用缓存。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, stylesDir } from './paths.js'
import { getBrowser } from './render.js'
import { mineDir } from './styles.js'

export const PER_SHEET = 16
const COLS = 4
const TILE_W = 240
const TILE_H = 135
const LABEL_H = 26
const GAP = 8
const LAYOUT = 1

const sheetsDir = () => join(stylesDir(), 'sheets')

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const coversDir = () => join(stylesDir(), 'covers')
const dataUrl = (buf, type) => `data:${type};base64,${buf.toString('base64')}`

/** 官方风格的封面先下到本机（按地址缓存），拼图时不等网络 */
async function fetchCover(url) {
  const file = join(ensureDir(coversDir()), createHash('sha256').update(url).digest('hex').slice(0, 24))
  if (existsSync(file)) return file
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`封面下载失败（${res.status}）`)
  writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  return file
}

/** 一个风格封面在拼图页里的地址（data URL）：官方风格用网站的图，我的风格读本机文件；没有就空着 */
async function coverSrc(s) {
  try {
    if (s.source === 'mine') {
      const file = s.cover ? join(mineDir(s.slug), s.cover) : ''
      if (!file || !existsSync(file)) return ''
      const lower = file.toLowerCase()
      return dataUrl(readFileSync(file), lower.endsWith('.png') ? 'image/png' : lower.endsWith('.webp') ? 'image/webp' : 'image/jpeg')
    }
    if (!s.cover) return ''
    const buf = readFileSync(await fetchCover(s.cover))
    const type = buf[0] === 0x89 ? 'image/png' : buf.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/jpeg'
    return dataUrl(buf, type)
  } catch {
    return ''
  }
}

/** 同时最多下 n 个 */
async function mapLimit(list, n, fn) {
  const out = new Array(list.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (next < list.length) {
      const i = next++
      out[i] = await fn(list[i])
    }
  }))
  return out
}

function page(items, srcs, start) {
  const tiles = items.map((s, i) => {
    const src = srcs[i]
    return `<figure><div class="img">${src ? `<img src="${esc(src)}">` : '<span>没有封面</span>'}</div><figcaption><b>${start + i + 1}</b>${esc(s.name)}</figcaption></figure>`
  }).join('')
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{background:#fff;font:15px/1 "PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif;color:#111;padding:${GAP}px;width:${COLS * TILE_W + (COLS + 1) * GAP}px}
main{display:grid;grid-template-columns:repeat(${COLS},${TILE_W}px);gap:${GAP}px}
.img{width:${TILE_W}px;height:${TILE_H}px;background:#e5e5e5;display:grid;place-items:center;overflow:hidden;border-radius:4px}
.img img{width:100%;height:100%;object-fit:cover}
.img span{color:#888;font-size:13px}
figcaption{height:${LABEL_H}px;display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden}
figcaption b{display:inline-grid;place-items:center;min-width:24px;height:19px;padding:0 4px;border-radius:4px;background:#111;color:#fff;font-size:13px}
</style><main>${tiles}</main>`
}

/**
 * 拼好的总览图（JPEG）。styles 的顺序就是编号顺序。
 * @returns {Promise<{ file: string, from: number, to: number }[]>}
 */
export async function styleSheets(styles) {
  // 张数按每张最多 16 个算，再平均分（113 个分成 8 张、每张 14 到 15 个，不会剩一张只有一个）
  const count = Math.max(1, Math.ceil(styles.length / PER_SHEET))
  const per = Math.ceil(styles.length / count)
  // 缓存按风格（名字、封面、版本）和每张几个来认；排版改了要换 LAYOUT
  const key = createHash('sha256').update(JSON.stringify([LAYOUT, per, styles.map(s => [s.slug, s.name, s.cover || '', s.updatedAt || s.revision || ''])])).digest('hex').slice(0, 16)
  const dir = ensureDir(sheetsDir())
  const sheets = []
  for (let i = 0, start = 0; start < styles.length; i++, start += per) {
    sheets.push({ file: join(dir, `${key}-${i + 1}.jpg`), from: start + 1, to: Math.min(styles.length, start + per) })
  }
  if (sheets.every(s => existsSync(s.file))) return sheets
  const browser = await getBrowser()
  const tab = await browser.newPage()
  try {
    for (const s of sheets) {
      if (existsSync(s.file)) continue
      const items = styles.slice(s.from - 1, s.to)
      const rows = Math.ceil(items.length / COLS)
      await tab.setViewport({ width: COLS * TILE_W + (COLS + 1) * GAP, height: rows * (TILE_H + LABEL_H) + (rows + 1) * GAP, deviceScaleFactor: 1 })
      const srcs = await mapLimit(items, 8, coverSrc)
      await tab.setContent(page(items, srcs, s.from - 1), { waitUntil: 'load', timeout: 45_000 })
      writeFileSync(s.file, await tab.screenshot({ type: 'jpeg', quality: 82, fullPage: true }))
    }
  } finally {
    await tab.close().catch(() => {})
  }
  // 旧的拼图删掉，只留这一批
  for (const f of readdirSync(dir)) if (!f.startsWith(key)) rmSync(join(dir, f), { force: true })
  return sheets
}
