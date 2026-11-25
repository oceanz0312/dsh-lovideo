// 作品：本机一个文件夹加一份 work.json 清单。聊天卡片和管理页读的是同一份，所以两边永远一致。
//   works/<id>/work.json   清单（分镜、制作状态、成片、时间线、导出记录）
//   works/<id>/proj/       风格工程（每段一个子目录）
//   works/<id>/segs/       每段渲染好的视频
//   works/<id>/voice/      每段的口播
//   works/<id>/film/       成片和封面
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { assertId, ensureDir, worksDir } from './paths.js'
import { readJson, writeJson } from './json-file.js'

export const events = new EventEmitter()
events.setMaxListeners(100)

export const workDir = id => join(worksDir(), assertId(id, '作品 id'))
const file = id => join(workDir(id), 'work.json')

export function newId(prefix = 'w') {
  return `${prefix}${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
}

export function getWork(id) {
  return readJson(file(id))
}

export function requireWork(id) {
  const w = getWork(id)
  if (!w) throw Object.assign(new Error(`找不到作品 ${id}`), { status: 404 })
  return w
}

export function listWorks() {
  const root = ensureDir(worksDir())
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => readJson(join(root, d.name, 'work.json')))
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

function save(work) {
  work.updatedAt = new Date().toISOString()
  ensureDir(workDir(work.id))
  writeJson(file(work.id), work)
  events.emit('change', { id: work.id, work })
  return work
}

/**
 * 片长和镜头（和 lovideo 网站一样）：片长 30 秒到 5 分钟、每 30 秒一档，是目标不是指标；
 * 一镜是制作时单独画的一段，每多一段就多一轮模型调用，所以一镜至少 15 秒。
 */
export const MIN_SHOT_SEC = 15
export const DEFAULT_DURATION = 30
export const FILM_DURATIONS = Array.from({ length: 10 }, (_, i) => 30 + i * 30)

export function createWork(fields) {
  const now = new Date().toISOString()
  const work = {
    id: newId(),
    title: '未命名作品',
    createdAt: now,
    updatedAt: now,
    status: 'draft',
    aspect: '16:9',
    fps: 30,
    duration: DEFAULT_DURATION,
    voice: { enabled: true },
    music: { enabled: false },
    subtitles: { enabled: true },
    // 用户在分镜卡上定的（duration / voice / music / subtitles），导演改分镜时照这个来
    choices: {},
    plan: null,
    job: null,
    film: null,
    timeline: null,
    exports: [],
    ...fields,
  }
  return save(work)
}

// 同一进程里对同一部作品的修改排队进行，避免两个异步步骤互相覆盖
const queues = new Map()

/** 读出最新的 work.json，交给 fn 修改，再写回；fn 返回 false 表示不写 */
export function updateWork(id, fn) {
  const prev = queues.get(id) || Promise.resolve()
  const next = prev.then(() => {
    const work = requireWork(id)
    const out = fn(work)
    if (out === false) return work
    return save(out && typeof out === 'object' ? out : work)
  })
  queues.set(id, next.catch(() => {}))
  return next
}

export function deleteWork(id) {
  const dir = workDir(id)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  events.emit('change', { id, work: null })
  return true
}
