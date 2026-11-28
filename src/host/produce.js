// 制作：确认分镜以后，在这台电脑上把片子做出来。
//   1. 配音：每段口播逐句念、量时长，按网站的留白和停顿铺成段的口播轨，段长跟着口播走（和网站一样）
//      段长定了就在后台生成配乐（要配乐时），和画面同时进行，拼成片前等它做完
//   2. 准备工程：写和网站沙箱同格式的 job.json、narration.json，跑风格包自带的 scripts/setup.py
//   3. 逐段制作：每段一个制作会话（segment.js，和网站的段 agent 一样）：模型（用户在 DSH 选的）用 draw 写画面，
//      平台渲染、看检查图、量画面跟不跟旁白动、核对铺满画面，有问题交回同一个会话改，交上去就结束
//   4. 拼成片：按时间线拼接、混口播和配乐，出封面和时间线
// 关掉 DSH 或点暂停会停在当前段，已经做好的段保留，继续时接着做。
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_ROOT, ensureDir } from './paths.js'
import { MAX_PARALLEL, readSettings, voiceConfig } from './settings.js'
import { notify } from './notices.js'
import { getWork, requireWork, updateWork, workDir } from './works.js'
import { resolveStyle } from './styles.js'
import { speak } from './tts.js'
import { makeSegmentSession, sharedPrompt } from './segment.js'
import { TAIL, sentencesOf, voiceSegment, writeNarrationJson } from './narration.js'
import { fill, parseRenderCommand, renderCommand, renderPage, startSite } from './render.js'
import { ensureFonts, findPython, fontsDir, mediaSeconds, run, runtimeStatus } from './runtime.js'
import { MODELS, activeModel, chooseModel, estimateSeconds, hardware, meetsMinimum } from './localvoice.js'
import { assembleFilm, buildTimeline, syncSwitches } from './assemble.js'
import { MUSIC_NAMES, generateMusic } from './music.js'
import { filmLang, voicePickOf, withMusicSource } from './filmsound.js'
import { musicReady } from './localvoice.js'
import { busyElsewhereError, ownedElsewhere, producerRecord } from './lock.js'

export const ASPECTS = { '16:9': { width: 1920, height: 1080 }, '9:16': { width: 1080, height: 1920 } }
const controllers = new Map()

export const isRunning = id => controllers.has(id)

const lang = filmLang

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

/** 正在另一个还开着的 DSH 窗口（另一个进程）里做 */
export const busyElsewhere = work => work?.status === 'producing' && !controllers.has(work.id) && ownedElsewhere(work.producer)

/**
 * 插件重启时，上次没做完的片子标成暂停（用户点继续再接着做）。
 * 桌面版和网页版会同时开着：另一个还活着的窗口正在做的不碰，只处理做它的进程已经不在了的。
 */
