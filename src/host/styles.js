// 风格库：平台风格（lovideo.ai 上架的，注册即免费，用到时下载到本机）和我的风格（自己蒸馏的）。
// 风格就是一个 Skill 包（SKILL.md + assets/ + scripts/），格式和网站完全一样，见 docs/PROTOCOL.md。
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertId, ensureDir, stylesDir, tmpDir } from './paths.js'
import { readJson, writeJson } from './json-file.js'
import { siteFetch, siteJson } from './site.js'

const platformRoot = () => join(stylesDir(), 'platform')
const mineRoot = () => join(stylesDir(), 'mine')
const catalogFile = () => join(stylesDir(), 'catalog.json')

/** SKILL.md 的 frontmatter */
export function readFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!m) return {}
  const field = k => (m[1].match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) || [])[1]?.trim().replace(/^(["'])(.*)\1$/, '$2')
  return { name: field('name'), description: field('description') }
}

/* ---------- 平台风格 ---------- */

/** 平台风格目录（公开接口，不用登录）；离线时用上次的缓存 */
export async function platformCatalog(lang = 'zh', { refresh = false } = {}) {
  const cached = readJson(catalogFile(), null)
  if (cached && !refresh && Date.now() - Date.parse(cached.at) < 10 * 60_000 && cached.lang === lang) return cached.styles
  try {
    const body = await siteJson(`/api/v1/styles?lang=${encodeURIComponent(lang)}`)
    const styles = (body.styles || []).map(s => ({ ...s, source: 'platform' }))
    ensureDir(stylesDir())
    writeJson(catalogFile(), { at: new Date().toISOString(), lang, styles })
    return styles
  } catch (err) {
    if (cached) return cached.styles
    throw err
  }
}

function installedDir(slug, revision) {
  return join(platformRoot(), assertId(slug, '风格'), revision.slice(0, 16), 'skill')
}

export function installedRevision(slug) {
  const dir = join(platformRoot(), slug)
  if (!existsSync(dir)) return null
  const meta = readJson(join(dir, 'current.json'))
  return meta?.revision || null
}

/** 找到解压后最浅一层的 SKILL.md 所在目录 */
function skillRoot(dir) {
  const queue = [dir]
  while (queue.length) {
    const d = queue.shift()
    if (existsSync(join(d, 'SKILL.md'))) return d
    for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) queue.push(join(d, e.name))
  }
  return null
}

const installing = new Map()

/** 下载并安装一个平台风格（要登录）；已装同一版本直接返回 */
export function installPlatformStyle(entry) {
  const key = `${entry.slug}@${entry.revision}`
  if (installing.has(key)) return installing.get(key)
  const job = (async () => {
    const dest = installedDir(entry.slug, entry.revision)
    if (existsSync(join(dest, 'SKILL.md'))) return dest
    const res = await siteFetch(`/api/v1/styles/${encodeURIComponent(entry.id || entry.slug)}/package`, { auth: true, signal: AbortSignal.timeout(300_000) })
    if (!res.ok) throw new Error(res.status === 403 ? '这个风格暂时不能下载' : `下载风格失败：HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const sha = createHash('sha256').update(buf).digest('hex')
    if (entry.revision && sha !== entry.revision) throw new Error('风格包校验失败（内容和版本号对不上）')
    const work = join(ensureDir(tmpDir()), `style-${sha.slice(0, 12)}-${Date.now()}`)
    mkdirSync(work, { recursive: true })
    try {
      const tgz = join(work, 'skill.tgz')
      writeFileSync(tgz, buf)
      const tar = await import('tar')
      const out = join(work, 'x')
      mkdirSync(out)
      await tar.x({ file: tgz, cwd: out, strict: true, filter: p => !p.split(/[\\/]/).includes('..') })
      const root = skillRoot(out)
      if (!root) throw new Error('风格包里没有 SKILL.md')
      mkdirSync(join(dest, '..'), { recursive: true })
      rmSync(dest, { recursive: true, force: true })
      renameSync(root, dest)
      writeJson(join(platformRoot(), entry.slug, 'current.json'), { revision: sha, at: new Date().toISOString(), entry })
      return dest
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })()
  installing.set(key, job)
  job.finally(() => installing.delete(key))
  return job
}

/* ---------- 我的风格 ---------- */

export function listMine() {
  const root = ensureDir(mineRoot())
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => readJson(join(root, d.name, 'style.json')))
    .filter(Boolean)
    .map(s => ({ ...s, source: 'mine', installed: true }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export const mineDir = slug => join(mineRoot(), assertId(slug, '风格'))

export function saveMine(meta) {
  const dir = ensureDir(mineDir(meta.slug))
  const now = new Date().toISOString()
  const prev = readJson(join(dir, 'style.json'), {})
  const out = { createdAt: now, ...prev, ...meta, updatedAt: now }
  writeJson(join(dir, 'style.json'), out)
  return out
}

export function removeMine(slug) {
  rmSync(mineDir(slug), { recursive: true, force: true })
}

/** 把一个现成的 Skill 目录收进「我的风格」（蒸馏完成、或开发时导入） */
export function importMineFromDir(slug, srcSkillDir, meta = {}) {
  const dest = join(ensureDir(mineDir(slug)), 'skill')
  rmSync(dest, { recursive: true, force: true })
  cpSync(srcSkillDir, dest, { recursive: true })
  const fm = readFrontmatter(readFileSync(join(dest, 'SKILL.md'), 'utf8'))
  return saveMine({ slug, name: meta.name || fm.name || slug, description: meta.description || fm.description || '', aspects: meta.aspects || ['16:9', '9:16'], fps: meta.fps || 30, ...meta })
}

/* ---------- 制作用：按 slug 拿到可用的 Skill 目录 ---------- */

/**
 * @returns {Promise<{slug, name, source, revision, dir, aspects, fps, skillMd}>}
 */
export async function resolveStyle(slug, { lang = 'zh' } = {}) {
  const mine = listMine().find(s => s.slug === slug)
  if (mine) {
    const dir = join(mineDir(slug), 'skill')
    return { ...mine, dir, revision: mine.revision || 'local', skillMd: readFileSync(join(dir, 'SKILL.md'), 'utf8') }
  }
  const catalog = await platformCatalog(lang).catch(() => [])
  let entry = catalog.find(s => s.slug === slug || s.id === slug)
  if (!entry) {
    // 离线又没目录时，用本机已经装过的版本
    const rev = installedRevision(slug)
    if (!rev) throw Object.assign(new Error(`找不到风格「${slug}」`), { status: 404 })
    const cur = readJson(join(platformRoot(), slug, 'current.json'))
    entry = cur.entry
  }
  const dir = await installPlatformStyle(entry)
  return { ...entry, source: 'platform', dir, skillMd: readFileSync(join(dir, 'SKILL.md'), 'utf8') }
}

/** 管理页用：平台风格（标出哪些已在本机）和我的风格 */
export async function listStyles(lang = 'zh') {
  let platform = []
  let offline = false
  try {
    platform = await platformCatalog(lang)
  } catch {
    offline = true
  }
  platform = platform.map(s => ({ ...s, installed: Boolean(installedRevision(s.slug)) && installedRevision(s.slug) === s.revision }))
  return { platform, mine: listMine(), offline }
}
