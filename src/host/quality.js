// 交段前的两道检查，和 lovideo 网站沙箱一样（workers/sandbox/job/segment_session.py、lovideo_job.py）：
//   1. 看检查图：第一次完整渲染前只画均匀取的 6～9 帧，拼成一张图，用一次很小的模型调用看观众一眼能看出的毛病；
//      有毛病就不渲染，把毛病交回同一个制作会话改一次，改完直接完整渲染，不再看第二次。模型看不了图就跳过。
//   2. 画面跟不跟着旁白动：渲染出来量一遍「旁白在说话时画面有没有在动」，不花模型调用；
//      整句话画面都不动的句子占到本段旁白三分之一以上，退回一次让它补动作。
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffmpeg, findFfmpeg } from './runtime.js'
import { chat, imageBlock, userMessage } from './llm.js'

/* ---------- 检查图 ---------- */

const SHEET_FRAMES = 6
// 10 秒以上的段取 9 帧（3×3）：一段十几二十秒有好几个节拍，6 帧会漏掉
const SHEET_FRAMES_LONG = 9
const SHEET_LONG_S = 10
const SHEET_EDGE = 400

/** 检查图取哪几帧（段内帧号）：把段均分成 n 份取每份中间那帧，开头和结尾都看得到 */
export function sheetFrames(frames, fps) {
  const n = frames > SHEET_LONG_S * fps ? SHEET_FRAMES_LONG : SHEET_FRAMES
  return [...new Set(Array.from({ length: n }, (_, i) => Math.min(frames - 1, Math.floor(((i + 0.5) * frames) / n))))].sort((a, b) => a - b)
}

const scale = `scale='if(gte(iw,ih),${SHEET_EDGE},-2)':'if(gte(iw,ih),-2,${SHEET_EDGE})'`
const tile = n => `tile=${Math.min(3, n)}x${Math.ceil(n / Math.min(3, n))}:padding=4`

