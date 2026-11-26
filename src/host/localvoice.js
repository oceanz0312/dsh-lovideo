// 本机配音模型：按电脑配置推荐模型，下载、测速，开拍时按口播长度挑一个 3 分钟内能配完的。
// 都在用户自己的电脑上跑，不联网生成。可商用的模型才列出来。
//
// 后端两种：Apple 芯片的 Mac 用 mlx-audio；Windows、Linux、Intel Mac 用 PyTorch（有 NVIDIA 显卡用显卡，没有就用 CPU）。
// Python 环境用 uv 单独装一份 3.12（DSH 自带的 Python 加载不了这类原生库，macOS 系统 Python 又太旧），放在插件目录里。
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, createWriteStream, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs'
import { cpus, platform as osPlatform, totalmem } from 'node:os'
import { delimiter, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { PLUGIN_ROOT, dataDir, ensureDir, runtimeDir } from './paths.js'
import { readSettings, writeSettings } from './settings.js'

const WIN = process.platform === 'win32'
const exe = name => (WIN ? `${name}.exe` : name)

/** 一部片子的配音要在这么多秒内生成完 */
export const BUDGET_SECONDS = 180

/**
 * 可选的模型，quality 越大越好。mlx / torch 两种后端各自的下载、配置要求。
 * 实测（M4 Pro）：Qwen3 1.7B 约 0.55×实时、峰值 10GB；Ming 0.5B 约 0.32×、4.3GB；Kokoro 约 0.05×、3GB。
 */
const QWEN_VOICES = {
  zh: [['Vivian', '女声 · 薇薇安'], ['Serena', '女声 · 塞丽娜'], ['Uncle_Fu', '男声 · 福叔'], ['Dylan', '男声 · 北京口音'], ['Eric', '男声 · 四川口音']],
  en: [['Ryan', '男声 · Ryan'], ['Aiden', '男声 · Aiden'], ['Vivian', '女声 · Vivian'], ['Serena', '女声 · Serena']],
}

/**
 * 可选的模型，quality 越大越好。mlx / torch 两种后端各自的下载、配置要求：
 * min* 是跑得起来的最低配置，comfy* 是跑得流畅的配置（低于它标「吃力」）。
 * voices 是能选的声音，第一个是默认。
 * 实测（M4 Pro）：Qwen3 1.7B 约 0.48×实时；Ming 0.5B 约 0.32×；Kokoro 约 0.12×（短句）。
 */
export const MODELS = [
  {
    id: 'qwen3-1.7b', name: 'Qwen3-TTS 1.7B', quality: 3, note: '语气最有起伏，能按描述换语气',
    mlx: { worker: 'mlx-qwen3-1.7b', repos: ['mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit'], sizeGB: 3.1, minRamGB: 16, comfyRamGB: 24 },
    torch: { worker: 'torch-qwen3-1.7b', repos: ['Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice'], sizeGB: 4.5, minVramGB: 8, comfyVramGB: 12, gpuOnly: true },
    voices: QWEN_VOICES,
  },
  {
    id: 'ming3-0.5b', name: 'Ming-3.0-tts 0.5B', quality: 2, note: '有情感控制里最快最省',
    mlx: { worker: 'mlx-ming3-0.5b', repos: ['mlx-community/Ming-3.0-tts-0.5B-bf16'], sizeGB: 3.0, minRamGB: 16, comfyRamGB: 16 },
    voices: { zh: [['narrator', '按语气描述生成的旁白声']], en: [['narrator', '按语气描述生成的旁白声']] },
  },
  {
    id: 'qwen3-0.6b', name: 'Qwen3-TTS 0.6B', quality: 2, note: '比 1.7B 省一半显存，不能换语气',
    torch: { worker: 'torch-qwen3-0.6b', repos: ['Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice'], sizeGB: 2.5, minVramGB: 4, comfyVramGB: 6, gpuOnly: true },
    voices: QWEN_VOICES,
  },
  {
    id: 'kokoro', name: 'Kokoro 82M', quality: 1, note: '最快最省，没显卡也能跑，没有语气控制',
    mlx: { worker: 'mlx-kokoro', repos: ['mlx-community/Kokoro-82M-bf16'], sizeGB: 0.4, minRamGB: 8, comfyRamGB: 8 },
    torch: { worker: 'torch-kokoro', repos: ['hexgrad/Kokoro-82M'], sizeGB: 0.4, minRamGB: 8, comfyRamGB: 8, comfyCores: 8 },
    // 中文默认「云健」：试听里起伏最大、最不像念稿
    voices: {
      zh: [['zm_yunjian', '男声 · 云健'], ['zm_yunxi', '男声 · 云希'], ['zm_yunyang', '男声 · 云扬'], ['zm_yunxia', '男声 · 云夏'],
        ['zf_xiaobei', '女声 · 晓北'], ['zf_xiaoxiao', '女声 · 晓晓'], ['zf_xiaoni', '女声 · 晓妮'], ['zf_xiaoyi', '女声 · 晓伊']],
      en: [['af_heart', '女声 · Heart'], ['af_bella', '女声 · Bella'], ['am_michael', '男声 · Michael'], ['bm_george', '男声 · George（英音）']],
    },
  },
]

/** 会话里一键下载的默认模型：最小、最快、哪台电脑都能跑 */
export const DEFAULT_MODEL = 'kokoro'

/**
 * 离线配乐模型。Stable Audio 3 small-music：纯器乐、按秒指定时长、一首最长 120 秒（更长的片子循环接上）。
 * 实测（M4 Pro，MLX）：加载 1.2 秒，30 秒的曲子 1–2 秒、120 秒 3.3 秒。
 * 许可：Stability 社区许可，年收入 100 万美元以下可商用。
 */
export const MUSIC_MODELS = [
  {
    id: 'sa3-small', kind: 'music', name: 'Stable Audio 3 Small', quality: 1, note: '纯器乐，按描述和时长生成，几秒出一首',
    mlx: { worker: 'mlx-sa3-small', repos: ['mlx-community/stable-audio-3-small-music'], sizeGB: 3.5, minRamGB: 8, comfyRamGB: 8 },
    // 没有显卡也能跑（CPU），只是慢一些
    torch: { worker: 'torch-sa3-small', repos: ['cocktailpeanut/stable-audio-3-small-music'], sizeGB: 3.5, minRamGB: 8, comfyVramGB: 4, comfyNeedsGpu: true },
  },
]
export const DEFAULT_MUSIC_MODEL = 'sa3-small'
// 配乐一首最长 120 秒；更长的片子生成 120 秒循环
export const MUSIC_MAX_SECONDS = 120

const ALL = () => [...MODELS, ...MUSIC_MODELS]
const byId = id => ALL().find(m => m.id === id)
const kindOf = m => m?.kind || 'voice'

// Python 环境要装的包（大约的磁盘占用写在 envGB 里）
const PACKAGES = {
  mlx: { pkgs: ['mlx-audio==0.6.8', 'misaki[zh,en]', 'soundfile', 'huggingface_hub'], envGB: 1.2 },
  torch: { pkgs: ['kokoro==0.9.4', 'misaki[zh,en]', 'soundfile', 'huggingface_hub'], envGB: 1.5 },
  'torch-qwen': { pkgs: ['qwen-tts==0.1.1'], envGB: 3 },
  // 配乐的 PyTorch 版：官方包锁定了自己的 torch 版本，单独一个环境，免得和配音的包打架
  'torch-music': { pkgs: ['stable-audio-3 @ https://github.com/Stability-AI/stable-audio-3/archive/1e1058a082d0a810132e34cfa822ce110592bdfd.zip', 'soundfile', 'huggingface_hub'], envGB: 3 },
}

/** 模型装在哪个 Python 环境：Mac 都在 mlx；PyTorch 版配音一个、配乐一个 */
const envKey = (model, hw) => (hw.backend === 'mlx' ? 'mlx' : kindOf(model) === 'music' ? 'torch-music' : 'torch')

/* ---------- 电脑配置 ---------- */

let hwCache = null
export function hardware() {
  if (hwCache) return hwCache
  const ramGB = Math.round(totalmem() / 1024 ** 3)
  let chip = cpus()[0]?.model || ''
  if (process.platform === 'darwin') {
    const r = spawnSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim()) chip = r.stdout.trim()
  }
  const appleSilicon = process.platform === 'darwin' && (process.arch === 'arm64' || /Apple/.test(chip))
  let gpu = null
  if (!appleSilicon) {
    const smi = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    const line = smi.status === 0 ? smi.stdout.split('\n').find(Boolean) : null
    if (line) {
      const [name, mib] = line.split(',').map(s => s.trim())
      gpu = { vendor: 'nvidia', name, vramGB: Math.round(Number(mib) / 1024) }
    }
  }
  let freeDiskGB = null
  try {
    const st = statfsSync(ensureDir(dataDir()))
    freeDiskGB = Math.round((st.bavail * st.bsize) / 1024 ** 3)
  } catch {
    freeDiskGB = null
  }
  hwCache = { platform: osPlatform(), arch: process.arch, chip, cores: cpus().length, ramGB, appleSilicon, gpu, freeDiskGB, backend: appleSilicon ? 'mlx' : 'torch' }
  return hwCache
}

