// 「lovideo 导演」模式的输入框：模式下拉选成 lovideo 导演、会话还是空白的时候，
// 输入框工具栏多出「风格（含画幅）」和「片长」两个选项，输入框下面是我的作品、我的收藏、官方风格。
// 标准模式下这些都不出现，和原版 DeepSeek Harness 一样。
// 选的东西按会话存到插件后端；用户发出第一句话时，后端把它作为说明交给导演（见 host/composer.js）。
// 配音、配乐、字幕不在这里选：导演出分镜时建议，用户在分镜卡上改。
import * as React from 'react'
import { api, fileUrl, useLive } from './api.js'
import { Styles, fmtSec } from './ui.jsx'
import { coverOf } from './cards.jsx'
import { StyleTile, seedFavorites, useFavorites } from './tiles.jsx'
import { openManager } from './host.js'

// 宿主页面里的 react-dom（和宿主共用同一个 React）；拿不到时风格墙就不画，输入框里的两个选项照常可用
let portal = null
try {
  // eslint-disable-next-line global-require
  portal = require('react-dom').createPortal
} catch {
  portal = null
}
export const hasPortal = () => typeof portal === 'function'

export const LOVIDEO_PRESET = 'lovideo'
const MIN = 10
const MAX = 300
const TICKS = [10, 60, 120, 180, 240, 300]
const BATCH = 24

export const durLabel = n => (n < 60 ? `${n} 秒` : n % 60 ? `${Math.floor(n / 60)} 分 ${n % 60} 秒` : `${n / 60} 分钟`)

/* ---------- 风格列表：全页只取一次 ---------- */

let stylesP = null
function loadStyles() {
  stylesP ??= api('styles').then(r => {
    seedFavorites(r.favorites)
    return r
  }, e => {
    stylesP = null
    throw e
  })
  return stylesP
}
const allStyles = r => [...(r?.mine || []).filter(s => !s.draft), ...(r?.platform || [])]

/* ---------- 每个会话一份开局条件：先改界面，停 300ms 再存，免得拖动时一直发请求 ---------- */

const stores = new Map()

function storeFor(sessionId) {
  let st = stores.get(sessionId)
  if (st) return st
  let state = { ready: false, slug: null, name: '', cover: null, aspects: ['16:9'], aspect: '16:9', duration: 30 }
  const subs = new Set()
  let timer = null
  let started = false
  const emit = () => {
    for (const fn of subs) fn()
  }
  const save = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      api('composer', { sessionId, brief: { slug: state.slug, aspect: state.aspect, duration: state.duration } }).catch(() => {})
    }, 300)
  }
  const pick = (s, extra = {}) => {
    const aspects = s.aspects?.length ? s.aspects : ['16:9']
    const aspect = aspects.includes(extra.aspect) ? extra.aspect : aspects.includes(state.aspect) ? state.aspect : aspects[0]
    return { slug: s.slug, name: s.name, cover: coverOf(s), aspects, aspect }
  }
  st = {
    get: () => state,
    subscribe: fn => {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    /** 打开时：这个会话存过就用存的，没有就用上次的选择，再没有用第一个官方风格 */
    start() {
      if (started) return
      started = true
      Promise.all([api(`composer?session=${encodeURIComponent(sessionId)}`), loadStyles()]).then(([c, r]) => {
        const list = allStyles(r)
        const want = c.brief || c.defaults || {}
        const s = list.find(x => x.slug === want.slug) || r.platform?.[0] || list[0]
        if (!s) return
        const duration = Number.isInteger(want.duration) ? Math.min(MAX, Math.max(MIN, want.duration)) : 30
        state = { ...state, ...pick(s, { aspect: want.aspect }), duration, ready: true }
        emit()
        if (!c.brief) save()
      }, () => {
        started = false
      })
    },
    setStyle(s) {
      state = { ...state, ...pick(s) }
      emit()
      save()
    },
    set(patch) {
      state = { ...state, ...patch }
      emit()
      save()
    },
    /** 切回别的模式：这个会话不再带开局条件 */
    clear() {
      clearTimeout(timer)
      if (!started && !state.ready) return
      started = false
      state = { ...state, ready: false }
      api('composer', { sessionId, brief: null }).catch(() => {})
    },
  }
  stores.set(sessionId, st)
  return st
}

