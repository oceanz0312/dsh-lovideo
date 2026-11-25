// 制作：确认分镜以后，在这台电脑上把片子做出来。
//   1. 配音：每段口播念一遍，段长跟着口播走（和网站一样）
//   2. 准备工程：写一份和网站沙箱同格式的 job.json，跑风格包自带的 scripts/setup.py
//   3. 逐段制作：模型（用户在 DSH 选的）按风格 SKILL.md 写这一段的画面代码，本机渲染；
//      渲染失败就把报错交回模型改，最多 3 次；还不行就用准备脚本的草稿兜底
//   4. 拼成片：按时间线拼接、混口播和配乐，出封面和时间线
// 关掉 DSH 或点暂停会停在当前段，已经做好的段保留，继续时接着做。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { PLUGIN_ROOT, ensureDir, isInside } from './paths.js'
import { readSettings } from './settings.js'
import { notify } from './notices.js'
import { getWork, requireWork, updateWork, workDir } from './works.js'
import { resolveStyle } from './styles.js'
import { speak } from './tts.js'
import { callModel, extractFiles } from './llm.js'
import { fill, parseRenderCommand, renderCommand, renderPage, startSite } from './render.js'
import { ensureFonts, findPython, fontsDir, mediaSeconds, run, runtimeStatus } from './runtime.js'
import { chooseModel, estimateSeconds } from './localvoice.js'
import { assembleFilm, buildTimeline } from './assemble.js'

export const ASPECTS = { '16:9': { width: 1920, height: 1080 }, '9:16': { width: 1080, height: 1920 } }
const MAX_ATTEMPTS = 3
const controllers = new Map()

export const isRunning = id => controllers.has(id)

const lang = work => (/[\u4e00-\u9fff]/.test(JSON.stringify(work.plan?.scenes || [])) ? 'zh' : 'en')

/* ---------- 状态 ---------- */

function segmentsOf(work) {
  return work.job?.segments || []
}

function progressOf(job) {
  if (!job?.segments?.length) return 0
  const total = job.segments.reduce((n, s) => n + (s.frames || 1), 0)
  const done = job.segments.reduce((n, s) => n + (s.state === 'done' ? s.frames || 1 : Math.min(s.rendered || 0, s.frames || 1) * 0.9), 0)
  const base = job.state === 'voicing' ? 0.03 : job.state === 'preparing' ? 0.06 : 0.08
  return job.state === 'done' ? 1 : Math.min(0.97, base + (done / total) * 0.85)
}

async function setJob(id, patch) {
  return updateWork(id, w => {
    w.job = { ...(w.job || {}), ...patch }
    w.job.progress = progressOf(w.job)
    return w
  })
}

async function setSegment(id, segId, patch) {
  return updateWork(id, w => {
    const seg = w.job.segments.find(s => s.id === segId)
    if (seg) Object.assign(seg, patch)
    w.job.progress = progressOf(w.job)
    return w
  })
}

/** 插件重启时，上次没做完的片子标成暂停（用户点继续再接着做） */
export async function markInterrupted(works) {
  for (const w of works) {
    if (w.status === 'producing' && !controllers.has(w.id)) {
      await updateWork(w.id, x => {
        x.status = 'paused'
        if (x.job) x.job.state = 'paused'
        return x
      })
    }
  }
}

/* ---------- 入口 ---------- */

/**
 * 开拍（或继续）。立刻返回，制作在后台进行。
 * @param {string} id 作品 id
 * @param {{redraw?: Array<{scene:string, brief?:string}>}} [opts]
 */
export async function startProduction(id, opts = {}) {
  const work = requireWork(id)
  if (!work.plan?.scenes?.length) throw Object.assign(new Error('还没有分镜，先让导演出分镜'), { status: 400 })
  if (controllers.has(id)) return work
  const env = runtimeStatus()
  if (!env.ready) throw Object.assign(new Error('本机渲染环境还没准备好，先在 lovideo 里点「准备渲染环境」'), { status: 409, code: 'runtime_missing' })
  const ctl = new AbortController()
  controllers.set(id, ctl)
  const fresh = !work.job || work.job.planRevision !== work.plan.revision
  await updateWork(id, w => {
    w.status = 'producing'
    if (fresh) {
      // 新一版分镜：上一版做好的镜头先记下来，内容没变的直接沿用，只重做改了的
      const carry = previousSegments(w)
      w.job = { state: 'voicing', planRevision: w.plan.revision, startedAt: new Date().toISOString(), error: null, segments: [], carry, progress: 0, modelCalls: 0 }
      w.film = null
      w.timeline = null
    } else {
      w.job.state = w.job.state === 'done' ? 'drawing' : w.job.state === 'paused' || w.job.state === 'failed' ? 'drawing' : w.job.state
      w.job.error = null
      for (const r of opts.redraw || []) {
        const seg = w.job.segments.find(s => s.id === r.scene)
        if (seg) Object.assign(seg, { state: 'wait', brief: r.brief || '', rendered: 0, error: null, redraws: (seg.redraws || 0) + 1 })
      }
    }
    return w
  })
  // run_ 自己接住所有错误并写进作品；这里只做清理，也不留没人接的 promise
  const done = () => controllers.delete(id)
  run_(id, ctl).then(done, done)
  return requireWork(id)
}