/**
 * 本机配音的最低配置：低于它就不推荐、也不让下载本机模型，配音直接用系统自带语音。
 * 内存：最小的 Kokoro 实测峰值 3GB，再算上系统和别的软件；CPU：没显卡时全靠 CPU，核太少会远超 3 分钟。
 */
export const MIN_SPEC = { ramGB: 8, cores: 4, freeDiskGB: 3 }

/** 这台电脑够不够用本机配音；不够时给出一句原因 */
export function meetsMinimum(hw = hardware()) {
  const why = []
  if (!['x64', 'arm64'].includes(hw.arch)) why.push('不是 64 位系统')
  if (hw.ramGB < MIN_SPEC.ramGB) why.push(`内存 ${hw.ramGB}GB，要 ${MIN_SPEC.ramGB}GB 起`)
  if (hw.cores !== undefined && hw.cores < MIN_SPEC.cores) why.push(`CPU ${hw.cores} 核，要 ${MIN_SPEC.cores} 核起`)
  if (hw.freeDiskGB !== null && hw.freeDiskGB !== undefined && hw.freeDiskGB < MIN_SPEC.freeDiskGB) why.push(`磁盘剩余 ${hw.freeDiskGB}GB，要 ${MIN_SPEC.freeDiskGB}GB 起`)
  return { ok: why.length === 0, reason: why.length ? why.join('；') : null }
}

