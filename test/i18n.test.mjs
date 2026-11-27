// 界面字典检查：中英两份的键一模一样、占位符一致、没有空值；界面代码里用到的键都在字典里。
// 宿主运行时也要求 zh、en 两份都给全，少一个键英文界面就会直接显示键名。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const client = join(root, 'src', 'client')
const zh = (await import('../src/client/locale/zh.js')).default
const en = (await import('../src/client/locale/en.js')).default
const sources = readdirSync(client).filter(f => /\.(jsx?|mjs)$/.test(f)).map(f => [f, readFileSync(join(client, f), 'utf8')])

const holes = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()

test('中英两份字典的键完全一致', () => {
  assert.deepEqual(Object.keys(zh).filter(k => !(k in en)), [], '英文字典缺这些键')
  assert.deepEqual(Object.keys(en).filter(k => !(k in zh)), [], '中文字典缺这些键')
})

test('每个键的占位符两边一致、没有空值', () => {
  for (const [k, v] of Object.entries(zh)) {
    assert.equal(typeof v, 'string', `zh ${k} 不是文字`)
    assert.equal(typeof en[k], 'string', `en ${k} 不是文字`)
    assert.ok(v.trim(), `zh ${k} 是空的`)
    assert.ok(en[k].trim(), `en ${k} 是空的`)
    assert.deepEqual(holes(en[k]), holes(v), `${k} 的占位符不一致`)
    // 宿主的字典检查同样拒绝零宽空格和 BOM
    assert.ok(!/[​﻿]/.test(v + en[k]), `${k} 里有零宽空格或 BOM`)
  }
})

test('界面代码里用到的键都在字典里', () => {
  const missing = []
  let seen = 0
  for (const [f, src] of sources) {
    // 形如 'manage.tab.works' 的字符串都当作键：直接写在 t(...) 里的，和放在映射表里（STATUS、LABELS、TABS 等）再交给 t 的。
    // 宿主的展位名（inject('shell.overlay')、name: 'sidebar.panellist'）也长这样，跳过
    for (const m of src.matchAll(/(inject\(|name: )?'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)'/g)) {
      if (m[1]) continue
      seen += 1
      if (!(m[2] in zh)) missing.push(`${f}: ${m[2]}`)
    }
    // 拼出来的键（t(`help.${k}.title`) 这种）：前后缀要能对上字典里的键
    for (const m of src.matchAll(/t\(`([a-z][\w.]*)\$\{\w+\}([\w.]*)`\)/g)) {
      assert.ok(Object.keys(zh).some(k => k.startsWith(m[1]) && k.endsWith(m[2])), `${f}: ${m[0]} 一个键都对不上`)
    }
  }
  assert.ok(seen > 200, `只认出 ${seen} 个键，正则可能失效了`)
  assert.deepEqual(missing, [], '这些键不在字典里')
  // 帮助对话框按服务拼键
  for (const k of ['doubao', 'elevenlabs', 'volcengine']) {
    for (const part of ['title', 'ask', 'step1', 'step2', 'step3', 'copy']) assert.ok(`help.${k}.${part}` in zh, `缺 help.${k}.${part}`)
  }
})

test('界面代码里没有漏掉的写死中文（注释、控制台日志、和后端文字比对的标记、试听句子除外）', () => {
  const allowed = [/console\.(warn|error|log)\(/, /【需要登录】/, /【请改好后再调用】/, /需要\.\{0,4\}先登录/, /长太多\|/, /分镜 v\(/, /已在剪映中打开\|已导入剪映草稿/, /你好，这是 lovideo 的配音试听。/]
  const left = []
  for (const [f, src] of sources) {
    if (f.startsWith('locale')) continue
    let inBlock = false
    src.split('\n').forEach((line, i) => {
      let code = line
      if (inBlock) {
        if (!code.includes('*/')) return
        code = code.slice(code.indexOf('*/') + 2)
        inBlock = false
      }
      code = code.replace(/\/\*.*?\*\//g, '')
      if (code.includes('/*')) {
        inBlock = true
        code = code.slice(0, code.indexOf('/*'))
      }
      code = code.replace(/(^|\s)\/\/.*$/, '')
      if (/[一-鿿]/.test(code) && !allowed.some(re => re.test(code))) left.push(`${f}:${i + 1}: ${line.trim().slice(0, 80)}`)
    })
  }
  assert.deepEqual(left, [], '这些地方还有写死的中文')
})

test('接上宿主的语言服务：注册字典、跟着切换语言；服务卸载后自己查字典', async () => {
  const { attachLocale, t } = await import('../src/client/i18n.js')
  // 照宿主 LocaleRuntime 的行为做一个小替身：register 收 { zh, en }，bind 出的函数按当前语言查、{name} 替换
  let active = 'en'
  const dicts = new Map()
  const listeners = new Set()
  const locale = {
    getSnapshot: () => ({ active }),
    subscribe: fn => (listeners.add(fn), () => listeners.delete(fn)),
    register: (ns, d) => (dicts.set(ns, d), () => dicts.delete(ns)),
    bind: ns => (key, params) => (dicts.get(ns)?.[active]?.[key] ?? key).replace(/\{(\w+)\}/g, (m, n) => (params && n in params ? String(params[n]) : m)),
  }
  const disposers = []
  let gone = false
  const ctx = {
    locale,
    get: name => (name === 'locale' && !gone ? locale : undefined),
    inject: (deps, fn) => fn(ctx),
    effect: fn => disposers.push(fn()),
  }
  attachLocale(ctx)
  assert.ok(dicts.has('dsh-lovideo'), '没有注册命名空间')
  assert.equal(t('panel.label'), 'lovideo video')
  assert.equal(t('works.count', { n: 3 }), '3 · all on this computer')
  active = 'zh'
  for (const fn of listeners) fn()
  assert.equal(t('works.count', { n: 3 }), '3 部 · 都在这台电脑上')
  // 卸载：取消订阅、撤掉字典，之后按页面语言自己查（Node 里没有 document，退回中文）
  for (const off of disposers) off()
  gone = true
  assert.equal(listeners.size, 0)
  assert.ok(!dicts.has('dsh-lovideo'))
  active = 'en'
  assert.equal(t('dur.min', { m: 2 }), '2 分钟')
  // 字典里没有的键显示键本身，和宿主一样
  assert.equal(t('no.such.key'), 'no.such.key')
})
