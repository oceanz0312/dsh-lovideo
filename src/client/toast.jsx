// 插件的提示条（Toast）：挂在 DeepSeek Harness 的 shell.overlay 上，不管用户在对话还是管理页都能看到。
// 来源有两个：后端推来的通知（登录成功、环境准备好、成片做好、导出完成及失败），和页面上操作的结果（退出、删除、保存）。
// 样式用宿主自带的 Toast（@deepseek-ai/dsh-client-ui-primitives），和 DeepSeek Harness 自己的提示一模一样；拿不到时用一个简单的替身。
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

/* ---------- 宿主的 Toast ---------- */

let primitives
function hostToast() {
  if (primitives === undefined) {
    try {
      // 由 DeepSeek Harness 的模块加载器提供（打包时不打进来）
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }
  }
  return primitives?.Toast ? primitives : null
}

/** 宿主没有 Toast 时的替身：底部居中的一条，几秒后自己消失 */
function FallbackToast({ text, tone, actions, holdMs = 4000, onDone }) {
  React.useEffect(() => {
    const t = setTimeout(onDone, holdMs)
    return () => clearTimeout(t)
  }, [holdMs, onDone])
  return (
    <div role="status" style={{
      position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 1000,
      display: 'flex', alignItems: 'center', gap: 12, maxWidth: 'min(560px, calc(100vw - 32px))',
      padding: '10px 16px', borderRadius: 12, fontSize: 13, lineHeight: 1.5,
      background: 'var(--dsw-alias-bg-layer-3, #1f1f1f)', color: 'var(--dsw-alias-label-primary, #fff)',
      border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12))', boxShadow: '0 8px 24px rgba(0,0,0,.18)',
    }}>
      <span aria-hidden style={{ color: tone === 'warning' ? 'var(--dsw-alias-state-warn-primary, #f5a524)' : 'var(--dsw-alias-state-success-primary, #22c55e)' }}>{tone === 'warning' ? '!' : '✓'}</span>
      <span style={{ flex: 1 }}>{text}</span>
      {(actions || []).map(a => (
        <button key={a.label} type="button" onClick={a.onClick}
          style={{ border: 0, background: 'transparent', color: 'inherit', font: 'inherit', fontWeight: 600, cursor: 'pointer', padding: 0 }}>{a.label}</button>
      ))}
    </div>
  )
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
  const prim = hostToast()
  if (prim) {
    const Icon = prim.IconWarningOutlineRegular
    return (
      <prim.Toast key={current.seq} text={current.text} onDone={onDone}
        {...current.tone === 'warning' ? (Icon ? { icon: <Icon /> } : {}) : { tone: 'success' }}
        {...current.holdMs ? { holdMs: current.holdMs } : {}}
        {...actions.length ? { actions } : {}} />
    )
  }
  return <FallbackToast key={current.seq} text={current.text} tone={current.tone} actions={actions} holdMs={current.holdMs} onDone={onDone} />
}
