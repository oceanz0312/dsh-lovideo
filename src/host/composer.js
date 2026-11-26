// 输入框里的开局条件：「lovideo 导演」模式的空白会话里，输入框多了风格（含画幅）和片长两个选项。
// 页面每改一次就按会话存一份，同时记成下次打开的默认值；用户发出第一句话时，
// 在这一步的消息后面附一段说明交给导演，导演照着出分镜，不再问画幅和片长。
// 风格默认是「导演推荐」（slug 为 null）：导演看过全部风格后按内容推荐；用户在输入框里点了风格才照用户的来。
// 配音、配乐、字幕不在这里选：导演出分镜时建议，用户在分镜卡上改。
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { dataDir, ensureDir } from './paths.js'
import { readJson, writeJson } from './json-file.js'

/** 输入框里能选的片长：10 秒到 5 分钟，可以拖动也可以直接输入秒数 */
export const COMPOSER_MIN_SEC = 10
export const COMPOSER_MAX_SEC = 300
export const ASPECTS = ['16:9', '9:16']

const file = () => join(ensureDir(dataDir()), 'composer.json')

/** { defaults: { slug, aspect, duration }, briefs: { 会话 id: { slug, name, aspect, duration, at, sent } } } */
function load() {
  const d = readJson(file(), {}) || {}
  return { defaults: d.defaults || null, briefs: d.briefs || {} }
}

function save(d) {
  // 只留最近 50 个会话的开局条件，够用且文件不会越长越大
  const entries = Object.entries(d.briefs).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, 50)
  writeJson(file(), { defaults: d.defaults, briefs: Object.fromEntries(entries) })
}

const bad = msg => Object.assign(new Error(msg), { status: 400 })

/** 检查页面传来的开局条件；风格要在可用列表里（不选就是交给导演推荐），画幅要是这个风格支持的 */
export function normalizeBrief(b, styles) {
  const duration = Math.round(Number(b?.duration))
  if (!Number.isInteger(duration) || duration < COMPOSER_MIN_SEC || duration > COMPOSER_MAX_SEC) throw bad(`片长要在 ${COMPOSER_MIN_SEC} 到 ${COMPOSER_MAX_SEC} 秒之间`)
  if (b?.slug == null) return { slug: null, name: null, aspect: ASPECTS.includes(b?.aspect) ? b.aspect : ASPECTS[0], duration }
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
  const d = load()
  if (!brief) delete d.briefs[sessionId]
  else {
    d.briefs[sessionId] = { ...brief, at: new Date().toISOString(), sent: false }
    d.defaults = { slug: brief.slug, aspect: brief.aspect, duration: brief.duration }
  }
  save(d)
  return d.briefs[sessionId] || null
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
    const d = load()
    const b = id ? d.briefs[id] : null
    if (!b || b.sent) return decision
    b.sent = true
    save(d)
    const message = Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: briefText(b) }], source: { kind: 'dsh-lovideo' } })
    const last = decision.messages.findLastIndex(m => payload.messages.includes(m))
    return { ...decision, messages: decision.messages.toSpliced(last + 1, 0, message) }
  })
}
