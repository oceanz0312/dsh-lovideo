// 插件的提示条（Toast）：挂在 DeepSeek Harness 的 shell.overlay 上，不管用户在对话还是管理页都能看到。
// 来源有两个：后端推来的通知（登录成功、环境准备好、成片做好、导出完成及失败），和页面上操作的结果（退出、删除、保存）。
// 样式照着 DeepSeek Harness 自己的 Toast 写（位置、圆角、阴影、出现和淡出的动画、停留时长），颜色全用宿主的主题变量，
// 深色浅色跟着宿主走。不直接用宿主的界面组件包：官方规定插件不能加载它（组件会不打招呼地改，一出错我们这块就整块空白）。
import * as React from 'react'
import { api, subscribe } from './api.js'
import { openManager, openSession } from './host.js'

/* ---------- 队列 ---------- */

let seq = 0
let queue = []
const subs = new Set()
const emit = () => {
  for (const fn of subs) fn()
}

/**
 * 弹一条提示。
 * @param {{ text: string, tone?: 'success' | 'warning', actions?: { label: string, onClick: () => void }[], holdMs?: number, whenFocused?: boolean }} t
 *   whenFocused：用户正在别的窗口（比如在浏览器里登录）时先不弹，等切回来再弹，免得没看到就消失了
 */
export function toast(t) {
  seq += 1
  queue = [...queue, { seq, tone: 'success', ...t }]
  emit()
}

const dismiss = id => {
  queue = queue.filter(t => t.seq !== id)
  emit()
}

const focused = () => document.visibilityState === 'visible' && document.hasFocus()

/** 后端通知 → 提示文字和按钮 */
function fromNotice(n) {
  const actions = []
  if (n.kind === 'film-done' || n.kind === 'film-failed') {
    actions.push(n.sessionId
      ? { label: '回到对话', onClick: () => openSession(n.sessionId) }
      : { label: '查看', onClick: () => openManager('works') })
  }
  if (n.kind === 'export-done' && n.path) {
    actions.push({ label: '在文件夹中显示', onClick: () => api(`works/${n.workId}/reveal`, { path: n.path }).catch(() => {}) })
  }
  if (n.kind === 'login') actions.push({ label: '看看官方风格', onClick: () => openManager('platform') })
  return {
    text: n.text,
    tone: n.tone === 'warning' ? 'warning' : 'success',
    actions,
    holdMs: actions.length || n.tone === 'warning' ? 6000 : undefined,
    whenFocused: true,
  }
}

/* ---------- 提示条本身 ---------- */

// 和宿主一样：默认停 3 秒，再用 1 秒淡出，淡出结束才算这条结束
const HOLD_MS = 3000
const FADE_MS = 1000

// 宿主页面里的 react-dom（和宿主共用同一个 React）：提示条画到 body 上，不受所在容器的裁切和层级影响
let portal = null
try {
  // eslint-disable-next-line global-require
  portal = require('react-dom').createPortal
} catch {
  portal = null
}

const TOAST_CSS = `
.lv-toast{position:fixed;top:40px;left:50%;z-index:1100;pointer-events:none;display:flex;align-items:center;gap:10px;width:max-content;max-width:min(640px,calc(100vw - 48px));padding:12px 16px;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);font-size:14px;line-height:22px;box-shadow:var(--dsw-shadow-lv3);transform:translate(-50%);animation:lv-toast-in .16s ease-out,lv-toast-fade ${FADE_MS}ms ease var(--lv-toast-hold,${HOLD_MS}ms) forwards}
.lv-toast-icon{display:grid;place-items:center;flex:none;color:var(--dsw-alias-state-warn-label)}
.lv-toast-icon.ok{color:var(--dsw-alias-state-success-primary)}
.lv-toast-text{min-width:0}
.lv-toast-action{display:inline;padding:0;border:0;background:none;color:var(--dsw-alias-toast-action);font:inherit;cursor:pointer;margin-inline:3px;pointer-events:auto}
@media (hover:hover){.lv-toast-action:hover{opacity:.8}}
@keyframes lv-toast-in{from{opacity:0;transform:translate(-50%,-6px)}to{opacity:1;transform:translate(-50%)}}
@keyframes lv-toast-fade{to{opacity:0;visibility:hidden}}
@media (prefers-reduced-motion:reduce){.lv-toast{animation:lv-toast-fade ${FADE_MS}ms ease var(--lv-toast-hold,${HOLD_MS}ms) forwards}}
`

function IconOk() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.2 8.2l1.9 1.9 3.7-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconWarn() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.6v4.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.1" r=".85" fill="currentColor" />
    </svg>
  )
}

/** 一条提示：顶部居中，停 holdMs 后淡出，淡出结束调用 onDone */
function Toast({ text, tone, actions, holdMs = HOLD_MS, onDone }) {
  const done = React.useRef(onDone)
  React.useLayoutEffect(() => {
    done.current = onDone
  }, [onDone])
  React.useEffect(() => {
    const t = setTimeout(() => done.current(), holdMs + FADE_MS)
    return () => clearTimeout(t)
  }, [holdMs])
  const node = (
    <div className="lv-toast" role="alert" style={{ '--lv-toast-hold': `${holdMs}ms` }}>
      <style>{TOAST_CSS}</style>
      <span className={`lv-toast-icon ${tone === 'warning' ? '' : 'ok'}`} aria-hidden="true">{tone === 'warning' ? <IconWarn /> : <IconOk />}</span>
      <span className="lv-toast-text">
        {text}
        {(actions || []).map(a => <button key={a.label} type="button" className="lv-toast-action" onClick={a.onClick}>{a.label}</button>)}
      </span>
    </div>
  )
  return portal ? portal(node, document.body) : node
}

/* ---------- 挂在 shell.overlay 上的组件 ---------- */

export function ToastOverlay() {
  const [, force] = React.useReducer(x => x + 1, 0)
  const [isFocused, setFocused] = React.useState(focused)
  React.useEffect(() => {
    subs.add(force)
    const update = () => setFocused(focused())
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    const off = subscribe(msg => {
      if (msg?.type === 'notice' && msg.text) toast(fromNotice(msg))
    })
    return () => {
      subs.delete(force)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
      off()
    }
  }, [])
  // 一次只显示一条，按先后顺序；要等用户回来的那条先不显示
  const current = queue.find(t => !t.whenFocused || isFocused)
  const onDone = React.useCallback(() => current && dismiss(current.seq), [current])
  if (!current) return null
  const actions = (current.actions || []).map(a => ({ label: a.label, onClick: () => { dismiss(current.seq); a.onClick() } }))
  return <Toast key={current.seq} text={current.text} tone={current.tone} actions={actions} holdMs={current.holdMs} onDone={onDone} />
}