export async function markInterrupted(works) {
  for (const w of works) {
    if (w.status !== 'producing' || controllers.has(w.id)) continue
    // 在锁里按最新的 work.json 再判断一次：另一个窗口可能刚刚开拍
    await updateWork(w.id, x => {
      if (x.status !== 'producing' || controllers.has(x.id) || ownedElsewhere(x.producer)) return false
      x.status = 'paused'
      if (x.job) x.job.state = 'paused'
      x.producer = null
      return x
    }).catch(() => {})
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
  if (busyElsewhere(work)) throw busyElsewhereError()
  const env = runtimeStatus()
  if (!env.ready) throw Object.assign(new Error('本机渲染环境还没准备好，先在 lovideo 里点「准备渲染环境」'), { status: 409, code: 'runtime_missing' })
  const ctl = new AbortController()
  controllers.set(id, ctl)
  const fresh = !work.job || work.job.planRevision !== work.plan.revision
  await updateWork(id, w => {
    // 在锁里按最新的再看一次：两个窗口同时点开拍，只有先进来的那个做
    if (w.status === 'producing' && ownedElsewhere(w.producer)) throw busyElsewhereError()
    w.status = 'producing'
    // 记下谁在做：别的窗口启动时据此判断这部片子是不是还有人在做
    w.producer = producerRecord()
    if (fresh) {
      // 新一版分镜：上一版做好的镜头先记下来，内容没变的直接沿用，只重做改了的。
      // 换了风格或画幅，上一版的镜头一个都不能用
      const look = lookOf(w)
      const carry = w.job?.look === look ? previousSegments(w) : []
      w.job = { state: 'voicing', planRevision: w.plan.revision, look, startedAt: new Date().toISOString(), error: null, segments: [], carry, progress: 0, modelCalls: 0 }
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
  }).catch(err => {
    controllers.delete(id)
    throw err
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
  // 别的窗口在做的，这里停不了它，明说让用户去那个窗口里点
  if (!ctl && busyElsewhere(getWork(id))) throw busyElsewhereError()
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
        const texts = sentencesOf(scene)
        const sig = sceneSig(scene)
        const old = carry.get(scene.id)
        const hasVideo = Boolean(old?.file && existsSync(join(workDir(id), old.file)))
        const sameText = Boolean(old) && old.narration === text
        let voice = null
        const wantVoice = texts.length && work.voice?.enabled !== false && settings.voice.provider !== 'none'
        if (wantVoice && sameText && old.voice?.sentences?.length && existsSync(join(workDir(id), old.voice.file))) {
          // 口播没变：沿用原来的配音
          voice = old.voice
        } else if (wantVoice) {
          voice = await voiceSegment({ segId: scene.id, texts, workDir: workDir(id), speak: (t, out, sig) => speak(t, out, voiceSettings, sig), signal })
        }
        // 以内容为准：有口播就按口播念完的时间（网站的 narrationFrames：段首留白 + 各句 + 句间停顿 + 段尾留白），
        // 不再按分镜秒数拉长画面；没口播才用分镜秒数
        const planned = Math.max(3, Number(scene.seconds) || 6)
        const minFrames = Math.ceil((voice ? voice.seconds + TAIL : planned) * fps)
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
      // 要重画的段从干净的目录开始：上一版（可能是别的风格）留下的代码和草稿备份不能再用，
      // 否则准备脚本不重写草稿、兜底时退回的也是旧草稿，模型写坏的文件一直留着
      for (const sg of segs) if (sg.state !== 'done') rmSync(join(workDir(id), 'proj', sg.id), { recursive: true, force: true })
      await setJob(id, { segments: segs, carry: undefined, fps, width: size.width, height: size.height })
      work = requireWork(id)
    }

    // 配乐和画面同时做；makeMusic 自己接住所有错误（配乐没做成不影响出片）
    const musicTask = makeMusic(id, settings, signal)

    // 2. 准备工程（平台字体只在第一次用到时下载）
    await setJob(id, { state: 'preparing' })
    await ensureFonts()
    const proj = ensureDir(join(workDir(id), 'proj'))
    const narration = writeNarrationJson(workDir(id), segmentsOf(work), fps)
    writeJobJson(work, fps, size, Boolean(narration))
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

    // 3. 逐段制作
    await setJob(id, { state: 'drawing' })
    const site = await startSite(mountsOf(spec, { skill: style.dir, project: proj }))
    try {
      const agents = Math.max(1, Math.min(MAX_PARALLEL, settings.parallel || 4, pending.length))
      const segments = segmentsOf(work)
      const shared = sharedPrompt({ style, segments, fps, size })
      const redraw = new Set(pending.filter(s => s.redraws).map(s => s.id))
      await pool(pending, agents, seg => makeSegmentSession({
        work, seg, segments, style, spec, size, fps, proj, site, signal, workDir: workDir(id), narration, shared, agents, redraw,
        update: patch => setSegment(id, seg.id, patch),
        log: entry => updateWork(id, w => (((w.job.segments.find(x => x.id === seg.id) || {}).history ||= []).push(entry), w)),
        countCall: () => updateWork(id, w => ((w.job.modelCalls = (w.job.modelCalls || 0) + 1), w)),
      }))
    } finally {
      site.server.closeAllConnections?.()
      site.server.close()
    }
    work = requireWork(id)
    const failed = segmentsOf(work).filter(s => s.state !== 'done')
    // 宁可停下让用户重试，也不拿不相干的画面凑数
    if (failed.length) throw new Error(`第 ${failed.map(s => s.idx).join('、')} 镜改了几轮都没通过检查，点「重试」会只重画这几镜（最后一次的问题：${String(failed[0].error || '原因不明').slice(0, 300)}）`)

    // 4. 拼成片
    await musicTask
    if (signal.aborted) throw abortError()
    await setJob(id, { state: 'assembling' })
    work = requireWork(id)
    const timeline = work.timeline && work.timeline.planRevision === work.plan.revision ? mergeTimeline(work.timeline, work) : buildTimeline(work)
    const film = await assembleFilm(id, timeline, { signal })
    await updateWork(id, w => {
      w.timeline = timeline
      w.film = film
      w.status = 'done'
      w.producer = null
      w.job.state = 'done'
      w.job.endedAt = new Date().toISOString()
      w.job.progress = 1
      return w
    })
    notify({ kind: 'film-done', tone: 'success', text: `《${requireWork(id).title}》做好了`, title: requireWork(id).title, workId: id, sessionId: requireWork(id).sessionId ?? null })
  } catch (err) {
    const aborted = err.name === 'AbortError' || signal.aborted
    await updateWork(id, w => {
      w.status = aborted ? 'paused' : 'failed'
      w.producer = null
      if (w.job) {
        w.job.state = aborted ? 'paused' : 'failed'
        w.job.error = aborted ? null : err.message
      }
      return w
    }).catch(() => {})
    if (!aborted) notify({ kind: 'film-failed', tone: 'warning', text: `《${getWork(id)?.title || '作品'}》没做成，可以重试`, title: getWork(id)?.title || null, workId: id, sessionId: getWork(id)?.sessionId ?? null })
  }
}

/**
 * 本机配音：先用用户选的模型；这部片子 3 分钟内配不完，就换装好的里面来得及的（越好越优先），原因写进 job.voiceNote。
 * 都来不及、或者还没装好时，这部片子先用系统语音。
 */
async function pickVoice(settings, work, id) {
  // 分镜卡上给这部片子换过声音：用它（设置里换了配音服务就不算数，用新服务的默认声音）
  const pick = voicePickOf(work, settings)
  const base = voiceConfig(settings)
  const v = pick && base.provider !== 'local' ? { ...base, voice: pick.id } : base
  if (v.provider !== 'local') return v
  // 配置低于门槛（比如内存不够了、磁盘满了）：不用本机模型
  const min = meetsMinimum(hardware())
  if (!min.ok) {
    await setJob(id, { voiceModel: null, voiceNote: `这台电脑配置偏低（${min.reason}），这次用系统自带语音`, voiceNoteCode: 'low-spec' })
    return { ...v, provider: 'system' }
  }
  const sec = estimateSeconds(work.plan.scenes.map(narrationText))
  const preferred = activeModel(settings)
  const choice = chooseModel(settings.local.models, sec, preferred)
  if (choice) {
    const name = mid => MODELS.find(m => m.id === mid)?.name || mid
    const note = choice.degraded
      ? `${name(preferred)} 配这部片子（约 ${Math.round(sec)} 秒口播）预计要超过 3 分钟，这次换成更快的 ${name(choice.id)}`
      : null
    await setJob(id, { voiceModel: choice.id, voiceNote: note, voiceNoteCode: note ? 'degraded' : null })
    // 换过的声音属于某个模型：这次换成了更快的模型就用那个模型自己的声音
    return { ...v, localModel: choice.id, localVoices: pick?.model === choice.id ? { [pick.lang]: pick.id } : undefined }
  }
  const installed = Object.keys(settings.local.models).length > 0
  const note = installed
    ? `离线配音配这部片子（约 ${Math.round(sec)} 秒口播）预计要超过 3 分钟，这次先用系统语音`
    : '还没有下载离线配音，这次先用系统语音'
  await setJob(id, { voiceModel: null, voiceNote: note, voiceNoteCode: installed ? 'too-slow' : 'not-installed' })
  return { ...v, provider: 'system' }
}

/**
 * 配乐：按成片长度生成一首，写进 work.music.file；进度和没配上的原因写在 job.music 里给卡片显示。
 * 不抛错：配乐没做成就不加配乐，片子照样出。
 */
async function makeMusic(id, settings, signal) {
  const note = (state, text, code = null) => setJob(id, { music: { state, note: text, code } })
  try {
    const work = requireWork(id)
    if (!work.music?.enabled) return await setJob(id, { music: null })
    const fps = work.job.fps || 30
    const total = segmentsOf(work).reduce((n, sg) => n + sg.frames, 0) / fps
    if (work.music.file && existsSync(join(workDir(id), work.music.file))) return await note('done', null)
    // 配乐来源：分镜卡上给这部片子选过就用它，否则用设置里的
    settings = withMusicSource(settings, work)
    const p = settings.music.provider
    if (p === 'local') {
      const ready = musicReady(total)
      if (!ready.ok) return await note('skipped', ready.reason, ready.code)
    }
    await note('making', null)
    const file = join('music', 'bgm.wav')
    ensureDir(join(workDir(id), 'music'))
    const r = await generateMusic({ brief: work.music.brief, mood: work.music.mood || work.music.brief, seconds: total, out: join(workDir(id), file), signal, settings })
    await updateWork(id, w => {
      w.music = { ...w.music, file, seconds: r.seconds, model: r.model, source: p }
      w.job.music = { state: 'done', note: null, code: null }
      return w
    })
  } catch (err) {
    if (err.name === 'AbortError' || signal.aborted) return
    await note('skipped', `配乐没做成（${MUSIC_NAMES[settings.music.provider] || settings.music.provider}）：${err.message}`.slice(0, 200), 'failed').catch(() => {})
  }
}

/** 一镜的内容指纹：标题、画面、口播都没变才算同一镜 */
export function sceneSig(scene) {
  return JSON.stringify([scene.title || '', scene.description || '', narrationText(scene)])
}

/** 画面的「样子」：风格和画幅。换了其中一个，做好的镜头都要重画 */
const lookOf = work => `${work.style?.slug || ''}|${work.aspect || ''}`

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

/** 和网站沙箱同格式的 job.json（风格包的 setup.py 读它；有口播时它再读旁边的 narration.json） */
function writeJobJson(work, fps, size, hasNarration) {
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
      params: { aspect: work.aspect, durationSec: segs.reduce((n, s) => n + s.frames, 0) / fps, fps, width: size.width, height: size.height, subtitles: true, ...(work.plan.direction ? { style: work.plan.direction } : {}) },
    },
    narration: hasNarration ? { path: 'narration.json' } : null,
    segments: segs.map(s => {
      const sc = scenes.get(s.id) || {}
      return {
        idx: s.idx, id: s.id, title: sc.title || '', description: sc.description || '', copy: sc.copy || {}, media: [],
        narration: s.voice?.sentences?.length ? { sentences: s.voice.sentences.map(l => ({ id: l.id, text: l.text, unitSeconds: [l.start, l.end] })) } : null,
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
  // 这一轮新做了配乐（或原来没有配乐轨）：用新的配乐轨
  const bgm = fresh.tracks.find(t => t.role === 'bgm')
  timeline.tracks = timeline.tracks.filter(t => t.role !== 'bgm')
  if (bgm) timeline.tracks.push(bgm)
  return syncSwitches(timeline, work)
}

export { mediaSeconds }
