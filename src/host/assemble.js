// 时间线和成片。时间线用网站编辑器同一个格式（schema 2，见 docs/PROTOCOL.md），
// 素材地址写本机相对路径；改片（裁短、换顺序、改字幕、重画）都改时间线，再按时间线重新拼成片。
// 成片不烧字幕（和网站一样），导出时可以选择把字幕烧进画面。配音和配乐是混进成片的，
// 所以它们的开关一变，成片要按开关重新拼一遍。
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir } from './paths.js'
import { workDir } from './works.js'
import { ffmpeg, mediaSeconds } from './runtime.js'

const r3 = n => Math.round(n * 1000) / 1000

/** 从制作结果生成一条新时间线 */
/** 一行字幕最多多少个字：超过就在逗号处断开，还长就硬切 */
const CAPTION_MAX = 18

/** 按句子切开：先按句号问号感叹号分号，太长再按逗号顿号冒号，还长就按字数切。句末的逗号句号去掉 */
export function splitCaption(text) {
  const out = []
  const sentences = String(text || '').replace(/\s+/g, ' ').match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || []
  for (const raw of sentences) {
    const sentence = raw.trim()
    if (!sentence) continue
    const parts = sentence.length <= CAPTION_MAX ? [sentence] : sentence.match(/[^，,、：:]+[，,、：:]?/g) || [sentence]
    let line = ''
    for (const part of parts) {
      if ((line + part).length <= CAPTION_MAX) line += part
      else {
        if (line) out.push(line)
        line = part
        while (line.length > CAPTION_MAX) {
          out.push(line.slice(0, CAPTION_MAX))
          line = line.slice(CAPTION_MAX)
        }
      }
    }
    if (line) out.push(line)
  }
  return out.map(l => l.trim().replace(/[，,。.；;：:、]+$/, '')).filter(Boolean)
}

/** 一镜的字幕：句子按字数分配这一镜口播的时长，首尾相接 */
export function captionCues(text, start, dur, sceneId) {
  const lines = splitCaption(text)
  const weight = l => Math.max(1, l.replace(/\s/g, '').length)
  const total = lines.reduce((n, l) => n + weight(l), 0) || 1
  let t = start
  return lines.map((l, k) => {
    const d = k === lines.length - 1 ? start + dur - t : (dur * weight(l)) / total
    const cue = { id: `sub-${sceneId}-${k + 1}`, of: sceneId, text: l, start: r3(t), dur: r3(Math.max(0.4, d)) }
    t += d
    return cue
  })
}

export function buildTimeline(work) {
  const job = work.job
  const fps = job.fps
  const scenes = new Map((work.plan?.scenes || []).map(s => [s.id, s]))
  const assets = {}
  const sceneClips = []
  const voice = []
  const subs = []
  for (const s of job.segments) {
    const start = s.start / fps
    const dur = s.frames / fps
    assets[`v-${s.id}`] = { kind: 'video', r2: s.file, uri: s.file, w: job.width, h: job.height, dur: r3(dur), thumb: s.poster }
    sceneClips.push({ id: `c-${s.id}`, sceneId: s.id, start: r3(start), dur: r3(dur), media: { asset: `v-${s.id}` } })
    const text = narration(scenes.get(s.id))
    // 逐句配音的口播轨从段首开始（自带段首留白）；之前做的片子口播轨不带留白，放在段首 0.3 秒处
    const lead = s.voice?.sentences ? 0 : 0.3
    if (s.voice) {
      assets[`n-${s.id}`] = { kind: 'audio', r2: s.voice.file, uri: s.voice.file, dur: r3(s.voice.seconds) }
      voice.push({ id: `vo-${s.id}`, of: s.id, asset: `n-${s.id}`, start: r3(start + lead), dur: r3(s.voice.seconds), offset: 0, gain: 0, fadeOut: 0 })
    }
    if (s.voice?.sentences?.length) {
      // 字幕跟着每句实际念的时间走：一句太长再切成几条，在这句的时间里按字数分
      let k = 0
      for (const l of s.voice.sentences) {
        for (const cue of captionCues(l.text, start + l.start, Math.max(0.4, l.end - l.start), s.id)) subs.push({ ...cue, id: `sub-${s.id}-${++k}` })
      }
    } else if (text) subs.push(...captionCues(text, start + lead, Math.max(1, s.voice ? s.voice.seconds : dur - 0.6), s.id))
  }
  const duration = r3(job.segments.reduce((n, s) => n + s.frames, 0) / fps)
  const tracks = [{ id: 't-scene', type: 'scene', clips: sceneClips }]
  if (voice.length) tracks.push({ id: 't-voice', type: 'audio', role: 'voice', clips: voice })
  if (subs.length) tracks.push({ id: 't-sub', type: 'subtitle', clips: subs })
  if (work.music?.file && existsSync(join(workDir(work.id), work.music.file))) {
    assets.bgm = { kind: 'audio', r2: work.music.file, uri: work.music.file, dur: duration }
    tracks.push({ id: 't-bgm', type: 'audio', role: 'bgm', clips: [{ id: 'bgm-1', asset: 'bgm', start: 0, dur: duration, offset: 0, gain: -14, fadeOut: 2, label: work.music.label || '配乐' }] })
  }
  return syncSwitches({
    schema: 2, schemaVersion: 2, taskId: work.id, version: 1, template: work.style?.slug || '',
    planRevision: work.plan?.revision ?? 0,
    output: { width: job.width, height: job.height, fps }, duration, assets, tracks,
  }, work)
}

