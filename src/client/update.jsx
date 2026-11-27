// 新版本提醒（后端见 host/update.js）：DeepSeek Harness 每次启动后弹一次提示条，管理页顶部常驻「有新版本」。
// 点「去更新」打开一个说明框：从 npm 包名装的，打开 DSH「插件」页点「更新」；从 GitHub 或安装包地址装的，教用户移除后填包名重装。
// 更新本身由用户在插件页发起（官方规定装插件要用户在插件页明确发起），插件不自己装。
import * as React from 'react'
import { api } from './api.js'
import { openPluginList } from './host.js'
import { lang, t, useT } from './i18n.js'
import { Button, Dialog, Styles } from './ui.jsx'
import { toast } from './toast.jsx'

/* ---------- 这次启动的检查结果：全页只问一次 ---------- */

let info = null
let asked = null
let open = false
const subs = new Set()
const emit = () => {
  for (const fn of subs) fn()
}
const subscribe = fn => {
  subs.add(fn)
  return () => subs.delete(fn)
}

function load() {
  asked ??= api('update').then(r => {
    info = r
    emit()
    return r
  }, () => {
    asked = null
    return null
  })
  return asked
}

export function openUpdate() {
  open = true
  emit()
}

const closeUpdate = () => {
  open = false
  emit()
}

/** 这一版更新了什么：按界面语言取，没有就用另一种语言 */
function notesOf(u) {
  const n = u?.notes
  if (!n) return ''
  return (lang() === 'zh' ? n.zh || n.en : n.en || n.zh) || ''
}

// 一次启动只提醒一次：启动编号记在本机，刷新页面不会再弹
const SHOWN = 'lovideo-update-shown'
function remindOnce(r) {
  if (!r?.update) return
  try {
    if (localStorage.getItem(SHOWN) === r.startId) return
    localStorage.setItem(SHOWN, r.startId)
  } catch {
    // 存不了：最多这次启动里刷新页面时再提醒一次
  }
  const notes = notesOf(r.update)
  toast({
    text: notes ? t('update.toastNotes', { version: r.update.version, notes }) : t('update.toast', { version: r.update.version }),
    actions: [{ label: t('update.go'), onClick: openUpdate }],
    holdMs: 12000,
    whenFocused: true,
  })
}

/* ---------- 挂在 shell.overlay 上：启动后提醒一次，说明框也画在这里 ---------- */

export function UpdateOverlay() {
  const t = useT()
  const r = React.useSyncExternalStore(subscribe, () => info)
  const isOpen = React.useSyncExternalStore(subscribe, () => open)
  React.useEffect(() => {
    load().then(remindOnce)
  }, [])
  const u = r?.update
  if (!u) return null
  const notes = notesOf(u)
  const reinstall = r.kind !== 'npm'
  const copy = async () => {
    try {
      await navigator.clipboard.writeText('dsh-lovideo')
      toast({ text: t('update.copied') })
    } catch {
      toast({ text: t('update.copyFailed'), tone: 'warning' })
    }
  }
  const goPlugins = () => {
    closeUpdate()
    if (!openPluginList()) toast({ text: t('update.noPluginPage'), tone: 'warning' })
  }
  return (
    <div className="lv">
      <Styles />
      <Dialog open={isOpen} title={t('update.title', { version: u.version })} onCancel={closeUpdate}
        actions={<>
          <Button onClick={closeUpdate}>{t('update.later')}</Button>
          {reinstall ? <Button onClick={copy}>{t('update.copyName')}</Button> : null}
          <Button kind="pri" onClick={goPlugins}>{t('update.openPlugins')}</Button>
        </>}>
        {notes ? <p style={{ margin: '0 0 10px' }}>{notes}</p> : null}
        <p className="lv-subtle" style={{ margin: 0 }}>{reinstall ? t(r.kind === 'git' ? 'update.howGit' : 'update.howTarball', { version: u.version }) : t('update.howNpm', { version: u.version })}</p>
      </Dialog>
    </div>
  )
}

/* ---------- 管理页顶部的常驻入口 ---------- */

export function UpdateBadge() {
  const t = useT()
  const r = React.useSyncExternalStore(subscribe, () => info)
  React.useEffect(() => {
    load()
  }, [])
  if (!r?.update) return null
  return <Button size="sm" onClick={openUpdate} title={notesOf(r.update) || undefined}>{t('update.badge', { version: r.update.version })}</Button>
}
