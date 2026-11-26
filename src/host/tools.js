import { randomUUID } from 'node:crypto'
// 给导演（DSH 里的 agent）用的工具。每个工具在对话里都有一张 lovideo 自己画的卡片（见 src/client/cards），
// 卡片按工具结果里的作品 id 去读本机的同一份数据，所以对话卡片和管理页永远一致。
// 工具和界面按钮调的是同一组函数（docs/DSH-user-actions：一个操作，两个调用方）。
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { DEFAULT_DURATION, FILM_DURATIONS, MIN_SHOT_SEC, createWork, listWorks, requireWork, updateWork } from './works.js'
import { estimateSeconds } from './localvoice.js'
import { listMine, listStyles } from './styles.js'
import { pauseProduction, startProduction, narrationText } from './produce.js'
import { reviseFilm, setSwitches } from './edit.js'
import { openInJianying, startExport, waitExport } from './export.js'
import { saveDistilled, startDistill } from './distill.js'
import { runtimeStatus } from './runtime.js'
import { readSettings } from './settings.js'
import { modelInfo } from './llm.js'

const text = s => [{ type: 'text', text: s }]

/** 「要先登录」的工具错误带这个记号：卡片据此在原地给登录按钮，而不是把给模型的话显示给用户 */
export const LOGIN_MARK = '【需要登录】'

/* ---------- 登录后自动继续 ---------- */

// 因为没登录卡住的会话（会话 id → 导演）；网站确认登录后逐个通知它们接着做
const loginWaiters = new Map()
function waitLogin(exec) {
  const agent = exec?.agent
  if (agent && typeof agent.followup === 'function') loginWaiters.set(agent.id ?? randomUUID(), agent)
}

/** 登录成功：叫醒所有等着登录的导演，让它们自己把卡住的那一步重做一遍 */
export function notifyLogin(account, ctx) {
  for (const [sessionId, held] of loginWaiters) {
    let live
    try {
      live = ctx?.get('agents')?.get(sessionId)
    } catch {
      live = undefined
    }
    followup(live || held, `[lovideo 通知] 用户已经登录 lovideo${account?.email ? `（${account.email}）` : ''}，官方风格现在可以用了。请直接继续刚才因为没登录卡住的那一步（比如用同样的参数重新调用 lovideo_plan，或重新开拍），不要再问用户，也不用再调用 lovideo_setup。`)
  }
  loginWaiters.clear()
}

function followup(agent, msg) {
  try {
    // 和 DSH 的 createUserMessage 一样：要有 id 和 role，否则会话历史会坏
    agent.followup(Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: msg }], source: { kind: 'dsh-lovideo' } }))
  } catch {
    // 会话已经关了
  }
}
const ANY = { type: 'object', additionalProperties: true }

/** 只做最基本的校验：必填、类型、枚举；复杂的约束在函数里报错 */
function check(args, schema, at = '') {
  const errs = []
  if (schema.type === 'object') {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return [`${at || '参数'}应该是对象`]
    for (const k of schema.required || []) if (args[k] === undefined || args[k] === '') errs.push(`缺少 ${at}${k}`)
    for (const [k, v] of Object.entries(args)) {
      const p = schema.properties?.[k]
      if (!p) {
        if (schema.additionalProperties === false) errs.push(`未知参数 ${at}${k}`)
        continue
      }
      errs.push(...check(v, p, `${at}${k}.`))
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(args)) return [`${at.slice(0, -1)} 应该是数组`]
    if (schema.minItems && args.length < schema.minItems) errs.push(`${at.slice(0, -1)} 至少 ${schema.minItems} 项`)
    if (schema.maxItems && args.length > schema.maxItems) errs.push(`${at.slice(0, -1)} 最多 ${schema.maxItems} 项`)
    args.forEach((v, i) => errs.push(...check(v, schema.items, `${at.slice(0, -1)}[${i}].`)))
  } else if (schema.type === 'string') {
    if (typeof args !== 'string') errs.push(`${at.slice(0, -1)} 应该是字符串`)
    else if (schema.enum && !schema.enum.includes(args)) errs.push(`${at.slice(0, -1)} 只能是 ${schema.enum.join(' / ')}`)
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof args !== 'number' || !Number.isFinite(args)) errs.push(`${at.slice(0, -1)} 应该是数字`)
    else if (schema.enum && !schema.enum.includes(args)) errs.push(`${at.slice(0, -1)} 只能是 ${schema.enum.join(' / ')}`)
  } else if (schema.type === 'boolean' && typeof args !== 'boolean') errs.push(`${at.slice(0, -1)} 应该是 true 或 false`)
  return errs
}