function useComposer(sessionId) {
  const st = storeFor(sessionId)
  return [React.useSyncExternalStore(st.subscribe, st.get), st]
}

/** 宿主给的会话情况：选的是哪个模式、会话还是不是空白的 */
function useActive(props) {
  const facts = props.useLvSession(f => f)
  return facts.preset === LOVIDEO_PRESET && facts.blank
}

/* ---------- 弹出层：工具栏在一个会裁切的容器里，弹出层画在全局浮层上，按按钮的位置摆 ---------- */

let pop = null
const popSubs = new Set()
const setPop = p => {
  pop = p
  for (const fn of popSubs) fn()
}
const popSubscribe = fn => {
  popSubs.add(fn)
  return () => popSubs.delete(fn)
}

function usePop(id) {
  const anchor = React.useRef(null)
  const open = React.useSyncExternalStore(popSubscribe, () => pop?.id === id)
  const toggle = render => (open ? setPop(null) : setPop({ id, anchor, render }))
  return { anchor, open, toggle }
}

/** 挂在 shell.overlay 上：一次只开一个弹出层；点外面、按 Esc、窗口大小变了就关 */
export function ComposerPopover() {
  const p = React.useSyncExternalStore(popSubscribe, () => pop)
  const box = React.useRef(null)
  const [, force] = React.useReducer(n => n + 1, 0)
  React.useEffect(() => {
    if (!p) return undefined
    const away = e => {
      if (box.current?.contains(e.target) || p.anchor.current?.contains(e.target)) return
      setPop(null)
    }
    const key = e => {
      if (e.key === 'Escape') setPop(null)
    }
    const move = () => force()
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', key)
    window.addEventListener('resize', move)
    document.addEventListener('scroll', move, true)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', key)
      window.removeEventListener('resize', move)
      document.removeEventListener('scroll', move, true)
    }
  }, [p])
  if (!p || !p.anchor.current) return null
  const r = p.anchor.current.getBoundingClientRect()
  const below = window.innerHeight - r.bottom > 260
  const style = { position: 'fixed', left: Math.max(12, Math.min(r.left, window.innerWidth - 12 - (p.width || 320))), zIndex: 1000 }
  if (below) style.top = r.bottom + 10
  else style.bottom = window.innerHeight - r.top + 10
  return (
    <div className="lv">
      <Styles />
      <div ref={box} className="lv-pop" style={style}>{p.render()}</div>
    </div>
  )
}

/* ---------- 风格选项：封面 + 名字 + 画幅；弹出层里改画幅，换风格去下面挑 ---------- */

export function StyleChip(props) {
  const active = useActive(props)
  const sessionId = props.lvSessionId
  const [c, st] = useComposer(sessionId)
  const { anchor, open, toggle } = usePop(`style:${sessionId}`)
  const facts = props.useLvSession(f => f)
  React.useEffect(() => {
    if (active) st.start()
    // 在空白会话里切回别的模式：这个会话不再带开局条件
    else if (facts.blank && facts.preset && facts.preset !== LOVIDEO_PRESET) st.clear()
  }, [active, facts.blank, facts.preset, st])
  // 风格墙放在输入框下面的那一栏里（宿主在空白首页不给插件留位置，所以画到那一栏里去）
  const [dock, setDock] = React.useState(null)
  React.useEffect(() => {
    if (!active || !c.ready) return
    let el = anchor.current
    while (el && !el.querySelector?.('[data-composer-dock]')) el = el.parentElement
    setDock(el?.querySelector('[data-composer-dock]') || null)
  }, [active, c.ready, anchor])
  if (!active || !c.ready) return null
  const panel = () => <AspectPanel sessionId={sessionId} />
  return (
    <span className="lv">
      <Styles />
      {dock && hasPortal() ? portal(<Library {...props} />, dock) : null}
      <button ref={anchor} type="button" className={`lvc-chip lvc-style ${open ? 'on' : ''}`} aria-haspopup="dialog" aria-expanded={open}
        title="风格和画幅" onClick={() => toggle(panel)}>
        {c.cover ? <img src={c.cover} alt="" /> : <i className="lvc-ph" />}
        <span className="lvc-name">{c.name}</span>
        <span className="lvc-dot">·</span>
        <span className="lvc-mono lvc-asp">{c.aspect}</span>
        <Chevron />
      </button>
    </span>
  )
}