/** 这台电脑跑这个模型够不够；不够时给出一句原因 */
export function fit(model, hw = hardware()) {
  const min = meetsMinimum(hw)
  if (!min.ok) return { ok: false, reason: `配置偏低：${min.reason}` }
  const b = model[hw.backend]
  if (!b) return { ok: false, reason: hw.backend === 'mlx' ? '这台 Mac 上用不了' : '只支持 Apple 芯片的 Mac' }
  if (b.gpuOnly && !hw.gpu) return { ok: false, reason: '需要 NVIDIA 显卡' }
  if (b.minVramGB && (!hw.gpu || hw.gpu.vramGB < b.minVramGB)) return { ok: false, reason: `显存要 ${b.minVramGB}GB 起` }
  if (b.minRamGB && hw.ramGB < b.minRamGB) return { ok: false, reason: `内存要 ${b.minRamGB}GB 起` }
  const need = b.sizeGB + envGB(model, hw) + 1
  if (hw.freeDiskGB !== null && hw.freeDiskGB < need) return { ok: false, reason: `磁盘剩余不够（要 ${Math.ceil(need)}GB）` }
  return { ok: true, reason: null }
}

function envGB(model, hw) {
  if (hw.backend === 'mlx') return PACKAGES.mlx.envGB
  if (kindOf(model) === 'music') return PACKAGES['torch-music'].envGB
  return PACKAGES.torch.envGB + (model.id.startsWith('qwen3') ? PACKAGES['torch-qwen'].envGB : 0)
}

/**
 * 这个模型在这台电脑上跑得怎么样：unable 跑不动 / heavy 吃力 / ok 流畅，附一句原因。
 * 测过速的再看实测：3 分钟口播 3 分钟内配不完也算吃力。
 */
export function grade(model, hw = hardware(), installed = null) {
  const f = fit(model, hw)
  if (!f.ok) return { grade: 'unable', reason: f.reason }
  const b = model[hw.backend]
  const why = []
  if (b.comfyRamGB && hw.ramGB < b.comfyRamGB) why.push(`内存 ${hw.ramGB}GB，${b.comfyRamGB}GB 以上更流畅`)
  if (b.comfyVramGB && hw.gpu && hw.gpu.vramGB < b.comfyVramGB) why.push(`显存 ${hw.gpu.vramGB}GB，${b.comfyVramGB}GB 以上更流畅`)
  if (b.comfyCores && !hw.gpu && hw.cores !== undefined && hw.cores < b.comfyCores) why.push(`没有显卡、CPU ${hw.cores} 核，生成会慢一些`)
  if (b.comfyNeedsGpu && !hw.gpu) why.push('没有显卡，用 CPU 生成会慢一些')
  const sample = kindOf(model) === 'music' ? MUSIC_MAX_SECONDS : BUDGET_SECONDS
  if (installed && predictSeconds(installed, sample) > BUDGET_SECONDS) why.push(kindOf(model) === 'music' ? '实测做一首 2 分钟的配乐要超过 3 分钟' : '实测配 3 分钟口播要超过 3 分钟')
  return why.length ? { grade: 'heavy', reason: why.join('；') } : { grade: 'ok', reason: null }
}