/** 插件卸载（重启、热重载、停用）时调用：正在做的片子都暂停，之后点「继续」接着做 */
export function pauseAllProductions() {
  for (const id of [...controllers.keys()]) pauseProduction(id)
}

export function pauseProduction(id) {
  const ctl = controllers.get(id)
  if (!ctl) return false
  ctl.abort()
  return true
}

async function run_(id, ctl) {
  const signal = ctl.signal
  try {
    let work = requireWork(id)
    const settings = readSettings()
    const style = await resolveStyle(work.style.slug, { lang: lang(work) })
    const spec = parseRenderCommand(style.skillMd)
    if (!spec) throw new Error(`风格「${style.name || style.slug}」的 SKILL.md 里没有渲染命令，本机画不了`)
    const size = ASPECTS[work.aspect] || ASPECTS['16:9']
    const fps = Number(style.fps) || work.fps || 30

    // 1. 配音（只在新开拍时做；继续时沿用）
    if (!work.job.segments.length) {
      await setJob(id, { state: 'voicing' })
      const voiceSettings = await pickVoice(settings, work, id)
      const segs = []
      let start = 0
      const carry = new Map((work.job.carry || []).map(c => [c.id, c]))
      for (const [i, scene] of work.plan.scenes.entries()) {
        if (signal.aborted) throw abortError()
        const text = narrationText(scene)
        const sig = sceneSig(scene)
        const old = carry.get(scene.id)
        const hasVideo = Boolean(old?.file && existsSync(join(workDir(id), old.file)))
        const sameText = Boolean(old) && old.narration === text
        let voiceSec = 0
        let voiceFile = join('voice', `${scene.id}.wav`)
        const wantVoice = text && work.voice?.enabled !== false && settings.voice.provider !== 'none'
        if (wantVoice && sameText && old.voice && existsSync(join(workDir(id), old.voice.file))) {
          // 口播没变：沿用原来的配音
          voiceSec = old.voice.seconds
          voiceFile = old.voice.file
        } else if (wantVoice) {
          voiceSec = await speak(text, join(workDir(id), voiceFile), voiceSettings, signal)
        }
        const voice = voiceSec ? { file: voiceFile, seconds: voiceSec } : null
        const planned = Math.max(3, Number(scene.seconds) || 6)
        const minFrames = Math.round(Math.max(planned, voiceSec ? voiceSec + 0.9 : 0) * fps)
        // 画面没变：时长没改就保持原长，改短了就裁；放不下新配音或要更长才重画
        if (hasVideo && pictureSig(old) === pictureSig(scene)) {
          const plannedChanged = (old.planned ?? Math.round(old.frames / fps)) !== planned
          const frames = plannedChanged ? minFrames : Math.max(old.frames, minFrames)
          if (frames <= old.frames) {
            segs.push({ ...old, idx: i + 1, title: scene.title, sig, narration: text, planned, frames, start, voice, state: 'done', carried: true, revoiced: !sameText, brief: '', history: [] })
            start += frames
            continue
          }
        }
        segs.push({ id: scene.id, idx: i + 1, title: scene.title, sig, narration: text, planned, frames: minFrames, start, voice, state: 'wait', attempts: 0, rendered: 0, changed: Boolean(old) })
        start += minFrames
      }
      await setJob(id, { segments: segs, carry: undefined, fps, width: size.width, height: size.height })
      work = requireWork(id)
    }

    // 2. 准备工程（平台字体只在第一次用到时下载）
    await setJob(id, { state: 'preparing' })
    await ensureFonts()
    const proj = ensureDir(join(workDir(id), 'proj'))
    writeJobJson(work, fps, size)
    const pending = segmentsOf(work).filter(s => s.state !== 'done')
    const setup = join(style.dir, 'scripts', 'setup.py')
    if (existsSync(setup) && pending.length) {
      const py = findPython()
      if (py) {
        const units = pending.map(s => s.id).join(',')
        const r = await run(py, ['-I', setup, '--job', join(workDir(id), 'job.json'), '--project', proj, '--unit', units], { cwd: style.dir, signal, timeoutMs: 600_000 })
        if (r.code !== 0) await setJob(id, { setupNote: (r.stderr || r.stdout).trim().slice(-400) })
      }
    }
    // 没有准备脚本、用通用画布引擎的风格（蒸馏出来的「我的风格」）：放一份能直接渲染的草稿
    const baseDraft = existsSync(join(style.dir, 'assets', 'draft-scene.js'))
      ? join(style.dir, 'assets', 'draft-scene.js')
      : style.skillMd.includes('/engine/canvas.js') ? join(PLUGIN_ROOT, 'vendor', 'base-style', 'assets', 'draft-scene.js') : null
    if (baseDraft) {
      for (const sg of pending) {
        const file = join(ensureDir(join(proj, sg.id)), 'scene.js')
        if (!existsSync(file)) writeFileSync(file, readFileSync(baseDraft, 'utf8').replace("q.get('title') || ''", JSON.stringify(sg.title || '')))
      }
    }
    // 准备脚本写的草稿留一份，模型改坏了可以退回
    for (const s of pending) snapshotDraft(proj, s.id)

    // 3. 逐段制作
    await setJob(id, { state: 'drawing' })
    const site = await startSite(mountsOf(spec, { skill: style.dir, project: proj }))
    try {
      await pool(pending, Math.max(1, Math.min(4, settings.parallel || 2)), seg =>
        makeSegment({ id, seg, style, spec, size, fps, proj, site, signal }))
    } finally {
      site.server.closeAllConnections?.()
      site.server.close()
    }
    work = requireWork(id)
    const failed = segmentsOf(work).filter(s => s.state !== 'done')
    if (failed.length) throw new Error(`第 ${failed.map(s => s.idx).join('、')} 段没做出来：${failed[0].error || '原因不明'}`)

    // 4. 拼成片
    await setJob(id, { state: 'assembling' })
    work = requireWork(id)
    const timeline = work.timeline && work.timeline.planRevision === work.plan.revision ? mergeTimeline(work.timeline, work) : buildTimeline(work)
    const film = await assembleFilm(id, timeline, { signal })
    await updateWork(id, w => {
      w.timeline = timeline
      w.film = film
      w.status = 'done'
      w.job.state = 'done'
      w.job.endedAt = new Date().toISOString()
      w.job.progress = 1
      return w
    })
    notify({ kind: 'film-done', tone: 'success', text: `《${requireWork(id).title}》做好了`, workId: id, sessionId: requireWork(id).sessionId ?? null })
  } catch (err) {
    const aborted = err.name === 'AbortError' || signal.aborted
    await updateWork(id, w => {
      w.status = aborted ? 'paused' : 'failed'
      if (w.job) {
        w.job.state = aborted ? 'paused' : 'failed'
        w.job.error = aborted ? null : err.message
      }
      return w
    }).catch(() => {})
    if (!aborted) notify({ kind: 'film-failed', tone: 'warning', text: `《${getWork(id)?.title || '作品'}》没做成，可以重试`, workId: id, sessionId: getWork(id)?.sessionId ?? null })
  }
}

