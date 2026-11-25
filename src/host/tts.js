// 配音：每段的口播念成一个 WAV（24 kHz 单声道），返回实测秒数，段长跟着口播走（和网站一样）。
// 服务商由用户自己选：系统自带语音（电脑上本来就有）、豆包语音、OpenAI 兼容、ElevenLabs，或者不配音。
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ensureDir } from './paths.js'
import { ffmpeg, mediaSeconds, run, which } from './runtime.js'
import { chooseModel, estimateSeconds, speakLocal } from './localvoice.js'
import { readSettings } from './settings.js'

const RATE = 24000

/** 把 16 位 PCM 包成 WAV */
function pcmToWav(pcm) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(RATE, 24)
  h.writeUInt32LE(RATE * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

/** 任意音频转成 24k 单声道 WAV */
async function normalize(src, out, signal) {
  await ffmpeg(['-i', src, '-ac', '1', '-ar', String(RATE), '-c:a', 'pcm_s16le', out], { signal })
}

const isZh = text => /[一-鿿]/.test(text)

/* ---------- 系统自带语音 ---------- */

let macVoices = null
function macVoice(text) {
  if (!macVoices) {
    const r = spawnSync('say', ['-v', '?'], { encoding: 'utf8' })
    macVoices = (r.stdout || '').split('\n').map(l => {
      const m = /^(.+?)\s{2,}(\w{2}_\w{2})\s/.exec(l)
      return m ? { name: m[1].trim(), lang: m[2] } : null
    }).filter(Boolean)
  }
  const want = isZh(text) ? ['zh_CN', 'zh_TW', 'zh_HK'] : ['en_US', 'en_GB']
  const prefer = isZh(text) ? ['Tingting', 'Ting-Ting', 'Flo (Chinese (China mainland))', 'Sandy (Chinese (China mainland))', 'Shelley (Chinese (China mainland))'] : ['Samantha', 'Alex']
  for (const p of prefer) if (macVoices.some(v => v.name === p)) return p
  return macVoices.find(v => want.includes(v.lang))?.name || null
}

async function systemSay(text, out, opts) {
  const tmp = join(dirname(out), `${randomUUID()}.tmp`)
  try {
    if (process.platform === 'darwin') {
      const voice = opts.voice || macVoice(text)
      const args = voice ? ['-v', voice] : []
      const aiff = `${tmp}.aiff`
      const r = await run('say', [...args, '-o', aiff, text], { signal: opts.signal, timeoutMs: 120_000 })
      if (r.code !== 0) throw new Error(`系统语音失败：${r.stderr.trim()}`)
      await normalize(aiff, out, opts.signal)
      rmSync(aiff, { force: true })
      return
    }
    if (process.platform === 'win32') {
      const wav = `${tmp}.wav`
      const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
        `$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like '${isZh(text) ? 'zh*' : 'en*'}' } | Select-Object -First 1; ` +
        `if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }; $s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}'); ` +
        `$s.Speak([Console]::In.ReadToEnd()); $s.Dispose()`
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: text, signal: opts.signal, timeoutMs: 120_000 })
      if (r.code !== 0 || !existsSync(wav)) throw new Error(`系统语音失败：${r.stderr.trim().slice(0, 300)}`)
      await normalize(wav, out, opts.signal)
      rmSync(wav, { force: true })
      return
    }
    const espeak = which('espeak-ng') || which('espeak')
    if (!espeak) throw new Error('这台电脑没有系统语音（Linux 请安装 espeak-ng），或在设置里换成自己的配音服务')
    const wav = `${tmp}.wav`
    const r = await run(espeak, ['-v', isZh(text) ? 'cmn' : 'en-us', '-w', wav, text], { signal: opts.signal })
    if (r.code !== 0) throw new Error(`系统语音失败：${r.stderr.trim()}`)
    await normalize(wav, out, opts.signal)
    rmSync(wav, { force: true })
  } finally {
    rmSync(tmp, { force: true })
  }
}

/* ---------- 豆包语音（火山引擎，X-Api-Key） ---------- */