/** 推荐：这台电脑上跑得流畅的里面最好的一个；都吃力就推荐吃力里最好的 */
export function recommend(hw = hardware(), installedMap = {}, models = MODELS) {
  const runnable = models.map(m => ({ m, g: grade(m, hw, installedMap[m.id]).grade })).filter(x => x.g !== 'unable')
  const best = list => list.sort((a, b) => b.m.quality - a.m.quality)[0]?.m || null
  return best(runnable.filter(x => x.g === 'ok')) || best(runnable)
}

/** 某个模型用户选的声音（没选过就用默认），{ zh, en } */
export function voicesFor(modelId, s = readSettings()) {
  const m = MODELS.find(x => x.id === modelId)
  const chosen = s.local?.voices?.[modelId] || {}
  const pick = lang => {
    const list = m?.voices?.[lang] || []
    return list.some(([id]) => id === chosen[lang]) ? chosen[lang] : list[0]?.[0]
  }
  return { zh: pick('zh'), en: pick('en') }
}

const ACTIVE_KEY = { voice: 'active', music: 'musicActive' }
const listOf = kind => (kind === 'music' ? MUSIC_MODELS : MODELS)

/** 正在用的离线模型（配音或配乐）：用户选的那个；没选过就是装好的里面最好的一个 */
export function activeModel(s = readSettings(), kind = 'voice') {
  const installed = s.local?.models || {}
  const picked = s.local?.[ACTIVE_KEY[kind]]
  if (picked && installed[picked]) return picked
  return listOf(kind).filter(m => installed[m.id]).sort((a, b) => b.quality - a.quality)[0]?.id || null
}

/** 用户选定用哪个离线模型（配音的还能选声音）；同时把配音或配乐切到离线 */
export function useModel(modelId, voices = {}) {
  const s = readSettings()
  const model = byId(modelId)
  if (!model || !s.local?.models?.[modelId]) throw Object.assign(new Error('这个模型还没下载'), { status: 409 })
  const kind = kindOf(model)
  s.local = { ...s.local, [ACTIVE_KEY[kind]]: modelId }
  if (kind === 'voice') {
    s.local.voices = { ...(s.local.voices || {}), [modelId]: { ...voicesFor(modelId, s), ...voices } }
    s.voice = { ...s.voice, provider: 'local' }
  } else s.music = { ...s.music, provider: 'local' }
  writeSettings(s)
  return localVoiceStatus(kind)
}

/**
 * 这部片子能不能用离线配乐：配置够、装好了、预计 3 分钟内做得完。
 * @returns {{ ok: boolean, reason?: string, code?: string }}
 */
export function musicReady(filmSeconds) {
  const min = meetsMinimum(hardware())
  if (!min.ok) return { ok: false, reason: `这台电脑配置偏低（${min.reason}），离线配乐跑不动，这次没加配乐`, code: 'low-spec' }
  const s = readSettings()
  const id = activeModel(s, 'music')
  if (!id) return { ok: false, reason: '还没有下载离线配乐，这次没加配乐', code: 'not-installed' }
  const predicted = predictSeconds(s.local.models[id], Math.min(MUSIC_MAX_SECONDS, filmSeconds))
  if (predicted > BUDGET_SECONDS) return { ok: false, reason: `离线配乐预计要 ${Math.round(predicted / 60)} 分钟以上，这次没加配乐`, code: 'too-slow' }
  return { ok: true, model: id }
}

/** 用离线模型做一首配乐（最长 120 秒，片子更长时拼成片会循环接上） */
export async function musicLocal({ prompt, seconds, out }) {
  const id = activeModel(readSettings(), 'music')
  if (!id) throw new Error('还没有下载离线配乐，请在 lovideo 设置的「配乐」里下载')
  ensureDir(join(out, '..'))
  const w = await worker(id)
  const r = await w.speak({ prompt, seconds: Math.min(MUSIC_MAX_SECONDS, Math.max(5, Math.round(seconds))), out })
  return { seconds: r.seconds, model: id }
}

/* ---------- 按口播长度挑模型 ---------- */

/** 估计口播时长：中文每秒约 4.5 个字，英文每秒约 2.6 个词 */
export function estimateSeconds(texts) {
  let s = 0
  for (const t of texts) {
    const text = String(t || '')
    const han = (text.match(/[一-鿿]/g) || []).length
    const words = text.replace(/[一-鿿]/g, ' ').split(/\s+/).filter(w => /[a-z0-9]/i.test(w)).length
    s += han / 4.5 + words / 2.6
  }
  return s
}