/**
 * 本机配音：按这部片子的口播长度，在装好的模型里挑一个 3 分钟内能配完的（越好越优先）。
 * 都来不及、或者还没装好时，这部片子先用系统语音，原因写在 job.voiceNote 里给卡片显示。
 */
async function pickVoice(settings, work, id) {
  const v = settings.voice
  if (v.provider !== 'local') return v
  const sec = estimateSeconds(work.plan.scenes.map(narrationText))
  const choice = chooseModel(settings.local.models, sec)
  if (choice) {
    await setJob(id, { voiceModel: choice.id, voiceNote: null })
    return { ...v, localModel: choice.id }
  }
  const note = Object.keys(settings.local.models).length
    ? `本机配音模型配这部片子（约 ${Math.round(sec)} 秒口播）预计要超过 3 分钟，这次先用系统语音`
    : '还没有装好本机配音模型，这次先用系统语音'
  await setJob(id, { voiceModel: null, voiceNote: note })
  return { ...v, provider: 'system' }
}

/** 一镜的内容指纹：标题、画面、口播都没变才算同一镜 */
export function sceneSig(scene) {
  return JSON.stringify([scene.title || '', scene.description || '', narrationText(scene)])
}

/** 只看画面（标题和画面描述），口播不算 */
function pictureSig(scene) {
  const sig = scene.sig ? JSON.parse(scene.sig) : sceneSig(scene) && JSON.parse(sceneSig(scene))
  return JSON.stringify(sig.slice(0, 2))
}

