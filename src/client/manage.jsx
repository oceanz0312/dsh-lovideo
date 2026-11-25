// 侧栏「lovideo 视频」：作品、官方风格、我的风格、设置。随时点开看，和对话里的卡片读同一份数据。
import * as React from 'react'
import { api, fileUrl, openExternal, useLive } from './api.js'
import { Badge, Button, LinkButton, Mark, Media, Player, StatusBadge, Styles, fmtSec } from './ui.jsx'
import { Doctor, WorkActions, WorkBody, coverOf } from './cards.jsx'
import { host, openSession, startDirector } from './host.js'

const PAGE_CSS = `
.lv-page{height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}
.lv-top{display:flex;align-items:center;gap:18px;height:52px;padding:0 24px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
.lv-brand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:15px}
.lv-tabs{display:flex;gap:4px;align-self:stretch}
.lv-tabs button{border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13.5px;padding:0 10px;cursor:pointer;border-bottom:2px solid transparent}
.lv-tabs button.on{color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--dsw-alias-label-primary)}
.lv-body{flex:1;min-height:0;overflow:auto;padding:22px 24px 40px}
.lv-split{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:22px;align-items:start}
.lv-side{position:sticky;top:0;display:flex;flex-direction:column;gap:12px}
.lv-h1{font-size:20px;font-weight:600;margin:0}
.lv-head{display:flex;align-items:flex-end;gap:12px;margin-bottom:16px}
.lv-section{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:4px 18px;margin-bottom:16px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base))}
.lv-section h3{font-size:14px;margin:14px 0 2px}
.lv-section .lv-subtle{margin-bottom:6px}
.lv-srow{display:flex;align-items:center;gap:16px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2)}
.lv-srow:first-of-type{border-top:0}
.lv-srow>.l{flex:1;min-width:0}
.lv-srow>.l b{font-weight:500;display:block}
.lv-chips{display:flex;flex-wrap:wrap;gap:6px}
.lv-chips button{height:28px;padding:0 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l4);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer}
.lv-chips button.on{border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);font-weight:500;background:var(--dsw-alias-interactive-bg-hover)}
.lv-banner{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;background:var(--dsw-alias-card-fill);margin-bottom:16px}
`

const TABS = [['works', '作品'], ['platform', '官方风格'], ['mine', '我的风格'], ['settings', '设置']]

