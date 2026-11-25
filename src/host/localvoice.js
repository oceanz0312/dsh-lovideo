// 本机配音模型：按电脑配置推荐模型，下载、测速，开拍时按口播长度挑一个 3 分钟内能配完的。
// 都在用户自己的电脑上跑，不联网生成。可商用的模型才列出来。
//
// 后端两种：Apple 芯片的 Mac 用 mlx-audio；Windows、Linux、Intel Mac 用 PyTorch（有 NVIDIA 显卡用显卡，没有就用 CPU）。
// Python 环境用 uv 单独装一份 3.12（DSH 自带的 Python 加载不了这类原生库，macOS 系统 Python 又太旧），放在插件目录里。
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, createWriteStream, existsSync, readdirSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs'
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
export const MODELS = [
  {
    id: 'qwen3-1.7b', name: 'Qwen3-TTS 1.7B', quality: 3, note: '语气最有起伏，能按描述换语气',
    mlx: { worker: 'mlx-qwen3-1.7b', repos: ['mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit'], sizeGB: 3.1, minRamGB: 16 },
    torch: { worker: 'torch-qwen3-1.7b', repos: ['Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice'], sizeGB: 4.5, minVramGB: 8, gpuOnly: true },
  },
  {
    id: 'ming3-0.5b', name: 'Ming-3.0-tts 0.5B', quality: 2, note: '有情感控制里最快最省',
    mlx: { worker: 'mlx-ming3-0.5b', repos: ['mlx-community/Ming-3.0-tts-0.5B-bf16'], sizeGB: 3.0, minRamGB: 16 },
  },
  {
    id: 'qwen3-0.6b', name: 'Qwen3-TTS 0.6B', quality: 2, note: '比 1.7B 省一半显存，不能换语气',
    torch: { worker: 'torch-qwen3-0.6b', repos: ['Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice'], sizeGB: 2.5, minVramGB: 4, gpuOnly: true },
  },
  {
    id: 'kokoro', name: 'Kokoro 82M', quality: 1, note: '最快最省，没显卡也能跑，没有语气控制',
    mlx: { worker: 'mlx-kokoro', repos: ['mlx-community/Kokoro-82M-bf16'], sizeGB: 0.4, minRamGB: 8 },
    torch: { worker: 'torch-kokoro', repos: ['hexgrad/Kokoro-82M'], sizeGB: 0.4, minRamGB: 8 },
  },
]

// Python 环境要装的包（大约的磁盘占用写在 envGB 里）
const PACKAGES = {
  mlx: { pkgs: ['mlx-audio==0.6.8', 'misaki[zh,en]', 'soundfile', 'huggingface_hub'], envGB: 1.2 },
  torch: { pkgs: ['kokoro==0.9.4', 'misaki[zh,en]', 'soundfile', 'huggingface_hub'], envGB: 1.5 },
  'torch-qwen': { pkgs: ['qwen-tts==0.1.1'], envGB: 3 },
}

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
  hwCache = { platform: osPlatform(), arch: process.arch, chip, ramGB, appleSilicon, gpu, freeDiskGB, backend: appleSilicon ? 'mlx' : 'torch' }
  return hwCache
}

/** 这台电脑跑这个模型够不够；不够时给出一句原因 */
export function fit(model, hw = hardware()) {
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
  return PACKAGES.torch.envGB + (model.id.startsWith('qwen3') ? PACKAGES['torch-qwen'].envGB : 0)
}

