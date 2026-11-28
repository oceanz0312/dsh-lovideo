// 一段的制作会话，和 lovideo 网站沙箱的段 agent 一样（workers/sandbox/job/run-job.sh、pi-segment.ts）：
//   - 第一条消息：各段共用的说明 + 风格 SKILL.md 全文 + 本段说明（制作上下文、准备脚本写好的草稿）
//   - 工具 draw：一次调用写文件（整文件或精确替换）并由平台渲染、检查、交段；失败把所有报错原样交回，
//     同一个会话接着改。交上去会话就结束。工具 read 只给少数非看不可的文件。
//   - 交段前：第一次完整渲染前看一次检查图（模型能看图时），渲染后量一次画面跟不跟着旁白动；各退回一次
//   - 页面风格渲染时有平台围栏：画面必须正好铺满成片尺寸（render.js 的 checkFill）
// 路径和网站沙箱一致（/work/proj/<段>/、/work/.agents/skills/<风格>/），风格的 SKILL.md 原样可用，平台换成本机目录。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { chat, canSeeImages, toolResult, userMessage } from './llm.js'
import { fill, renderCommand, renderPage } from './render.js'
import { motionGray, motionSteps, reviewReport, reviewSheet, sheetFrames, sheetFromImages, sheetFromVideo, stillReport, stillSentences } from './quality.js'

// 一个会话最多调用几次工具（防止无限循环）、最多渲染几次；一段最多开几个会话
const TOOL_CALL_LIMIT = 12
const SEGMENT_RENDERS = 5
const SESSIONS = 2
// 草稿只贴源文件内容；数据文件只列路径
const DRAFT_EXT = /\.(js|mjs|ts|tsx|jsx|html|css|md|txt|py|svg|ya?ml)$/i
const DRAFT_MAX = 16_000
const READ_MAX = 60_000
const OUTPUT_TAIL = 4000

const WORK = '/work'
const PROJ = '/work/proj'

const SYSTEM = 'You make one segment of a short film. The first message holds the task, the style Skill and your segment brief; follow it.'

const DRAW = {
  name: 'draw',
  description: 'Write your segment\'s files and have the platform render, check and submit the segment, in one call. files: whole files; edits: exact replacements in existing files (old must match exactly once). Returns every error, or that the segment is submitted.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      files: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } } },
      edits: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'old', 'new'], properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } } } },
    },
  },
}

const READ = {
  name: 'read',
  description: 'Read one text file from the installed Skill or the project (only for the rare fact you cannot work without; the SKILL.md and your draft are already in your message).',
  parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } },
}

const r3 = n => Math.round(n * 1000) / 1000
const paused = () => Object.assign(new Error('已暂停'), { name: 'AbortError' })

/** 各段共用的说明（逐字相同，排在第一条消息最前面，模型服务能缓存它） */
export function sharedPrompt({ style, segments, fps, size }) {
  const skillDir = `${WORK}/.agents/skills/${style.slug}`
  const list = segments.map(s => `${s.id} ${s.frames} frames`).join(', ')
  return `You make a short film in an installed style, one segment per agent.

Segments (the approved storyboard, in order, at ${fps} fps, ${size.width}x${size.height}): ${list}. Frame numbers run on the whole film's clock (the first segment starts at frame 0, each next one right after the previous one).
- The production context in your segment brief is freshly prepared for this attempt: complete confirmed.inputs/params (false, 0 and empty strings are real values), the film outline, only your segment's full copy and laid sentence/word times, current submission/remake state, project and Skill. No need to read ${WORK}/job.json or other segments' detailed data. The installed SKILL.md is in full in the <skill_md> block of these instructions: do not read it again; consult the files it references only as needed. Never alter confirmed content or the approved segment count and lengths.
- The platform runs the Skill's render command from SKILL.md for your segment (with --unit set to it), encodes and submits it; you never run commands. The platform stitches the film (with the voice-over and the subtitles) once every segment is submitted; you do not stitch it.
- Your tool for making the segment is \`draw\`: in ONE call it writes your files (\`files\`: whole files; \`edits\`: exact replacements) and has the segment rendered, then returns either every error or the submitted segment. \`read\` is only for the rare fact you cannot work without.
- Before a segment is first drawn in full, the platform may draw only a contact sheet of it (frames spread across the segment) and a reviewer checks that once. If the reviewer finds defects, nothing is rendered or submitted and the defects come back as errors: fix only those with one \`draw\` call. A fix must not break what was fine: the finished render may be checked once more.
- A page must fill exactly the film's frame (film.width x film.height from ready(film)); a page that draws at a fixed size and overflows or leaves empty bands is refused.

The installed style Skill ${style.slug}: its SKILL.md (${skillDir}/SKILL.md) follows in full. Do not read it again; resolve its relative paths against ${skillDir}. Where it tells you to run its setup, read the draft, write the scene and then render, the platform has already run the setup and put the draft in your message: go straight to one draw call.
<skill_md>
${style.skillMd}
</skill_md>`
}

