// 插件设置：配音、配乐用什么（离线模型或用户自己的 key），导出位置，同时渲染几段，lovideo 账号。
// 整个文件只存在本机（权限 0600），key 不进作品数据、不上传 lovideo。导演帮用户配置时 key 会经过对话，界面和工具结果里只显示末 4 位。
import { join } from 'node:path'
import { dataDir, defaultExportDir, ensureDir } from './paths.js'
import { readJson, writeJson } from './json-file.js'

export const VOICE_PROVIDERS = ['local', 'system', 'doubao', 'elevenlabs', 'openai', 'none']
export const MUSIC_PROVIDERS = ['local', 'volcengine', 'elevenlabs', 'none']
/**
 * 各家服务的 key，按服务分开存：换配音服务不会冲掉另一家的 key；
 * ElevenLabs 配音和配乐用同一把，火山配乐要 AccessKey + SecretKey 两把。
 */
export const KEY_NAMES = ['doubao', 'elevenlabs', 'openai', 'volcAk', 'volcSk']

/** 最多同时渲染几段：默认 4，最多 10（每段一个浏览器页面，再多普通电脑吃不消） */
export const MAX_PARALLEL = 10

const DEFAULTS = {
  version: 1,
  // 系统自带语音：电脑上本来就有，默认用它；下载离线配音后自动换成离线配音
  // voices：每家服务选的声音 { doubao: 'seed-tts-2.0/zh_female_vv_uranus_bigtts', elevenlabs: 'voice_id', openai: 'alloy' }
  // openaiUrl / openaiModel：只有「OpenAI 兼容」要自己填
  voice: { provider: 'system', voices: {}, openaiUrl: '', openaiModel: '' },
  // 配乐：默认用离线配乐（没下载模型时这部片子先不配，卡片上提示去下载）
  music: { provider: 'local' },
  keys: Object.fromEntries(KEY_NAMES.map(k => [k, ''])),
  exportDir: '',
  parallel: 4,
  model: null,
  site: 'https://lovideo.ai',
  account: null,
  // 离线模型：装好并测过速的模型 { id: { rtf, load, backend, at } }；active 是配音用的，musicActive 是配乐用的
  local: { models: {} },
}

const file = () => join(ensureDir(dataDir()), 'settings.json')

export function readSettings() {
  const saved = readJson(file(), {}) || {}
  return {
    ...DEFAULTS,
    ...saved,
    voice: { ...DEFAULTS.voice, ...(saved.voice || {}), voices: { ...(saved.voice?.voices || {}) } },
    music: { ...DEFAULTS.music, ...(saved.music || {}) },
    keys: { ...DEFAULTS.keys, ...(saved.keys || {}) },
    local: { models: {}, ...(saved.local || {}) },
  }
}

export function writeSettings(next) {
  writeJson(file(), next, { secret: true })
  return next
}

const mask = key => (key ? `••••${String(key).slice(-4)}` : '')

/** 某家服务配音时实际用的参数（配音模块只认这个形状） */
export function voiceConfig(s = readSettings()) {
  const p = s.voice.provider
  return {
    provider: p,
    key: { doubao: s.keys.doubao, elevenlabs: s.keys.elevenlabs, openai: s.keys.openai }[p] || '',
    voice: s.voice.voices?.[p] || '',
    url: p === 'openai' ? s.voice.openaiUrl : '',
    model: p === 'openai' ? s.voice.openaiModel : '',
  }
}

/** 给界面看的设置：key 只露末 4 位 */
export function publicSettings(s = readSettings()) {
  return {
    voice: { provider: s.voice.provider, voices: s.voice.voices, openaiUrl: s.voice.openaiUrl, openaiModel: s.voice.openaiModel },
    music: { provider: s.music.provider },
    // { doubao: '••••1a2b' 或 '' }：有没有填、末 4 位
    keys: Object.fromEntries(KEY_NAMES.map(k => [k, mask(s.keys[k])])),
    exportDir: s.exportDir || defaultExportDir(),
    parallel: s.parallel,
    model: s.model,
    site: s.site,
    account: s.account ? { email: s.account.email, name: s.account.name, at: s.account.at } : null,
  }
}

const str = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined)

/**
 * 合并界面（或导演的 lovideo_configure）提交的修改：
 *   voice: { provider, voices: { doubao: '…' }, openaiUrl, openaiModel }
 *   music: { provider }
 *   keys:  { doubao: '…' }  空字符串或掩码表示不改，null 表示删除
 */
export function updateSettings(patch = {}) {
  const s = readSettings()
  const pickProvider = (cur, p, providers) => {
    if (p === undefined) return cur
    if (!providers.includes(p)) throw Object.assign(new Error('不支持的服务商'), { status: 400 })
    return p
  }
  if (patch.voice && typeof patch.voice === 'object') {
    const v = patch.voice
    s.voice.provider = pickProvider(s.voice.provider, v.provider, VOICE_PROVIDERS)
    if (v.voices && typeof v.voices === 'object') {
      for (const [p, id] of Object.entries(v.voices)) if (VOICE_PROVIDERS.includes(p)) s.voice.voices[p] = str(id, 200) ?? ''
    }
    if (v.openaiUrl !== undefined) s.voice.openaiUrl = str(v.openaiUrl, 300) ?? ''
    if (v.openaiModel !== undefined) s.voice.openaiModel = str(v.openaiModel, 100) ?? ''
  }
  if (patch.music && typeof patch.music === 'object') s.music.provider = pickProvider(s.music.provider, patch.music.provider, MUSIC_PROVIDERS)
  if (patch.keys && typeof patch.keys === 'object') {
    for (const k of KEY_NAMES) {
      const val = patch.keys[k]
      if (val === null) s.keys[k] = ''
      else if (typeof val === 'string' && val.trim() && !val.startsWith('••••')) s.keys[k] = val.trim()
    }
  }
  if (patch.exportDir !== undefined) s.exportDir = str(patch.exportDir, 1000) ?? ''
  if (patch.parallel !== undefined) {
    const n = Number(patch.parallel)
    if (!Number.isInteger(n) || n < 1 || n > MAX_PARALLEL) throw Object.assign(new Error(`最多同时渲染只能是 1 到 ${MAX_PARALLEL} 段`), { status: 400 })
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
