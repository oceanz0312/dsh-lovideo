// 对话里的 lovideo 卡片：按工具名注册到 tool.call.toolview。
// 卡片只从工具结果里拿作品 id，内容实时读本机数据，所以和管理页、和后续的修改永远一致。
import * as React from 'react'
import { api, argsOf, fileUrl, loginUrl, openExternal, pick, resultText, useLive } from './api.js'
import { Badge, Bar, Button, Dialog, LinkButton, Mark, Media, Player, SEG, STEP, SpeedButton, Spin, StatusBadge, Styles, fmtSec, usePlaybackRate } from './ui.jsx'
import { openManager } from './host.js'
import { toast } from './toast.jsx'

/* ---------- 外框 ---------- */

function Shell({ title, right, children, foot, error }) {
  return (
    <div className="lv lv-card" style={{ margin: '4px 0' }}>
      <Styles />
      <div className="lv-card-head">
        <Mark />
        <span className="lv-card-title lv-grow lv-truncate">{title}</span>
        {right}
      </div>
      {error ? <div className="lv-card-body lv-err">{error}</div> : null}
      {children}
      {foot ? <div className="lv-card-foot">{foot}</div> : null}
    </div>
  )
}

/** 工具还在运行或出错时的通用外观 */
function Pending({ props, label }) {
  if (props.phase === 'result' && props.block.isError) {
    const msg = resultText(props.block).replace(/^Error:\s*/, '')
    // 因为没登录：给用户看的是一句话加登录按钮，登录后这张卡自己变成「已登录」；给导演的话不显示
    if (needsLogin(msg)) return <LoginBlockedCard label={label} />
    return <Shell title={label} right={<Badge tone="err">没成功</Badge>} error={msg.slice(0, 400)} />
  }
  return (
    <Shell title={label} right={<span className="lv-subtle lv-row"><Spin /> 处理中</span>} />
  )
}

const done = props => props.phase === 'result' && !props.block.isError

const LOGIN_MARK = '【需要登录】'
// 老版本发出的卡片没有记号，按原话认出来
const needsLogin = msg => msg.includes(LOGIN_MARK) || /需要.{0,4}先登录 lovideo/.test(msg)

/** 因为没登录而没做成的卡片：跟着登录状态实时变，不留一张红色的失败卡 */
function LoginBlockedCard({ label }) {
  const [st] = useLive('state', () => false, 3000)
  const ok = Boolean(st?.login?.account)
  return (
    <Shell title={label} right={ok ? <Badge tone="ok">已登录</Badge> : <Badge tone="warn">要先登录</Badge>}>
      <div className="lv-card-body"><LoginAction /></div>
    </Shell>
  )
}