/** 本段说明：分工、做法、画面跟着旁白动、写得紧凑 */
function segmentNote(segId, agents, resume, size) {
  const W = size.width
  const H = size.height
  return `You make segment ${segId} and nothing else. Every other segment is made at the same time by another agent (${agents} agents at once). Do not make, overwrite or delete another segment or what was written for it: write only inside ${PROJ}/${segId}/.
How to work: everything you need is in this message (the task, the whole SKILL.md, your segment's data and its prepared draft). Do not explore, do not re-read them, do not keep notes. In your FIRST reply call \`draw\` once with the complete, final scene for the whole segment (every beat of the narration timed on its words). If the render reports errors, fix all of them in one \`draw\` call with \`edits\`. The session ends by itself once the segment is submitted; say nothing more.
The picture moves with the voice: give every voice-over sentence its own visible action timed on its words (something enters, moves, transforms, is highlighted, or the camera moves) and keep what is on screen alive between actions; no sentence plays over a still picture, even where the Skill lets a layout hold. The platform measures the rendered segment and sends it back if the picture barely changes while the voice speaks. Text needs time to be read before its shot or the segment ends, so text that belongs to words spoken in the last three seconds comes in before those words, and the words themselves get a motion or a highlight. When the page says a text has too little time, bring it in earlier or shorten it, and check every other text for the same problem before you draw again: the page stops at the first problem it finds. Never fix a problem by deleting an element.
What gets a segment sent back most often, so get it right the first time (where SKILL.md says otherwise, SKILL.md wins):
- Components first. Build the segment from the ready-made components and layouts SKILL.md lists (whole layouts, rows, panels, labels); draw with the raw canvas or helpers of your own only for what SKILL.md has no component for. A short scene made of the Skill's components beats a long hand-drawn one.
- No fixed positions. Every position and size comes from the frame the page gives you (its width and height, the Skill's layout helpers, its safe area), never from numbers that only fit one aspect. This film is ${W}x${H}; text and key graphics stay inside the frame and above the subtitle band at every moment, also while the camera moves or zooms.
- Time on the words. Start each action on the word it belongs to: use the Skill's word-time helper where it has one, otherwise the sentence and word times in your production context. Do not guess seconds.
- Reading time. A text must stay fully on screen at least 1.5 s plus 0.22 s for each Chinese character (0.07 s for each other character) before it leaves or its shot ends: a 6-character label needs about 2.8 s, a 12-character line about 4.2 s. So few and short texts, brought in early; never a text that appears in the last two seconds of its shot.
- The approved on-screen texts. \`copy\` in your production context lists the texts the user approved for this segment: show each of them, spelled exactly, and take numbers from \`confirmed.inputs\` exactly; add no long text of your own.
- One action per sentence. Each voice-over sentence gets one clear visible action; few, large elements, not many small ones. Whatever the description names must be recognisable at a glance: simple, deliberate shapes.
- Start from the prepared draft and keep its structure: replace its sample content with this segment's through \`edits\`; do not rewrite the file from scratch unless the draft cannot hold the scene.
Write compactly: no comments, no text before or after the call, nothing restated from the brief; draw repeated elements with a loop or a small helper. Compact code must still draw every beat in full.${resume ? `\n\nResume: an earlier attempt at this segment did not finish. ${PROJ}/${segId}/ holds what it left; reuse what is there.` : ''}`
}