/** 按作品上的开关（work.voice / music / subtitles 的 enabled）给对应轨道打上或去掉 hidden */
export function syncSwitches(tl, work) {
  for (const key of Object.keys(SWITCHES)) {
    const t = trackOf(tl, key)
    if (t) t.hidden = work[key]?.enabled === false
  }
  return tl
}

/**
 * 配音、字幕、配乐三个开关，各对应时间线上的一条轨道。关掉就是给这条轨道打 hidden：
 * 播放时不显示、成片里不混进声音、导出 MP4 不烧字幕、剪映工程里不带这条轨道。
 */
export const SWITCHES = {
  voice: { label: '配音', is: t => t.type === 'audio' && t.role === 'voice' },
  subtitles: { label: '字幕', is: t => t.type === 'subtitle' },
  music: { label: '配乐', is: t => t.type === 'audio' && t.role === 'bgm' },
}

export const trackOf = (tl, key) => tl?.tracks.find(SWITCHES[key].is)

/** 每个开关现在是开还是关；这部片子没有的轨道（比如没配乐）不出现 */
export function switchesOf(tl) {
  const out = {}
  for (const key of Object.keys(SWITCHES)) {
    const t = trackOf(tl, key)
    if (t) out[key] = !t.hidden
  }
  return out
}


function narration(scene) {
  if (!scene) return ''
  const n = scene.narration
  return (Array.isArray(n) ? n.join('') : String(n || '')).trim()
}

/** 场景重新排好、首尾相接；口播和字幕跟着所在场景移动 */
export function normalizeTimeline(tl) {
  const scene = tl.tracks.find(t => t.type === 'scene')
  if (!scene) return tl
  scene.clips.sort((a, b) => a.start - b.start)
  const moved = new Map()
  let t = 0
  for (const c of scene.clips) {
    moved.set(c.sceneId, { from: c.start, to: t, end: t + c.dur })
    c.start = r3(t)
    t += c.dur
  }
  tl.duration = r3(t)
  for (const track of tl.tracks) {
    if (track.type === 'scene') continue
    for (const c of track.clips) {
      const m = c.of && moved.get(c.of)
      if (m) {
        c.start = r3(m.to + (c.start - m.from))
        // 场景被裁短时，口播和字幕不跑到场景外面
        c.dur = r3(Math.max(0.1, Math.min(c.dur, m.end - c.start)))
      }
    }
    if (track.role === 'bgm') for (const c of track.clips) c.dur = tl.duration
  }
  return tl
}

/** 按时间线拼成片：拼画面、混口播和配乐、出封面 */
export async function assembleFilm(id, timeline, { signal } = {}) {
  const dir = workDir(id)
  normalizeTimeline(timeline)
  const scene = timeline.tracks.find(t => t.type === 'scene')
  // 关掉的配音、配乐不混进成片
  const audio = timeline.tracks.filter(t => t.type === 'audio' && !t.hidden).flatMap(t => t.clips.map(c => ({ ...c, role: t.role })))
  const { width, height, fps } = timeline.output
  const args = []
  const filters = []
  scene.clips.forEach((c, i) => {
    const a = timeline.assets[c.media.asset]
    args.push('-i', join(dir, a.uri || a.r2))
    filters.push(`[${i}:v]trim=start=${c.media.trimStart || 0}:duration=${c.dur},setpts=PTS-STARTPTS,scale=${width}:${height},fps=${fps},format=yuv420p[v${i}]`)
  })
  filters.push(`${scene.clips.map((_, i) => `[v${i}]`).join('')}concat=n=${scene.clips.length}:v=1:a=0[v]`)
  const n = scene.clips.length
  const mix = []
  audio.forEach((c, k) => {
    const a = timeline.assets[c.asset]
    if (!a) return
    const idx = n + mix.length
    if (c.role === 'bgm') args.push('-stream_loop', '-1')
    args.push('-i', join(dir, a.uri || a.r2))
    const vol = Math.pow(10, (c.gain || 0) / 20).toFixed(3)
    const delay = Math.round(c.start * 1000)
    const fade = c.fadeOut ? `,afade=t=out:st=${Math.max(0, c.dur - c.fadeOut)}:d=${c.fadeOut}` : ''
    filters.push(`[${idx}:a]atrim=start=${c.offset || 0}:duration=${c.dur},asetpts=PTS-STARTPTS,aresample=48000,volume=${vol}${fade},adelay=${delay}|${delay}[a${k}]`)
    mix.push(`[a${k}]`)
  })
  if (mix.length) filters.push(`${mix.join('')}amix=inputs=${mix.length}:normalize=0:dropout_transition=0,apad[a]`)
  else {
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo')
    filters.push(`[${n}:a]anull[a]`)
  }
  const out = join(ensureDir(join(dir, 'film')), 'final.mp4')
  await ffmpeg([...args, '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', '-t', String(timeline.duration),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-movflags', '+faststart', `${out}.tmp.mp4`], { signal })
  const { renameSync } = await import('node:fs')
  renameSync(`${out}.tmp.mp4`, out)
  const poster = join(dir, 'film', 'poster.jpg')
  const firstPoster = scene.clips[0] && timeline.assets[scene.clips[0].media.asset]?.thumb
  if (firstPoster && existsSync(join(dir, firstPoster))) copyFileSync(join(dir, firstPoster), poster)
  else await ffmpeg(['-ss', String(Math.min(1, timeline.duration / 2)), '-i', out, '-frames:v', '1', '-q:v', '3', poster], { signal })
  return { file: 'film/final.mp4', poster: 'film/poster.jpg', duration: mediaSeconds(out) || timeline.duration, width, height, fps, version: Date.now() }
}