function tool(def) {
  return {
    ...def,
    output: { schema: ANY, render: (args, value) => text(value.text) },
    async execute(args, exec) {
      const errs = check(args ?? {}, def.parameters)
      if (errs.length) throw new Error(errs.join('；'))
      try {
        return await def.run(args ?? {}, exec)
      } catch (err) {
        if (err?.code !== 'login_required') throw err
        // 没登录：记下这位导演，登录成功后通知它；卡片看到记号会在原地给登录按钮
        waitLogin(exec)
        throw Object.assign(new Error(`${LOGIN_MARK}${err.message.replace(LOGIN_MARK, '')}。卡片上已经给了用户登录按钮，不用再调用 lovideo_setup；用户登录后你会收到「[lovideo 通知] 用户已经登录」，到时直接重做这一步。`), { code: 'login_required' })
      }
    },
  }
}

// 插件启动时记下宿主，卡片上的操作（比如改时长）要能叫醒这部片子所在会话的导演
let hostCtx = null
export const setHostCtx = ctx => { hostCtx = ctx }

/** 给这部片子的导演发一条消息（会话不在了就什么都不做）；返回有没有发出去 */
export function askDirector(work, msg) {
  let live
  try {
    live = work.sessionId ? hostCtx?.get('agents')?.get(work.sessionId) : undefined
  } catch {
    live = undefined
  }
  const agent = live || watchers.get(work.id)
  if (!agent) return false
  followup(agent, msg)
  return true
}

// 列过推荐风格的会话（会话 id → 导演）；DSH 重启后句柄会失效，所以优先用会话当前活着的导演
const pickers = new Map()

/** 用户在推荐卡片上点了一个风格：告诉这个会话的导演用它（会话不在了返回 false） */
export function pickStyle(sessionId, s) {
  let live
  try {
    live = hostCtx?.get('agents')?.get(sessionId)
  } catch {
    live = undefined
  }
  const agent = live || pickers.get(sessionId)
  if (!agent) return false
  followup(agent, `[lovideo 通知] 用户在推荐卡片上选了风格「${s.name}」（style: ${s.slug}）。还没出分镜就用它出分镜；这个会话里已经用别的风格出过分镜的，带上那部片子的 work_id 换成这个风格重出一版，口播和片长不变。不用再问用户，出完用一句话说明。`)
  return true
}

/** 制作完成时叫醒导演，让它告诉用户（不在对话里时什么都不做） */
export const watchers = new Map()
function watch(workId, exec) {
  if (exec?.agent && typeof exec.agent.followup === 'function') watchers.set(workId, exec.agent)
}

const workLine = w => `work_id: ${w.id}`

/* ---------- 工具 ---------- */

