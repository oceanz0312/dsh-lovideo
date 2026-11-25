// 插件设置：配音、配乐用用户自己的 key，导出位置，同时渲染几段，lovideo 账号。
// 整个文件只存在本机（权限 0600），key 不进作品数据、不发给模型、不上传 lovideo。
import { join } from 'node:path'
import { dataDir, defaultExportDir, ensureDir } from './paths.js'
import { readJson, writeJson } from './json-file.js'

export const VOICE_PROVIDERS = ['local', 'system', 'doubao', 'openai', 'elevenlabs', 'none']
export const MUSIC_PROVIDERS = ['none', 'elevenlabs', 'file']

const DEFAULTS = {
  version: 1,
  // 系统自带语音：电脑上本来就有，默认用它；想要更好的声音再填自己的 key
  voice: { provider: 'system', url: '', voice: '', model: '', key: '' },
  music: { provider: 'none', url: '', model: '', key: '', file: '' },
  exportDir: '',
  parallel: 2,
  model: null,
  site: 'https://lovideo.ai',
  account: null,
  // 本机配音模型：装好并测过速的模型 { id: { rtf, load, backend, at } }
  local: { models: {} },
}

const file = () => join(ensureDir(dataDir()), 'settings.json')

export function readSettings() {
  const saved = readJson(file(), {}) || {}
  return {
    ...DEFAULTS,
    ...saved,
    voice: { ...DEFAULTS.voice, ...(saved.voice || {}) },
    music: { ...DEFAULTS.music, ...(saved.music || {}) },
    local: { models: {}, ...(saved.local || {}) },
  }
}

export function writeSettings(next) {
  writeJson(file(), next, { secret: true })
  return next
}

const mask = key => (key ? `••••${String(key).slice(-4)}` : '')

/** 给界面看的设置：key 只露末 4 位 */
export function publicSettings(s = readSettings()) {
  return {
    voice: { ...s.voice, key: mask(s.voice.key), hasKey: Boolean(s.voice.key) },
    music: { ...s.music, key: mask(s.music.key), hasKey: Boolean(s.music.key) },
    exportDir: s.exportDir || defaultExportDir(),
    parallel: s.parallel,
    model: s.model,
    site: s.site,
    account: s.account ? { email: s.account.email, name: s.account.name, at: s.account.at } : null,
  }
}

const str = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined)

/** 合并界面提交的修改；key 留空表示不改，传 null 表示删除 */
export function updateSettings(patch = {}) {
  const s = readSettings()
  const merge = (cur, p, providers) => {
    if (!p || typeof p !== 'object') return cur
    const out = { ...cur }
    if (p.provider !== undefined) {
      if (!providers.includes(p.provider)) throw Object.assign(new Error('不支持的服务商'), { status: 400 })
      out.provider = p.provider
    }
    for (const k of ['url', 'voice', 'model', 'file']) if (p[k] !== undefined) out[k] = str(p[k]) ?? ''
    if (p.key === null) out.key = ''
    else if (typeof p.key === 'string' && p.key.trim() && !p.key.startsWith('••••')) out.key = p.key.trim()
    return out
  }
  s.voice = merge(s.voice, patch.voice, VOICE_PROVIDERS)
  s.music = merge(s.music, patch.music, MUSIC_PROVIDERS)
  if (patch.exportDir !== undefined) s.exportDir = str(patch.exportDir, 1000) ?? ''
  if (patch.parallel !== undefined) {
    const n = Number(patch.parallel)
    if (![1, 2, 3, 4].includes(n)) throw Object.assign(new Error('同时渲染只能是 1 到 4 段'), { status: 400 })
    s.parallel = n
  }
  if (patch.model !== undefined) {
    const m = patch.model
    s.model = m && typeof m.provider === 'string' && typeof m.model === 'string' ? { provider: m.provider, model: m.model } : null
  }
  return writeSettings(s)
}

export function setAccount(account) {
  const s = readSettings()
  s.account = account
  return writeSettings(s)
}