/** 原地登录：登录成功后插件会通知导演接着做，用户不用再说话 */
export function LoginAction() {
  const [st, , reload] = useLive('state', () => false)
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState(null)
  const pending = st?.login?.pending
  React.useEffect(() => {
    if (!pending) return
    const t = setInterval(reload, 1000)
    return () => clearInterval(t)
  }, [pending, reload])
  if (!st) return <div className="lv-subtle lv-shimmer">正在检查…</div>
  if (st.login.account) {
    return <div className="lv-row lv-enter"><span className="lv-dot ok">✓</span><span>已登录{st.login.account.email ? ` ${st.login.account.email}` : ''}，导演正在接着做。</span></div>
  }
  const start = async () => {
    setBusy(true)
    setErr(null)
    try {
      const r = await api('login', {})
      if (r.pending?.url) openExternal(loginUrl(r.pending.url))
      reload()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="lv-col">
      <div className="lv-row">
        <span className="lv-grow">{pending ? <>已在浏览器打开 lovideo.ai，确认代码 <b className="lv-mono">{pending.userCode}</b> 后点「允许」，回来就会自动继续。</> : '这是官方风格，需要先登录 lovideo（注册即免费）。登录后会自动继续。'}</span>
        {pending ? <LinkButton size="sm" href={loginUrl(pending.url)}>重新打开</LinkButton> : <Button size="sm" kind="pri" busy={busy} onClick={start}>登录</Button>}
      </div>
      {err || st.login.error ? <div className="lv-err">{err || st.login.error}</div> : null}
    </div>
  )
}

/* ---------- 环境检查 ---------- */

export function SetupCard(props) {
  if (!done(props)) return <Pending props={props} label="检查这台电脑" />
  return <Shell title="准备好就能开拍"><div className="lv-card-body"><Doctor /></div></Shell>
}

export function Doctor() {
  const [st, , reload] = useLive('state', () => false)
  const [busy, setBusy] = React.useState(null)
  const [err, setErr] = React.useState(null)
  const setupRunning = st?.runtime?.setup?.running
  const pending = st?.login?.pending
  React.useEffect(() => {
    // 下载环境、等网站确认登录时每秒刷新一次
    if (!setupRunning && !pending) return
    const t = setInterval(reload, 1000)
    return () => clearInterval(t)
  }, [setupRunning, pending, reload])
  if (!st) return <div className="lv-subtle lv-shimmer">正在检查…</div>
  const act = async (key, fn) => {
    setBusy(key)
    setErr(null)
    try {
      await fn()
      reload()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }
  const env = st.runtime
  const login = async () => {
    const r = await api('login', {})
    if (r.pending?.url) openExternal(loginUrl(r.pending.url))
  }
  return (
    <div className="lv-doctor">
      <Row ok={Boolean(st.model)} title="模型" desc={st.model ? `跟随 DeepSeek Harness · ${st.model.label}` : 'DeepSeek Harness 里还没有可用的模型'} />
      <Row ok={env.ready} title="渲染环境"
        desc={env.ready ? `浏览器 · ffmpeg 已就绪${env.fonts?.ok ? ' · 字体已就绪' : ' · 字体在第一次开拍时自动下载（约 47 MB）'}` : setupRunning ? `正在下载${{ chrome: '浏览器', ffmpeg: ' ffmpeg', fonts: '字体' }[env.setup.step] || ''}… ${Math.round((env.setup.progress || 0) * 100)}%` : `缺 ${[!env.chrome.ok && '浏览器', !env.ffmpeg.ok && 'ffmpeg', !env.fonts?.ok && '字体'].filter(Boolean).join('、')}，约 ${(!env.chrome.ok || !env.ffmpeg.ok) ? 180 : 30} MB，点了才下载`}
        extra={setupRunning ? <div style={{ marginTop: 6 }}><Bar value={env.setup.progress} /></div> : env.setup?.error ? <div className="lv-err">{env.setup.error}</div> : null}
        action={env.ready ? null : <Button size="sm" kind="pri" busy={busy === 'setup' || setupRunning} onClick={() => act('setup', () => api('runtime/setup', {}))}>准备</Button>} />
      <Row ok={Boolean(st.login.account)} title="lovideo 账号"
        desc={st.login.account ? `已登录 ${st.login.account.email || ''} · 平台风格可用` : pending ? '已在浏览器打开 lovideo.ai，核对下面的代码后点「允许」' : '登录后可以用平台上的 100 多种风格，注册即免费'}
        extra={pending ? <div className="lv-code" style={{ marginTop: 8 }}>{pending.userCode}</div> : st.login.error ? <div className="lv-err">{st.login.error}</div> : null}
        action={st.login.account ? null : pending ? <LinkButton size="sm" href={loginUrl(pending.url)}>重新打开</LinkButton> : <Button size="sm" kind={env.ready ? 'pri' : ''} busy={busy === 'login'} onClick={() => act('login', login)}>登录</Button>} />
      <Row ok title="配音"
        desc={st.settings.voice.provider === 'system' ? '系统自带语音（可以在设置里换成自己的配音服务）' : st.settings.voice.provider === 'none' ? '不配音，只出字幕' : `${st.settings.voice.provider}${st.settings.voice.hasKey ? '' : '（还没填 key）'}`}
        action={<Button size="sm" kind="ghost" onClick={() => openManager('settings')}>设置</Button>} />
      {err ? <div className="lv-err">{err}</div> : null}
    </div>
  )
}

function Row({ ok, title, desc, action, extra }) {
  return (
    <div>
      <span className={`lv-dot ${ok ? 'ok' : 'no'}`}>{ok ? '✓' : '•'}</span>
      <div className="lv-grow">
        <div style={{ fontWeight: 500 }}>{title}</div>
        <div className="lv-subtle">{desc}</div>
        {extra}
      </div>
      {action}
    </div>
  )
}

/* ---------- 推荐风格 ---------- */

export function coverOf(s) {
  if (!s) return null
  if (s.source === 'mine') return s.cover ? fileUrl(`styles/mine/${s.slug}/file/${s.cover}`) : null
  return s.cover || null
}

export function StylesCard(props) {
  const args = argsOf(props.block)
  const [data] = useLive(done(props) ? 'styles' : null, () => false)
  if (!done(props)) return <Pending props={props} label="挑风格" />
  const all = data ? [...data.mine, ...data.platform] : []
  const picks = (args.recommend || []).map(slug => all.find(s => s.slug === slug)).filter(Boolean)
  if (!picks.length) {
    return <Shell title="风格库" right={<Button size="sm" kind="ghost" onClick={() => openManager('platform')}>看全部风格</Button>}>
      <div className="lv-card-body lv-subtle">{data ? `共 ${all.length} 个风格可用` : '正在读取风格…'}</div>
    </Shell>
  }
  return (
    <Shell title={`推荐 ${picks.length} 个风格`} right={<Button size="sm" kind="ghost" onClick={() => openManager('platform')}>看全部风格</Button>}>
      <div className="lv-card-body">
        <div className="lv-grid" style={{ '--lv-min': '150px' }}>
          {picks.map((s, i) => (
            <div key={s.slug}>
              <Media src={coverOf(s)} chip={i === 0 ? '最推荐' : null} chipRight={s.gpu ? '3D 绘制' : null} />
              <div className="lv-tile-title">{s.name}</div>
              <div className="lv-subtle lv-truncate">{s.source === 'mine' ? '我的风格' : s.use || (s.aspects || []).join(' · ')}</div>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  )
}

/* ---------- 分镜 ---------- */

export function PlanCard(props) {
  const id = done(props) ? pick(resultText(props.block), 'work_id') : null
  const myRev = Number((/分镜 v(\d+)/.exec(resultText(props.block)) || [])[1] || 0)
  const [w] = useLive(id ? `works/${id}` : null, m => m.id === id)
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState(null)
  const [open, setOpen] = React.useState(false)
  if (!done(props)) return <Pending props={props} label={argsOf(props.block).work_id ? '改分镜' : '出分镜'} />
  if (!w) return <Shell title="分镜" right={<span className="lv-subtle lv-shimmer">读取中…</span>} />
  const latest = w.plan?.revision === myRev
  const scenes = latest ? w.plan.scenes : null
  const secs = w.plan.scenes.reduce((n, s) => n + (s.seconds || 0), 0)
  const started = w.status !== 'draft'
  const confirm = async () => {
    setBusy(true)
    setErr(null)
    try {
      await api(`works/${id}/produce`, { action: 'start' })
    } catch (e) {
      setErr(e.code === 'runtime_missing' ? '这台电脑的渲染环境还没准备好，先在下面的检查里点「准备」' : e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Shell
      title={<span className="lv-row">{w.title}<Badge>分镜 v{myRev}</Badge>{latest && w.plan.note ? <Badge tone="info">{w.plan.note}</Badge> : null}{latest && started ? <StatusBadge status={w.status} /> : null}</span>}
      right={<span className="lv-subtle lv-mono">{w.plan.scenes.length} 镜 · 约 {secs} 秒 · {w.aspect}</span>}
      foot={latest ? (
        <>
          <span className="lv-grow lv-subtle lv-truncate">风格「{w.style?.name}」 · {w.voice?.enabled === false ? '不配音' : '配音'} · 在这台电脑上制作，约 {Math.max(2, Math.round(w.plan.scenes.length * 1.2))} 分钟</span>
          {started ? null : <Button kind="pri" busy={busy} onClick={confirm}>确认开拍</Button>}
        </>
      ) : <span className="lv-subtle">已经有新版本（v{w.plan.revision}），看下面最新的分镜卡</span>}
    >
      {err ? <div className="lv-card-body lv-err" style={{ paddingBottom: 0 }}>{err}</div> : null}
      {latest && started ? (
        <div className="lv-card-body" style={{ borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
          <WorkBody w={w} />
          <div className="lv-row" style={{ marginTop: 10 }}><WorkActions w={w} /></div>
        </div>
      ) : null}
      {scenes && started ? (
        <button type="button" className="lv-btn ghost sm" style={{ margin: '8px 10px' }} onClick={() => setOpen(o => !o)}>{open ? '收起分镜' : `看分镜（${scenes.length} 镜）`}</button>
      ) : null}
      {scenes && (!started || open) ? (
        // 只有用户点「看分镜」展开时才淡入；卡片本身出现时不播动画（对话滚动时卡片会反复挂载）
        <div className={`lv-scenes ${started ? 'lv-enter' : ''}`}>
          {scenes.map((s, i) => (
            <div className="lv-scene" key={s.id}>
              <span className="n lv-mono">{String(i + 1).padStart(2, '0')}</span>
              <span className="t">{s.title}</span>
              <span className="lv-subtle lv-mono">约 {s.seconds} 秒</span>
              <span className="d">{s.description}</span>
              {s.narration ? <span className="v">{s.narration}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </Shell>
  )
}

/* ---------- 制作进度和成片 ---------- */

export function WorkCard(props) {
  const id = done(props) ? pick(resultText(props.block), 'work_id') : null
  if (!done(props)) return <Pending props={props} label={props.toolName === 'lovideo_revise' ? '修改成片' : '开拍'} />
  return <LiveWork id={id} />
}

export function LiveWork({ id, compact }) {
  const [w, error] = useLive(id ? `works/${id}` : null, m => m.id === id)
  if (error) return <Shell title="作品" error={error.message} />
  if (!w) return <Shell title="作品" right={<span className="lv-subtle lv-shimmer">读取中…</span>} />
  return (
    <Shell title={w.title} right={<span className="lv-row"><StatusBadge status={w.status} />{w.film ? <span className="lv-subtle lv-mono">{fmtSec(w.film.duration)}</span> : null}</span>}
      foot={<WorkActions w={w} compact={compact} />}>
      <div className="lv-card-body"><WorkBody w={w} /></div>
    </Shell>
  )
}

export function WorkBody({ w }) {
  // 做好的段可以先点开看（成片还没拼好时）
  const [preview, setPreview] = React.useState(null)
  const job = w.job
  if (w.status === 'done' && w.film) {
    return <Player src={fileUrl(w.film.url)} poster={fileUrl(w.film.posterUrl)} subtitles={w.subtitles} hidden={w.subtitlesHidden} portrait={w.aspect === '9:16'} />
  }
  if (!job) return <div className="lv-subtle">分镜还没确认开拍。</div>
  const segs = job.segments || []
  const shown = segs.find(s => s.id === preview && s.state === 'done' && s.video) || null
  return (
    <div className="lv" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="lv-row">
        <span style={{ fontWeight: 500 }}>{STEP[job.state] || job.state}</span>
        {segs.length ? <span className="lv-subtle">{segs.filter(s => s.state === 'done').length}/{segs.length} 段</span> : null}
        <span className="lv-grow" />
        {job.modelCalls ? <span className="lv-subtle">模型调用 {job.modelCalls} 次</span> : null}
      </div>
      <Bar value={job.progress} />
      {shown ? <SegmentPreview key={shown.id} seg={shown} portrait={w.aspect === '9:16'} onClose={() => setPreview(null)} /> : null}
      {segs.length ? (
        <div className="lv-segs" style={{ gridTemplateColumns: `repeat(${Math.min(6, Math.max(3, segs.length))}, minmax(0,1fr))` }}>
          {segs.map(s => {
            const ready = s.state === 'done' && s.video
            const media = (
              <Media src={fileUrl(s.poster)} portrait={w.aspect === '9:16'} chip={String(s.idx).padStart(2, '0')}
                style={s.state === 'done' ? null : { opacity: 0.55 }}>
                {ready ? <span className="lv-play"><i /></span> : null}
              </Media>
            )
            return (
            <div key={s.id}>
              {ready ? (
                <button type="button" className={`lv-seg-tile ${preview === s.id ? 'on' : ''}`} title={`播放第 ${s.idx} 镜`}
                  onClick={() => setPreview(p => (p === s.id ? null : s.id))}>{media}</button>
              ) : media}
              <div className="lv-subtle lv-row" style={{ marginTop: 3, fontSize: 11.5 }}>
                {s.state === 'render' || s.state === 'draw' ? <Spin /> : null}
                {s.state === 'done' ? `${(s.frames / (job.fps || 30)).toFixed(1)}s${s.carried ? ' · 沿用' : ''}` : s.state === 'render' ? `渲染 ${Math.round(((s.rendered || 0) / s.frames) * 100)}%` : SEG[s.state] || s.state}
                {s.attempts > 1 && s.state !== 'done' ? ` · 第 ${s.attempts} 次` : ''}
              </div>
            </div>
            )
          })}
        </div>
      ) : null}
      {job.error ? <div className="lv-err">{job.error}</div> : null}
      {w.status === 'producing' ? <div className="lv-subtle">做好一段显示一段。关掉 DeepSeek Harness 会自动暂停，下次打开接着做。</div> : null}
    </div>
  )
}

/**
 * 单段预览：画面和这一段的配音一起播。成片里配音从这一段开头 0.3 秒处开始，这里照同样的偏移对齐。
 * 字幕和配乐要等拼成片时才加。
 */
const VOICE_DELAY = 0.3
function SegmentPreview({ seg, portrait, onClose }) {
  const video = React.useRef(null)
  const audio = React.useRef(null)
  const timer = React.useRef(null)
  // 倍速同时作用在画面和配音上
  const speed = usePlaybackRate(video, audio)
  const sync = React.useCallback(() => {
    const v = video.current
    const a = audio.current
    if (!v || !a) return
    clearTimeout(timer.current)
    if (v.paused) {
      a.pause()
      return
    }
    const at = v.currentTime - VOICE_DELAY
    if (at < 0) {
      a.pause()
      a.currentTime = 0
      timer.current = setTimeout(() => !v.paused && a.play().catch(() => {}), (-at / (v.playbackRate || 1)) * 1000)
    } else if (at < (a.duration || Infinity)) {
      a.currentTime = at
      a.play().catch(() => {})
    } else a.pause()
  }, [])
  React.useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <div className="lv-preview">
      <div className="lv-row">
        <span style={{ fontWeight: 500 }}>第 {seg.idx} 镜 · {seg.title}</span>
        <span className="lv-subtle">单段预览，字幕和配乐在拼成片时加上</span>
        <span className="lv-grow" />
        <Button size="sm" kind="ghost" onClick={onClose}>收起</Button>
      </div>
      <div className={`lv-player ${portrait ? 'p' : ''}`}>
        <video ref={video} src={fileUrl(seg.video)} poster={fileUrl(seg.poster)} controls autoPlay playsInline
          onLoadedMetadata={speed.apply} onPlay={sync} onPause={sync} onSeeked={sync} onEnded={sync} onRateChange={sync} />
        <SpeedButton rate={speed.rate} onNext={speed.next} />
      </div>
      {seg.voiceUrl ? <audio ref={audio} src={fileUrl(seg.voiceUrl)} preload="auto" /> : null}
    </div>
  )
}

/**
 * 「在剪映中打开」：先检查剪映装没装、草稿目录、权限、是不是正开着，有问题先用对话框说清楚；
 * 没问题就生成草稿、导入剪映草稿目录、打开剪映。macOS 和 Windows 一样。
 */
function OpenInJianying({ w, disabled, onExportFolder }) {
  const [busy, setBusy] = React.useState(false)
  const [dialog, setDialog] = React.useState(null) // { kind:'problem'|'running', status }
  const [note, setNote] = React.useState(null)
  const [err, setErr] = React.useState(null)
  const run = async restart => {
    setDialog(null)
    setBusy(true)
    setErr(null)
    setNote(null)
    try {
      const r = await api(`works/${w.id}/open-jianying`, { restart })
      setNote(r.launched ? `已在剪映中打开，草稿「${r.name}」在草稿列表最上面。` : `已放进剪映草稿列表「${r.name}」，关掉剪映重新打开就能看到。`)
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }
  const start = async () => {
    setErr(null)
    setNote(null)
    try {
      const st = await api('jianying/status')
      if (st.problem) setDialog({ kind: 'problem', status: st })
      else if (st.running) setDialog({ kind: 'running', status: st })
      else run(false)
    } catch (e) {
      setErr(e.message)
    }
  }
  const close = () => setDialog(null)
  const st = dialog?.status
  return (
    <>
      <Button size="sm" busy={busy} disabled={disabled || busy} onClick={start}>{busy ? '正在放进剪映…' : '在剪映中打开'}</Button>
      {note ? <span className="lv-subtle lv-enter">{note}</span> : null}
      {err ? <span className="lv-err">{err}</span> : null}
      <Dialog open={dialog?.kind === 'problem'} title={st?.code === 'missing' ? '没有找到剪映专业版' : st?.code === 'unsupported' ? '这台电脑用不了剪映专业版' : '剪映还没准备好'} onCancel={close}
        actions={<>
          <button type="button" className="lv-btn" onClick={close}>关闭</button>
          {st?.code === 'missing' || st?.code === 'unsupported' ? <button type="button" className="lv-btn" onClick={() => { close(); onExportFolder() }}>改为导出工程文件夹</button> : null}
          {st?.code === 'missing' ? <a className="lv-btn pri" href={st.downloadUrl} target="_blank" rel="noopener noreferrer" onClick={close}>下载剪映专业版</a> : null}
          {st?.code === 'not-initialized' || st?.code === 'no-permission' ? <button type="button" className="lv-btn pri" onClick={start}>我弄好了，再试一次</button> : null}
        </>}>
        <p>{st?.problem}</p>
      </Dialog>
      <Dialog open={dialog?.kind === 'running'} title="剪映正开着" onCancel={close}
        actions={<>
          <button type="button" className="lv-btn" onClick={close}>取消</button>
          <button type="button" className="lv-btn" onClick={() => run(false)}>只导入，我自己重开</button>
          <button type="button" className="lv-btn pri" onClick={() => run(true)}>关掉剪映并打开</button>
        </>}>
        <p>新草稿要重新打开剪映才会出现在列表里。可以让我先把剪映正常关掉（它会自己保存正在编辑的草稿），导入后再打开。</p>
      </Dialog>
    </>
  )
}

export function WorkActions({ w, compact }) {
  const [busy, setBusy] = React.useState(null)
  const [err, setErr] = React.useState(null)
  const act = (key, path, body) => async () => {
    setBusy(key)
    setErr(null)
    try {
      await api(path, body)
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }
  const exp = w.exporting
  const exporting = exp?.state === 'running'
  return (
    <div className="lv-row lv-grow" style={{ flexWrap: 'wrap' }}>
      {w.status === 'producing' ? <Button size="sm" busy={busy === 'pause'} onClick={act('pause', `works/${w.id}/produce`, { action: 'pause' })}>暂停</Button> : null}
      {w.status === 'paused' || w.status === 'failed' ? <Button size="sm" kind="pri" busy={busy === 'resume'} onClick={act('resume', `works/${w.id}/produce`, { action: 'start' })}>{w.status === 'failed' ? '重试' : '继续'}</Button> : null}
      {w.status === 'done' ? (
        <>
          <Button size="sm" kind="pri" busy={exporting && exp.format !== 'jianying'} disabled={exporting} onClick={act('mp4', `works/${w.id}/export`, { format: 'mp4', quality: '1080', burn: true })}>导出 MP4</Button>
          <OpenInJianying w={w} disabled={exporting} onExportFolder={act('jy', `works/${w.id}/export`, { format: 'jianying' })} />
        </>
      ) : null}
      <span className="lv-grow" />
      {exp?.state === 'done' && exp.results?.length ? (
        exp.results.map(r => <Button key={r.path} size="sm" kind="ghost" onClick={act('reveal', `works/${w.id}/reveal`, { path: r.path })}>{r.kind === 'mp4' ? '在文件夹中显示 MP4' : '打开剪映工程文件夹'}</Button>)
      ) : null}
      {exp?.state === 'failed' ? <span className="lv-err">{exp.error}</span> : null}
      {!compact ? <Button size="sm" kind="ghost" onClick={() => openManager('works')}>作品库</Button> : null}
      {err ? <span className="lv-err" style={{ width: '100%' }}>{err}</span> : null}
    </div>
  )
}

/* ---------- 导出 ---------- */

export function ExportCard(props) {
  const id = done(props) ? pick(resultText(props.block), 'work_id') : null
  const [w] = useLive(id ? `works/${id}` : null, m => m.id === id)
  if (!done(props)) return <Pending props={props} label="导出中" />
  const said = resultText(props.block)
  if (/已在剪映中打开|已导入剪映草稿/.test(said)) {
    return (
      <Shell title="在剪映中打开" right={<Badge tone="ok">剪映草稿</Badge>}>
        <div className="lv-card-body">{said.split('\n').slice(1).join(' ')}</div>
      </Shell>
    )
  }
  const results = (w?.exports || []).filter(e => e.kind !== 'jianying-open').slice(-((w?.exporting?.results || []).length || 1))
  const reveal = path => api(`works/${id}/reveal`, { path })
  return (
    <Shell title="导出完成" right={<Badge tone="ok">在这台电脑上</Badge>}>
      <div className="lv-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {results.map(r => (
          <div key={r.path} className="lv-row">
            <span className="lv-grow">
              <div style={{ fontWeight: 500 }}>{r.kind === 'mp4' ? `MP4 · ${r.quality}${r.burned ? ' · 字幕已烧进画面' : ''}` : '剪映工程'}</div>
              <div className="lv-subtle lv-mono lv-truncate" title={r.path}>{r.path}</div>
              {r.kind === 'jianying' ? <div className="lv-subtle">在装了剪映的电脑上，退出剪映后双击文件夹里的导入脚本（macOS：install_mac.command，Windows：install_windows.bat），再打开剪映就能看到。</div> : null}
            </span>
            <Button size="sm" onClick={() => reveal(r.path)}>在文件夹中显示</Button>
          </div>
        ))}
      </div>
    </Shell>
  )
}

/* ---------- 作品列表 ---------- */

export function WorksCard(props) {
  const [data] = useLive(done(props) ? 'works' : null, () => true)
  if (!done(props)) return <Pending props={props} label="找作品" />
  const list = (data?.works || []).slice(0, 4)
  return (
    <Shell title="最近的作品" right={<Button size="sm" kind="ghost" onClick={() => openManager('works')}>全部作品</Button>}>
      <div className="lv-card-body">
        <div className="lv-grid" style={{ '--lv-min': '140px' }}>
          {list.map(w => (
            <div key={w.id}>
              <Media src={fileUrl(w.poster)} chipRight={w.duration ? fmtSec(w.duration) : null} />
              <div className="lv-tile-title lv-truncate">{w.title}</div>
              <StatusBadge status={w.status} />
            </div>
          ))}
        </div>
      </div>
    </Shell>
  )
}

/* ---------- 蒸馏 ---------- */

export function DistillCard(props) {
  const slug = done(props) ? pick(resultText(props.block), 'style_slug') : null
  const [data, , reload] = useLive(slug ? 'styles' : null, () => false, 2000)
  const [busy, setBusy] = React.useState(false)
  if (!done(props)) return <Pending props={props} label="蒸馏风格" />
  const s = data?.mine.find(x => x.slug === slug)
  if (!s) return <Shell title="蒸馏风格" right={<span className="lv-subtle lv-shimmer">读取中…</span>} />
  const d = s.distill || {}
  const STEPS = [['look', '看参考'], ['write', '写画法'], ['sample', '出样片'], ['done', '完成']]
  const at = STEPS.findIndex(x => x[0] === d.step)
  const file = rel => fileUrl(`styles/mine/${slug}/file/${rel}`)
  const save = async () => {
    setBusy(true)
    try {
      await api(`styles/mine/${slug}/save`, {})
      toast({ text: `「${s.name}」已保存到我的风格` })
      reload()
    } catch (e) {
      toast({ text: e.message, tone: 'warning' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Shell title={s.name} right={d.state === 'failed' ? <Badge tone="err">没成功</Badge> : s.draft === false ? <Badge tone="ok">已保存到我的风格</Badge> : d.state === 'done' ? <Badge tone="ok">样片好了</Badge> : <Badge tone="warn">蒸馏中</Badge>}
      foot={d.state === 'done' && s.draft !== false ? <><span className="lv-grow lv-subtle">满意就保存，以后出分镜时可以直接用它。</span><Button kind="pri" busy={busy} onClick={save}>保存为我的风格</Button></> : s.draft === false ? <><span className="lv-grow lv-subtle">以后做视频时说「用{s.name}」就行。</span><Button size="sm" kind="ghost" onClick={() => openManager('mine')}>我的风格</Button></> : null}
      error={d.state === 'failed' ? d.error : null}>
      <div className="lv-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="lv-row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {STEPS.map(([k, label], i) => (
            <Badge key={k} tone={i < at || d.state === 'done' ? 'ok' : i === at && d.state === 'running' ? 'warn' : ''}>
              {i === at && d.state === 'running' ? <Spin /> : i < at || d.state === 'done' ? '✓' : null} {label}
            </Badge>
          ))}
        </div>
        {d.features ? <div className="lv-row" style={{ gap: 4 }}>{d.features.palette.map(p => <span key={p.hex} title={p.hex} style={{ width: 22, height: 22, borderRadius: 6, background: p.hex, border: '1px solid var(--dsw-alias-border-l2)' }} />)}<span className="lv-subtle" style={{ marginLeft: 6 }}>参考里的主色</span></div> : null}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 96px', gap: 10, alignItems: 'start' }}>
          {d.samples?.[0] ? <video className="lv-media" src={file(d.samples[0].file)} poster={file(d.samples[0].poster)} controls muted loop style={{ width: '100%', borderRadius: 8 }} /> : d.sheet ? <Media src={file(d.sheet)} chip="参考" /> : <Media />}
          {d.samples?.[1] ? <video src={file(d.samples[1].file)} poster={file(d.samples[1].poster)} controls muted loop style={{ width: '100%', borderRadius: 8, aspectRatio: '9/16', background: '#000' }} /> : <Media portrait />}
        </div>
      </div>
    </Shell>
  )
}

export const TOOL_VIEWS = {
  lovideo_setup: SetupCard,
  lovideo_styles: StylesCard,
  lovideo_plan: PlanCard,
  lovideo_produce: WorkCard,
  lovideo_revise: WorkCard,
  lovideo_export: ExportCard,
  lovideo_works: WorksCard,
  lovideo_distill: DistillCard,
}
