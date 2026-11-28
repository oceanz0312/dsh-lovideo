// 口播按句：和 lovideo 网站一样逐句配音、量时长，按网站的时序规则铺成一段的口播轨，
// 再写出风格包要读的 narration.json（每句所在段、整片起止秒、逐词时间）。
//   时序（网站 src/lovideo/narration/layout.ts）：段首留白 150 ms、句间停顿 250 ms、段尾留白 400 ms；一句最多 60 字。
//   逐词时间：网站用配音服务返回的词时间；本机的配音服务大多不给，按字数在句内均分（风格包没有词时间时也是这样估的）。
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ffmpeg, mediaSeconds } from './runtime.js'

export const HEAD = 0.15
export const GAP = 0.25
export const TAIL = 0.4
export const SENTENCE_MAX = 60

const r3 = n => Math.round(n * 1000) / 1000
const CJK = /[぀-ヿ㐀-鿿가-힯]/

/** 句子连成一段话：中日韩直接接上，其他语言之间空一格 */
export function joinSentences(list) {
  return list.reduce((out, s) => (!out ? s : CJK.test(out.at(-1)) || CJK.test(s[0]) ? out + s : `${out} ${s}`), '')
}

/** 一段口播拆成句：分镜给了句子就用它，否则按句末标点切 */
export function sentencesOf(scene) {
  if (Array.isArray(scene?.sentences) && scene.sentences.length) return scene.sentences.map(s => String(s).trim()).filter(Boolean)
  const text = String(Array.isArray(scene?.narration) ? joinSentences(scene.narration) : scene?.narration || '').replace(/\s+/g, ' ').trim()
  if (!text) return []
  return (text.match(/[^。！？!?；;\n]+[。！？!?；;]*|[^.]+(?:\.(?=\s|$))?/g) || [text])
    .flatMap(s => s.split(/(?<=\.)\s+(?=[A-Z])/))
    .map(s => s.trim())
    .filter(Boolean)
}

/** 一句话里的词：中日韩每个字一个词（标点跟着前一个字），其他语言按空格 */
function tokens(text) {
  if (CJK.test(text)) {
    const out = []
    for (const ch of text) {
      if (/[\s]/.test(ch)) continue
      if (/[\p{P}\p{S}]/u.test(ch) && out.length) out[out.length - 1] += ch
      else out.push(ch)
    }
    return out
  }
  return text.split(/\s+/).filter(Boolean)
}

/** 句内逐词时间（按字数均分），秒 */
export function wordsOf(text, start, end) {
  const toks = tokens(text)
  const weight = t => Math.max(1, t.replace(/[\p{P}\p{S}]/gu, '').length)
  const total = toks.reduce((n, t) => n + weight(t), 0) || 1
  let at = start
  return toks.map(w => {
    const d = ((end - start) * weight(w)) / total
    const word = { w, start: r3(at), end: r3(at + d) }
    at += d
    return word
  })
}

/** 有口播的段多少帧：网站的 narrationFrames */
export const narrationFrames = (secs, fps) => Math.ceil((HEAD + secs.reduce((a, b) => a + b, 0) + GAP * Math.max(0, secs.length - 1) + TAIL) * fps)

/**
 * 给一段配音：逐句念，量每句时长，按留白和停顿拼成这一段的口播轨（从段首开始，含段首留白）。
 * @returns {{file:string, seconds:number, sentences:{id:string,text:string,file:string,start:number,end:number}[]}}
 *   file 相对作品目录；start/end 是段内秒
 */
export async function voiceSegment({ segId, texts, workDir, speak, signal }) {
  const lines = []
  let at = HEAD
  for (const [i, text] of texts.entries()) {
    const file = join('voice', `${segId}-s${i + 1}.wav`)
    const raw = join(workDir, 'voice', `${segId}-s${i + 1}.raw.wav`)
    if (!((await speak(text, raw, signal)) > 0)) throw new Error(`第 ${i + 1} 句没有念出声音：${text.slice(0, 30)}`)
    // 和网站一样：按 -40 dBFS 裁掉前后多余的静音，只留 50 ms，句子的起止才准
    const trim = 'silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.05'
    await ffmpeg(['-i', raw, '-af', `${trim},areverse,${trim},areverse`, '-ar', '24000', '-ac', '1', join(workDir, file)], { signal })
    rmSync(raw, { force: true })
    const sec = await mediaSeconds(join(workDir, file))
    if (!(sec > 0.05)) throw new Error(`第 ${i + 1} 句裁掉静音后没有声音：${text.slice(0, 30)}`)
    lines.push({ id: `${segId}-s${i + 1}`, text, file, start: r3(at), end: r3(at + sec) })
    at += sec + GAP
  }
  const file = join('voice', `${segId}.wav`)
  // 段首留白 + 句 + 停顿 + 句 …：每句前面补到它的起点
  const inputs = lines.flatMap(l => ['-i', join(workDir, l.file)])
  const parts = lines.map((l, i) => `[${i}:a]aresample=24000,aformat=sample_fmts=s16:channel_layouts=mono,adelay=${Math.round(l.start * 1000)}|${Math.round(l.start * 1000)}[a${i}]`)
  const mix = lines.length > 1 ? `${lines.map((_, i) => `[a${i}]`).join('')}amix=inputs=${lines.length}:normalize=0:dropout_transition=0[out]` : '[a0]anull[out]'
  await ffmpeg([...inputs, '-filter_complex', [...parts, mix].join(';'), '-map', '[out]', '-ar', '24000', '-ac', '1', join(workDir, file)], { signal })
  const seconds = r3(lines.at(-1).end)
  return { file, seconds, sentences: lines }
}

/**
 * 写风格包读的 narration.json（网站沙箱 /work/narration.json 同格式）：每句的段、整片起止秒、逐词时间（整片秒）。
 * @returns {object|null} 没有口播时 null（不写文件）
 */
export function writeNarrationJson(dir, segments, fps) {
  const sentences = []
  for (const s of segments) {
    const offset = s.start / fps
    for (const l of s.voice?.sentences || []) {
      const start = r3(offset + l.start)
      const end = r3(offset + l.end)
      sentences.push({ id: l.id, n: sentences.length + 1, segment: s.id, text: l.text, file: l.file, start, end, words: wordsOf(l.text, start, end) })
    }
  }
  if (!sentences.length) return null
  const total = segments.reduce((n, s) => n + s.frames, 0) / fps
  const data = { sampleRate: 24000, fps, duration: r3(total), sentences }
  writeFileSync(join(dir, 'narration.json'), JSON.stringify(data, null, 1))
  return data
}
