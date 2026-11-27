// JSON 文件的原子读写：先写临时文件再改名，读的一方不会读到半个文件。
// 读出来改完再写回的，用 updateJson：DSH 桌面版和网页版两个进程可能同时改同一个文件，要排队。
import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { withFileLock } from './lock.js'

export function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(file, value, { secret = false } = {}) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 1) + '\n', { mode: secret ? 0o600 : 0o644 })
  renameSync(tmp, file)
  if (secret) {
    try {
      chmodSync(file, 0o600)
    } catch {
      // Windows 不支持 POSIX 权限，忽略
    }
  }
}

/**
 * 跨进程排队地「读最新的-改-写回」：fn 拿到当前内容（没有时是 fallback），返回要写的新内容；
 * 返回 undefined 表示不写。fn 要是同步的（锁不跨 await）。返回 fn 的结果。
 */
export function updateJson(file, fn, { fallback = null, secret = false } = {}) {
  return withFileLock(file, () => {
    const next = fn(readJson(file, fallback))
    if (next !== undefined) writeJson(file, next, { secret })
    return next
  })
}