export function ManagePage() {
  const [tab, setTab] = React.useState(host.tab || 'works')
  React.useEffect(() => {
    host.setTab = setTab
    host.tab = null
    return () => {
      host.setTab = null
    }
  }, [])
  return (
    <div className="lv lv-page">
      <Styles />
      <style>{PAGE_CSS}</style>
      <div className="lv-top">
        <span className="lv-brand"><Mark />lovideo</span>
        <nav className="lv-tabs" aria-label="lovideo">
          {TABS.map(([id, label]) => <button key={id} type="button" className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>)}
        </nav>
        <span className="lv-grow" />
        <Button kind="pri" onClick={() => startDirector('我想做一个视频：')}>做一部新片</Button>
      </div>
      <div className="lv-body">
        {tab === 'works' ? <Works /> : tab === 'platform' ? <Platform /> : tab === 'mine' ? <Mine /> : <Settings />}
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

function Platform() {
  const [data, , reload] = useLive('styles', () => false)
  const [st] = useLive('state', () => false)
  const [q, setQ] = React.useState('')
  const [aspect, setAspect] = React.useState('all')
  const [sel, setSel] = React.useState(null)
  const list = (data?.platform || []).filter(s => (!q || `${s.name}${s.use || ''}${s.description || ''}`.includes(q)) && (aspect === 'all' || (s.aspects || []).includes(aspect)))
  const current = list.find(s => s.slug === sel)
  return (
    <div className={current ? 'lv-split' : ''}>
      <div>
        <div className="lv-head">
          <h1 className="lv-h1">官方风格</h1>
          <span className="lv-subtle">{data?.platform?.length || 0} 个 · 注册即免费 · 用到时下载到本机</span>
          <span className="lv-grow" />
          <input className="lv-input" style={{ width: 200 }} placeholder="搜风格、用途…" value={q} onChange={e => setQ(e.target.value)} />
          <div className="lv-seg">{[['all', '全部'], ['16:9', '16:9'], ['9:16', '9:16']].map(([k, l]) => <button key={k} type="button" className={aspect === k ? 'on' : ''} onClick={() => setAspect(k)}>{l}</button>)}</div>
        </div>
        {st && !st.login.account ? <LoginBanner onDone={reload} /> : null}
        {data?.offline ? <div className="lv-banner"><span className="lv-grow">现在连不上 lovideo.ai，显示的是上次的风格列表。</span><Button size="sm" onClick={reload}>重试</Button></div> : null}
        {!data ? <div className="lv-subtle lv-shimmer">读取中…</div> : (
          <div className="lv-grid">
            {list.map(s => (
              <button key={s.slug} type="button" className={`lv-tile ${sel === s.slug ? 'on' : ''}`} onClick={() => setSel(sel === s.slug ? null : s.slug)}>
                <Media src={coverOf(s)} chip={s.installed ? '已在本机' : null} chipRight={s.gpu ? '需要独立显卡' : null} />
                <div className="lv-tile-title lv-truncate">{s.name}</div>
                <div className="lv-subtle lv-truncate">{[s.use, (s.aspects || []).join(' · ')].filter(Boolean).join(' · ')}</div>
              </button>
            ))}
          </div>
        )}
      </div>
      {current ? <StylePanel s={current} onClose={() => setSel(null)} /> : null}
    </div>
  )
}

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
    if (r.pending?.url) openExternal(r.pending.url)
    reload()
  }
  return (
    <div className="lv-banner">
      <span className="lv-grow">{pending ? <>已在浏览器打开 lovideo.ai，确认页面上的代码是 <b className="lv-mono">{pending.userCode}</b> 后点「允许」。</> : '登录 lovideo 后就能用这些风格（注册即免费）。'}</span>
      {pending ? <LinkButton size="sm" kind="pri" href={pending.url}>重新打开</LinkButton> : <Button size="sm" kind="pri" onClick={login}>登录</Button>}
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
            {s.gpu ? <Badge tone="warn">需要独立显卡</Badge> : <Badge>CPU 即可</Badge>}
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
          {s.draft && s.distill?.state === 'done' ? <Button kind="pri" onClick={() => api(`styles/mine/${s.slug}/save`, {}).then(reload)}>保存为我的风格</Button> : null}
          {!s.draft ? <Button kind="pri" size="lg" onClick={() => startDirector(`用我的风格「${s.name}」（${s.slug}）做一个视频：`)}>用它开拍</Button> : null}
          <div className="lv-row">
            <span className="lv-grow" />
            {confirm ? <><Button size="sm" onClick={() => setConfirm(false)}>取消</Button><Button size="sm" kind="pri" onClick={() => api(`styles/mine/${s.slug}/delete`, {}).then(() => { onClose(); reload() })}>删除</Button></> : <Button size="sm" kind="ghost" onClick={() => setConfirm(true)}>删除</Button>}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------- 设置 ---------- */

const VOICES = [['system', '系统自带语音'], ['doubao', '豆包语音'], ['openai', 'OpenAI 兼容'], ['elevenlabs', 'ElevenLabs'], ['none', '不配音']]
const VOICE_HINT = {
  system: { url: null, voice: '留空自动选（中文用系统的中文声音）', model: null },
  doubao: { url: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', voice: '资源/音色，例如 seed-tts-2.0/zh_female_vv_uranus_bigtts', model: null },
  openai: { url: 'https://api.openai.com/v1', voice: '音色，例如 alloy', model: '模型，例如 gpt-4o-mini-tts' },
  elevenlabs: { url: null, voice: 'voice_id', model: '模型，例如 eleven_multilingual_v2' },
  none: { url: null, voice: null, model: null },
}

function Settings() {
  const [st, , reload, setSt] = useLive('state', () => false)
  const [models] = useLive('models', () => false)
  const [form, setForm] = React.useState(null)
  const [msg, setMsg] = React.useState(null)
  const [busy, setBusy] = React.useState(null)
  React.useEffect(() => {
    if (st && !form) setForm({ voice: { ...st.settings.voice, key: '' }, exportDir: st.settings.exportDir, parallel: st.settings.parallel, model: st.settings.model })
  }, [st, form])
  if (!st || !form) return <div className="lv-subtle lv-shimmer">读取中…</div>
  const v = form.voice
  const hint = VOICE_HINT[v.provider]
  const save = async patch => {
    setBusy('save')
    setMsg(null)
    try {
      const next = await api('settings', patch)
      setSt(next)
      setMsg({ ok: true, text: '已保存' })
      setForm(f => ({ ...f, voice: { ...next.settings.voice, key: '' } }))
    } catch (e) {
      setMsg({ ok: false, text: e.message })
    } finally {
      setBusy(null)
    }
  }
  const test = async () => {
    setBusy('test')
    setMsg(null)
    try {
      await api('settings', { voice: v })
      const r = await api('settings/test-voice', { text: '你好，这是 lovideo 的配音试听。' })
      setMsg({ ok: true, text: `试听 ${r.seconds.toFixed(1)} 秒`, audio: fileUrl(r.url) })
    } catch (e) {
      setMsg({ ok: false, text: e.message })
    } finally {
      setBusy(null)
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
      <div className="lv-head"><h1 className="lv-h1">设置</h1><span className="lv-subtle">电脑上有的用你自己的；key 只存在这台电脑上，不上传 lovideo，也不发给模型。</span></div>

      <div className="lv-section">
        <h3>这台电脑</h3>
        <div style={{ padding: '8px 0 12px' }}><Doctor /></div>
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

      <div className="lv-section">
        <h3>配音</h3>
        <div className="lv-subtle">电脑上没有好用的配音服务时，填你自己的 key；不想要口播就选「不配音」，只出字幕。</div>
        <div className="lv-srow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          <div className="lv-chips">{VOICES.map(([k, l]) => <button key={k} type="button" className={v.provider === k ? 'on' : ''} onClick={() => setForm(f => ({ ...f, voice: { ...f.voice, provider: k } }))}>{l}</button>)}</div>
          {hint.url ? <div className="lv-field"><label>接口地址（留空用默认）</label><input className="lv-input lv-mono" placeholder={hint.url} value={v.url || ''} onChange={e => setForm(f => ({ ...f, voice: { ...f.voice, url: e.target.value } }))} /></div> : null}
          <div style={{ display: 'grid', gridTemplateColumns: hint.model ? '1fr 1fr' : '1fr', gap: 10 }}>
            {hint.voice ? <div className="lv-field"><label>音色</label><input className="lv-input" placeholder={hint.voice} value={v.voice || ''} onChange={e => setForm(f => ({ ...f, voice: { ...f.voice, voice: e.target.value } }))} /></div> : null}
            {hint.model ? <div className="lv-field"><label>模型</label><input className="lv-input" placeholder={hint.model} value={v.model || ''} onChange={e => setForm(f => ({ ...f, voice: { ...f.voice, model: e.target.value } }))} /></div> : null}
          </div>
          {v.provider !== 'system' && v.provider !== 'none' ? (
            <div className="lv-field"><label>密钥 {st.settings.voice.hasKey && st.settings.voice.provider === v.provider ? `（已保存 ${st.settings.voice.key}，留空不改）` : ''}</label>
              <input className="lv-input" type="password" autoComplete="off" placeholder="填你自己的 key" value={v.key} onChange={e => setForm(f => ({ ...f, voice: { ...f.voice, key: e.target.value } }))} /></div>
          ) : null}
          <div className="lv-row">
            <Button kind="pri" busy={busy === 'save'} onClick={() => save({ voice: v })}>保存</Button>
            {v.provider !== 'none' ? <Button busy={busy === 'test'} onClick={test}>试听</Button> : null}
            {msg ? <span className={msg.ok ? 'lv-subtle' : 'lv-err'}>{msg.text}</span> : null}
            {msg?.audio ? <audio src={msg.audio} controls autoPlay style={{ height: 30 }} /> : null}
          </div>
        </div>
      </div>

      <div className="lv-section">
        <h3>制作和导出</h3>
        <div className="lv-srow">
          <div className="l"><b>同时渲染几段</b><span className="lv-subtle">越多越快，也越占电脑</span></div>
          <div className="lv-seg">{[1, 2, 3, 4].map(n => <button key={n} type="button" className={form.parallel === n ? 'on' : ''} onClick={() => { setForm(f => ({ ...f, parallel: n })); save({ parallel: n }) }}>{n}</button>)}</div>
        </div>
        <div className="lv-srow">
          <div className="l"><b>导出位置</b><span className="lv-subtle lv-mono">{st.settings.exportDir}</span></div>
          <input className="lv-input lv-mono" style={{ width: 280 }} value={form.exportDir} onChange={e => setForm(f => ({ ...f, exportDir: e.target.value }))} onBlur={() => form.exportDir !== st.settings.exportDir && save({ exportDir: form.exportDir })} />
        </div>
      </div>

      <div className="lv-section">
        <h3>lovideo 账号</h3>
        <div className="lv-srow">
          <div className="l"><b>{st.login.account ? st.login.account.email || '已登录' : '未登录'}</b><span className="lv-subtle">{st.login.account ? '平台风格免费使用' : '登录后可以用平台上的风格（注册即免费）'}</span></div>
          {st.login.account ? <Button size="sm" onClick={() => api('logout', {}).then(reload)}>退出</Button> : null}
        </div>
        {!st.login.account ? <LoginBanner onDone={reload} /> : null}
      </div>
    </div>
  )
}

export { Player }