/** 本段的制作上下文（网站 production_context.py 的 build_context，只给这一段的细节） */
function productionContext({ work, segments, seg, fps, size, narration, styleSlug, redraw }) {
  const scene = work.plan.scenes.find(s => s.id === seg.id) || {}
  const offset = seg.start / fps
  const state = s => ({ status: s.state === 'done' ? (s.carried ? 'carried' : 'submitted') : 'missing', remake: redraw.has(s.id) })
  const lines = (narration?.sentences || []).filter(x => x.segment === seg.id)
  const total = segments.reduce((n, s) => n + s.frames, 0)
  const params = { aspect: work.aspect, fps, durationSec: r3(total / fps), subtitles: work.subtitles?.enabled !== false }
  if (work.plan.direction) params.style = work.plan.direction
  return {
    confirmed: {
      inputs: (work.plan.inputs || []).map((x, i) => ({ key: x.key || `k${i + 1}`, label: x.label || '', value: x.value })),
      params,
      title: work.title,
    },
    film: { fps, width: size.width, height: size.height, frames: total, durationSeconds: params.durationSec },
    paths: { project: PROJ, skill: `${WORK}/.agents/skills/${styleSlug}` },
    outline: segments.map(s => ({ id: s.id, idx: s.idx, title: s.title, start: s.start, frames: s.frames, ...state(s) })),
    segments: [{
      id: seg.id, idx: seg.idx, start: seg.start, frames: seg.frames, title: scene.title || '', description: scene.description || '', label: scene.title || '', copy: scene.copy || {},
      ...state(seg),
      ...(seg.brief ? { redrawRequest: seg.brief } : {}),
      narration: lines.map(x => ({
        id: x.id, n: x.n, text: x.text,
        filmSeconds: { start: x.start, end: x.end },
        unitSeconds: { start: r3(x.start - offset), end: r3(x.end - offset) },
        words: x.words.map(w => `${w.w}@${r3(w.start - offset)}`).join(' '),
      })),
    }],
    narration: narration ? { path: `${WORK}/narration.json`, clocks: { filmSeconds: 'seconds from film start', unitSeconds: 'filmSeconds minus segment start/fps', words: "each sentence's words as word@start, in unitSeconds" } } : null,
  }
}

const sha = file => {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** 准备脚本给这一段写的东西：源文件草稿贴内容，数据文件只列路径（风格包原样拷进来的不算草稿） */
function preparedText({ proj, segId, styleDir, resume }) {
  const files = walk(join(proj, segId))
  if (!files.length) return ''
  const known = new Set(walk(styleDir).filter(f => statSync(f).size <= 2_000_000).map(sha))
  const drafts = []
  const data = []
  for (const f of files) {
    const size = statSync(f).size
    if (DRAFT_EXT.test(f) && size <= DRAFT_MAX && !known.has(sha(f))) drafts.push(f)
    else data.push(f)
  }
  const virt = f => `${PROJ}/${relative(proj, f).split(sep).join('/')}`
  const parts = [resume
    ? 'The platform already ran the Skill\'s scripts/setup.py for this segment; do not run it again. A previous attempt may have changed these files.'
    : 'The platform already ran the Skill\'s setup for this segment; do not run it again.']
  if (data.length) parts.push(`It also wrote (data and copied assets; do not edit, read only if you must): ${data.map(virt).join(', ')}`)
  for (const f of drafts) {
    const ext = (f.split('.').pop() || 'text').toLowerCase()
    parts.push(`${resume ? 'Current' : 'Draft it wrote, as it is now,'} ${virt(f)}:\n\`\`\`${ext}\n${readFileSync(f, 'utf8').trimEnd()}\n\`\`\``)
  }
  return parts.join('\n\n')
}

/** 这一段目录里唯一的源文件（会话里的写法）；没有或不止一个返回 null */
function onlySource(proj, segId) {
  const files = walk(join(proj, segId)).filter(f => /\.(js|mjs|ts|tsx|jsx|html|css|py|svg)$/i.test(f) && statSync(f).size <= DRAFT_MAX * 4)
  return files.length === 1 ? `${PROJ}/${relative(proj, files[0]).split(sep).join('/')}` : null
}

/**
 * 把会话里的路径（网站沙箱的写法）换成本机路径。
 * 写：只能写本段目录；相对路径按本段目录算。读：工程、风格包、job.json、narration.json。
 */
export function placeFor({ proj, segId, styleDir, styleSlug, workDir }) {
  const segDir = join(proj, segId)
  const skillPrefix = `${WORK}/.agents/skills/${styleSlug}`
  const toLocal = p => {
    const path = String(p || '').trim().replace(/\\/g, '/')
    if (path === `${WORK}/job.json`) return join(workDir, 'job.json')
    if (path === `${WORK}/narration.json`) return join(workDir, 'narration.json')
    if (path === skillPrefix || path.startsWith(`${skillPrefix}/`)) return resolve(styleDir, `.${path.slice(skillPrefix.length)}`)
    if (path === PROJ || path.startsWith(`${PROJ}/`)) return resolve(proj, `.${path.slice(PROJ.length)}`)
    if (path.startsWith('/')) return null
    if (path.startsWith('proj/')) return resolve(proj, path.slice(5))
    return resolve(segDir, path.startsWith(`${segId}/`) ? path.slice(segId.length + 1) : path)
  }
  const inside = (root, full) => full === root || full.startsWith(root + sep)
  return {
    write(p) {
      const full = toLocal(p)
      if (!full || !inside(segDir, full) || full === segDir) throw new Error(`${p}: you may write only inside ${PROJ}/${segId}/`)
      return full
    },
    read(p) {
      const full = toLocal(p)
      if (!full || !(inside(proj, full) || inside(styleDir, full) || full === join(workDir, 'job.json') || full === join(workDir, 'narration.json'))) {
        throw new Error(`${p}: not readable (only the project, the installed Skill, ${WORK}/job.json and ${WORK}/narration.json)`)
      }
      return full
    },
  }
}

/** 工具参数：模型给的是 JSON 字符串，坏了就原样报回 */
function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  try {
    return JSON.parse(raw || '{}')
  } catch (e) {
    throw new Error(`the tool arguments are not valid JSON (${e.message}); call the tool again with valid JSON`)
  }
}

