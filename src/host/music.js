// 配乐：按导演给的描述（mood）生成一首纯器乐背景音乐，长度对上成片。
// 来源由设置里的「配乐」决定：离线配乐（本机模型）、火山配乐、ElevenLabs，或者不配乐。
// 生成的曲子比成片短时，拼成片会循环接上并在结尾淡出。
import { createHmac, createHash } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { readSettings } from './settings.js'
import { musicLocal } from './localvoice.js'
import { run, findFfmpeg, mediaSeconds } from './runtime.js'

export const MUSIC_NAMES = { local: '离线配乐', volcengine: '火山配乐', elevenlabs: 'ElevenLabs', none: '不配乐' }

/**
 * 生成配乐写到 out（wav）。
 * @returns {Promise<{ seconds: number, model: string }>}
 */
export async function generateMusic({ brief, mood, seconds, out, signal, settings = readSettings() }) {
  const m = settings.music
  const keys = settings.keys
  const want = Math.max(10, Math.round(seconds))
  if (m.provider === 'local') {
    const r = await musicLocal({ prompt: mood, seconds: want, out, signal })
    return { seconds: r.seconds, model: r.model }
  }
  const raw = `${out}.download`
  try {
    // 火山按中文描述效果更好（和网站一样）；ElevenLabs 和离线模型用英文
    if (m.provider === 'volcengine') await volcengine({ text: brief || mood, seconds: want, ak: keys.volcAk, sk: keys.volcSk, out: raw, signal })
    else if (m.provider === 'elevenlabs') await elevenlabs({ styles: mood, seconds: want, key: keys.elevenlabs, out: raw, signal })
    else throw new Error('设置里选了不配乐')
    await toWav(raw, out, signal)
  } finally {
    rmSync(raw, { force: true })
  }
  return { seconds: mediaSeconds(out), model: m.provider }
}

async function toWav(src, out, signal) {
  const r = await run(findFfmpeg(), ['-y', '-loglevel', 'error', '-i', src, '-ar', '48000', '-ac', '2', out], { signal, timeoutMs: 120_000 })
  if (r.code !== 0) throw new Error(`配乐转码失败：${(r.stderr || '').trim().slice(-200)}`)
}

/* ---------- 火山引擎智能创作「生成纯音乐」（和 lovideo 网站同一个接口） ---------- */

const VOLC_HOST = 'open.volcengineapi.com'
const VOLC_REGION = 'cn-beijing'
const VOLC_SERVICE = 'imagination'
const VOLC_VERSION = '2024-08-12'
// 火山一首 30–120 秒；成片更长时生成 120 秒，拼成片时循环
const VOLC_MIN = 30
const VOLC_MAX = 120

const sha256 = text => createHash('sha256').update(text).digest('hex')
const hmac = (key, text) => createHmac('sha256', key).update(text).digest()

/** 火山 OpenAPI 的签名头：规范请求 → 待签字符串 → 按日期/地区/服务派生的密钥签名 */
export function signVolc({ ak, sk, query, body, now = new Date() }) {
  const xDate = `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`
  const day = xDate.slice(0, 8)
  const payloadHash = sha256(body)
  const headers = { 'content-type': 'application/json', host: VOLC_HOST, 'x-content-sha256': payloadHash, 'x-date': xDate }
  const names = Object.keys(headers).sort()
  const canonical = ['POST', '/', query, names.map(n => `${n}:${headers[n]}\n`).join(''), names.join(';'), payloadHash].join('\n')
  const scope = `${day}/${VOLC_REGION}/${VOLC_SERVICE}/request`
  const toSign = ['HMAC-SHA256', xDate, scope, sha256(canonical)].join('\n')
  let key = Buffer.from(sk)
  for (const part of [day, VOLC_REGION, VOLC_SERVICE, 'request']) key = hmac(key, part)
  const signature = createHmac('sha256', key).update(toSign).digest('hex')
  return { ...headers, authorization: `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` }
}

async function volcCall(cred, action, payload, signal) {
  const query = `Action=${action}&Version=${VOLC_VERSION}`
  const body = JSON.stringify(payload)
  const res = await fetch(`https://${VOLC_HOST}/?${query}`, { method: 'POST', headers: signVolc({ ...cred, query, body }), body, signal })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

/** 按时长切段落：开头、主体、结尾，让曲子有起伏（多段时每段至少 5 秒） */
export function volcSegments(seconds) {
  const total = Math.max(VOLC_MIN, Math.min(VOLC_MAX, Math.round(seconds)))
  const intro = Math.max(5, Math.round(total * 0.15))
  const outro = Math.max(5, Math.round(total * 0.15))
  return [{ Name: 'intro', Duration: intro }, { Name: 'inst', Duration: total - intro - outro }, { Name: 'outro', Duration: outro }]
}

async function volcengine({ text, seconds, ak, sk, out, signal }) {
  if (!ak || !sk) throw new Error('火山配乐还没填 AccessKey 和 SecretKey，请在 lovideo 设置的「配乐」里填写')
  const cred = { ak, sk }
  const submit = await volcCall(cred, 'GenBGMForTime', { Text: text, Version: 'v5.0', Segments: volcSegments(seconds) }, signal)
  const taskId = submit.json.Result?.TaskID
  if (!taskId) {
    const e = submit.json.ResponseMetadata?.Error
    throw new Error(`火山配乐没接单（${submit.status}）：${e?.Code || ''} ${e?.Message || ''}`.trim())
  }
  // 火山 QPS 2 把查进度也算在内：5 秒查一次，一首通常 15 秒左右出来
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 5000)
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('已暂停'), { name: 'AbortError' })) }, { once: true })
    })
    const q = await volcCall(cred, 'QuerySong', { TaskID: taskId }, signal).catch(() => null)
    const r = q?.json?.Result
    if (r?.Status === 3) throw new Error(`火山配乐生成失败：${r.FailureReason || '原因不明'}`)
    if (r?.Status === 2 && r.SongDetail?.AudioUrl) {
      const res = await fetch(r.SongDetail.AudioUrl, { signal })
      if (!res.ok) throw new Error(`火山配乐下载失败（${res.status}）`)
      writeFileSync(out, Buffer.from(await res.arrayBuffer()))
      return
    }
  }
  throw new Error('火山配乐 4 分钟没做完，这次先不配乐')
}

/* ---------- ElevenLabs Music（和 lovideo 网站同一个接口） ---------- */

async function elevenlabs({ styles, seconds, key, out, signal }) {
  if (!key) throw new Error('ElevenLabs 配乐还没填 key，请在 lovideo 设置的「配乐」里填写')
  // 一段最长 120 秒：长片按 120 秒切成几段，风格相同
  const sections = []
  let left = Math.min(600, Math.round(seconds)) * 1000
  for (let i = 0; left > 0; i++) {
    const ms = Math.max(3000, Math.min(120_000, left))
    sections.push({ section_name: `part ${i + 1}`, positive_local_styles: [], negative_local_styles: [], duration_ms: ms, lines: [] })
    left -= ms
  }
  const body = {
    model_id: 'music_v1',
    composition_plan: { positive_global_styles: [styles], negative_global_styles: ['vocals'], sections },
  }
  const res = await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192', {
    method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  })
  if (!res.ok) throw new Error(`ElevenLabs 配乐失败（${res.status}）：${(await res.text().catch(() => '')).slice(0, 200)}`)
  writeFileSync(out, Buffer.from(await res.arrayBuffer()))
}