/** 预计生成要多少秒：加载 + 口播时长 × 实测速度，多留 15% 余量 */
export const predictSeconds = (installed, narrationSec) => (installed.load || 0) + narrationSec * installed.rtf * 1.15

/**
 * 挑这部片子用哪个模型：先看用户选的那个，3 分钟内配得完就用它；配不完再在装好的里面按质量从高到低找。
 * @returns {{ id, predicted, degraded } | null} degraded 表示没用上用户选的；都来不及返回 null（退回系统语音）
 */
export function chooseModel(installedMap, narrationSec, preferred = null, models = MODELS) {
  if (preferred && installedMap[preferred]) {
    const predicted = predictSeconds(installedMap[preferred], narrationSec)
    if (predicted <= BUDGET_SECONDS) return { id: preferred, predicted, degraded: false }
  }
  const ranked = models.filter(m => installedMap[m.id] && m.id !== preferred).sort((a, b) => b.quality - a.quality)
  for (const m of ranked) {
    const predicted = predictSeconds(installedMap[m.id], narrationSec)
    if (predicted <= BUDGET_SECONDS) return { id: m.id, predicted, degraded: Boolean(preferred && installedMap[preferred]) }
  }
  return null
}

/* ---------- 安装：uv → Python 3.12 → 包 → 模型 → 测速 ---------- */

const UV_VERSION = '0.12.12'
const UV_ASSET = {
  'darwin-arm64': 'uv-aarch64-apple-darwin.tar.gz',
  'darwin-x64': 'uv-x86_64-apple-darwin.tar.gz',
  'linux-x64': 'uv-x86_64-unknown-linux-gnu.tar.gz',
  'linux-arm64': 'uv-aarch64-unknown-linux-gnu.tar.gz',
  'win32-x64': 'uv-x86_64-pc-windows-msvc.zip',
  'win32-arm64': 'uv-aarch64-pc-windows-msvc.zip',
}
// 国内访问不了 GitHub / PyPI / Hugging Face 时换镜像
const PYPI_MIRROR = 'https://mirrors.aliyun.com/pypi/simple/'
const PYTHON_MIRROR = 'https://registry.npmmirror.com/-/binary/python-build-standalone/'
const HF_MIRROR = 'https://hf-mirror.com'

const ttsDir = () => ensureDir(join(runtimeDir(), 'tts'))

/**
 * worker.py 拷到数据目录再运行：插件可能装在「文稿」「桌面」这类受系统隐私保护的目录里，
 * macOS 不让我们装的 Python 直接读那里的文件（报 Operation not permitted）。内容变了才重新拷。
 */
function workerScript() {
  const src = join(PLUGIN_ROOT, 'vendor', 'tts', 'worker.py')
  const dst = join(ttsDir(), 'worker.py')
  const code = readFileSync(src)
  if (!existsSync(dst) || !readFileSync(dst).equals(code)) copyFileSync(src, dst)
  return dst
}
const envDir = backend => join(ttsDir(), `env-${backend}`)
const envPython = backend => (WIN ? join(envDir(backend), 'Scripts', 'python.exe') : join(envDir(backend), 'bin', 'python'))
const hfHome = () => ensureDir(join(ttsDir(), 'hf'))

/**
 * 在插件的 Python 环境里跑命令要带的环境变量。英文分词第一次用时会自动装语言包，
 * 这个环境里没有 pip，装包要走 uv，所以要告诉它当前是哪个环境、uv 在哪。
 */
function pyEnv(backend, extra = {}) {
  const uvBin = join(runtimeDir(), 'bin')
  return {
    ...process.env,
    VIRTUAL_ENV: envDir(backend),
    PATH: [join(envDir(backend), WIN ? 'Scripts' : 'bin'), uvBin, process.env.PATH || ''].join(delimiter),
    UV_CACHE_DIR: join(ttsDir(), 'uv-cache'),
    HF_HOME: hfHome(),
    PYTHONIOENCODING: 'utf-8',
    ...extra,
  }
}

/**
 * 每个模型各自的下载状态：配音、配乐可以同时下载。
 * 装下载工具和 Python 包会改同一个环境，这一步排队做（envLock）；下载模型、测速各下各的。
 */
const jobs = new Map()
const idle = model => ({ running: false, model, step: null, progress: 0, error: null })
export const setupState = (modelId = null) => ({ ...(jobs.get(modelId) || idle(modelId)) })
let envLock = Promise.resolve()
function withEnvLock(fn) {
  const run = envLock.then(fn, fn)
  envLock = run.catch(() => {})
  return run
}