/** 几张帧图（JPEG，按顺序）拼成检查图 PNG：长边缩到 400，每行 3 张 */
export async function sheetFromImages(images, signal) {
  const dir = mkdtempSync(join(tmpdir(), 'lovideo-sheet-'))
  try {
    images.forEach((b, i) => writeFileSync(join(dir, `${String(i).padStart(3, '0')}.jpg`), b))
    const dest = join(dir, 'sheet.png')
    await ffmpeg(['-framerate', '1', '-i', join(dir, '%03d.jpg'), '-vf', `${scale},${tile(images.length)}`, '-frames:v', '1', dest], { signal })
    return readFileSync(dest)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 段视频的检查图（用段命令渲染的风格：渲染完再看） */
export async function sheetFromVideo(video, picked, signal) {
  const dir = mkdtempSync(join(tmpdir(), 'lovideo-sheet-'))
  try {
    const dest = join(dir, 'sheet.png')
    const select = picked.map(n => `eq(n\\,${n})`).join('+')
    await ffmpeg(['-i', video, '-vf', `select='${select}',${scale},${tile(picked.length)}`, '-fps_mode', 'vfr', '-frames:v', '1', dest], { signal })
    return readFileSync(dest)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const REVIEW_RULES = `You check one segment of a short film before the viewer sees it. The image below is its contact sheet: frames spread evenly across the segment, left to right, top to bottom. The platform adds the subtitles later in the bottom band, so their absence is not a defect.

Report only defects a viewer would notice at once:
- text overlapping other text or graphics so that it cannot be read;
- text or a key graphic cut off by the frame edge;
- a shape, colour block or element that hides the subject or fills a large part of the frame and is clearly not meant to be there (for example a highlight, glow or particle drawn many times too large);
- a frame that is empty or visibly broken (a deliberate build-up at the very start is fine);
- garbled or missing characters;
- on-screen text that contradicts the approved copy.
Taste, pacing, colour and small alignment are not defects.

Reply with exactly OK if there is none. Otherwise reply with at most 3 lines, one defect per line: the frame number (1 is the first), what is wrong, and the fix.`

/**
 * 看一次检查图。没有毛病返回空串，有毛病返回最多 3 行；看不了抛错。
 * @param {{title?:string, description?:string, copy?:object}} seg
 */
export async function reviewSheet(seg, png, signal) {
  const copy = Object.entries(seg.copy || {}).filter(([, v]) => String(v).trim()).map(([k, v]) => `${k}: ${v}`).join('; ') || '(none)'
  const about = `Segment title: ${seg.title || seg.id}\nWhat it should show: ${seg.description || '(not given)'}\nOn-screen copy the user approved: ${copy}`
  // 回答最多 3 行，但思考也算输出：上限给宽一点，不然毛病说到一半被截断（网站实测过）
  const r = await chat({
    system: 'You review contact sheets of short-film segments.',
    messages: [userMessage([{ type: 'text', text: REVIEW_RULES }, await imageBlock(png), { type: 'text', text: about }])],
    maxTokens: 4000,
    light: true,
    signal,
  })
  const lines = r.text.split('\n').map(l => l.trim()).filter(Boolean)
  if (!lines.length) throw new Error('看检查图没有回答')
  if (lines[0].replace(/\.$/, '').toUpperCase() === 'OK') return ''
  return lines.slice(0, 3).join('\n')
}

/** 交回制作会话的话：检查图里看到的毛病 */
export function reviewReport(segId, picked, notes) {
  return `${segId} is not submitted yet: a reviewer looked at a contact sheet of it (segment frames ${picked.join(', ')}, left to right, top to bottom; frame 1 is the first of them) and found these defects:\n${notes}\nFix only these, with one draw call (edits to the current files). The next draw renders the whole segment and submits it; it is not reviewed again.`
}

/* ---------- 画面有没有跟着旁白动 ---------- */
// 量法：把段视频缩成小灰度图，每 0.2 秒取一帧，相邻两帧有一小块像素变了就算「这一步在动」。
// 一句旁白说话期间，在动的步数不到四分之一，就是「话在说、画面停着」。阈值是网站按线上成片校准的。
const MOTION_FPS = 5
const MOTION_EDGE = 160
const MOTION_PIXEL = 8
const MOTION_AREA = 0.0005
const MOTION_MIN_SHARE = 0.25
const MOTION_MIN_SENTENCE_S = 1.5
const MOTION_REJECT_SHARE = 1 / 3

/** 段视频每 0.2 秒一帧的灰度小图（一帧接一帧）和一帧的字节数 */
export function motionGray(video, width, height, signal) {
  const [w, h] = width >= height
    ? [MOTION_EDGE, Math.max(2, Math.round((MOTION_EDGE * height) / width / 2) * 2)]
    : [Math.max(2, Math.round((MOTION_EDGE * width) / height / 2) * 2), MOTION_EDGE]
  return new Promise((ok, fail) => {
    const bin = findFfmpeg()
    if (!bin) return fail(new Error('还没有 ffmpeg'))
    const child = spawn(bin, ['-v', 'error', '-i', video, '-vf', `fps=${MOTION_FPS},scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { windowsHide: true })
    const chunks = []
    let err = ''
    child.stdout.on('data', d => chunks.push(d))
    child.stderr.on('data', d => (err += d))
    const kill = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', kill, { once: true })
    child.on('error', fail)
    child.on('close', code => {
      signal?.removeEventListener('abort', kill)
      if (code === 0) ok({ gray: Buffer.concat(chunks), frameBytes: w * h })
      else fail(new Error(`量画面变化失败：${err.trim().slice(-200)}`))
    })
    return undefined
  })
}

/** 相邻两帧之间画面动没动 */
export function motionSteps(gray, frameBytes) {
  const count = frameBytes ? Math.floor(gray.length / frameBytes) : 0
  const floor = frameBytes * MOTION_AREA
  const steps = []
  for (let i = 0; i < count - 1; i++) {
    let changed = 0
    const a = i * frameBytes
    const b = a + frameBytes
    for (let k = 0; k < frameBytes; k++) if (Math.abs(gray[a + k] - gray[b + k]) > MOTION_PIXEL) changed++
    steps.push(changed > floor)
  }
  return steps
}

/**
 * 旁白在说、画面几乎不动的句子：[{sentence, share}]。sentences 的 start/end 是整片秒，startS 是这一段的起点。
 * 这些句子加起来不到本段旁白时间的三分之一就不算（返回空）。
 */
export function stillSentences(steps, sentences, startS) {
  const still = []
  let spoken = 0
  let frozen = 0
  for (const x of sentences) {
    const begin = x.start - startS
    const end = x.end - startS
    if (end - begin < MOTION_MIN_SENTENCE_S) continue
    const span = steps.slice(Math.max(0, Math.floor(begin * MOTION_FPS)), Math.max(0, Math.floor(end * MOTION_FPS) + 1))
    if (!span.length) continue
    spoken += end - begin
    const share = span.filter(Boolean).length / span.length
    if (share < MOTION_MIN_SHARE) {
      still.push({ sentence: x, share })
      frozen += end - begin
    }
  }
  return spoken && frozen / spoken >= MOTION_REJECT_SHARE ? still : []
}

/** 退回这一段时给制作会话的话 */
export function stillReport(segId, still) {
  const lines = still.map(({ sentence: x, share }) => `- ${x.id} ${x.start.toFixed(2)}-${x.end.toFixed(2)}s (film clock), the picture changes during only ${Math.round(share * 100)}% of it: ${x.text}`)
  return `${segId} is not submitted: the picture stands still while the voice-over speaks. Measured on the rendered segment, these sentences play over a picture that barely changes:\n${lines.join('\n')}\nGive each of them its own visible action timed on its words (something enters, moves, transforms, is highlighted, or the camera moves), and keep what is already on screen alive between actions (for example what moves keeps moving). Do not remove or shorten anything to get there, and keep every action on the words it belongs to. Fix all of them in one draw call.`
}
