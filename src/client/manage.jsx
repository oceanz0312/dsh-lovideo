// 侧栏「lovideo 视频」：作品、官方风格、我的风格、设置。随时点开看，和对话里的卡片读同一份数据。
import * as React from 'react'
import { api, fileUrl, loginUrl, openExternal, useLive } from './api.js'
import { Badge, Button, ConfirmDialog, LinkButton, Mark, Media, Player, StatusBadge, Styles, fmtSec } from './ui.jsx'
import { Doctor, WorkActions, WorkBody, coverOf } from './cards.jsx'
import { StyleTile, seedFavorites } from './tiles.jsx'
import { host, openSession, startDirector, watchPanel } from './host.js'
import { toast } from './toast.jsx'
import { SoundSettings } from './sound-settings.jsx'

const PAGE_CSS = `
.lv-page{height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}
.lv-top{display:flex;align-items:center;gap:18px;height:52px;padding:0 24px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
.lv-brand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:15px}
.lv-tabs{display:flex;gap:4px;align-self:stretch}
.lv-tabs button{border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13.5px;padding:0 10px;cursor:pointer;border-bottom:2px solid transparent;transition:color var(--lv-dur) var(--lv-ease),border-color var(--lv-dur) var(--lv-ease)}
.lv-tabs button:hover{color:var(--dsw-alias-label-primary)}
.lv-tabs button.on{color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--dsw-alias-label-primary)}
.lv-body{flex:1;min-height:0;overflow:auto;padding:22px 24px 40px}
.lv-split{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:22px;align-items:start}
.lv-side{position:sticky;top:0;display:flex;flex-direction:column;gap:12px;animation:lv-side-in var(--lv-slow) var(--lv-ease-out)}
@keyframes lv-side-in{from{opacity:0;transform:translateX(12px)}}
.lv-pane{animation:lv-fade var(--lv-dur) var(--lv-ease)}
.lv-h1{font-size:20px;font-weight:600;margin:0}
.lv-head{display:flex;align-items:flex-end;flex-wrap:wrap;gap:12px;margin-bottom:16px}
.lv-section{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:4px 18px;margin-bottom:16px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base))}
.lv-section h3{font-size:14px;margin:14px 0 2px}
.lv-section .lv-subtle{margin-bottom:6px}
.lv-srow{display:flex;align-items:center;gap:16px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2)}
.lv-srow:first-of-type{border-top:0}
.lv-srow>.l{flex:1;min-width:0}
.lv-srow>.l b{font-weight:500;display:block}
.lv-chips{display:flex;flex-wrap:wrap;gap:6px}
.lv-chips button{transition:border-color var(--lv-dur) var(--lv-ease),color var(--lv-dur) var(--lv-ease),background-color var(--lv-dur) var(--lv-ease);height:28px;padding:0 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l4);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer}
.lv-chips button.on{border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);font-weight:500;background:var(--dsw-alias-interactive-bg-hover)}
.lv-end{height:1px}
.lv-banner{animation:lv-in var(--lv-slow) var(--lv-ease-out);display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;background:var(--dsw-alias-card-fill);margin-bottom:16px}
`

const TABS = [['works', '作品'], ['platform', '官方风格'], ['mine', '我的风格'], ['settings', '设置']]

export function ManagePage() {
  const [tab, setTab] = React.useState(host.tab || 'works')
  // 从哪个对话跳过来的；用户离开管理页就清掉，下次从侧栏直接进来时不会冒出旧的来源
  const [from, setFrom] = React.useState(host.from)
  React.useEffect(() => {
    host.setTab = setTab
    host.tab = null
    host.setFrom = setFrom
    host.from = null
    const off = watchPanel(() => setFrom(null))
    return () => {
      host.setTab = null
      host.setFrom = null
      off()
    }
  }, [])
  return (
    <div className="lv lv-page">
      <Styles />
      <style>{PAGE_CSS}</style>
      <div className="lv-top">
        {from ? (
          <Button size="sm" kind="ghost" onClick={() => openSession(from.sessionId)}>
            ← 返回对话{from.title ? <span className="lv-truncate" style={{ display: 'inline-block', maxWidth: 200, verticalAlign: 'bottom' }}>《{from.title}》</span> : null}
          </Button>
        ) : null}
        <span className="lv-brand"><Mark />lovideo</span>
        <nav className="lv-tabs" aria-label="lovideo">
          {TABS.map(([id, label]) => <button key={id} type="button" className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>)}
        </nav>
        <span className="lv-grow" />
        <Button kind="pri" onClick={() => startDirector('我想做一个视频：')}>做一部新片</Button>
      </div>
      <div className="lv-body">
        <div key={tab} className="lv-pane">{tab === 'works' ? <Works /> : tab === 'platform' ? <Platform /> : tab === 'mine' ? <Mine /> : <Settings />}</div>
      </div>
    </div>
  )
}