async function doubao(text, out, s, signal) {
  const [resource, speaker] = (s.voice || 'seed-tts-2.0/zh_female_vv_uranus_bigtts').includes('/')
    ? s.voice.split('/')
    : ['seed-tts-2.0', s.voice]
  const res = await fetch(s.url || 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Api-Key': s.key, 'X-Api-Resource-Id': resource, 'X-Api-Request-Id': randomUUID() },
    body: JSON.stringify({ user: { uid: 'dsh-lovideo' }, req_params: { text, speaker, audio_params: { format: 'pcm', sample_rate: RATE } } }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000 + 100 * text.length)].filter(Boolean)),
  })
  if (!res.ok) throw new Error(`豆包语音 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`)
  const raw = await res.text()
  const parts = []
  // 返回的是一串拼在一起的 JSON 对象
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '{' && depth++ === 0) start = i
    else if (c === '}' && --depth === 0) {
      const chunk = JSON.parse(raw.slice(start, i + 1))
      if (chunk.code && chunk.code !== 0 && chunk.code !== 20000000) throw new Error(`豆包语音出错 ${chunk.code}：${chunk.message || ''}`)
      if (chunk.data) parts.push(Buffer.from(chunk.data, 'base64'))
    }
  }
  if (!parts.length) throw new Error('豆包语音没有返回音频')
  writeFileSync(out, pcmToWav(Buffer.concat(parts)))
}

/* ---------- OpenAI 兼容 ---------- */

async function openaiTts(text, out, s, signal) {
  const base = (s.url || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const res = await fetch(`${base}/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` },
    body: JSON.stringify({ model: s.model || 'gpt-4o-mini-tts', voice: s.voice || 'alloy', input: text, response_format: 'wav' }),
    signal,
  })
  if (!res.ok) throw new Error(`配音服务 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`)
  const tmp = `${out}.src`
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()))
  await normalize(tmp, out, signal)
  rmSync(tmp, { force: true })
}

/* ---------- ElevenLabs ---------- */

async function eleven(text, out, s, signal) {
  const voice = s.voice || '21m00Tcm4TlvDq8ikWAM'
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_24000`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'xi-api-key': s.key },
    body: JSON.stringify({ text, model_id: s.model || 'eleven_multilingual_v2' }),
    signal,
  })
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}：${(await res.text()).slice(0, 200)}`)
  writeFileSync(out, pcmToWav(Buffer.from(await res.arrayBuffer())))
}

/**
 * 念一段口播。
 * @returns {Promise<number>} 实测秒数；不配音时返回 0
 */
export async function speak(text, out, voiceSettings, signal) {
  const t = String(text || '').trim()
  if (!t || voiceSettings.provider === 'none') return 0
  ensureDir(dirname(out))
  const p = voiceSettings.provider
  if (!['system', 'local'].includes(p) && !voiceSettings.key) throw new Error('配音服务还没填 key，请在 lovideo 设置里填写，或换成系统自带语音')
  if (p === 'local') {
    // 开拍时已经按口播长度挑好模型；单独试听时挑装好的里面最好的
    const model = voiceSettings.localModel || chooseModel(readSettings().local.models, estimateSeconds([t]))?.id
    if (!model) throw new Error('还没有装好本机配音模型，请在 lovideo 设置的「配音」里下载')
    const raw = `${out}.local.wav`
    await speakLocal(model, { text: t, lang: isZh(t) ? 'zh' : 'en', out: raw, instruct: voiceSettings.instruct })
    await normalize(raw, out, signal)
    rmSync(raw, { force: true })
  } else if (p === 'system') await systemSay(t, out, { voice: voiceSettings.voice, signal })
  else if (p === 'doubao') await doubao(t, out, voiceSettings, signal)
  else if (p === 'openai') await openaiTts(t, out, voiceSettings, signal)
  else if (p === 'elevenlabs') await eleven(t, out, voiceSettings, signal)
  else throw new Error(`不支持的配音服务：${p}`)
  return mediaSeconds(out)
}