/** 上一版做好的镜头（带内容指纹）；老作品没存指纹时从 job.json 里补出来 */
function previousSegments(work) {
  const segs = (work.job?.segments || []).filter(s => s.state === 'done' && s.file)
  if (!segs.length) return []
  let prev = null
  try {
    prev = JSON.parse(readFileSync(join(workDir(work.id), 'job.json'), 'utf8'))
  } catch {
    prev = null
  }
  const byId = new Map((prev?.segments || []).map(s => [s.id, s]))
  return segs.map(s => {
    if (s.sig) return s
    const p = byId.get(s.id)
    if (!p) return s
    const narration = (p.narration?.sentences || []).map(x => x.text).join('')
    return { ...s, narration, sig: JSON.stringify([p.title || '', p.description || '', narration]) }
  })
}

const abortError = () => Object.assign(new Error('已暂停'), { name: 'AbortError' })

export function narrationText(scene) {
  const n = scene.narration
  return (Array.isArray(n) ? n.join('') : String(n || '')).trim()
}

/** 和网站沙箱同格式的 job.json（风格包的 setup.py 读它） */
function writeJobJson(work, fps, size) {
  const segs = segmentsOf(work)
  const scenes = new Map(work.plan.scenes.map(s => [s.id, s]))
  const job = {
    jobId: work.id,
    kind: 'generate',
    fps,
    width: size.width,
    height: size.height,
    confirmed: {
      inputs: (work.plan.inputs || []).map((x, i) => ({ key: x.key || `k${i + 1}`, label: x.label || '', value: x.value })),
      audio: null,
      params: { aspect: work.aspect, durationSec: segs.reduce((n, s) => n + s.frames, 0) / fps, fps, width: size.width, height: size.height, subtitles: true },
    },
    segments: segs.map(s => {
      const sc = scenes.get(s.id) || {}
      return {
        idx: s.idx, id: s.id, title: sc.title || '', description: sc.description || '', copy: sc.copy || {}, media: [],
        narration: narrationText(sc) ? { sentences: [{ id: `${s.id}-n1`, text: narrationText(sc), unitSeconds: [0.3, 0.3 + (s.voice?.seconds || 0)] }] } : null,
        label: sc.title || '', frames: s.frames, start: s.start,
      }
    }),
  }
  writeFileSync(join(workDir(work.id), 'job.json'), JSON.stringify(job, null, 1))
}

function mountsOf(spec, vars) {
  const mounts = spec.mounts.length
    ? spec.mounts.map(m => {
        const at = m.indexOf('=')
        const prefix = m.slice(0, at)
        let dir = fill(m.slice(at + 1), vars)
        // 网站沙箱的平台字体目录 /work/fonts，本机放在插件的 runtime/fonts
        if (dir === '/work/fonts') dir = fontsDir()
        return { prefix: prefix.endsWith('/') ? prefix : `${prefix}/`, dir }
      })
    : [{ prefix: '/skill/', dir: vars.skill }, { prefix: '/project/', dir: vars.project }]
  return mounts
}

/* ---------- 一段 ---------- */

const TEXT_EXT = /\.(js|mjs|json|html|css|txt|md|svg|py|glsl|frag|vert)$/i

function listFiles(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== '.draft') listFiles(p, base, out)
    } else out.push({ rel: relative(base, p).split('\\').join('/'), size: statSync(p).size, path: p })
  }
  return out
}

function snapshotDraft(proj, segId) {
  const dir = join(proj, segId)
  const draft = join(dir, '.draft')
  if (!existsSync(dir) || existsSync(draft)) return
  mkdirSync(draft, { recursive: true })
  for (const f of listFiles(dir)) if (TEXT_EXT.test(f.rel) && f.size < 200_000) {
    mkdirSync(dirname(join(draft, f.rel)), { recursive: true })
    copyFileSync(f.path, join(draft, f.rel))
  }
}