/* ---------- 作品 ---------- */

function Works() {
  const [data] = useLive('works', () => true)
  const [sel, setSel] = React.useState(null)
  const works = data?.works || []
  const current = works.find(w => w.id === sel) || null
  return (
    <div className={current ? 'lv-split' : ''}>
      <div>
        <div className="lv-head">
          <h1 className="lv-h1">作品</h1>
          <span className="lv-subtle">{works.length} 部 · 都在这台电脑上</span>
        </div>
        {!data ? <div className="lv-subtle lv-shimmer">读取中…</div> : !works.length ? (
          <div className="lv-empty">
            <div style={{ fontSize: 15, color: 'var(--dsw-alias-label-primary)', marginBottom: 6 }}>还没有作品</div>
            <div style={{ marginBottom: 14 }}>说一句想做什么，导演帮你选风格、出分镜，在这台电脑上做出来。</div>
            <Button kind="pri" onClick={() => startDirector('我想做一个视频：')}>做第一部片子</Button>
          </div>
        ) : (
          <div className="lv-grid" style={{ '--lv-min': '210px' }}>
            {works.map(w => (
              <button key={w.id} type="button" className={`lv-tile ${sel === w.id ? 'on' : ''}`} onClick={() => setSel(sel === w.id ? null : w.id)}>
                <Media src={fileUrl(w.poster)} chipRight={w.duration ? fmtSec(w.duration) : null} chip={w.status !== 'done' ? null : w.aspect} />
                <div className="lv-tile-title lv-truncate">{w.title}</div>
                <div className="lv-row" style={{ marginTop: 3 }}>
                  <StatusBadge status={w.status} />
                  <span className="lv-subtle lv-truncate">{w.style?.name} · {w.updatedAt.slice(5, 16).replace('T', ' ')}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      {current ? <WorkPanel id={current.id} onClose={() => setSel(null)} /> : null}
    </div>
  )
}

function WorkPanel({ id, onClose }) {
  const [w] = useLive(`works/${id}`, m => m.id === id)
  const [confirm, setConfirm] = React.useState(false)
  if (!w) return <div className="lv-side lv-subtle lv-shimmer">读取中…</div>
  const del = async () => {
    await api(`works/${id}/delete`, {})
    toast({ text: `已删除《${w.title}》` })
    onClose()
  }
  return (
    <div className="lv-side">
      <div className="lv-card">
        <div className="lv-card-head">
          <span className="lv-card-title lv-grow lv-truncate">{w.title}</span>
          <StatusBadge status={w.status} />
          <Button size="sm" kind="ghost" onClick={onClose} aria-label="关闭">✕</Button>
        </div>
        <div className="lv-card-body"><WorkBody w={w} /></div>
        <div className="lv-card-foot"><WorkActions w={w} compact /></div>
      </div>
      <div className="lv-card"><div className="lv-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="lv-row"><span className="lv-subtle" style={{ width: 56 }}>风格</span>{w.style?.name}</div>
        <div className="lv-row"><span className="lv-subtle" style={{ width: 56 }}>分镜</span>v{w.plan?.revision} · {w.scenes} 镜 · {w.aspect}</div>
        {w.film ? <div className="lv-row"><span className="lv-subtle" style={{ width: 56 }}>成片</span>{fmtSec(w.film.duration)} · {w.film.width}×{w.film.height}</div> : null}
        <div className="lv-row"><span className="lv-subtle" style={{ width: 56 }}>位置</span><span className="lv-mono lv-truncate lv-subtle" title={w.dir}>{w.dir}</span></div>
        {w.exports?.length ? <div className="lv-row" style={{ alignItems: 'flex-start' }}><span className="lv-subtle" style={{ width: 56 }}>导出</span><span className="lv-grow">{w.exports.slice(-3).reverse().map(e => <div key={e.path} className="lv-truncate lv-subtle" title={e.path}>{e.kind === 'mp4' ? `MP4 ${e.quality}` : '剪映工程'} · {e.path.split(/[\\/]/).pop()}</div>)}</span></div> : null}
        <div className="lv-row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
          {w.sessionId ? <Button size="sm" onClick={() => openSession(w.sessionId)}>回到对话</Button> : <Button size="sm" onClick={() => startDirector(`继续改我的作品《${w.title}》（work_id: ${w.id}）：`)}>在对话里改</Button>}
          <Button size="sm" kind="ghost" onClick={() => api(`works/${id}/reveal`, {})}>在文件夹中显示</Button>
          <span className="lv-grow" />
          {confirm ? <><span className="lv-subtle">删除后不能恢复</span><Button size="sm" onClick={() => setConfirm(false)}>取消</Button><Button size="sm" kind="pri" onClick={del}>删除</Button></> : <Button size="sm" kind="ghost" onClick={() => setConfirm(true)}>删除</Button>}
        </div>
      </div></div>
    </div>
  )
}

/* ---------- 官方风格 ---------- */

/** 「AI 帮你推荐」的草稿：带上页面上已选的画幅和搜索词，用户在冒号后面补一句想做什么再发出 */
function recommendPrompt(q, aspect) {
  const want = [aspect === '9:16' ? '竖版 9:16' : aspect === '16:9' ? '横版 16:9' : '', q.trim() ? `和「${q.trim()}」有关` : ''].filter(Boolean).join('，')
  return `不知道用哪个风格，帮我从官方风格里推荐几个${want ? `（${want}）` : ''}。我想做的视频是：`
}

function Platform() {
  const [data, , reload] = useLive('styles', () => false)
  const [st] = useLive('state', () => false)
  React.useEffect(() => seedFavorites(data?.favorites), [data])
  const [q, setQ] = React.useState('')
  const [aspect, setAspect] = React.useState('all')
  const [sel, setSel] = React.useState(null)
  const [count, setCount] = React.useState(BATCH)
  const top = React.useRef(null)
  const end = React.useRef(null)
  const list = (data?.platform || []).filter(s => (!q || `${s.name}${s.use || ''}${s.description || ''}`.includes(q)) && (aspect === 'all' || (s.aspects || []).includes(aspect)))
  // 选中的风格可能还没滚出来，详情栏照样显示它，所以从筛选后的完整列表里找
  const current = list.find(s => s.slug === sel)
  const shown = list.slice(0, count)
  const more = shown.length < list.length
  // 搜索词或画幅一变，结果换了一批，从头开始显示
  const filter = fn => v => {
    fn(v)
    setCount(BATCH)
    top.current?.closest('.lv-body')?.scrollTo({ top: 0 })
  }
  // 列表底部的哨兵快进入视野（提前 400px）就多显示一批；每显示一批重新观察一次，
  // 所以屏幕很高、一批填不满时会接着往下补，直到铺满或没有更多
  React.useEffect(() => {
    const el = end.current
    if (!el || !more) return undefined
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) setCount(c => c + BATCH)
    }, { root: el.closest('.lv-body'), rootMargin: '0px 0px 400px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [more, count])
  return (
    <div className={current ? 'lv-split' : ''}>
      <div ref={top}>
        <div className="lv-head">
          <h1 className="lv-h1">官方风格</h1>
          <span className="lv-subtle">{data?.platform?.length || 0} 个 · 注册即免费 · 用到时下载到本机</span>
          <span className="lv-grow" />
          <Button onClick={() => startDirector(recommendPrompt(q, aspect))} title="说说你想做什么视频，导演从官方风格里挑几个给你选">
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.2 6.3 6.3 2.2-6.3 2.2L12 19.5l-2.2-6.3L3.5 11l6.3-2.2z" fill="#ff6b3d" /></svg>
            不知道选哪个？AI 帮你推荐
          </Button>
          <input className="lv-input" style={{ width: 200 }} placeholder="搜风格、用途…" value={q} onChange={e => filter(setQ)(e.target.value)} />
          <div className="lv-seg">{[['all', '全部'], ['16:9', '16:9'], ['9:16', '9:16']].map(([k, l]) => <button key={k} type="button" className={aspect === k ? 'on' : ''} onClick={() => filter(setAspect)(k)}>{l}</button>)}</div>
        </div>
        {st && !st.login.account ? <LoginBanner onDone={reload} /> : null}
        {data?.offline ? <div className="lv-banner"><span className="lv-grow">现在连不上 lovideo.ai，显示的是上次的风格列表。</span><Button size="sm" onClick={reload}>重试</Button></div> : null}
        {!data ? <div className="lv-subtle lv-shimmer">读取中…</div> : (
          <>
            <div className="lv-grid">
              {shown.map(s => <StyleTile key={s.slug} s={s} selected={sel === s.slug} onSelect={() => setSel(sel === s.slug ? null : s.slug)} />)}
            </div>
            {!list.length ? <div className="lv-subtle">没有符合的风格。</div> : null}
            {more ? <div ref={end} className="lv-end" aria-hidden="true" /> : null}
          </>
        )}
      </div>
      {current ? <StylePanel s={current} onClose={() => setSel(null)} /> : null}
    </div>
  )
}

/** 官方风格每次多显示几张：24 张能排满 3、4、6 列的整行 */
const BATCH = 24

function LoginBanner({ onDone }) {
  const [st, , reload] = useLive('state', () => false)
  const pending = st?.login?.pending
  React.useEffect(() => {
    if (!pending) return
    const t = setInterval(reload, 1000)
    return () => clearInterval(t)
  }, [pending, reload])
  React.useEffect(() => {
    if (st?.login?.account) onDone?.()
  }, [st?.login?.account, onDone])
  const login = async () => {
    const r = await api('login', {})
    if (r.pending?.url) openExternal(loginUrl(r.pending.url))
    reload()
  }
  return (
    <div className="lv-banner">
      <span className="lv-grow">{pending ? <>已在浏览器打开 lovideo.ai，确认页面上的代码是 <b className="lv-mono">{pending.userCode}</b> 后点「允许」。</> : '登录 lovideo 后就能用这些风格（注册即免费）。'}</span>
      {pending ? <LinkButton size="sm" kind="pri" href={loginUrl(pending.url)}>重新打开</LinkButton> : <Button size="sm" kind="pri" onClick={login}>登录</Button>}
    </div>
  )
}

function StylePanel({ s, onClose }) {
  return (
    <div className="lv-side">
      <div className="lv-card">
        {s.sample ? <video src={s.sample} poster={coverOf(s) || undefined} controls muted loop style={{ width: '100%', display: 'block', background: '#000' }} /> : <Media src={coverOf(s)} style={{ borderRadius: 0 }} />}
        <div className="lv-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="lv-row"><span className="lv-card-title lv-grow">{s.name}</span><Button size="sm" kind="ghost" onClick={onClose} aria-label="关闭">✕</Button></div>
          {s.description ? <div className="lv-muted">{s.description}</div> : null}
          <div className="lv-row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {(s.aspects || []).map(a => <Badge key={a}>{a}</Badge>)}
            {s.fps ? <Badge>{s.fps} fps</Badge> : null}
            {s.gpu ? <Badge>3D 绘制</Badge> : null}
            {s.source === 'mine' ? <Badge tone="info">我的风格</Badge> : s.installed ? <Badge tone="ok">已在本机</Badge> : null}
          </div>
          <Button kind="pri" size="lg" onClick={() => startDirector(`用「${s.name}」风格（${s.slug}）做一个视频：`)}>用这个风格开拍</Button>
          <span className="lv-subtle">会开一个「lovideo 导演」对话，把你想讲的说给导演就行。</span>
        </div>
      </div>
    </div>
  )
}

/* ---------- 我的风格 ---------- */

function Mine() {
  const [data, , reload] = useLive('styles', () => false, 3000)
  const [sel, setSel] = React.useState(null)
  const mine = data?.mine || []
  const current = mine.find(s => s.slug === sel)
  return (
    <div className={current ? 'lv-split' : ''}>
      <div>
        <div className="lv-head">
          <h1 className="lv-h1">我的风格</h1>
          <span className="lv-subtle">从喜欢的视频蒸馏出来的风格，只在这台电脑上</span>
          <span className="lv-grow" />
          <Button kind="pri" onClick={() => startDirector('把这段视频蒸馏成我的风格（把参考视频拖进来），想保留的特点是：')}>蒸馏新风格</Button>
        </div>
        {!data ? <div className="lv-subtle lv-shimmer">读取中…</div> : !mine.length ? (
          <div className="lv-empty">
            <div style={{ fontSize: 15, color: 'var(--dsw-alias-label-primary)', marginBottom: 6 }}>还没有自己的风格</div>
            <div>把一段喜欢的视频拖进对话，说「蒸馏成我的风格」，导演会在这台电脑上看参考、写画法、出样片。</div>
          </div>
        ) : (
          <div className="lv-grid">
            {mine.map(s => (
              <button key={s.slug} type="button" className={`lv-tile ${sel === s.slug ? 'on' : ''}`} onClick={() => setSel(sel === s.slug ? null : s.slug)}>
                <Media src={coverOf(s) || (s.distill?.sheet ? fileUrl(`styles/mine/${s.slug}/file/${s.distill.sheet}`) : null)} chip={s.draft ? (s.distill?.state === 'failed' ? '没成功' : s.distill?.state === 'done' ? '待保存' : '蒸馏中') : null} />
                <div className="lv-tile-title lv-truncate">{s.name}</div>
                <div className="lv-subtle lv-truncate">{(s.aspects || []).join(' · ')}</div>
              </button>
            ))}
          </div>
        )}
      </div>
      {current ? <MinePanel s={current} onClose={() => setSel(null)} reload={reload} /> : null}
    </div>
  )
}

function MinePanel({ s, onClose, reload }) {
  const file = rel => fileUrl(`styles/mine/${s.slug}/file/${rel}`)
  const samples = s.distill?.samples || []
  const [confirm, setConfirm] = React.useState(false)
  return (
    <div className="lv-side">
      <div className="lv-card">
        {samples[0] ? <video src={file(samples[0].file)} poster={file(samples[0].poster)} controls muted loop style={{ width: '100%', display: 'block', background: '#000' }} /> : <Media src={coverOf(s)} style={{ borderRadius: 0 }} />}
        <div className="lv-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="lv-row"><span className="lv-card-title lv-grow">{s.name}</span><Button size="sm" kind="ghost" onClick={onClose} aria-label="关闭">✕</Button></div>
          {s.description ? <div className="lv-muted">{s.description}</div> : null}
          {s.distill?.error ? <div className="lv-err">{s.distill.error}</div> : null}
          {samples[1] ? <video src={file(samples[1].file)} poster={file(samples[1].poster)} controls muted loop style={{ width: 120, borderRadius: 8, background: '#000' }} /> : null}
          {s.draft && s.distill?.state === 'done' ? <Button kind="pri" onClick={() => api(`styles/mine/${s.slug}/save`, {}).then(() => { toast({ text: `「${s.name}」已保存到我的风格` }); reload() }, e => toast({ text: e.message, tone: 'warning' }))}>保存为我的风格</Button> : null}
          {!s.draft ? <Button kind="pri" size="lg" onClick={() => startDirector(`用我的风格「${s.name}」（${s.slug}）做一个视频：`)}>用它开拍</Button> : null}
          <div className="lv-row">
            <span className="lv-grow" />
            {confirm ? <><Button size="sm" onClick={() => setConfirm(false)}>取消</Button><Button size="sm" kind="pri" onClick={() => api(`styles/mine/${s.slug}/delete`, {}).then(() => { toast({ text: `已删除风格「${s.name}」` }); onClose(); reload() }, e => toast({ text: e.message, tone: 'warning' }))}>删除</Button></> : <Button size="sm" kind="ghost" onClick={() => setConfirm(true)}>删除</Button>}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------- 设置 ---------- */

function Settings() {
  const [st, , reload, setSt] = useLive('state', () => false)
  const [models] = useLive('models', () => false)
  const [form, setForm] = React.useState(null)
  const [askLogout, setAskLogout] = React.useState(false)
  const [loggingOut, setLoggingOut] = React.useState(false)
  const [voiceRev, setVoiceRev] = React.useState(0)
  const logout = async () => {
    setLoggingOut(true)
    try {
      await api('logout', {})
      setAskLogout(false)
      toast({ text: '已退出 lovideo' })
      reload()
    } finally {
      setLoggingOut(false)
    }
  }
  React.useEffect(() => {
    if (st && !form) setForm({ exportDir: st.settings.exportDir, parallel: st.settings.parallel, model: st.settings.model })
  }, [st, form])
  if (!st || !form) return <div className="lv-subtle lv-shimmer">读取中…</div>
  // 在「这台电脑」里一键下载完离线配音、配乐时，配音配乐会在后台切过去：重新读一次
  const syncVoice = async () => {
    setSt(await api('state'))
    setVoiceRev(n => n + 1)
  }
  const save = async patch => {
    try {
      setSt(await api('settings', patch))
      toast({ text: '设置已保存' })
    } catch (e) {
      toast({ text: e.message, tone: 'warning' })
    }
  }
  const pickModel = e => {
    const val = e.target.value
    const m = val ? JSON.parse(val) : null
    setForm(f => ({ ...f, model: m }))
    save({ model: m })
  }
  return (
    <div style={{ maxWidth: 760 }}>
      <div className="lv-head"><h1 className="lv-h1">设置</h1><span className="lv-subtle">电脑上有的用你自己的；key 只存在这台电脑上，不上传 lovideo。</span></div>

      <div className="lv-section">
        <h3>lovideo 账号</h3>
        <div className="lv-srow">
          <div className="l"><b>{st.login.account ? st.login.account.email || '已登录' : '未登录'}</b><span className="lv-subtle">{st.login.account ? '平台风格免费使用' : '登录后可以用平台上的风格（注册即免费）'}</span></div>
          {st.login.account ? <Button size="sm" onClick={() => setAskLogout(true)}>退出</Button> : null}
        </div>
        {!st.login.account ? <LoginBanner onDone={reload} /> : null}
      </div>

      <div className="lv-section">
        <h3>这台电脑</h3>
        <div style={{ padding: '8px 0 12px' }}><Doctor onVoiceChange={syncVoice} /></div>
      </div>

      <div className="lv-section">
        <h3>模型</h3>
        <div className="lv-srow">
          <div className="l"><b>导演和制作用的模型</b><span className="lv-subtle">默认跟随 DeepSeek Harness 当前选的模型</span></div>
          <select className="lv-select" style={{ width: 300 }} value={form.model ? JSON.stringify(form.model) : ''} onChange={pickModel}>
            <option value="">跟随 DeepSeek Harness{st.model && !form.model ? `（${st.model.label}）` : ''}</option>
            {(models?.models || []).map(m => <option key={`${m.provider}/${m.model}`} value={JSON.stringify({ provider: m.provider, model: m.model })}>{m.label}（{m.provider}）</option>)}
          </select>
        </div>
      </div>

      <SoundSettings key={voiceRev} st={st} onState={setSt} />

      <div className="lv-section">
        <h3>制作和导出</h3>
        <div className="lv-srow">
          <div className="l"><b>最多同时渲染几段</b><span className="lv-subtle">越多越快，也越占电脑；默认 4 段</span></div>
          <select className="lv-select" style={{ width: 'auto' }} value={form.parallel || 4} onChange={e => { const n = Number(e.target.value); setForm(f => ({ ...f, parallel: n })); save({ parallel: n }) }}>
            {Array.from({ length: 10 }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n} 段{n === 4 ? '（默认）' : ''}</option>)}
          </select>
        </div>
        <div className="lv-srow">
          <div className="l"><b>导出位置</b><span className="lv-subtle lv-mono">{st.settings.exportDir}</span></div>
          <input className="lv-input lv-mono" style={{ width: 280 }} value={form.exportDir} onChange={e => setForm(f => ({ ...f, exportDir: e.target.value }))} onBlur={() => form.exportDir !== st.settings.exportDir && save({ exportDir: form.exportDir })} />
        </div>
      </div>

      <ConfirmDialog open={askLogout} title="退出 lovideo 账号？" confirmText="退出" danger busy={loggingOut} onConfirm={logout} onCancel={() => setAskLogout(false)}>
        <p>退出后不能再用官方风格开新片，要用时重新登录就行。这台电脑上的作品、你自己的风格和已经下载的风格都会保留。</p>
      </ConfirmDialog>
    </div>
  )
}

export { Player }