const setup = tool({
  name: 'lovideo_setup',
  description: '检查这台电脑能不能做 lovideo 视频：模型、渲染环境（浏览器、ffmpeg）、lovideo 账号、配音设置。用户第一次做视频、或制作报环境错误时调用；结果以卡片展示，用户在卡片上点按钮准备环境和登录。',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  async run(_args, exec) {
    const env = runtimeStatus()
    const s = readSettings()
    if (!s.account) waitLogin(exec)
    const m = modelInfo()
    const lines = [
      `模型：${m ? m.label : '没有可用模型'}`,
      `渲染环境：${env.ready ? '已就绪' : `缺 ${[!env.chrome.ok && '浏览器', !env.ffmpeg.ok && 'ffmpeg'].filter(Boolean).join('、')}，需要用户在卡片上点「准备」`}`,
      `lovideo 账号：${s.account ? '已登录（平台风格可用）' : '未登录（用平台风格要先登录，注册即免费；卡片上有登录按钮，用户登录后你会收到通知）'}`,
      `配音：${{ local: '离线配音', system: '系统自带语音', none: '不配音（只出字幕）' }[s.voice.provider] || s.voice.provider}`,
      `配乐来源：${{ local: '离线配乐（没下载时导演建议的配乐会跳过）', volcengine: '火山配乐', elevenlabs: 'ElevenLabs', none: '设置里关了配乐' }[s.music.provider] || s.music.provider}`,
      `我的风格：${listMine().filter(x => !x.draft).length} 个`,
    ]
    return { text: lines.join('\n'), ready: env.ready && Boolean(m), login: Boolean(s.account) }
  },
})

const styles = tool({
  name: 'lovideo_styles',
  description: '列出可以用的视频风格（平台风格和用户自己的风格），并在对话里用卡片展示你推荐的 1 到 3 个（带真实封面）。出分镜前调用一次，按用户要讲的内容挑最合适的风格推荐。卡片上每个风格都能点选：推荐完用一句话请用户在卡片上点一个（或直接说），然后停下等；用户点了你会收到「[lovideo 通知] 用户在推荐卡片上选了风格」。',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      query: { type: 'string', description: '按名字、用途筛选，例如「产品」「科普」「节日」；不填列出全部' },
      recommend: { type: 'array', maxItems: 3, items: { type: 'string' }, description: '要在卡片里推荐的风格 slug（从列表里挑），按推荐程度排序' },
    },
  },
  async run(args, exec) {
    const { platform, mine, offline } = await listStyles('zh')
    const all = [...mine.filter(s => !s.draft), ...platform]
    const q = (args.query || '').trim()
    const hit = q ? all.filter(s => `${s.name} ${s.use || ''} ${s.description || ''} ${s.slug}`.includes(q)) : all
    const list = (hit.length ? hit : all).slice(0, 60)
    const unknown = (args.recommend || []).filter(r => !all.some(s => s.slug === r))
    if (unknown.length) throw new Error(`没有这些风格：${unknown.join('、')}`)
    const lines = list.map(s => `- ${s.slug} | ${s.name} | ${s.source === 'mine' ? '我的风格' : s.use || ''} | ${(s.aspects || ['16:9']).join(' ')}${s.gpu ? ' | 3D 绘制' : ''}${s.description ? ` | ${String(s.description).slice(0, 80)}` : ''}`)
    const note = offline ? '（现在连不上 lovideo.ai，平台风格列表用的是缓存或为空）\n' : ''
    const login = readSettings().account ? '' : '（用户还没登录 lovideo：平台风格要登录后才能用，可以先用 lovideo_setup 让用户登录）\n'
    // 卡片上点选风格时要找到这个会话的导演：会话 id 写进结果，卡片从结果里取
    const session = exec?.agent?.id ? `session_id: ${exec.agent.id}\n` : ''
    if (exec?.agent && typeof exec.agent.followup === 'function') pickers.set(exec.agent.id, exec.agent)
    return { text: `${session}${note}${login}共 ${all.length} 个风格${q ? `，匹配「${q}」的 ${hit.length} 个` : ''}：\n${lines.join('\n')}`, recommend: args.recommend || [] }
  },
})

const SCENE = {
  type: 'object', additionalProperties: false, required: ['title', 'description', 'narration'],
  properties: {
    title: { type: 'string', description: '这一镜的标题，4 到 12 个字' },
    description: { type: 'string', description: '画面里有什么、怎么动（给制作看的，具体、可画）' },
    narration: { type: 'string', description: '这一镜的口播，一两句口语；不要旁白就给空字符串' },
    seconds: { type: 'number', description: '这一镜大概几秒（15 到 60）；有口播时以实际念完的时间为准' },
  },
}