function restoreDraft(proj, segId) {
  const dir = join(proj, segId)
  const draft = join(dir, '.draft')
  if (!existsSync(draft)) return false
  for (const f of listFiles(draft, draft)) copyFileSync(f.path, join(dir, f.rel))
  return true
}

/** 风格包里给模型参考的代码（引擎、页面），按大小截断 */
function styleReference(styleDir) {
  const files = listFiles(join(styleDir, 'assets')).filter(f => /\.(js|mjs|html)$/.test(f.rel) && f.size < 60_000)
  let budget = 60_000
  const parts = []
  for (const f of files.sort((a, b) => a.size - b.size)) {
    if (f.size > budget) continue
    budget -= f.size
    parts.push(`--- assets/${f.rel} ---\n${readFileSync(f.path, 'utf8')}`)
  }
  return parts.join('\n\n')
}

const SYSTEM = `你是 lovideo 的单段制作程序：按一个视频风格 Skill 的规则，为成片里的一段写出画面代码。
- 严格遵守 SKILL.md 的风格规则和制作说明。SKILL.md 里的 setup、render、check、submit 等命令由平台替你执行，你只负责写文件。
- 只写这一段自己的工程目录（路径相对段目录，例如 scene.js），不写别的目录，不改风格包。
- 按段内时间作画：段长、帧率、画布尺寸见下面的「这一段」。旁白和字幕由平台另加，不要把旁白全文画进画面。
- 画面要跟着旁白的意思走，有明显的动作和变化，不要整段只有底色。
- 不要提问，不要解释，不要用 Markdown 代码块。只输出要写入的文件，每个文件写完整内容，格式严格如下（示例）：
=== FILE: scene.js ===
import * as K from '/engine/collage.js'
……完整代码……
=== END ===`