function AspectPanel({ sessionId }) {
  const [c, st] = useComposer(sessionId)
  return (
    <div className="lvc-panel" style={{ width: 300 }}>
      <div className="lvc-h">画幅</div>
      <div className="lvc-seg">
        {[['16:9', '横版', 20, 12], ['9:16', '竖版', 11, 18]].map(([a, label, w, h]) => (
          <button key={a} type="button" className={c.aspect === a ? 'on' : ''} disabled={!c.aspects.includes(a)} onClick={() => st.set({ aspect: a })}>
            <span className="lvc-shape" style={{ width: w, height: h }} />{a} {label}
          </button>
        ))}
      </div>
      <div className="lv-subtle" style={{ marginTop: 8, fontSize: 12 }}>{c.aspects.length > 1 ? `「${c.name}」横竖两版都能做` : `「${c.name}」只能做横版`}</div>
      <button type="button" className="lvc-link" onClick={() => {
        setPop(null)
        showTab(sessionId, 'all')
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
        换风格：在下方挑一个
      </button>
    </div>
  )
}

/* ---------- 片长：10 秒到 5 分钟，拖动或直接输入秒数；按钮宽度固定，拖的时候工具栏不挪位 ---------- */

export function DurationChip(props) {
  const active = useActive(props)
  const sessionId = props.lvSessionId
  const [c] = useComposer(sessionId)
  const { anchor, open, toggle } = usePop(`dur:${sessionId}`)
  if (!active || !c.ready) return null
  return (
    <span className="lv">
      <Styles />
      <button ref={anchor} type="button" className={`lvc-chip lvc-dur ${open ? 'on' : ''}`} aria-haspopup="dialog" aria-expanded={open}
        title="片长" onClick={() => toggle(() => <DurationPanel sessionId={sessionId} />)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
        <span className="lvc-mono lvc-durv">{durLabel(c.duration)}</span>
      </button>
    </span>
  )
}

function DurationPanel({ sessionId }) {
  const [c, st] = useComposer(sessionId)
  const [text, setText] = React.useState(String(c.duration))
  const [bad, setBad] = React.useState(false)
  // 拖动条或外面改了片长时，输入框跟着变（自己正在输入时不打断）
  const typing = React.useRef(false)
  React.useEffect(() => {
    if (!typing.current) setText(String(c.duration))
  }, [c.duration])
  const pct = (c.duration - MIN) / (MAX - MIN)
  return (
    <div className="lvc-panel lvc-durpanel">
      <div className="lvc-dhead">
        <b className="lvc-mono">约 {durLabel(c.duration)}</b>
        <label className="lvc-custom">自定义
          <input className={`lvc-mono ${bad ? 'bad' : ''}`} inputMode="numeric" maxLength={3} value={text} aria-label="片长（秒）"
            onFocus={() => { typing.current = true }}
            onChange={e => {
              const raw = e.target.value.replace(/\D/g, '')
              setText(raw)
              const n = Number(raw)
              const ok = n >= MIN && n <= MAX
              setBad(Boolean(raw) && !ok)
              if (ok) st.set({ duration: n })
            }}
            onBlur={() => {
              typing.current = false
              setBad(false)
              setText(String(c.duration))
            }} />
          秒</label>
      </div>
      <div className="lvc-rng">
        <div className="lvc-tr" />
        <div className="lvc-fill" style={{ width: `calc((100% - 18px) * ${pct})` }} />
        <div className="lvc-knob" style={{ left: `calc(9px + (100% - 18px) * ${pct})` }} />
        <input type="range" min={MIN} max={MAX} step={10} value={Math.round(c.duration / 10) * 10} aria-label="片长" aria-valuetext={durLabel(c.duration)}
          onChange={e => st.set({ duration: Number(e.target.value) })} />
      </div>
      <div className="lvc-ticks lvc-mono">
        {TICKS.map(v => <span key={v} className={Math.abs(v - c.duration) < 5 ? 'on' : ''} style={{ left: `${((v - MIN) / (MAX - MIN)) * 100}%` }}>{v}</span>)}
      </div>
      <p className="lv-subtle">可以拖动，也可以直接输入 {MIN} 到 {MAX} 之间的秒数。时长仅供参考：实际长短取决于内容是否丰富，导演不会为了凑时长拼凑没有意义的内容。</p>
    </div>
  )
}

function Chevron() {
  return <svg className="lvc-cv" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M7 10l5 5 5-5" /></svg>
}

/* ---------- 输入框下面：我的作品、我的收藏、官方风格 ---------- */

const tabSubs = new Map()
function showTab(sessionId, tab) {
  tabSubs.get(sessionId)?.(tab)
}

export function Library(props) {
  const active = useActive(props)
  const sessionId = props.lvSessionId
  const [c, st] = useComposer(sessionId)
  const [tab, setTab] = React.useState('all')
  const [q, setQ] = React.useState('')
  const [count, setCount] = React.useState(BATCH)
  const root = React.useRef(null)
  const scroller = React.useRef(null)
  const end = React.useRef(null)
  const [styles, setStyles] = React.useState(null)
  const favs = useFavorites()
  const [worksData] = useLive(active ? 'works' : null, () => true)
  React.useEffect(() => {
    if (!active) return undefined
    let live = true
    loadStyles().then(r => live && setStyles(r), () => live && setStyles({ platform: [], mine: [], offline: true }))
    return () => {
      live = false
    }
  }, [active])
  React.useEffect(() => {
    tabSubs.set(sessionId, t => {
      setTab(t)
      setCount(BATCH)
      scroller.current?.scrollTo({ top: 0 })
    })
    return () => tabSubs.delete(sessionId)
  }, [sessionId])
  // 风格墙浮在输入框下面：滚动区的高度按它离窗口底部还有多远来定，窗口变了重新算
  React.useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return undefined
    const fit = () => {
      const top = el.getBoundingClientRect().top
      el.style.setProperty('--lvc-h', `${Math.max(220, Math.round(window.innerHeight - top - 20))}px`)
    }
    fit()
    window.addEventListener('resize', fit)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null
    if (ro && root.current?.parentElement) ro.observe(root.current.parentElement.parentElement || root.current.parentElement)
    return () => {
      window.removeEventListener('resize', fit)
      ro?.disconnect()
    }
  })
  const hit = text => !q.trim() || text.toLowerCase().includes(q.trim().toLowerCase())
  const platform = styles?.platform || []
  const mine = (styles?.mine || []).filter(s => !s.draft)
  const favList = [...mine, ...(favs || []).map(slug => platform.find(s => s.slug === slug)).filter(Boolean)]
  const works = (worksData?.works || [])
  const list = tab === 'works' ? works.filter(w => hit(`${w.title}${w.style?.name || ''}`))
    : tab === 'favs' ? favList.filter(s => hit(`${s.name}${s.use || ''}`))
      : platform.filter(s => hit(`${s.name}${s.use || ''}${s.description || ''}`))
  const shown = list.slice(0, count)
  const more = shown.length < list.length
  // 和管理页一样分批显示：快滚到底就多显示一批
  React.useEffect(() => {
    const el = end.current
    if (!el || !more) return undefined
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) setCount(n => n + BATCH)
    }, { root: scroller.current, rootMargin: '0px 0px 400px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [more, count, tab])
  if (!active || !c.ready) return null
  const go = t => {
    setTab(t)
    setCount(BATCH)
    scroller.current?.scrollTo({ top: 0 })
  }
  const pickWork = w => {
    props.inputActions?.setDraft(`接着改《${w.title}》（work_id: ${w.id}）：`)
    const s = allStyles(styles).find(x => x.slug === w.style?.slug)
    if (s) st.setStyle(s)
  }
  return (
    <div ref={root} className="lv lvc-lib">
      <Styles />
      <div className="lvc-lhead">
        {[['works', '我的作品', works.length], ['favs', '我的收藏', favList.length], ['all', '官方风格', platform.length]].map(([k, label, n]) => (
          <button key={k} type="button" className={`lvc-tab ${tab === k ? 'on' : ''}`} onClick={() => go(k)}>{label}<small>{n}</small></button>
        ))}
        <span className="lv-grow" />
        <input className="lv-input lvc-search" placeholder={tab === 'works' ? '搜作品…' : '搜风格、用途…'} value={q} onChange={e => {
          setQ(e.target.value)
          setCount(BATCH)
        }} />
      </div>
      <div ref={scroller} className="lvc-scroll">
      {!styles ? <div className="lv-subtle lv-shimmer">读取中…</div> : (
        <div className="lv-grid lvc-grid">
          {tab === 'works'
            ? shown.map(w => <WorkTile key={w.id} w={w} onSelect={() => pickWork(w)} />)
            : shown.map(s => <StyleTile key={s.slug} s={s} selected={c.slug === s.slug} onSelect={() => st.setStyle(s)} />)}
          {tab === 'favs' && !q ? (
            <div role="button" tabIndex={0} className="lv-tile" onClick={() => openManager('mine')} onKeyDown={e => e.key === 'Enter' && openManager('mine')}>
              <div className="lv-media lvc-new">＋ 蒸馏新风格<br /><span className="lv-subtle">把喜欢的视频或图片变成自己的风格</span></div>
              <div className="lv-tile-title">新建我的风格</div>
              <div className="lv-subtle">在「lovideo 视频」里蒸馏</div>
            </div>
          ) : null}
          {!list.length && !(tab === 'favs' && !q) ? <div className="lv-subtle lvc-empty">{tab === 'works' ? (q ? '没有找到作品' : '还没有作品，说一句想做什么就开始') : '没有符合的风格'}</div> : null}
        </div>
      )}
      {more ? <div ref={end} style={{ height: 1 }} aria-hidden="true" /> : null}
      <div className="lv-subtle lvc-foot">{tab === 'works' ? '点一部作品：在这个对话里接着改它' : tab === 'favs' ? '我蒸馏的风格和收藏的官方风格都在这里' : '悬停预览，点一下选中；右上角星星收藏'}</div>
      </div>
    </div>
  )
}

function WorkTile({ w, onSelect }) {
  return (
    <div role="button" tabIndex={0} className="lv-tile" onClick={onSelect} onKeyDown={e => e.key === 'Enter' && onSelect()}>
      <div className="lv-media">
        {w.poster ? <img src={fileUrl(w.poster)} alt="" loading="lazy" /> : null}
        {w.duration ? <span className="lv-chip r bl lv-mono">{fmtSec(w.duration)}</span> : null}
      </div>
      <div className="lv-tile-title lv-truncate">{w.title}</div>
      <div className="lv-subtle lv-truncate">{w.status === 'failed' ? <span className="lv-err">没做完 · </span> : null}{w.style?.name}</div>
    </div>
  )
}
