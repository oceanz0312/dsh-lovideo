// 插件在本机的各个目录。DSH 桌面版和网页版读同一个 DSH_HOME，所以数据也只有一份。
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function dshHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh')
}

/** 插件的数据根目录；测试里用 LOVIDEO_DATA_DIR 指到临时目录 */
export function dataDir(env = process.env) {
  return env.LOVIDEO_DATA_DIR || join(dshHome(env), 'lovideo')
}

export const worksDir = () => join(dataDir(), 'works')
export const stylesDir = () => join(dataDir(), 'styles')
export const runtimeDir = () => join(dataDir(), 'runtime')
export const tmpDir = () => join(dataDir(), 'tmp')

/** 默认导出位置：macOS 放「影片」，其他系统放「视频」 */
export function defaultExportDir() {
  const base = process.platform === 'darwin' ? 'Movies' : 'Videos'
  return join(homedir(), base, 'lovideo')
}

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 判断 child 是否在 parent 里面（防止路径穿越） */
export function isInside(parent, child) {
  const p = resolve(parent) + sep
  const c = resolve(child)
  return c === resolve(parent) || c.startsWith(p)
}

/** 作品、风格、段的 id 只许字母数字和 - _，可以直接拼进路径 */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/

export function assertId(id, what = 'id') {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw Object.assign(new Error(`${what} 不合法`), { status: 400 })
  return id
}
