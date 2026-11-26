// 宿主提供的导航能力：打开 lovideo 管理页、开一个导演会话、回到某个会话。
// apply 时由 index.jsx 填进来；宿主没有某项能力时按钮安静地降级。
export const host = { ctx: null, tab: null, setTab: null, from: null, setFrom: null }

export const PANEL = 'lovideo'

/** 按名字取宿主服务（ctx.get 不要求事先声明 inject） */
function svc(name) {
  try {
    return host.ctx?.get?.(name) ?? null
  } catch {
    return null
  }
}

/**
 * 用户现在正在看的对话（没在看对话时是 null）。
 * 从对话跳到管理页时记下它，管理页据此给一个「返回对话」；用户自己点侧栏进管理页时没有来源，就没有这个按钮。
 * 做法和宿主工作区一样：主视图正在显示的会话，就是 retainedBy.mainView 大于 0 的那个。
 */
function currentSession() {
  try {
    if (svc('layout')?.panelInfo.getSnapshot().activePanelId !== null) return null
    const byId = svc('sessions')?.list.getSnapshot().byId || {}
    const s = Object.values(byId).find(c => (c.retainedBy?.mainView ?? 0) > 0)
    return s ? { sessionId: s.id, title: s.displayTitle || '' } : null
  } catch {
    return null
  }
}

/** 监听宿主的面板切换：用户离开管理页（回到对话或去了别的面板）时调用 onLeave；返回取消监听的函数 */
export function watchPanel(onLeave) {
  try {
    const info = svc('layout')?.panelInfo
    if (!info) return () => {}
    const off = info.subscribe(() => {
      if (info.getSnapshot().activePanelId !== PANEL) onLeave()
    })
    return typeof off === 'function' ? off : () => {}
  } catch {
    return () => {}
  }
}

export function openManager(tab) {
  if (tab && host.setTab) host.setTab(tab)
  else if (tab) host.tab = tab
  // 已经在管理页里时不覆盖原来的来源（currentSession 此时是 null）
  const from = currentSession()
  if (from) {
    if (host.setFrom) host.setFrom(from)
    else host.from = from
  }
  try {
    svc('layout')?.selectPanel(PANEL)
  } catch (err) {
    console.warn('[dsh-lovideo] 打开管理页失败', err)
  }
}

/*
 * 带着风格开会话：宿主的 startSession 不告诉我们开的是哪个会话（还可能复用一个空白会话），
 * 所以先把风格记在这里，等那个会话输入框里的风格选项出现时领走（见 composer.jsx 的 takeStylePick）。
 * 只等 20 秒：开会话失败时，不会让后面别的会话莫名其妙换了风格。
 */
let stylePick = null

export function takeStylePick() {
  const p = stylePick
  stylePick = null
  return p && Date.now() - p.at < 20_000 ? p.slug : null
}

/**
 * 开一个「lovideo 导演」会话，把草稿放进输入框（不直接发送）。
 * 传了 style 时，输入框里的风格选项换成这个风格：风格只认输入框里选的那一个，不写进草稿文字，
 * 免得草稿说一个、输入框选另一个，导演不知道听谁的。
 */
export function startDirector(prompt, { style } = {}) {
  stylePick = style ? { slug: style, at: Date.now() } : null
  try {
    svc('uiWorkspace')?.startSession(undefined, { agentPreset: 'lovideo', prompt, whenDraftExists: 'replace' })
  } catch (err) {
    console.warn('[dsh-lovideo] 开会话失败', err)
  }
}

export function openSession(id) {
  try {
    if (id) svc('uiWorkspace')?.openSession(id)
  } catch (err) {
    console.warn('[dsh-lovideo] 打开会话失败', err)
  }
}