/** 这一类（配音或配乐）界面上要显示的下载状态：正在下载的优先，没有就是最近一次的结果 */
function kindSetup(kind) {
  const list = [...jobs.values()].filter(j => kindOf(byId(j.model)) === kind)
  return { ...(list.find(j => j.running) || list[list.length - 1] || idle(null)) }
}

function sh(cmd, args, { env, timeoutMs = 1_800_000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (out += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', e => {
      clearTimeout(timer)
      resolve({ code: -1, out: String(e.message) })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

async function ensureUv() {
  const mine = join(ensureDir(join(runtimeDir(), 'bin')), exe('uv'))
  if (existsSync(mine)) return mine
  const onPath = spawnSync(WIN ? 'where' : 'which', ['uv'], { encoding: 'utf8' })
  const found = onPath.status === 0 && onPath.stdout.split(/\r?\n/).find(Boolean)
  if (found) return found.trim()  // 用户自己装的 uv：pyEnv 里的 PATH 会带上当前 PATH，能找到它
  const asset = UV_ASSET[`${process.platform}-${process.arch}`]
  if (!asset) throw new Error(`这台电脑（${process.platform}-${process.arch}）装不了离线配音`)
  const tmp = ensureDir(join(ttsDir(), 'tmp'))
  const file = join(tmp, asset)
  const res = await fetch(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`下载 uv 失败：HTTP ${res.status}（可以先自己安装 uv，再点一次）`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file))
  const r = await sh('tar', ['-xf', file, '-C', tmp])
  if (r.code !== 0) throw new Error(`解压 uv 失败：${r.out.slice(-200)}`)
  const bin = findFile(tmp, exe('uv'))
  if (!bin) throw new Error('uv 压缩包里没有找到 uv')
  renameSync(bin, mine)
  if (!WIN) chmodSync(mine, 0o755)
  rmSync(tmp, { recursive: true, force: true })
  return mine
}

function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isFile() && e.name === name) return p
    if (e.isDirectory()) {
      const hit = findFile(p, name)
      if (hit) return hit
    }
  }
  return null
}

/** 跑一个 uv 命令；失败时换国内镜像再试一次 */
async function uvRun(uv, args) {
  const env = { UV_PYTHON_INSTALL_DIR: join(ttsDir(), 'python'), UV_CACHE_DIR: join(ttsDir(), 'uv-cache') }
  let r = await sh(uv, args, { env })
  if (r.code !== 0) r = await sh(uv, args, { env: { ...env, UV_INDEX_URL: PYPI_MIRROR, UV_PYTHON_INSTALL_MIRROR: PYTHON_MIRROR } })
  if (r.code !== 0) throw new Error(r.out.trim().split('\n').slice(-3).join(' ').slice(0, 300))
}

async function ensureEnv(uv, model, hw) {
  const key = envKey(model, hw)
  const py = envPython(key)
  if (!existsSync(py)) await uvRun(uv, ['venv', '--python', '3.12', envDir(key)])
  const pkgs = [...PACKAGES[key].pkgs, ...(key === 'torch' && model.id.startsWith('qwen3') ? PACKAGES['torch-qwen'].pkgs : [])]
  // PyTorch 按这台电脑的显卡自动选 CUDA 或 CPU 版本
  const extra = key !== 'mlx' ? ['--torch-backend', 'auto'] : []
  await uvRun(uv, ['pip', 'install', '--python', py, ...extra, ...pkgs])
  return py
}

function dirSize(dir) {
  let n = 0
  if (!existsSync(dir)) return 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) n += dirSize(p)
    else if (e.isFile()) n += statSync(p).size
  }
  return n
}

async function downloadModel(py, b, job) {
  const script = `import sys\nfrom huggingface_hub import snapshot_download\nfor r in sys.argv[1:]:\n    snapshot_download(r)\n`
  // 只看这个模型自己的缓存目录，两个模型同时下载时进度不会串
  const repoDirs = b.repos.map(r => join(hfHome(), 'hub', `models--${r.replace('/', '--')}`))
  const size = () => repoDirs.reduce((n, d) => n + dirSize(d), 0)
  const before = size()
  const total = b.sizeGB * 1024 ** 3
  const tick = setInterval(() => {
    job.progress = Math.min(0.99, (size() - before) / total)
  }, 1000)
  try {
    let r = await sh(py, ['-c', script, ...b.repos], { env: { HF_HOME: hfHome() } })
    if (r.code !== 0) r = await sh(py, ['-c', script, ...b.repos], { env: { HF_HOME: hfHome(), HF_ENDPOINT: HF_MIRROR } })
    if (r.code !== 0) throw new Error(`下载模型失败：${r.out.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`)
  } finally {
    clearInterval(tick)
  }
}