const plan = tool({
  name: 'lovideo_plan',
  description: '出分镜或改分镜（每次都给完整的分镜）。分镜以卡片展示给用户，卡片上有「确认开拍」按钮。只在用户确认（点按钮或明确说开拍）后才调用 lovideo_produce；改分镜就带上 work_id 再调用一次本工具。成片已经做好后，用户只想改某几镜（字幕、口播、重画、裁短、调顺序）时不要用本工具，用 lovideo_revise；改分镜后重新开拍时，没改动的镜头会自动沿用。',
  parameters: {
    type: 'object', additionalProperties: false, required: ['title', 'style', 'duration', 'scenes', 'voice', 'music', 'subtitles'],
    properties: {
      work_id: { type: 'string', description: '改已有作品的分镜时填；新片子不填' },
      title: { type: 'string', description: '片名' },
      style: { type: 'string', description: '风格 slug（来自 lovideo_styles）' },
      aspect: { type: 'string', enum: ['16:9', '9:16'], description: '画幅。新片默认用风格的第一个画幅；改分镜时不填就沿用原来的' },
      duration: { type: 'integer', enum: FILM_DURATIONS, description: `目标片长（秒），只能取这几档：${FILM_DURATIONS.join('、')}（10 秒到 10 分钟）。用户说了就取最近的一档，没说就 ${DEFAULT_DURATION}。这是目标不是指标：素材撑不满就做短一点，不要凑；镜头数不超过「片长 ÷ ${MIN_SHOT_SEC}」` },
      subtitles: { type: 'boolean', description: '要不要字幕（字幕就是口播原文）。有配音时一般要；用户说不要就 false' },
      voice: {
        type: 'object', additionalProperties: false, required: ['use', 'why'],
        description: '你对这部片子要不要口播配音的建议。卡片上用户可以直接改',
        properties: {
          use: { type: 'boolean', description: '要不要配音' },
          why: { type: 'string', description: '一句话理由，给用户看（15 字以内），比如「讲解片，靠口播讲清楚」' },
        },
      },
      music: {
        type: 'object', additionalProperties: false, required: ['use', 'brief', 'prompt'],
        description: '你对这部片子要不要背景配乐的建议，以及配什么样的。不建议配乐时也要写 brief 和 prompt（用户打开开关就按它生成）。卡片上用户可以直接改',
        properties: {
          use: { type: 'boolean', description: '建议配乐填 true' },
          brief: { type: 'string', description: '给用户看的一句中文：什么样的配乐、为什么（30 字以内），例如「轻快的钢琴小品，托住好奇的科普节奏」' },
          prompt: { type: 'string', description: '给配乐模型的英文描述：曲风、乐器、情绪、速度，只要纯器乐，例如「calm lo-fi piano, soft pads, warm and curious, 80 bpm, instrumental」' },
        },
      },
      scenes: { type: 'array', minItems: 1, maxItems: 20, items: SCENE },
      note: { type: 'string', description: '这一版改了什么（改分镜时填，会显示在卡片上）' },
    },
  },
  async run(args, exec) {
    const { platform, mine } = await listStyles('zh').catch(() => ({ platform: [], mine: listMine() }))
    const st = [...mine, ...platform].find(s => s.slug === args.style)
    if (!st) throw new Error(`没有风格「${args.style}」，先用 lovideo_styles 看可用的风格`)
    if (st.source === 'platform' && !readSettings().account) throw Object.assign(new Error('这是官方风格，需要先登录 lovideo（注册即免费）'), { code: 'login_required' })
    const cur = args.work_id ? requireWork(args.work_id) : null
    // 改分镜没说画幅就沿用这部片子原来的（导演按新时长、新风格重出时常常漏掉画幅）
    const keepAspect = cur?.aspect && (!st.aspects || st.aspects.includes(cur.aspect)) ? cur.aspect : null
    const aspect = args.aspect || keepAspect || (st.aspects || ['16:9'])[0]
    if (st.aspects && !st.aspects.includes(aspect)) throw new Error(`风格「${st.name}」只支持 ${st.aspects.join('、')}`)
    // 用户在分镜卡上定过的（时长、配音、配乐、字幕）以用户为准，导演这一版给的不算
    const userSet = cur?.choices || {}
    const duration = userSet.duration ?? args.duration
    const maxShots = Math.max(1, Math.floor(duration / MIN_SHOT_SEC))
    if (args.scenes.length > maxShots) throw new Error(`片长 ${duration} 秒最多 ${maxShots} 镜（每镜至少 ${MIN_SHOT_SEC} 秒，一镜里可以有好几个画面变化），把相邻的镜头合并后再出分镜`)
    const scenes = args.scenes.map((s, i) => ({ id: `shot-${i + 1}`, title: s.title, description: s.description, narration: s.narration || '', seconds: Math.max(3, Math.min(90, Number(s.seconds) || MIN_SHOT_SEC)) }))
    const est = scenes.reduce((n, s) => n + Math.max(s.seconds, s.narration ? estimateSeconds([s.narration]) + 0.9 : 0), 0)
    if (est > duration * 1.3) throw new Error(`这版分镜估计约 ${Math.round(est)} 秒，比目标片长 ${duration} 秒长太多：精简口播（中文每秒约 4.5 个字）或减少镜头后再出`)
    const pickOn = (key, suggested) => (typeof userSet[key] === 'boolean' ? userSet[key] : suggested)
    const fields = {
      title: args.title, aspect, style: { slug: st.slug, name: st.name, source: st.source, cover: st.cover || null },
      duration,
      voice: { enabled: pickOn('voice', args.voice.use), suggested: args.voice.use, why: String(args.voice.why || '').slice(0, 40) },
      music: { enabled: pickOn('music', args.music.use), suggested: args.music.use, brief: String(args.music.brief || '').slice(0, 60), mood: String(args.music.prompt || '').slice(0, 300) },
      subtitles: { enabled: pickOn('subtitles', args.subtitles) },
      sessionId: exec?.agent?.id ?? null,
    }
    let work
    if (cur) {
      if (cur.status === 'producing') throw new Error('这部片子正在制作中，先暂停或等它做完再改分镜')
      work = await updateWork(cur.id, w => {
        // 配乐描述没变时，上一版生成好的配乐留着，开拍时直接沿用
        const keepMusic = w.music?.file && w.music.mood === fields.music.mood ? { file: w.music.file, seconds: w.music.seconds, model: w.music.model, source: w.music.source } : {}
        Object.assign(w, fields)
        Object.assign(w.music, keepMusic)
        w.plan = { revision: (w.plan?.revision || 0) + 1, scenes, note: args.note || '', at: new Date().toISOString() }
        w.status = 'draft'
        return w
      })
    } else {
      work = createWork({ ...fields, plan: { revision: 1, scenes, note: '', at: new Date().toISOString() } })
    }
    // 用户在卡片上点「确认开拍」时没有工具调用，做完也要能叫醒这位导演
    watch(work.id, exec)
    const secs = Math.round(est)
    const userNotes = Object.keys(userSet).map(k => ({ duration: `时长 ${userSet.duration} 秒`, voice: userSet.voice ? '要配音' : '不配音', music: userSet.music ? '要配乐' : '不配乐', subtitles: userSet.subtitles ? '要字幕' : '不要字幕' })[k]).filter(Boolean)
    const keep = work.film ? '上一版成片还在，现在照样能看、能导出；确认开拍后，没改动的镜头直接沿用，只改字幕或改短的镜头不重画，几十秒就换成新成片。' : ''
    return {
      text: `${workLine(work)}\n分镜 v${work.plan.revision}：${scenes.length} 镜，约 ${secs} 秒，${aspect}（目标 ${duration} 秒），风格「${st.name}」，${work.voice.enabled ? '配音' : '不配音'}、${work.music.enabled ? '配乐' : '不配乐'}、${work.subtitles.enabled ? '有字幕' : '无字幕'}。${userNotes.length ? `其中「${userNotes.join('、')}」是用户在卡片上定的，已照用户的来。` : ''}用户可以在卡片上改时长和这几个开关。卡片已经展示给用户；等用户确认开拍再调用 lovideo_produce。${keep}`,
      work_id: work.id, revision: work.plan.revision,
    }
  },
})

