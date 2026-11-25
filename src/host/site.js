// lovideo.ai 账号和接口。登录走设备码：插件用系统浏览器打开网站，用户在网站上登录并确认同一串代码，
// 插件轮询拿到令牌，存在本机设置里（0600）。之后用 Bearer 调接口：平台风格列表、下载风格包、网站上的作品。
import { EventEmitter } from 'node:events'
import { readSettings, setAccount } from './settings.js'

/** 网站确认登录成功时发 'login'（带邮箱）：等着登录的导演据此自动继续 */
export const loginEvents = new EventEmitter()

const CLIENT_ID = 'dsh-lovideo'

export function siteUrl(path = '') {
  const base = (process.env.LOVIDEO_SITE || readSettings().site || 'https://lovideo.ai').replace(/\/+$/, '')
  return `${base}${path}`
}

function token() {
  return readSettings().account?.token || null
}

export async function siteFetch(path, { auth = false, ...init } = {}) {
  const headers = { accept: 'application/json', ...(init.headers || {}) }
  if (auth) {
    const t = token()
    if (!t) throw Object.assign(new Error('还没有登录 lovideo'), { status: 401, code: 'login_required' })
    headers.authorization = `Bearer ${t}`
  }
  const res = await fetch(siteUrl(path), { ...init, headers, signal: init.signal ?? AbortSignal.timeout(60_000) })
  if (res.status === 401 && auth) {
    setAccount(null)
    throw Object.assign(new Error('lovideo 登录已过期，请重新登录'), { status: 401, code: 'login_required' })
  }
  return res
}

export async function siteJson(path, opts) {
  const res = await siteFetch(path, opts)
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok) throw Object.assign(new Error(body?.message || body?.error_description || body?.error || `lovideo 接口 HTTP ${res.status}`), { status: res.status })
  return body
}

/* ---------- 设备码登录 ---------- */

let pending = null

/** 开始登录：拿到用户要在网站上核对的代码和网址 */
export async function startLogin() {
  const body = await siteJson('/api/auth/device/code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: 'styles works' }),
  })
  pending = {
    deviceCode: body.device_code,
    userCode: body.user_code,
    url: body.verification_uri_complete || `${body.verification_uri}?user_code=${encodeURIComponent(body.user_code)}`,
    interval: Math.max(2, Number(body.interval) || 5),
    expiresAt: Date.now() + (Number(body.expires_in) || 600) * 1000,
    state: 'waiting',
    error: null,
  }
  poll(pending)
  return loginState()
}

export function loginState() {
  const acc = readSettings().account
  return {
    account: acc ? { email: acc.email, name: acc.name } : null,
    pending: pending && pending.state === 'waiting' ? { userCode: pending.userCode, url: pending.url, expiresAt: pending.expiresAt } : null,
    error: pending?.state === 'failed' ? pending.error : null,
  }
}

async function poll(p) {
  while (p === pending && p.state === 'waiting') {
    await new Promise(r => setTimeout(r, p.interval * 1000))
    if (p !== pending) return
    if (Date.now() > p.expiresAt) {
      p.state = 'failed'
      p.error = '代码已过期，请重新登录'
      return
    }
    try {
      const res = await siteFetch('/api/auth/device/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: p.deviceCode, client_id: CLIENT_ID }),
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok && body.access_token) {
        // 账号信息用 Better Auth 自带的 get-session（带 Bearer 返回 {session, user}，没登录返回 null）；
        // 先拿到邮箱再一次存好，页面不会看到「已登录但没有邮箱」的中间状态
        const me = await siteJson('/api/auth/get-session', { headers: { authorization: `Bearer ${body.access_token}` } }).catch(() => null)
        setAccount({ token: body.access_token, email: me?.user?.email ?? null, name: me?.user?.name ?? null, at: new Date().toISOString() })
        p.state = 'done'
        loginEvents.emit('login', { email: me?.user?.email ?? null })
        return
      }
      if (body.error === 'slow_down') p.interval += 5
      else if (body.error && body.error !== 'authorization_pending') {
        p.state = 'failed'
        p.error = body.error === 'access_denied' ? '你在网站上拒绝了登录' : body.error_description || body.error
        return
      }
    } catch {
      // 网络抖一下，下一轮再试
    }
  }
}

export function logout() {
  pending = null
  setAccount(null)
  return loginState()
}
