// 宿主提供的导航能力：打开 lovideo 管理页、开一个导演会话、回到某个会话。
// apply 时由 index.jsx 填进来；宿主没有某项能力时按钮安静地降级。
export const host = { ctx: null, tab: null, setTab: null }

export const PANEL = 'lovideo'

/** 按名字取宿主服务（ctx.get 不要求事先声明 inject） */
function svc(name) {
  try {
    return host.ctx?.get?.(name) ?? null
  } catch {
    return null
  }
}

export function openManager(tab) {
  if (tab && host.setTab) host.setTab(tab)
  else if (tab) host.tab = tab
  try {
    svc('layout')?.selectPanel(PANEL)
  } catch (err) {
    console.warn('[dsh-lovideo] 打开管理页失败', err)
  }
}

/** 开一个「lovideo 导演」会话，把草稿放进输入框（不直接发送） */
export function startDirector(prompt) {
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