const produce = tool({
  name: 'lovideo_produce',
  description: '开拍、暂停或继续制作。开拍后在用户电脑上后台制作（每段几十秒到几分钟），进度以卡片实时显示，用户可以继续聊天；做完会通知你。只在用户确认分镜后调用 start。',
  parameters: {
    type: 'object', additionalProperties: false, required: ['work_id'],
    properties: {
      work_id: { type: 'string' },
      action: { type: 'string', enum: ['start', 'pause', 'resume'], description: '默认 start' },
    },
  },
  async run(args, exec) {
    const w0 = requireWork(args.work_id)
    if (args.action === 'pause') {
      pauseProduction(w0.id)
      return { text: `${workLine(w0)}\n已暂停，做好的段都保留；用户说继续时用 action: resume。` }
    }
    const w = await startProduction(w0.id)
    watch(w.id, exec)
    const segs = w.plan.scenes.length
    return { text: `${workLine(w)}\n已经在用户电脑上开拍：${segs} 段，进度在卡片里实时显示。不要轮询；做完会有一条 lovideo 通知交给你，那时再告诉用户。` }
  },
})

const revise = tool({
  name: 'lovideo_revise',
  description: '修改做好的成片（用户说「第 2 镜太长」「第 3 镜字幕改成…」「把最后一镜挪到前面」「第 4 镜重画成…」「去掉配乐」「不要配音」「关掉字幕」时用）。配音、配乐、字幕的开关和卡片上的开关是同一个：关掉就不播放、导出也没有；片子没有配乐时打开配乐会按分镜里的配乐描述现做一首。裁短、挪位置、改字幕几秒就好；重画某一镜会在后台只重做那一段。更大的改动（换风格、加减镜头、改整体内容）请用 lovideo_plan 出新分镜。',
  parameters: {
    type: 'object', additionalProperties: false, required: ['work_id', 'ops'],
    properties: {
      work_id: { type: 'string' },
      ops: {
        type: 'array', minItems: 1, maxItems: 20,
        items: {
          type: 'object', additionalProperties: false, required: ['op'],
          properties: {
            op: { type: 'string', enum: ['trim', 'move', 'caption', 'subtitles', 'voice', 'music', 'redraw'] },
            scene: { type: 'integer', description: '第几镜（从 1 开始）；subtitles / voice / music 不用' },
            seconds: { type: 'number', description: 'trim：这一镜改成几秒（只能变短）' },
            to: { type: 'integer', description: 'move：挪到第几个' },
            text: { type: 'string', description: 'caption：新的字幕文字' },
            show: { type: 'boolean', description: 'subtitles / voice / music：打开还是关掉' },
            brief: { type: 'string', description: 'redraw：这一镜要怎么改' },
          },
        },
      },
    },
  },
  async run(args, exec) {
    // 开关类的操作走和卡片同一套（配音、配乐要重新拼成片）
    const sw = args.ops.filter(o => ['voice', 'music', 'subtitles'].includes(o.op))
    const rest = args.ops.filter(o => !sw.includes(o))
    const lines = []
    if (sw.length) {
      await setSwitches(args.work_id, Object.fromEntries(sw.map(o => [o.op, o.show !== false])))
      lines.push(...sw.map(o => `${o.show !== false ? '打开' : '关掉'}${{ voice: '配音', music: '配乐', subtitles: '字幕' }[o.op]}`))
      if (!rest.length) {
        const w = requireWork(args.work_id)
        const making = w.remix && w.remix.state !== 'failed'
        return { text: `${workLine(w)}\n${lines.join('；')}。${making ? '正在做配乐，做好后成片自动更新，卡片里能看到进度。' : '成片已经更新，卡片里可以直接看。'}` }
      }
    }
    const r = await reviseFilm(args.work_id, rest)
    if (r.background) watch(args.work_id, exec)
    return { text: `${workLine(r.work)}\n${[...lines, ...r.done].join('；')}。${r.background ? '正在后台重画，卡片里能看到进度；做完会通知你。' : '成片已经更新，卡片里可以直接看。'}` }
  },
})

