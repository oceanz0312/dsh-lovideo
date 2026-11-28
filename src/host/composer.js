// 输入框里的开局条件：「lovideo 导演」模式的空白会话里，输入框多了风格（含画幅）和片长两个选项。
// 页面每改一次就按会话存一份，同时记成下次打开的默认值；用户发出第一句话时，
// 在这一步的消息后面附一段说明交给导演，导演照着出分镜，不再问画幅和片长。
// 风格默认是「导演推荐」（slug 为 null）：导演看过全部风格后按内容推荐；用户在输入框里点了风格才照用户的来。
// 配音、配乐、字幕不在这里选：导演出分镜时建议，用户在分镜卡上改。
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { dataDir, ensureDir } from './paths.js'
import { readJson, updateJson } from './json-file.js'

/** 输入框里能选的片长：10 秒到 5 分钟，可以拖动也可以直接输入秒数 */
export const COMPOSER_MIN_SEC = 10
export const COMPOSER_MAX_SEC = 300
/** 能出的画幅，第一个是没选时的默认（和 lovideo.ai 网站的 FILM_ASPECTS 一致） */
export const ASPECTS = ['16:9', '9:16', '3:4']

const file = () => join(ensureDir(dataDir()), 'composer.json')

/** { defaults: { slug, aspect, duration }, briefs: { 会话 id: { slug, name, aspect, duration, at, sent } } } */
const shape = d => ({ defaults: d?.defaults || null, briefs: d?.briefs || {} })

function load() {
  return shape(readJson(file(), {}))
}

/** 在锁里读最新的交给 fn 改（返回 false 表示不写）：DSH 桌面版和网页版可能同时在改 */
function change(fn) {
  let out
  updateJson(file(), raw => {
    const d = shape(raw)
    out = fn(d)
    if (out === false) return undefined
    // 只留最近 50 个会话的开局条件，够用且文件不会越长越大
    const entries = Object.entries(d.briefs).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, 50)
    return { defaults: d.defaults, briefs: Object.fromEntries(entries) }
  })
  return out
}

const bad = msg => Object.assign(new Error(msg), { status: 400 })

/** 检查页面传来的开局条件；风格要在可用列表里（不选就是交给导演推荐），画幅要是这个风格支持的；
 *  不选风格时画幅至少要有一个风格能做（一个都做不了的话导演推荐不出风格），否则用默认画幅 */
export function normalizeBrief(b, styles) {
  const duration = Math.round(Number(b?.duration))
  if (!Number.isInteger(duration) || duration < COMPOSER_MIN_SEC || duration > COMPOSER_MAX_SEC) throw bad(`片长要在 ${COMPOSER_MIN_SEC} 到 ${COMPOSER_MAX_SEC} 秒之间`)
  if (b?.slug == null) {
    const usable = a => ASPECTS.includes(a) && (!styles.length || styles.some(s => (s.aspects?.length ? s.aspects : ['16:9']).includes(a)))
    return { slug: null, name: null, aspect: usable(b?.aspect) ? b.aspect : ASPECTS[0], duration }
  }
  const s = styles.find(x => x.slug === b?.slug)
  if (!s) throw bad('没有这个风格')
  const aspects = s.aspects?.length ? s.aspects : ['16:9']
  const aspect = ASPECTS.includes(b.aspect) && aspects.includes(b.aspect) ? b.aspect : aspects[0]
  return { slug: s.slug, name: s.name, aspect, duration }
}

export function composerDefaults() {
  return load().defaults
}

export function getBrief(sessionId) {
  return load().briefs[sessionId] || null
}

/** 存一个会话的开局条件（brief 为 null 表示这个会话不用了，比如切回了标准模式） */
export function setBrief(sessionId, brief) {
  if (!/^[\w-]{1,120}$/.test(sessionId || '')) throw bad('会话 id 不对')
  return change(d => {
    if (!brief) delete d.briefs[sessionId]
    else {
      d.briefs[sessionId] = { ...brief, at: new Date().toISOString(), sent: false }
      d.defaults = { slug: brief.slug, aspect: brief.aspect, duration: brief.duration }
    }
    return d.briefs[sessionId] || null
  })
}

function briefText(b) {
  if (!b.slug) {
    return `[lovideo 输入框] 用户没有指定风格，要你按内容推荐；画幅 ${b.aspect}、片长约 ${b.duration} 秒已经选好。`
      + '先调用 lovideo_styles 看全部风格的介绍和总览图，按内容挑 1 到 3 个推荐给用户点选（只挑支持这个画幅的）；'
      + '出分镜时用这个画幅和片长（lovideo_plan 的 duration 填这个秒数），不要再问画幅和片长；配音和配乐照常由你建议。'
  }
  return `[lovideo 输入框] 用户在输入框里已经选好：风格「${b.name}」（style: ${b.slug}）、画幅 ${b.aspect}、片长约 ${b.duration} 秒。`
    + '出分镜时直接用这个风格、画幅和片长（lovideo_plan 的 duration 填这个秒数），不要再推荐风格，也不要再问画幅和片长；'
    + '配音和配乐照常由你建议。用户之后在对话里明确说要换的，以对话为准。'
}

/**
 * 用户在这个会话里发出第一句话时，把开局条件附在这一步的消息后面交给导演（每份只交一次）。
 * 做法和宿主自带的 agent-instructions 一样：等后面的环节定好这一步的消息，再把说明插在用户的话后面。
 */
export function installBriefContext(ctx) {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || payload.step !== 1) return decision
    const id = payload.agent?.id
    // 标成「已交」和读出来在同一把锁里：两个窗口不会把同一份交两次
    const b = id ? change(d => {
      const x = d.briefs[id]
      if (!x || x.sent) return false
      x.sent = true
      return x
    }) : false
    if (!b) return decision
    const message = Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: briefText(b) }], source: { kind: 'dsh-lovideo' } })
    const last = decision.messages.findLastIndex(m => payload.messages.includes(m))
    return { ...decision, messages: decision.messages.toSpliced(last + 1, 0, message) }
  })
}