const TEST_ZH = '光刻机是造芯片这条路上最贵、也最精密的一台机器，它把画好的图案缩小再缩小，印到硅片上。'
const TEST_EN = 'A lithography machine shrinks a drawn pattern again and again, and prints it onto a silicon wafer.'

/** 测速：中英文各热身一句，再各测一段，取慢的那个；配乐热身 5 秒、再测一首 30 秒 */
async function benchmark(modelId) {
  const w = await worker(modelId)
  const tmp = ensureDir(join(ttsDir(), 'bench', modelId))
  if (kindOf(byId(modelId)) === 'music') {
    await w.speak({ prompt: 'warm piano', seconds: 5, out: join(tmp, 'warm.wav') })
    const m = await w.speak({ prompt: 'calm lo-fi piano, soft pads, warm and curious, 80 bpm', seconds: 30, out: join(tmp, 'music.wav') })
    return { rtf: Math.round((m.gen / m.seconds) * 1000) / 1000, load: w.load, sample: join(tmp, 'music.wav') }
  }
  // 中英文各热身一句：第一次用会编译、装语言包，这些一次性开销不算进速度
  await w.speak({ text: '你好。', lang: 'zh', out: join(tmp, 'warm.wav') })
  await w.speak({ text: 'Hello.', lang: 'en', out: join(tmp, 'warm.wav') })
  const zh = await w.speak({ text: TEST_ZH, lang: 'zh', out: join(tmp, 'zh.wav') })
  const en = await w.speak({ text: TEST_EN, lang: 'en', out: join(tmp, 'en.wav') })
  const rtf = Math.max(zh.gen / zh.seconds, en.gen / en.seconds)
  return { rtf: Math.round(rtf * 1000) / 1000, load: w.load, sample: join(tmp, 'zh.wav') }
}

/** 下载并测速一个模型（后台进行，进度看 setupState(modelId)）；不同模型可以同时下载 */
export function startSetup(modelId) {
  if (jobs.get(modelId)?.running) return setupState(modelId)
  const model = byId(modelId)
  if (!model) throw Object.assign(new Error('没有这个模型'), { status: 400 })
  const hw = hardware()
  const f = fit(model, hw)
  if (!f.ok) throw Object.assign(new Error(`这台电脑跑不了 ${model.name}：${f.reason}`), { status: 409 })
  const job = { running: true, model: modelId, step: 'queued', progress: 0, error: null }
  jobs.set(modelId, job)
  ;(async () => {
    try {
      // 装下载工具和运行环境：同一时间只装一个，另一个显示「排队中」
      const py = await withEnvLock(async () => {
        job.step = 'uv'
        const uv = await ensureUv()
        job.step = 'packages'
        return ensureEnv(uv, model, hw)
      })
      job.step = 'model'
      await downloadModel(py, model[hw.backend], job)
      job.step = 'test'
      job.progress = 0
      const r = await benchmark(modelId)
      const s = readSettings()
      s.local = { ...(s.local || {}), models: { ...(s.local?.models || {}), [modelId]: { rtf: r.rtf, load: r.load, backend: hw.backend, at: new Date().toISOString() } } }
      // 这一类还没选过离线模型（第一次装、或从会话里一键下载）：装好就用上
      const kind = kindOf(model)
      const cur = s.local[ACTIVE_KEY[kind]]
      if (!cur || !s.local.models[cur]) {
        s.local[ACTIVE_KEY[kind]] = modelId
        if (kind === 'voice') s.voice = { ...s.voice, provider: 'local' }
        else s.music = { ...s.music, provider: 'local' }
      }
      writeSettings(s)
      Object.assign(job, { running: false, step: 'done', progress: 1, error: null })
    } catch (e) {
      Object.assign(job, { running: false, error: e.message })
    }
  })().catch(() => {})
  return setupState(modelId)
}

/** 会话里一键准备：默认的离线配音和离线配乐一起下（这台电脑跑不了的、已经装好的跳过） */
export function startDefaultSetup() {
  const s = readSettings()
  const hw = hardware()
  const started = []
  for (const id of [DEFAULT_MODEL, DEFAULT_MUSIC_MODEL]) {
    const m = byId(id)
    if (s.local?.models?.[id] || !fit(m, hw).ok) continue
    startSetup(id)
    started.push(id)
  }
  return { started, voice: kindSetup('voice'), music: kindSetup('music') }
}