const exportTool = tool({
  name: 'lovideo_export',
  description: '把成片导出到用户电脑：MP4（可选清晰度、是否把字幕烧进画面）和/或剪映工程文件夹。用户说「在剪映里打开」「导到剪映」「用剪映精剪」时用 open_in_jianying：直接导入这台电脑的剪映草稿列表并打开剪映。只要有过成片就能导出：分镜改了还没重新开拍时，导出的是上一版成片。',
  parameters: {
    type: 'object', additionalProperties: false, required: ['work_id'],
    properties: {
      work_id: { type: 'string' },
      format: { type: 'string', enum: ['mp4', 'jianying', 'both'], description: '默认 mp4' },
      quality: { type: 'string', enum: ['720', '1080', '2160'], description: 'MP4 清晰度，默认 1080' },
      burn_subtitles: { type: 'boolean', description: '把字幕烧进画面，默认是' },
      open_in_jianying: { type: 'boolean', description: '在这台电脑的剪映专业版里打开（导入草稿并打开剪映）；给了它就不导出文件，format 等参数不用填' },
    },
  },
  timeoutMs: 900_000,
  async run(args) {
    if (args.open_in_jianying) {
      // 剪映正开着时只导入、不替用户关掉剪映；要重开由用户在卡片上点「在剪映中打开」确认
      const r = await openInJianying(args.work_id, { restart: false })
      return { text: `${workLine(requireWork(args.work_id))}\n${r.launched ? `已在剪映中打开：草稿「${r.name}」在剪映草稿列表最上面。` : `已导入剪映草稿「${r.name}」。剪映正开着，关掉重开就能在草稿列表里看到；也可以在卡片上点「在剪映中打开」，我帮用户重开。`}` }
    }
    await startExport(args.work_id, { format: args.format || 'mp4', quality: args.quality || '1080', burn: args.burn_subtitles !== false })
    const w = await waitExport(args.work_id)
    if (w.exporting?.state !== 'done') throw new Error(w.exporting?.error || '导出没完成')
    const lines = w.exporting.results.map(r => (r.kind === 'mp4' ? `MP4（${r.quality}${r.burned ? '，字幕已烧进画面' : ''}）：${r.path}` : (r.imported ? `剪映工程：已放进剪映草稿列表「${r.imported.name}」，打开剪映就能看到（文件夹：${r.path}）` : `剪映工程：${r.path}（退出剪映后双击里面的 ${r.installer} 导入）`)))
    return { text: `${workLine(w)}\n导出完成：\n${lines.join('\n')}` }
  },
})

