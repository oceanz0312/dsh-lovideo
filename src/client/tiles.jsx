// 风格卡片和收藏：管理页的官方风格、我的风格，以及输入框下面的风格墙都用这一套。
// 收藏只存风格 slug，在这台电脑上；「我的收藏」= 我蒸馏的风格 + 收藏的官方风格。
import * as React from 'react'
import { api } from './api.js'
import { HoverVideo, Media, useHoverPreview } from './ui.jsx'
import { toast } from './toast.jsx'
import { coverOf } from './cards.jsx'

/* ---------- 收藏：全页共用一份，点星星先改界面再存，存失败就改回来 ---------- */

let favs = null
let loading = null
const favSubs = new Set()
const emitFavs = () => {
  for (const fn of favSubs) fn()
}

function loadFavs() {
  if (favs || loading) return
  loading = api('styles').then(r => {
    favs = r.favorites || []
    emitFavs()
  }, () => {
    favs = []
    emitFavs()
  }).finally(() => {
    loading = null
  })
}

/** 风格列表接口顺带带回了收藏，拿到时直接用，省一次请求 */
export function seedFavorites(list) {
  if (!Array.isArray(list)) return
  const same = favs && favs.length === list.length && favs.every((s, i) => s === list[i])
  if (same) return
  favs = list
  emitFavs()
}

export function useFavorites() {
  const subscribe = React.useCallback(fn => {
    favSubs.add(fn)
    loadFavs()
    return () => favSubs.delete(fn)
  }, [])
  return React.useSyncExternalStore(subscribe, () => favs)
}

export async function toggleFavorite(s) {
  const was = favs || []
  const on = !was.includes(s.slug)
  favs = on ? [s.slug, ...was] : was.filter(x => x !== s.slug)
  emitFavs()
  try {
    const r = await api('favorites', { slug: s.slug, on })
    favs = r.favorites
    emitFavs()
    toast({ text: on ? `已收藏「${s.name}」` : `已取消收藏「${s.name}」`, holdMs: 1600 })
  } catch (e) {
    favs = was
    emitFavs()
    toast({ text: `没存上：${e.message}`, tone: 'warning' })
  }
}

/* ---------- 收藏星：没收藏时悬停才出现，收藏了一直显示；没有底色，只是一颗带阴影的星 ---------- */

function Star({ s, on }) {
  return (
    <button type="button" className={`lv-star ${on ? 'on' : ''}`} aria-pressed={on} aria-label={on ? `取消收藏「${s.name}」` : `收藏「${s.name}」`}
      title={on ? '取消收藏' : '收藏'}
      onClick={e => {
        e.stopPropagation()
        toggleFavorite(s)
      }}
      onKeyDown={e => e.stopPropagation()}>
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"
          fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

/**
 * 一张风格卡片：鼠标停在上面在封面处播小样片；右上角收藏星（我自己的风格不需要收藏，标「我蒸馏的」）。
 * 卡片本身是可点的块，不是 <button>：里面还有收藏按钮，按钮不能套按钮。
 */
export function StyleTile({ s, selected, onSelect, cover }) {
  const { playing, stop, bind } = useHoverPreview(s.sample)
  const list = useFavorites()
  const mine = s.source === 'mine'
  const fav = !mine && Boolean(list?.includes(s.slug))
  return (
    <div role="button" tabIndex={0} className={`lv-tile ${selected ? 'on' : ''}`} aria-pressed={selected ? true : undefined}
      onClick={onSelect} onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect?.()
        }
      }} {...bind}>
      <Media src={cover ?? coverOf(s)} chip={s.installed ? '已在本机' : null}>
        {playing ? <HoverVideo src={s.sample} onFail={stop} /> : null}
        {s.gpu ? <span className="lv-chip bl">3D 绘制</span> : null}
        {mine ? <span className="lv-chip r">我蒸馏的</span> : <Star s={s} on={fav} />}
      </Media>
      <div className="lv-tile-title lv-truncate">{s.name}</div>
      <div className="lv-subtle lv-truncate">{[s.use, (s.aspects || []).join(' · ')].filter(Boolean).join(' · ')}</div>
    </div>
  )
}
