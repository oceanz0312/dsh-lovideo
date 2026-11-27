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
import { withFileLock } from './lock.js'

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

function write(work) {
  work.updatedAt = new Date().toISOString()
  ensureDir(workDir(work.id))
  writeJson(file(work.id), work)
  return work
}

function save(work) {
  write(work)
  events.emit('change', { id: work.id, work })
  return work
}

/**
 * 片长和镜头：片长 10 秒到 10 分钟，是目标不是指标。分档越长越粗：
 * 1 分钟内每 10 秒一档，1–5 分钟每 30 秒一档，5–10 分钟每分钟一档（分镜卡上拖动条按档跳）。
 * 一镜是制作时单独画的一段，每多一段就多一轮模型调用，所以一镜至少 15 秒（不到 30 秒的片子只有一镜）。
 */
export const MIN_SHOT_SEC = 15
export const DEFAULT_DURATION = 30
export const FILM_DURATIONS = [
  10, 20, 30, 40, 50, 60,
  90, 120, 150, 180, 210, 240, 270, 300,
  360, 420, 480, 540, 600,
]
/** 用户或导演给的任意秒数 → 最近的一档 */
export const nearestDuration = n => FILM_DURATIONS.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a))

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

// 同一进程里对同一部作品的修改排队进行，避免两个异步步骤互相覆盖；
// 跨进程（DSH 桌面版和网页版同时开着）靠 work.json 旁边的锁文件排队
const queues = new Map()

/** 读出最新的 work.json，交给 fn（同步）修改，再写回；fn 返回 false 表示不写 */
export function updateWork(id, fn) {
  const prev = queues.get(id) || Promise.resolve()
  const next = prev.then(() => {
    // 锁里只读、改、写，几毫秒就放；通知界面放到锁外面
    const { work, changed } = withFileLock(file(id), () => {
      const work = requireWork(id)
      const out = fn(work)
      if (out === false) return { work, changed: false }
      return { work: write(out && typeof out === 'object' ? out : work), changed: true }
    })
    if (changed) events.emit('change', { id: work.id, work })
    return work
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