/** 推荐：这台电脑能跑的里面最好的一个 */
export function recommend(hw = hardware()) {
  return MODELS.filter(m => fit(m, hw).ok).sort((a, b) => b.quality - a.quality)[0] || null
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
 * 在已经装好的模型里，按质量从高到低挑第一个 3 分钟内能配完的。
 * @returns {{ id, predicted } | null} 都来不及时返回 null（开拍时退回系统语音）
 */
export function chooseModel(installedMap, narrationSec, models = MODELS) {
  const ranked = models.filter(m => installedMap[m.id]).sort((a, b) => b.quality - a.quality)
  for (const m of ranked) {
    const predicted = predictSeconds(installedMap[m.id], narrationSec)
    if (predicted <= BUDGET_SECONDS) return { id: m.id, predicted }
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

let state = { running: false, model: null, step: null, progress: 0, error: null }
export const setupState = () => ({ ...state })

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
  if (!asset) throw new Error(`这台电脑（${process.platform}-${process.arch}）装不了本机配音`)
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
  const backend = hw.backend
  const py = envPython(backend)
  if (!existsSync(py)) await uvRun(uv, ['venv', '--python', '3.12', envDir(backend)])
  const pkgs = [...PACKAGES[backend].pkgs, ...(backend === 'torch' && model.id.startsWith('qwen3') ? PACKAGES['torch-qwen'].pkgs : [])]
  // PyTorch 按这台电脑的显卡自动选 CUDA 或 CPU 版本
  const extra = backend === 'torch' ? ['--torch-backend', 'auto'] : []
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

async function downloadModel(py, b) {
  const script = `import sys\nfrom huggingface_hub import snapshot_download\nfor r in sys.argv[1:]:\n    snapshot_download(r)\n`
  const before = dirSize(hfHome())
  const total = b.sizeGB * 1024 ** 3
  const tick = setInterval(() => {
    state.progress = Math.min(0.99, (dirSize(hfHome()) - before) / total)
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

/** 测速：中英文各热身一句，再各测一段，取慢的那个 */
async function benchmark(modelId) {
  const w = await worker(modelId)
  const tmp = ensureDir(join(ttsDir(), 'bench'))
  // 中英文各热身一句：第一次用会编译、装语言包，这些一次性开销不算进速度
  await w.speak({ text: '你好。', lang: 'zh', out: join(tmp, 'warm.wav') })
  await w.speak({ text: 'Hello.', lang: 'en', out: join(tmp, 'warm.wav') })
  const zh = await w.speak({ text: TEST_ZH, lang: 'zh', out: join(tmp, 'zh.wav') })
  const en = await w.speak({ text: TEST_EN, lang: 'en', out: join(tmp, 'en.wav') })
  const rtf = Math.max(zh.gen / zh.seconds, en.gen / en.seconds)
  return { rtf: Math.round(rtf * 1000) / 1000, load: w.load, sample: join(tmp, 'zh.wav') }
}

/** 下载并测速一个模型（后台进行，进度看 setupState） */
export function startSetup(modelId) {
  if (state.running) return setupState()
  const model = MODELS.find(m => m.id === modelId)
  if (!model) throw Object.assign(new Error('没有这个模型'), { status: 400 })
  const hw = hardware()
  const f = fit(model, hw)
  if (!f.ok) throw Object.assign(new Error(`这台电脑跑不了 ${model.name}：${f.reason}`), { status: 409 })
  state = { running: true, model: modelId, step: 'uv', progress: 0, error: null }
  ;(async () => {
    try {
      const uv = await ensureUv()
      state.step = 'packages'
      const py = await ensureEnv(uv, model, hw)
      state.step = 'model'
      await downloadModel(py, model[hw.backend])
      state.step = 'test'
      state.progress = 0
      const r = await benchmark(modelId)
      const s = readSettings()
      s.local = { ...(s.local || {}), models: { ...(s.local?.models || {}), [modelId]: { rtf: r.rtf, load: r.load, backend: hw.backend, at: new Date().toISOString() } } }
      writeSettings(s)
      state = { running: false, model: modelId, step: 'done', progress: 1, error: null }
    } catch (e) {
      state = { ...state, running: false, error: e.message }
    }
  })().catch(() => {})
  return setupState()
}

/** 设置页要的全部信息 */
export function localVoiceStatus() {
  const hw = hardware()
  const installed = readSettings().local?.models || {}
  const rec = recommend(hw)
  return {
    hardware: hw,
    budgetSeconds: BUDGET_SECONDS,
    recommended: rec?.id || null,
    models: MODELS.map(m => {
      const b = m[hw.backend]
      const f = fit(m, hw)
      const inst = installed[m.id]
      return {
        id: m.id, name: m.name, note: m.note, quality: m.quality,
        downloadGB: b ? Math.round((b.sizeGB + envGB(m, hw)) * 10) / 10 : null,
        ok: f.ok, reason: f.reason,
        installed: inst ? { rtf: inst.rtf, load: inst.load, oneMinute: Math.round(predictSeconds(inst, 60)), maxMinutes: Math.max(0, Math.floor(((BUDGET_SECONDS - (inst.load || 0)) / (inst.rtf * 1.15)) / 60 * 10) / 10) } : null,
      }
    }),
    setup: setupState(),
  }
}

/* ---------- 常驻进程 ---------- */

const workers = new Map()
const IDLE_MS = 10 * 60_000

/** 拿到（必要时启动）一个模型的常驻进程 */
export function worker(modelId) {
  const hw = hardware()
  const model = MODELS.find(m => m.id === modelId)
  const b = model?.[hw.backend]
  if (!b) throw new Error(`本机配音模型不可用：${modelId}`)
  const cur = workers.get(modelId)
  if (cur) return cur.ready
  const child = spawn(envPython(hw.backend), [join(PLUGIN_ROOT, 'vendor', 'tts', 'worker.py'), b.worker], {
    env: pyEnv(hw.backend), windowsHide: true,
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
      const e = new Error(`本机配音进程退出（${code}）：${err.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`)
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
  return w.speak({ text, lang, out, instruct })
}