/** 设置页要的全部信息（kind：voice 配音 / music 配乐） */
export function localVoiceStatus(kind = 'voice') {
  const hw = hardware()
  const s = readSettings()
  const installed = s.local?.models || {}
  const list = listOf(kind)
  const rec = recommend(hw, installed, list)
  return {
    kind,
    active: activeModel(s, kind),
    usingLocal: (kind === 'music' ? s.music : s.voice).provider === 'local',
    defaultModel: kind === 'music' ? DEFAULT_MUSIC_MODEL : DEFAULT_MODEL,
    hardware: hw,
    minimum: { ...meetsMinimum(hw), spec: MIN_SPEC },
    budgetSeconds: BUDGET_SECONDS,
    recommended: rec?.id || null,
    // 这个平台上没有的版本（比如 Mac 上的 PyTorch 版）不列出来
    models: list.filter(m => m[hw.backend]).map(m => {
      const b = m[hw.backend]
      const f = fit(m, hw)
      const inst = installed[m.id]
      const g = grade(m, hw, inst)
      return {
        id: m.id, name: m.name, note: m.note, quality: m.quality, grade: g.grade, gradeReason: g.reason,
        voices: m.voices || null, chosenVoices: m.voices ? voicesFor(m.id, s) : null,
        downloadGB: b ? Math.round((b.sizeGB + envGB(m, hw)) * 10) / 10 : null,
        ok: f.ok, reason: f.reason,
        // 这个模型自己的下载进度（配音、配乐、不同模型可以同时下载）
        job: jobs.has(m.id) ? setupState(m.id) : null,
        installed: inst ? { rtf: inst.rtf, load: inst.load, oneMinute: Math.round(predictSeconds(inst, 60)), maxMinutes: Math.max(0, Math.floor(((BUDGET_SECONDS - (inst.load || 0)) / (inst.rtf * 1.15)) / 60 * 10) / 10) } : null,
      }
    }),
    // 下载是配音、配乐共用的一条队伍：只显示这一类的进度
    setup: kindSetup(kind),
  }
}

/* ---------- 常驻进程 ---------- */

const workers = new Map()
const IDLE_MS = 10 * 60_000

/** 拿到（必要时启动）一个模型的常驻进程 */
export function worker(modelId) {
  const hw = hardware()
  const model = byId(modelId)
  const b = model?.[hw.backend]
  if (!b) throw new Error(`离线模型不可用：${modelId}`)
  const cur = workers.get(modelId)
  if (cur) return cur.ready
  const key = envKey(model, hw)
  const child = spawn(envPython(key), [workerScript(), b.worker], {
    env: pyEnv(key), windowsHide: true,
  })
  const pending = new Map()
  let seq = 0
  let buf = ''
  let err = ''
  let idle = null
  const entry = { child, ready: null }
  const touch = () => {
    clearTimeout(idle)
    idle = setTimeout(() => stop(modelId), IDLE_MS)
  }
  entry.ready = new Promise((resolve, reject) => {
    child.stdout.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.ready) {
          touch()
          resolve({
            load: msg.load,
            speak: req => new Promise((ok, fail) => {
              const id = ++seq
              pending.set(id, { ok, fail })
              touch()
              child.stdin.write(`${JSON.stringify({ id, ...req })}\n`)
            }),
          })
        } else if (pending.has(msg.id)) {
          const p = pending.get(msg.id)
          pending.delete(msg.id)
          msg.ok ? p.ok(msg) : p.fail(new Error(msg.error))
        }
      }
    })
    child.stderr.on('data', d => (err = (err + d).slice(-4000)))
    child.stdin.on('error', () => {})
    child.on('error', e => reject(e))
    child.on('close', code => {
      workers.delete(modelId)
      clearTimeout(idle)
      const e = new Error(`${kindOf(model) === 'music' ? '离线配乐' : '离线配音'}没能启动：${err.trim().split('\n').pop().slice(0, 160)}`)
      reject(e)
      for (const p of pending.values()) p.fail(e)
      pending.clear()
    })
  })
  // 启动失败的拒绝由调用方接；这里先挂上，免得没人接时拖垮后端
  entry.ready.catch(() => {})
  workers.set(modelId, entry)
  return entry.ready
}

export function stop(modelId) {
  const w = workers.get(modelId)
  if (!w) return
  workers.delete(modelId)
  w.child.stdin.end()
  setTimeout(() => w.child.kill(), 3000).unref?.()
}

/** 插件卸载时关掉所有常驻进程 */
export function stopAll() {
  for (const id of [...workers.keys()]) stop(id)
}

/** 用本机模型念一段；返回生成信息 */
export async function speakLocal(modelId, { text, lang, out, instruct }) {
  ensureDir(join(out, '..'))
  const w = await worker(modelId)
  return w.speak({ text, lang, out, instruct, voice: voicesFor(modelId)[lang] })
}

