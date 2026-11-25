// JSON 文件的原子读写：先写临时文件再改名，读的一方不会读到半个文件。
import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs'

export function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(file, value, { secret = false } = {}) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
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
