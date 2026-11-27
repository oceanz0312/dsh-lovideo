// 界面文字的中英两份字典，跟着宿主的语言走（DSH 要求界面文字走 Client 的 locale 服务）。
//
// 用法：
//   组件里：const t = useT()；t('manage.tab.works')、t('works.count', { n: 3 })。语言一切换，用了 useT 的组件立即重画。
//   非组件代码（toast 文案、草稿、小工具函数）：import { t } from './i18n.js'，按调用那一刻的语言取字。
//   调用这些函数的组件自己也要调一次 useT()，切换语言时才会跟着重画。
//   要在文字中间嵌一个元素（比如加粗的登录码）：rich(t('login.pending'), { code: <b>…</b> })。
//
// 字典注册到宿主的 locale 服务（命名空间 dsh-lovideo），翻译用它 bind 出来的函数；
// 宿主没有 locale 服务（老版本或拿不到）时不挂掉，按页面或浏览器的语言自己查这两份字典。
import * as React from 'react'
import zh from './locale/zh.js'
import en from './locale/en.js'

export const NS = 'dsh-lovideo'
export const DICTS = { zh, en }

let service = null
// apply 拿到的 ctx：inject 还没生效时也能用 ctx.get 读宿主当前语言
let hostCtx = null
let bound = null
let rev = 0
const subs = new Set()
const emit = () => {
  rev += 1
  for (const fn of subs) fn()
}

/** 当前界面用中文还是英文：宿主选的语言优先；宿主选了别的语言（日语等）按宿主的回退规则用英文 */
export function lang() {
  let active = ''
  try {
    active = String((service || hostCtx?.get?.('locale'))?.getSnapshot?.()?.active || '')
  } catch {
    active = ''
  }
  if (!active) {
    try {
      active = document.documentElement.lang || navigator.language || 'zh'
    } catch {
      active = 'zh'
    }
  }
  return /^zh/i.test(active) ? 'zh' : 'en'
}

/** 和宿主一样的 {name} 替换：没给的占位符原样留着 */
function fill(text, vars) {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m))
}

/** 按当前语言取一条文字；字典里没有时显示键本身（和宿主的规则一样），方便发现漏掉的键 */
export function t(key, vars) {
  if (bound) {
    try {
      return bound(key, vars)
    } catch {
      // 宿主的翻译函数出错时退回自己查
    }
  }
  return fill(DICTS[lang()][key] ?? DICTS.zh[key] ?? key, vars)
}

const subscribe = fn => {
  subs.add(fn)
  return () => subs.delete(fn)
}
const snapshot = () => rev

/** 组件里用：订阅语言变化，切换语言（或宿主晚到注册完字典）时重画；返回的函数每次语言变化换一个新的，方便放进依赖 */
export function useT() {
  const r = React.useSyncExternalStore(subscribe, snapshot)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return React.useMemo(() => (key, vars) => t(key, vars), [r])
}

/** 把文字里的 {name} 换成 React 元素（t 先把普通变量换好，留下的占位符在这里换） */
export function rich(text, parts) {
  const out = []
  let last = 0
  text.replace(/\{(\w+)\}/g, (m, name, at) => {
    if (!(name in parts)) return m
    if (at > last) out.push(text.slice(last, at))
    out.push(React.createElement(React.Fragment, { key: out.length }, parts[name]))
    last = at + m.length
    return m
  })
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** 用反引号标出的部分画成 <code>（帮助对话框里的网址） */
export function codeText(text) {
  return text.split('`').map((s, i) => (i % 2 ? React.createElement('code', { key: i }, s) : s))
}

/**
 * apply 时调用：宿主有 locale 服务时注册字典、跟着它的语言变化重画；服务卸载时退回自己查字典。
 * 用 ctx.inject 而不是在插件声明里要求 locale：拿不到这个服务时插件其余部分照常工作。
 */
export function attachLocale(ctx) {
  hostCtx = ctx
  try {
    ctx.inject(['locale'], c => {
      c.effect(() => {
        const svc = c.locale
        let off = () => {}
        try {
          off = svc.register(NS, DICTS)
          bound = svc.bind(NS)
        } catch (err) {
          // 注册不上（比如命名空间已被占）就只跟着宿主的语言，自己查字典
          console.warn('[dsh-lovideo] 注册界面字典失败', err)
          bound = null
        }
        service = svc
        const unsub = svc.subscribe(emit)
        emit()
        return () => {
          unsub()
          off()
          if (service === svc) {
            service = null
            bound = null
          }
          emit()
        }
      }, 'dsh-lovideo: locale dictionaries')
    })
  } catch (err) {
    console.warn('[dsh-lovideo] 拿不到宿主的语言服务，按浏览器语言显示', err)
  }
}