/**
 * 写文件：先全部核对，有一处不对就一个都不写。
 * fallbackPath：漏写 path 时用它（这一段唯一的源文件，或这个会话上次写的那个文件）。
 * 小模型改文件时常常只给 old/new、漏掉 path，为这个退回一轮不值得（V4.1 Flash 实测 10 部片子里 4 次）。
 * @returns {string|null} 这次写的最后一个文件的路径（会话里的写法），下次漏写 path 时用
 */
export function applyDraw(args, place, fallbackPath = null) {
  const problems = []
  const next = new Map()
  let lastPath = null
  const pathOf = (x, what, i) => {
    const p = typeof x?.path === 'string' && x.path.trim() ? x.path : fallbackPath
    if (!p) throw new Error(`${what}[${i}] has no "path": give the file's path`)
    lastPath = p
    return p
  }
  for (const [i, f] of (args.files || []).entries()) {
    try {
      next.set(place.write(pathOf(f, 'files', i)), String(f.content ?? ''))
    } catch (e) {
      problems.push(e.message)
    }
  }
  for (const [i, e] of (args.edits || []).entries()) {
    try {
      e.path = pathOf(e, 'edits', i)
      const full = place.write(e.path)
      const current = next.get(full) ?? (existsSync(full) ? readFileSync(full, 'utf8') : null)
      if (current === null) {
        problems.push(`${e.path}: no such file`)
        continue
      }
      const hits = e.old ? current.split(e.old).length - 1 : 0
      if (hits !== 1) {
        problems.push(`${e.path}: "old" must match exactly once (found ${hits}): ${String(e.old || '').slice(0, 80)}`)
        continue
      }
      next.set(full, current.replace(e.old, () => e.new))
    } catch (err) {
      problems.push(err.message)
    }
  }
  if (!next.size && !problems.length) problems.push('draw needs files or edits')
  if (problems.length) throw new Error(`Nothing was written or rendered. Fix every problem and call draw again:\n${problems.join('\n')}`)
  for (const [full, content] of next) {
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return lastPath
}

const tail = text => (text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text)

/**
 * 做一段：开会话，模型 draw，平台渲染、检查、交段。
 * @returns {Promise<{ok:boolean, last?:string}>}
 */
export async function makeSegmentSession(o) {
  const { work, seg, segments, style, spec, size, fps, proj, site, signal, workDir, narration, shared, agents, redraw, update, log, countCall } = o
  const place = placeFor({ proj, segId: seg.id, styleDir: style.dir, styleSlug: style.slug, workDir })
  const vars = {
    unit: seg.id, unitIndex: seg.idx, seconds: (seg.frames / fps).toFixed(3), fps, width: size.width, height: size.height,
    skill: style.dir, project: proj, start: seg.start, count: seg.frames, film_seconds: (segments.reduce((n, s) => n + s.frames, 0) / fps).toFixed(3),
    unit_dir: join(proj, '.render', seg.id), frames_dir: join(proj, '.render', seg.id, 'frames'), video: '',
  }
  const film = { unit: seg.id, fps, width: size.width, height: size.height, start: seg.start, frames: seg.frames, clock: spec.clock === 'unit' ? 'unit' : 'film' }
  const out = join(workDir, 'segs', `${seg.id}.mp4`)
  const poster = join(workDir, 'segs', `${seg.id}.jpg`)
  mkdirSync(dirname(out), { recursive: true })
  const logDir = join(proj, '.log')
  mkdirSync(logDir, { recursive: true })
  const lines = (narration?.sentences || []).filter(x => x.segment === seg.id)
  const scene = work.plan.scenes.find(s => s.id === seg.id) || seg
  const seeImages = await canSeeImages(signal)
  // 检查图和画面变化各最多退回两次。网站各只查一次（Opus 改完很少改坏）；小模型被退回后常把别处改坏：
  // V4.1 Flash 实测一段被「画面不动」退回后改成了前 10 秒空白纸面，第二次不查就直接出片了。
  // 第二次看检查图只在上次看过之后又被这两道检查退回过（画面确实改了）时才看，看的是渲染好的视频。
  const left = { review: seeImages ? 2 : 0, motion: lines.length ? 2 : 0 }
  let reviewed = false
  let changedSinceReview = false
  let attempts = seg.attempts || 0
  let last = null

  const review = async sheet => {
    left.review--
    reviewed = true
    changedSinceReview = false
    try {
      return await reviewSheet(scene, sheet, signal)
    } catch (e) {
      if (signal.aborted) throw paused()
      await log({ note: `看检查图没成功，跳过这一步：${e.message}`.slice(0, 300) })
      return ''
    } finally {
      await countCall()
    }
  }

  /** draw 之后：渲染、检查、交段 */
  const submit = async () => {
    const picked = sheetFrames(seg.frames, fps)
    const rejectReview = notes => {
      changedSinceReview = true
      return { ok: false, text: reviewReport(seg.id, picked.map(n => n + 1), notes) }
    }
    if (left.review > 0 && !reviewed && spec.page) {
      await update({ state: 'check', error: null })
      const shots = await renderPage({ origin: site.origin, entry: fill(spec.page, vars), film, pick: picked, signal })
      const notes = await review(await sheetFromImages(shots, signal))
      if (notes) return rejectReview(notes)
    }
    await update({ state: 'render', rendered: 0 })
    let lastTick = 0
    const onFrame = n => {
      if (n - lastTick >= 15 || n === seg.frames) {
        lastTick = n
        update({ rendered: n }).catch(() => {})
      }
    }
    if (spec.page) await renderPage({ origin: site.origin, entry: fill(spec.page, vars), film, out, poster, signal, onFrame })
    else await renderCommand({ command: spec.command, checkExit: spec.checkExit, vars, film, out, poster, signal })
    // 先量画面变化（不花模型调用），再看检查图
    if (left.motion > 0) {
      try {
        const { gray, frameBytes } = await motionGray(out, size.width, size.height, signal)
        const still = stillSentences(motionSteps(gray, frameBytes), lines, seg.start / fps)
        if (still.length) {
          left.motion--
          changedSinceReview = true
          rmSync(out, { force: true })
          return { ok: false, text: stillReport(seg.id, still) }
        }
      } catch (e) {
        if (signal.aborted) throw paused()
        await log({ note: `画面变化没量成，照常交段：${e.message}`.slice(0, 300) })
      }
    }
    // 段命令渲染的风格渲染完才看得到画面；页面风格在被退回、画面改过之后再看一次渲染好的视频
    if (left.review > 0 && (!reviewed || changedSinceReview)) {
      await update({ state: 'check' })
      const notes = await review(await sheetFromVideo(out, picked, signal))
      if (notes) {
        rmSync(out, { force: true })
        return rejectReview(notes)
      }
    }
    await update({ state: 'done', rendered: seg.frames, file: `segs/${seg.id}.mp4`, poster: `segs/${seg.id}.jpg`, error: null })
    return { ok: true, text: `Segment ${seg.id} is submitted.` }
  }

  for (let session = 1; session <= SESSIONS; session++) {
    const resume = session > 1 || attempts > 0
    const brief = [
      segmentNote(seg.id, agents, resume, size),
      `Production context (task data, prepared for this attempt):\n${JSON.stringify(productionContext({ work, segments, seg, fps, size, narration, styleSlug: style.slug, redraw }), null, 1)}`,
      preparedText({ proj, segId: seg.id, styleDir: style.dir, resume }),
      seg.brief ? `The user asked to redraw this segment: ${seg.brief}` : '',
    ].filter(Boolean).join('\n\n')
    const messages = [userMessage([{ type: 'text', text: shared }, { type: 'text', text: brief }])]
    let calls = 0
    let renders = 0
    let nudged = 0
    let lastWritten = null
    while (calls < TOOL_CALL_LIMIT && renders < SEGMENT_RENDERS) {
      if (signal.aborted) throw paused()
      attempts++
      await update({ state: 'draw', attempts, error: null })
      let reply
      try {
        reply = await chat({ system: SYSTEM, messages, tools: [DRAW, READ], maxTokens: 64000, light: 'mid', signal })
      } catch (e) {
        if (signal.aborted) throw paused()
        last = `模型调用失败：${e.message}`
        await log({ attempt: attempts, error: last.slice(0, 400) })
        break
      } finally {
        await countCall()
      }
      messages.push(reply.message)
      try {
        writeFileSync(join(logDir, `${seg.id}-${session}-${attempts}.json`), JSON.stringify({ text: reply.text, toolCalls: reply.toolCalls, finish: reply.finish }, null, 1))
      } catch {
        // 存档失败不影响制作
      }
      if (!reply.toolCalls.length) {
        // 没调用工具：提醒一次，再不调就换一个新会话
        last = reply.finish === 'max-tokens' ? '模型一次回复写到了长度上限，没写完 draw 调用' : '模型没有调用 draw'
        await log({ attempt: attempts, error: last })
        if (nudged++ >= 1) break
        messages.push(userMessage(reply.finish === 'max-tokens'
          ? 'Your reply hit the output limit before the draw call was complete. Call draw now, and write more compactly (loops and small helpers, no comments).'
          : 'Call draw now with your complete scene. Say nothing else.'))
        continue
      }
      let submitted = false
      for (const call of reply.toolCalls) {
        calls++
        if (submitted) {
          messages.push(toolResult(call.id, 'Not run: the segment is already submitted.'))
          continue
        }
        try {
          const args = parseArgs(call.arguments)
          if (call.name === 'read') {
            const text = readFileSync(place.read(args.path), 'utf8')
            messages.push(toolResult(call.id, text.length > READ_MAX ? `${text.slice(0, READ_MAX)}\n…(cut at ${READ_MAX} characters)` : text))
            continue
          }
          if (call.name !== 'draw') throw new Error(`no tool named ${call.name}; use draw or read`)
          lastWritten = applyDraw(args, place, lastWritten || onlySource(proj, seg.id)) || lastWritten
          renders++
          const r = await submit()
          if (r.ok) {
            submitted = true
            messages.push(toolResult(call.id, r.text))
            continue
          }
          last = r.text
          await log({ attempt: attempts, error: r.text.slice(0, 400) })
          messages.push(toolResult(call.id, `${r.text}${renders >= SEGMENT_RENDERS ? '\nNo render runs are left in this session.' : ''}`, true))
        } catch (e) {
          if (signal.aborted || e.name === 'AbortError') throw paused()
          last = String(e.message)
          await log({ attempt: attempts, error: last.slice(0, 400) })
          const more = renders >= SEGMENT_RENDERS ? 'No render runs are left in this session.' : 'Fix every problem above in one go and call draw again. A check stops at the first problem it finds: look for the same problem in every other element and fix those too.'
          messages.push(toolResult(call.id, `${tail(last)}\nSegment ${seg.id} is not submitted. ${more}`, true))
        }
      }
      if (submitted) return { ok: true }
    }
  }
  await update({ state: 'failed', error: last })
  return { ok: false, last }
}