const works = tool({
  name: 'lovideo_works',
  description: '列出用户最近的 lovideo 作品（标题、状态、work_id），用户说「改一下上次那部」时用来找作品。',
  parameters: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', description: '最多几部，默认 10' } } },
  async run(args) {
    const list = listWorks().filter(w => !w.hidden).slice(0, Math.min(30, args.limit || 10))
    const STATUS = { draft: '分镜待确认', producing: '制作中', paused: '已暂停', done: '已完成', failed: '失败' }
    return { text: list.length ? list.map(w => `- ${w.id} | ${w.title} | ${STATUS[w.status] || w.status}${w.status !== 'done' && w.film ? '（上一版成片可看可导出）' : ''} | ${w.style?.name || ''} | ${w.plan?.scenes?.length || 0} 镜 | ${w.updatedAt.slice(0, 16).replace('T', ' ')}`).join('\n') : '还没有作品。' }
  },
})

const distill = tool({
  name: 'lovideo_distill',
  description: '把用户给的参考视频（或图片）蒸馏成用户自己的风格：在这台电脑上看参考、写画法、出横竖两条样片（几分钟），以卡片展示；用户满意后用 action: save 保存进「我的风格」。参考文件用用户拖进对话的附件的绝对路径。',
  parameters: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: ['start', 'save'] },
      reference: { type: 'string', description: 'start：参考视频或图片的绝对路径' },
      name: { type: 'string', description: 'start：风格名字' },
      brief: { type: 'string', description: 'start：用户想保留的特点' },
      slug: { type: 'string', description: 'save：要保存的风格（start 返回的 slug）' },
    },
  },
  async run(args) {
    if (args.action === 'save') {
      const s = saveDistilled(args.slug)
      return { text: `style_slug: ${s.slug}\n已保存进「我的风格」：${s.name}。以后出分镜时可以直接用 style: ${s.slug}。` }
    }
    if (!args.reference || !isAbsolute(args.reference) || !existsSync(args.reference)) throw new Error('reference 要给参考文件的绝对路径（用户拖进对话的附件）')
    const s = await startDistill({ reference: args.reference, name: args.name, brief: args.brief })
    return { text: `style_slug: ${s.slug}\n开始蒸馏「${s.name}」：看参考 → 写画法 → 出横竖样片，进度在卡片里。完成后卡片上会显示样片，用户点「保存」或让你调用 action: save。` }
  },
})