async function makeSegment({ id, seg, style, spec, size, fps, proj, site, signal }) {
  const work = requireWork(id)
  const scenes = work.plan.scenes
  const scene = scenes.find(s => s.id === seg.id) || {}
  const segDir = ensureDir(join(proj, seg.id))
  const vars = {
    unit: seg.id, unitIndex: seg.idx, seconds: (seg.frames / fps).toFixed(3), fps, width: size.width, height: size.height,
    skill: style.dir, project: proj, start: seg.start, count: seg.frames, film_seconds: (segmentsOf(work).reduce((n, s) => n + s.frames, 0) / fps).toFixed(3),
    unit_dir: join(proj, '.render', seg.id), frames_dir: join(proj, '.render', seg.id, 'frames'), video: '',
  }
  const context = {
    film: { title: work.title, aspect: work.aspect, width: size.width, height: size.height, fps, segments: scenes.length, language: lang(work) },
    segment: {
      id: seg.id, idx: seg.idx, title: scene.title, description: scene.description, narration: narrationText(scene),
      seconds: Number(vars.seconds), frames: seg.frames, isLast: seg.idx === scenes.length,
      previous: scenes[seg.idx - 2]?.title || null, next: scenes[seg.idx]?.title || null,
    },
    redraw: seg.brief ? `用户要求重画这一段：${seg.brief}` : undefined,
  }
  let lastError = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS + 1; attempt++) {
    if (signal.aborted) throw abortError()
    const fallback = attempt > MAX_ATTEMPTS
    await setSegment(id, seg.id, { state: 'draw', attempts: attempt, error: null, rendered: 0 })
    if (fallback) {
      if (!restoreDraft(proj, seg.id)) break
    } else {
      const current = listFiles(segDir).filter(f => TEXT_EXT.test(f.rel) && f.size < 60_000)
        .map(f => `--- ${f.rel} ---\n${readFileSync(f.path, 'utf8')}`).join('\n\n')
      const user = [
        `# 风格 Skill（SKILL.md，风格包目录 ${style.dir}）\n\n${style.skillMd}`,
        `# 风格包里的页面和引擎（只读参考）\n\n${styleReference(style.dir) || '（无）'}`,
        `# 这一段\n\n${JSON.stringify(context, null, 1)}`,
        `# 段目录 ${seg.id}/ 现有文件\n\n${current || '（空）'}`,
        lastError ? `# 上次写的文件渲染失败\n\n${lastError}\n\n请改好后重新输出完整文件。` : '',
      ].filter(Boolean).join('\n\n')
      let text
      try {
        ;({ text } = await callModel({ system: SYSTEM, user, maxTokens: 32000, signal, light: true }))
      } catch (err) {
        if (signal.aborted) throw abortError()
        lastError = `模型调用失败：${err.message}`
        await updateWork(id, w => ((w.job.modelCalls = (w.job.modelCalls || 0) + 1), w))
        continue
      }
      await updateWork(id, w => ((w.job.modelCalls = (w.job.modelCalls || 0) + 1), w))
      try {
        writeFileSync(join(ensureDir(join(proj, '.log')), `${seg.id}-${attempt}.txt`), text)
      } catch {
        // 存档失败不影响制作
      }
      let files = extractFiles(text)
      if (!files.length) {
        // 模型没按格式写、但只给了一个代码块时，当作这一段的 scene.js
        const blocks = [...text.matchAll(/```(?:js|javascript|mjs)?\s*\n([\s\S]*?)```/g)].map(m => m[1])
        if (blocks.length === 1 && existsSync(join(segDir, 'scene.js'))) files = [{ path: 'scene.js', content: blocks[0] }]
      }
      if (!files.length) {
        lastError = '没有按格式输出任何文件。每个文件必须用一行 === FILE: <路径> === 开头、一行 === END === 结尾，中间是完整内容'
        await updateWork(id, w => (((w.job.segments.find(x => x.id === seg.id) || {}).history ||= []).push({ attempt, error: lastError }), w))
        continue
      }
      for (const f of files) {
        const target = normalize(join(segDir, f.path.replace(/^\.?\/*/, '').replace(new RegExp(`^${seg.id}/`), '')))
        if (!isInside(segDir, target)) continue
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, f.content)
      }
    }
    await setSegment(id, seg.id, { state: 'render' })
    const out = join(ensureDir(join(workDir(id), 'segs')), `${seg.id}.mp4`)
    const poster = join(workDir(id), 'segs', `${seg.id}.jpg`)
    const film = { unit: seg.id, fps, width: size.width, height: size.height, start: seg.start, frames: seg.frames, clock: spec.clock === 'unit' ? 'unit' : 'film' }
    try {
      let last = 0
      const onFrame = n => {
        if (n - last >= 15 || n === seg.frames) {
          last = n
          setSegment(id, seg.id, { rendered: n }).catch(() => {})
        }
      }
      if (spec.page) await renderPage({ origin: site.origin, entry: fill(spec.page, vars), film, out, poster, signal, onFrame })
      else await renderCommand({ command: spec.command, checkExit: spec.checkExit, vars, film, out, poster, signal })
      await setSegment(id, seg.id, { state: 'done', rendered: seg.frames, file: `segs/${seg.id}.mp4`, poster: `segs/${seg.id}.jpg`, error: null, fallback })
      return
    } catch (err) {
      if (signal.aborted || err.name === 'AbortError') throw abortError()
      lastError = err.message.slice(0, 1500)
      rmSync(out, { force: true })
      await updateWork(id, w => (((w.job.segments.find(x => x.id === seg.id) || {}).history ||= []).push({ attempt, error: lastError.slice(0, 400) }), w))
    }
  }
  await setSegment(id, seg.id, { state: 'failed', error: lastError })
}

async function pool(items, size, fn) {
  const queue = [...items]
  const errors = []
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) {
      const it = queue.shift()
      try {
        await fn(it)
      } catch (err) {
        if (err.name === 'AbortError') {
          queue.length = 0
          errors.push(err)
          return
        }
        errors.push(err)
      }
    }
  }))
  const abort = errors.find(e => e.name === 'AbortError')
  if (abort) throw abort
}

/** 继续或重画后：保留用户在时间线上的修改，只更新重做过的段 */
function mergeTimeline(timeline, work) {
  const fresh = buildTimeline(work)
  const scene = timeline.tracks.find(t => t.type === 'scene')
  if (!scene) return fresh
  const segs = new Map(segmentsOf(work).map(s => [s.id, s]))
  // 保留用户的顺序、裁剪和字幕改动；段长变长时以新段为准
  for (const clip of scene.clips) {
    const s = segs.get(clip.sceneId)
    if (s) clip.dur = Math.min(clip.dur, s.frames / work.job.fps)
  }
  timeline.version = (timeline.version || 1) + 1
  timeline.assets = { ...fresh.assets, ...timeline.assets }
  return timeline
}

export { mediaSeconds }
