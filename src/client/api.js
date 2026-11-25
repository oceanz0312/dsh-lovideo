// 和插件 Host 半边说话：同源的 lovideo/api/*（DSH 页面的登录凭证自动带上）。
import * as React from 'react'

// 用站点根路径：会话页的地址带子路径，相对路径会被解析到错误的位置
export const API = new URL('/lovideo/api/', location.href).pathname

export async function api(path, body) {
  const res = await fetch(API + path, body === undefined
    ? { headers: { accept: 'application/json' } }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok) throw Object.assign(new Error(data?.error || `请求失败（${res.status}）`), { status: res.status, code: data?.code })
  return data
}

export const fileUrl = rel => (rel ? API + rel : null)

/**
 * 用系统浏览器打开外部网址。交给页面的 window.open：桌面版 DeepSeek Harness 会转给
 * Electron 的 shell.openExternal（macOS、Windows 都打开默认浏览器），网页版在用户自己的浏览器里开新标签。
 * 不要让插件后端去跑 open / explorer：Windows 的 explorer 收到带 ? & 的网址可能打开文件夹，
 * 网页版远程访问时还会在跑 DSH 的那台电脑上打开。
 */
/**
 * 登录确认页地址：桌面版（页面地址是 dsh-app:）加上 app=desktop，
 * 网站在登录成功后就会给一个「回到 DeepSeek Harness」按钮（打开 dsh://open 把应用切到前台）。
 */
export function loginUrl(url) {
  if (!url || location.protocol !== 'dsh-app:') return url
  const u = new URL(url)
  u.searchParams.set('app', 'desktop')
  return u.toString()
}

export function openExternal(url) {
  if (/^https:\/\//.test(url || '')) window.open(url, '_blank', 'noopener,noreferrer')
}

/* ---------- 变化推送：一个 EventSource 全页面共用 ---------- */

const listeners = new Set()
let source = null

function ensureSource() {
  if (source || typeof EventSource === 'undefined') return
  source = new EventSource(API + 'events')
  source.onmessage = e => {
    let msg = null
    try {
      msg = JSON.parse(e.data)
    } catch {
      return
    }
    for (const fn of listeners) fn(msg)
  }
  source.onerror = () => {
    // 断了浏览器会自动重连；连不上时卡片退回定时刷新
  }
}

export function subscribe(fn) {
  ensureSource()
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
    if (!listeners.size && source) {
      source.close()
      source = null
    }
  }
}

/** 读一个接口并在作品变化时自动刷新；filter 决定哪些变化需要刷新 */
export function useLive(path, filter = () => true, intervalMs = 0) {
  const [data, setData] = React.useState(null)
  const [error, setError] = React.useState(null)
  const timer = React.useRef(null)
  const load = React.useCallback(() => {
    if (!path) return
    api(path).then(d => {
      setData(d)
      setError(null)
    }, e => setError(e))
  }, [path])
  React.useEffect(() => {
    load()
    const off = subscribe(msg => {
      if (!filter(msg)) return
      // 合并短时间内的多次变化
      clearTimeout(timer.current)
      timer.current = setTimeout(load, 250)
    })
    const poll = intervalMs ? setInterval(load, intervalMs) : null
    return () => {
      off()
      clearTimeout(timer.current)
      if (poll) clearInterval(poll)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, load, intervalMs])
  return [data, error, load, setData]
}

/** 从工具结果文字里取出 work_id、style_slug 等 */
export function pick(text, key) {
  const m = new RegExp(`${key}:\\s*([A-Za-z0-9_-]+)`).exec(text || '')
  return m ? m[1] : null
}

export function resultText(block) {
  if (!block || !('kind' in block)) return ''
  return (block.content || []).map(c => (c.type === 'text' ? c.text : '')).join('\n')
}

export function argsOf(block) {
  const raw = ('kind' in block ? block.call?.argsRaw : block.argsRaw) || ''
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export const fmtSec = s => {
  if (!Number.isFinite(s)) return ''
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}