export const TOOLS = [setup, styles, plan, produce, revise, exportTool, works, distill]

/** 作品从制作中变成完成或失败时，通知调用过工具的导演 */
export function notifyDone(prev, work, ctx) {
  if (!work || !prev || prev.status !== 'producing' || work.status === 'producing') return
  // 先找这部片子所在会话当前活着的导演（DSH 重启后手里的句柄会失效），找不到再用开拍时记下的
  let live
  try {
    live = work.sessionId ? ctx?.get('agents')?.get(work.sessionId) : undefined
  } catch {
    live = undefined
  }
  const agent = live || watchers.get(work.id)
  watchers.delete(work.id)
  if (!agent) return
  const secs = work.film?.duration ? Math.round(work.film.duration) : null
  const needLogin = work.status === 'failed' && /登录/.test(work.job?.error || '')
  // 因为没登录做不了：登录成功后同一位导演会再收到通知，接着重新开拍
  if (needLogin) loginWaiters.set(agent.id ?? randomUUID(), agent)
  const msg = work.status === 'done'
    ? `[lovideo 通知] ${workLine(work)}《${work.title}》做好了${secs ? `，${secs} 秒` : ''}。卡片里已经可以播放。请用一两句话告诉用户：可以直接在卡片里看，想改哪里直接说（裁短、换顺序、改字幕、重画某一镜），或者导出 MP4 / 剪映工程。`
    : needLogin
      ? `[lovideo 通知] ${workLine(work)}《${work.title}》没能开始：这个官方风格要先登录 lovideo（注册即免费）。请调用 lovideo_setup 给用户登录卡片，用一句话请用户登录；用户登录后你会收到通知，到时调用 lovideo_produce（action: start）重新开拍。`
      : work.status === 'failed'
        ? `[lovideo 通知] ${workLine(work)}《${work.title}》制作失败：${work.job?.error || '原因不明'}。请告诉用户原因，并给出下一步（例如重试、换风格或检查渲染环境）。`
        : null
  if (msg) followup(agent, msg)
}

export { narrationText }
