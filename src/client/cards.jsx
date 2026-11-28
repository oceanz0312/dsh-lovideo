// 对话里的 lovideo 卡片：按工具名注册到 tool.call.toolview。
// 卡片只从工具结果里拿作品 id，内容实时读本机数据，所以和管理页、和后续的修改永远一致。
import * as React from 'react'
import { api, argsOf, fileUrl, loginUrl, openExternal, pick, resultText, useLive, whileProducing } from './api.js'
import { Badge, Bar, Button, Dialog, LinkButton, Mark, Media, Player, SpeedButton, Spin, StatusBadge, Styles, Switch, durLabel, fmtSec, segLabel, stepLabel, usePlaybackRate } from './ui.jsx'
import { openManager } from './host.js'
import { toast } from './toast.jsx'
import { KeyCard, ListenButton, jobText, musicName, voiceName } from './sound-settings.jsx'
import { rich, t, useT } from './i18n.js'

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
  const t = useT()
  if (props.phase === 'result' && props.block.isError) {
    const msg = resultText(props.block).replace(/^Error:\s*/, '')
    // 因为没登录：给用户看的是一句话加登录按钮，登录后这张卡自己变成「已登录」；给导演的话不显示
    if (needsLogin(msg)) return <LoginBlockedCard label={label} />
    // 导演自己能改好的错（分镜太长、参数不对）不给用户看，导演改好再调用会出新卡片
    if (isFixable(msg)) return null
    return <Shell title={label} right={<Badge tone="err">{t('common.failed')}</Badge>} error={msg.slice(0, 400)} />
  }
  return (
    <Shell title={label} right={<span className="lv-subtle lv-row"><Spin /> {t('card.working')}</span>} />
  )
}

const done = props => props.phase === 'result' && !props.block.isError

const LOGIN_MARK = '【需要登录】'
// 老版本发出的卡片没有记号，按原话认出来
const needsLogin = msg => msg.includes(LOGIN_MARK) || /需要.{0,4}先登录 lovideo/.test(msg)

const FIX_MARK = '【请改好后再调用】'
// 老版本发出的退回没有记号，按原话认出来
export const isFixable = msg => msg.includes(FIX_MARK) || /长太多|最多 \d+ 镜|口播太短|^缺少 |应该是|只能是|不能小于|不能大于|未知参数/.test(msg)

/** 因为没登录而没做成的卡片：跟着登录状态实时变，不留一张红色的失败卡 */
function LoginBlockedCard({ label }) {
  const t = useT()
  const [st] = useLive('state', () => false, 3000)
  const ok = Boolean(st?.login?.account)
  return (
    <Shell title={label} right={ok ? <Badge tone="ok">{t('settings.signedIn')}</Badge> : <Badge tone="warn">{t('card.needLogin')}</Badge>}>
      <div className="lv-card-body"><LoginAction /></div>
    </Shell>
  )
}

/** 原地登录：登录成功后插件会通知导演接着做，用户不用再说话 */
export function LoginAction() {
  const t = useT()
  const [st, , reload] = useLive('state', () => false)
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState(null)
  const pending = st?.login?.pending
  React.useEffect(() => {
    if (!pending) return
    const timer = setInterval(reload, 1000)
    return () => clearInterval(timer)
  }, [pending, reload])
  if (!st) return <div className="lv-subtle lv-shimmer">{t('card.checking')}</div>
  if (st.login.account) {
    return <div className="lv-row lv-enter"><span className="lv-dot ok">✓</span><span>{st.login.account.email ? t('login.doneEmail', { email: st.login.account.email }) : t('login.done')}</span></div>
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
        <span className="lv-grow">{pending ? rich(t('login.pendingResume'), { code: <b className="lv-mono">{pending.userCode}</b> }) : t('login.needed')}</span>
        {pending ? <LinkButton size="sm" href={loginUrl(pending.url)}>{t('common.reopen')}</LinkButton> : <Button size="sm" kind="pri" busy={busy} onClick={start}>{t('common.login')}</Button>}
      </div>
      {err || st.login.error ? <div className="lv-err">{err || st.login.error}</div> : null}
    </div>
  )
}

/* ---------- 环境检查 ---------- */

export function SetupCard(props) {
  const t = useT()
  if (!done(props)) return <Pending props={props} label={t('tool.setup')} />
  return <Shell title={t('setup.title')}><div className="lv-card-body"><Doctor /></div></Shell>
}

export function Doctor({ onVoiceChange } = {}) {
  const t = useT()
  const [st, , reload] = useLive('state', () => false)
  const [busy, setBusy] = React.useState(null)
  const [err, setErr] = React.useState(null)
  const setupRunning = st?.runtime?.setup?.running
  const pending = st?.login?.pending
  React.useEffect(() => {
    // 下载环境、等网站确认登录时每秒刷新一次
    if (!setupRunning && !pending) return
    const timer = setInterval(reload, 1000)
    return () => clearInterval(timer)
  }, [setupRunning, pending, reload])
  if (!st) return <div className="lv-subtle lv-shimmer">{t('card.checking')}</div>
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
      <Row ok={Boolean(st.model)} title={t('common.model')} desc={st.model ? t('setup.modelFollow', { label: st.model.label }) : t('setup.noModel')} />
      <Row ok={env.ready} title={t('setup.runtime')}
        desc={env.ready ? t('setup.ready', { fonts: env.fonts?.ok ? t('setup.fontsReady') : t('setup.fontsLater') }) : setupRunning ? t('setup.downloading', { what: { chrome: t('setup.browser'), ffmpeg: t('setup.ffmpegStep'), fonts: t('setup.fonts') }[env.setup.step] || '', pct: Math.round((env.setup.progress || 0) * 100) }) : t('setup.missing', { list: [!env.chrome.ok && t('setup.browser'), !env.ffmpeg.ok && 'ffmpeg', !env.fonts?.ok && t('setup.fonts')].filter(Boolean).join(t('common.listSep')), mb: (!env.chrome.ok || !env.ffmpeg.ok) ? 180 : 30 })}
        extra={setupRunning ? <div style={{ marginTop: 6 }}><Bar value={env.setup.progress} /></div> : env.setup?.error ? <div className="lv-err">{env.setup.error}</div> : null}
        action={env.ready ? null : <Button size="sm" kind="pri" busy={busy === 'setup' || setupRunning} onClick={() => act('setup', () => api('runtime/setup', {}))}>{t('setup.prepare')}</Button>} />
      <Row ok={Boolean(st.login.account)} title={t('settings.account')}
        desc={st.login.account ? t('setup.loggedIn', { email: st.login.account.email || '' }) : pending ? t('setup.loginPending') : t('setup.loginHint')}
        extra={pending ? <div className="lv-code" style={{ marginTop: 8 }}>{pending.userCode}</div> : st.login.error ? <div className="lv-err">{st.login.error}</div> : null}
        action={st.login.account ? null : pending ? <LinkButton size="sm" href={loginUrl(pending.url)}>{t('common.reopen')}</LinkButton> : <Button size="sm" kind={env.ready ? 'pri' : ''} busy={busy === 'login'} onClick={() => act('login', login)}>{t('common.login')}</Button>} />
      <SoundRow settings={st.settings} onChange={() => { reload(); onVoiceChange?.() }} />
      {err ? <div className="lv-err">{err}</div> : null}
    </div>
  )
}

/**
 * 配音和配乐这一行。默认的离线配音（Kokoro）、离线配乐（Stable Audio 3）还没下载时，给一个按钮两样一起下，
 * 装好自动用上；换服务、换模型、换声音去设置页。
 */
function SoundRow({ settings, onChange }) {
  const t = useT()
  const voice = useLocalStatus('voice', onChange)
  const music = useLocalStatus('music', onChange)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const settingsBtn = <Button size="sm" kind="ghost" onClick={() => openManager('settings')}>{t('manage.tab.settings')}</Button>
  const vp = settings.voice.provider
  const mp = settings.music.provider
  const keys = settings.keys || {}
  const activeName = d => d?.models.find(m => m.id === d.active)?.name
  const noKey = name => t('sound.noKey', { name })
  const voiceDesc = vp === 'local' ? (activeName(voice) ? `${voiceName('local')} · ${activeName(voice)}` : t('soundRow.voiceNotDownloaded'))
    : vp === 'doubao' || vp === 'elevenlabs' || vp === 'openai' ? (keys[vp] ? voiceName(vp) : noKey(voiceName(vp))) : voiceName(vp)
  const musicDesc = mp === 'local' ? (activeName(music) ? `${musicName('local')} · ${activeName(music)}` : t('soundRow.musicNotDownloaded'))
    : mp === 'volcengine' ? (keys.volcAk && keys.volcSk ? musicName('volcengine') : noKey(musicName('volcengine'))) : mp === 'elevenlabs' ? (keys.elevenlabs ? 'ElevenLabs' : noKey('ElevenLabs')) : musicName(mp)
  // 一键下载会下哪些：用得上（选的是离线或系统语音）、还没装、这台电脑跑得动的默认模型
  const want = (d, wanted) => {
    if (!d || !wanted || !d.minimum.ok || d.models.some(m => m.installed)) return null
    const m = d.models.find(x => x.id === d.defaultModel)
    return m && m.ok && !m.installed ? m : null
  }
  const needs = [['voice', want(voice, vp === 'local' || vp === 'system')], ['music', want(music, mp === 'local')]].filter(([, m]) => m)
  const jobs = [voice, music].flatMap(d => (d?.models || []).filter(m => m.job?.running).map(m => ({ kind: d.kind, m })))
  const failed = [voice, music].flatMap(d => (d?.models || []).filter(m => !m.job?.running && m.job?.error).map(m => t('soundRow.failed', { name: m.name, error: m.job.error })))
  const download = async () => {
    setBusy(true)
    setError(null)
    try {
      await api('local-voice/setup-defaults', {})
      voice.reload()
      music.reload()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  const gb = Math.round(needs.reduce((n, [, m]) => n + (m.downloadGB || 0), 0) * 10) / 10
  const dl = needs.length === 2 ? 'soundRow.downloadBoth' : needs[0]?.[0] === 'music' ? 'soundRow.downloadMusic' : 'soundRow.downloadVoice'
  return (
    <Row ok title={t('soundRow.title')}
      desc={t('soundRow.desc', { voice: voiceDesc, music: musicDesc, hint: needs.length && !jobs.length ? t('soundRow.hint') : '' })}
      extra={jobs.length || failed.length || error ? (
        <div className="lv-col" style={{ marginTop: 6, gap: 6 }}>
          {jobs.map(({ kind, m }) => (
            <div key={m.id}>
              <div className="lv-subtle">{t('soundRow.job', { what: kind === 'music' ? musicName('local') : voiceName('local'), name: m.name, step: jobText(m.job) })}</div>
              {m.job.step === 'model' ? <Bar value={m.job.progress} /> : null}
            </div>
          ))}
          {failed.map(t => <div key={t} className="lv-err">{t}</div>)}
          {error ? <div className="lv-err">{error}</div> : null}
        </div>
      ) : null}
      action={<div className="lv-row" style={{ gap: 6 }}>{needs.length && !jobs.length ? <Button size="sm" kind="pri" busy={busy} onClick={download}>{t(dl, { gb })}</Button> : null}{settingsBtn}</div>} />
  )
}

/** 离线配音或配乐的状态：有模型在下载时每秒刷新，下完时通知外面（装好会自动用上） */
function useLocalStatus(kind, onDone) {
  const [data, , reload] = useLive(kind === 'music' ? 'local-voice?kind=music' : 'local-voice', () => false,
    d => (d?.models?.some(m => m.job?.running) ? 1000 : 0))
  const running = (data?.models || []).some(m => m.job?.running)
  const was = React.useRef(false)
  React.useEffect(() => {
    if (was.current && !running) onDone?.()
    was.current = running
  }, [running])
  return data ? { ...data, reload } : { kind, reload, models: [], minimum: { ok: false } }
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
  const t = useT()
  const args = argsOf(props.block)
  const [data] = useLive(done(props) ? 'styles' : null, () => false)
  const { chosen, busy, err, choose } = useStylePick(props.callId, done(props) ? pick(resultText(props.block), 'session_id') : null)
  if (!done(props)) return <Pending props={props} label={t('tool.styles')} />
  const all = data ? [...data.mine, ...data.platform] : []
  const picks = (args.recommend || []).map(slug => all.find(s => s.slug === slug)).filter(Boolean)
  const sessionId = pick(resultText(props.block), 'session_id')
  if (!picks.length) {
    return <Shell title={t('styles.library')} right={<Button size="sm" kind="ghost" onClick={() => openManager('platform')}>{t('styles.all')}</Button>}>
      <div className="lv-card-body lv-subtle">{data ? t('styles.looking', { n: all.length }) : t('styles.loading')}</div>
    </Shell>
  }
  return (
    <Shell title={t('styles.recommended', { n: picks.length })} right={<Button size="sm" kind="ghost" onClick={() => openManager('platform')}>{t('styles.all')}</Button>}>
      <div className="lv-card-body">
        <div className="lv-grid" style={{ '--lv-min': '150px' }}>
          {picks.map((s, i) => (
            <button key={s.slug} type="button" className={`lv-tile ${chosen === s.slug ? 'on' : ''}`} disabled={!sessionId || busy} onClick={() => choose(s)} title={sessionId ? t('styles.useTitle', { name: s.name }) : undefined}>
              <Media src={coverOf(s)} chip={chosen === s.slug ? t('styles.chosen') : i === 0 ? t('styles.top') : null} chipRight={s.gpu ? t('style.gpu') : null} />
              <div className="lv-tile-title">{s.name}</div>
              <div className="lv-subtle lv-truncate">{s.source === 'mine' ? t('style.mineBadge') : s.use || (s.aspects || []).join(' · ')}</div>
              {args.why?.[i] ? <div className="lv-style-why">{args.why[i]}</div> : null}
            </button>
          ))}
        </div>
        {sessionId ? <div className="lv-subtle" style={{ marginTop: 10 }}>{chosen ? t('styles.told', { name: picks.find(s => s.slug === chosen)?.name || chosen }) : t('styles.pickHint')}</div> : null}
        {err ? <div className="lv-err" style={{ marginTop: 6 }}>{err}</div> : null}
      </div>
    </Shell>
  )
}

/** 推荐卡片上点选风格：叫这个会话的导演用它出分镜（选过的记在本机，刷新后还在） */
function useStylePick(callId, sessionId) {
  const key = `lovideo-pick-${callId}`
  const [chosen, setChosen] = React.useState(() => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  })
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState(null)
  const choose = async s => {
    if (!sessionId || s.slug === chosen) return
    setBusy(true)
    setErr(null)
    try {
      await api('styles/pick', { sessionId, slug: s.slug })
      setChosen(s.slug)
      try {
        localStorage.setItem(key, s.slug)
      } catch {
        // 存不了就只在这次页面里记着
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }
  return { chosen, busy, err, choose }
}

/* ---------- 分镜 ---------- */

export function PlanCard(props) {
  const t = useT()
  const id = done(props) ? pick(resultText(props.block), 'work_id') : null
  const myRev = Number((/分镜 v(\d+)/.exec(resultText(props.block)) || [])[1] || 0)
  const [w] = useLive(id ? `works/${id}` : null, m => m.id === id, whileProducing)
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState(null)
  const [open, setOpen] = React.useState(false)
  if (!done(props)) return <Pending props={props} label={argsOf(props.block).work_id ? t('plan.revising') : t('tool.plan')} />
  if (!w) return <Shell title={t('work.plan')} right={<span className="lv-subtle lv-shimmer">{t('common.loading')}</span>} />
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
      setErr(e.code === 'runtime_missing' ? t('plan.runtimeMissing') : e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Shell
      title={<span className="lv-row">{w.title}<Badge>{t('plan.version', { rev: myRev })}</Badge>{latest && w.plan.note ? <Badge tone="info">{w.plan.note}</Badge> : null}{latest && started ? <StatusBadge status={w.status} /> : null}</span>}
      right={<span className="lv-subtle lv-mono">{t('plan.summary', { n: w.plan.scenes.length, secs, aspect: w.aspect })}</span>}
      foot={latest ? (
        <>
          {err
            ? <span className="lv-grow lv-err">{err}</span>
            : <span className="lv-grow lv-subtle lv-truncate">{t('plan.foot', { name: w.style?.name || '', min: Math.max(2, Math.round(w.plan.scenes.length * 1.2)) })}</span>}
          {started ? null : <Button kind="pri" busy={busy} onClick={confirm}>{t('plan.confirm')}</Button>}
        </>
      ) : <span className="lv-subtle">{t('plan.outdated', { rev: w.plan.revision })}</span>}
    >
      {latest && started ? (
        <div className="lv-card-body" style={{ borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
          <WorkBody w={w} />
          <div className="lv-row" style={{ marginTop: 10 }}><WorkActions w={w} /></div>
        </div>
      ) : null}
      {latest && !started ? <PlanOptions w={w} /> : null}
      {scenes && started ? (
        <button type="button" className="lv-btn ghost sm" style={{ margin: '8px 10px' }} onClick={() => setOpen(o => !o)}>{open ? t('plan.collapse') : t('plan.expand', { n: scenes.length })}</button>
      ) : null}
      {scenes && (!started || open) ? (
        // 只有用户点「看分镜」展开时才淡入；卡片本身出现时不播动画（对话滚动时卡片会反复挂载）
        <div className={`lv-scenes ${started ? 'lv-enter' : ''}`}>
          {scenes.map((s, i) => (
            <div className="lv-scene" key={s.id}>
              <span className="n lv-mono">{String(i + 1).padStart(2, '0')}</span>
              <span className="t">{s.title}</span>
              <span className="lv-subtle lv-mono">{t('plan.sceneSecs', { s: s.seconds })}</span>
              <span className="d">{s.description}</span>
              {s.narration ? <span className="v">{s.narration}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </Shell>
  )
}

/* ---------- 成片下面的配音、配乐、字幕开关 ---------- */

/**
 * 关掉就不播放、导出的 MP4 和剪映工程里也没有。字幕马上生效；配音、配乐要按开关重新拼一遍成片（几秒），
 * 拼好播放器接着原来的位置播。这部片子还没有配乐时，打开配乐就按导演写的描述现做一首。
 */
function FilmSwitches({ w }) {
  const t = useT()
  const [busy, setBusy] = React.useState(null)
  const [err, setErr] = React.useState(null)
  const sw = w.switches || {}
  const remix = w.remix
  const working = remix && remix.state !== 'failed'
  const set = async (key, value) => {
    setBusy(key)
    setErr(null)
    try {
      await api(`works/${w.id}/switches`, { [key]: value })
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }
  const items = [
    ['voice', t('common.voice'), sw.voice],
    ['subtitles', t('common.subtitles'), sw.subtitles],
    // 没配乐的片子也给开关：打开就现做一首
    ['music', t('common.music'), sw.music],
  ].filter(([k]) => k === 'music' || sw[k] !== undefined)
  return (
    <div className="lv-switches">
      {items.map(([k, label, on]) => (
        <label key={k}>
          {label}
          <Switch checked={Boolean(on)} busy={busy === k || (working && remix.keys?.includes(k))} disabled={Boolean(working) && !remix.keys?.includes(k)} label={label} onChange={v => set(k, v)} />
        </label>
      ))}
      {working ? <span className="lv-subtle"><Spin /> {remix.state === 'music' ? t('film.makingMusic') : t('film.remixing')}</span> : null}
      {remix?.state === 'failed' ? <span className="lv-err">{remix.error}</span> : err ? <span className="lv-err">{err}</span> : null}
    </div>
  )
}

/* ---------- 分镜卡上的时长、配音、配乐、字幕 ---------- */

// 和后端 works.js 的 FILM_DURATIONS 一样：1 分钟内每 10 秒、1–5 分钟每 30 秒、5–10 分钟每分钟一档
const DURATIONS = [10, 20, 30, 40, 50, 60, 90, 120, 150, 180, 210, 240, 270, 300, 360, 420, 480, 540, 600]
const nearestIdx = n => DURATIONS.reduce((best, d, i) => (Math.abs(d - n) < Math.abs(DURATIONS[best] - n) ? i : best), 0)

/** 片长拖动条：拖的时候只改显示，松手（或键盘调完）才提交，免得一路叫导演重出分镜 */
function DurationSlider({ value, busy, onCommit }) {
  const t = useT()
  const [idx, setIdx] = React.useState(() => nearestIdx(value))
  // 输入框里可以填不在档位上的秒数（比如 45）：没拖过时照实显示，拖了才换成档位
  const [moved, setMoved] = React.useState(false)
  React.useEffect(() => {
    setIdx(nearestIdx(value))
    setMoved(false)
  }, [value])
  const shown = moved ? DURATIONS[idx] : value
  const commit = () => {
    if (moved && DURATIONS[idx] !== value) onCommit(DURATIONS[idx])
  }
  return (
    <div className="lv-dur">
      <input type="range" min={0} max={DURATIONS.length - 1} step={1} value={idx} disabled={busy}
        aria-label={t('plan.targetDuration')} aria-valuetext={durLabel(shown)}
        style={{ '--p': `${(idx / (DURATIONS.length - 1)) * 100}%` }}
        onChange={e => {
          setIdx(Number(e.target.value))
          setMoved(true)
        }} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
      <span className="lv-dur-v">{durLabel(shown)}</span>
    </div>
  )
}

/**
 * 导演给的建议，用户在这里直接改（开拍前）。改过的记在作品上，导演再出分镜时照用户的来；
 * 改时长要重出分镜，会自动叫导演按新时长出一版。
 */
const ZH_LINE = '你好，这是 lovideo 的配音试听。'
const EN_LINE = 'Hi, this is a lovideo narration preview.'

/**
 * 分镜卡上的时长、字幕、配音、配乐（和 lovideo 网站的分镜卡一样每项一行）：
 * 配音能只给这部片子换声音（列出现在的配音服务里这部片子语言的声音，每个都能试听），配乐能换来源；
 * 两行右边都有总开关。都是开拍前改，记进这部片子的 choices。
 */
function PlanOptions({ w }) {
  const t = useT()
  // 这部片子变了、或者设置改了（换服务、填 Key、下完离线模型）都重新读
  const [sound, soundErr, reloadSound] = useLive(`works/${w.id}/sound`, msg => msg?.id === w.id || msg?.type === 'settings')
  const [busy, setBusy] = React.useState(null)
  const [err, setErr] = React.useState(null)
  const [replan, setReplan] = React.useState(null)
  const set = async (key, patch) => {
    setBusy(key)
    setErr(null)
    try {
      const r = await api(`works/${w.id}/choices`, patch)
      if (patch.duration !== undefined) setReplan(r.replanning ? patch.duration : -1)
      if ('voicePick' in patch || 'musicSource' in patch) reloadSound()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }
  const voiceOn = w.voice?.enabled !== false
  const musicOn = w.music?.enabled === true
  const subsOn = w.subtitlesOn !== false
  const v = sound?.voice
  const m = sound?.music
  const src = m?.sources.find(x => x.id === m.source)
  const preview = o => async () => {
    setErr(null)
    try {
      // 豆包、ElevenLabs 先放官方样音（不调接口、不花额度），没有样音才真念一句
      if (v.provider === 'doubao' || v.provider === 'elevenlabs') {
        const r = await api('voice/sample', { provider: v.provider, voice: o.id })
        if (r.url) return fileUrl(r.url)
      }
      const r = v.provider === 'local'
        ? await api('local-voice/preview', { model: o.model, lang: v.lang, voice: o.id })
        : await api('settings/test-voice', { provider: v.provider, voice: o.id || undefined, text: v.lang === 'en' ? EN_LINE : ZH_LINE })
      return fileUrl(r.url)
    } catch (e) {
      setErr(e.message)
      return null
    }
  }
  // 离线配乐试听：本机现做 15 秒（不花钱）；云服务没有现成样音，不给试听
  const musicPreview = x => async () => {
    setErr(null)
    try {
      return fileUrl((await api('local-voice/preview', { kind: 'music', model: x.model })).url)
    } catch (e) {
      setErr(e.message)
      return null
    }
  }
  const toSettings = <a href="#" onClick={e => { e.preventDefault(); openManager('settings') }}>{t('plan.toSettings')}</a>
  const langName = v?.lang === 'en' ? t('common.english') : t('common.chinese')
  const srcTag = x => (x.code === 'no-key' ? t('plan.srcNoKey') : x.code === 'not-installed' ? t('plan.srcNotInstalled') : t('plan.srcUnavailable'))
  return (
    <div className="lv-card-body lv-prows" style={{ paddingBottom: 0 }}>
      <div className="lv-prow">
        <span className="k">{t('plan.duration')}</span>
        <div className="m">
          <DurationSlider value={w.duration || 30} busy={busy === 'duration'} onCommit={n => set('duration', { duration: n })} />
          <span className="lv-subtle lv-truncate">{replan > 0 ? t('plan.replanning', { dur: durLabel(replan) }) : replan === -1 ? t('plan.sessionClosed') : t('plan.durationHint')}</span>
        </div>
        <span className="lv-mini">{t('common.subtitles')}<Switch checked={subsOn} busy={busy === 'subtitles'} label={t('common.subtitles')} onChange={x => set('subtitles', { subtitles: x })} /></span>
      </div>

      {/* 配音、配乐两行一个样子：名字 · 说明 · 导演建议，右边「更换」和总开关；换服务、下载、填 Key 都去设置 */}
      <div className={`lv-prow ${voiceOn ? '' : 'off'}`}>
        <span className="k">{t('common.voice')}</span>
        <div className="m">
          {!v ? <span className="lv-subtle lv-shimmer">{t('plan.loadingVoice')}</span> : voiceOn ? (
            <>
              {v.current ? <ListenButton size="round" kind="plain" label="" load={preview(v.current)} /> : null}
              <b>{v.current?.name || v.service}</b>
              <span className="lv-subtle lv-truncate">{[langName, v.current?.gender, v.current?.note, v.service].filter(Boolean).join(' · ')}</span>
            </>
          ) : (
            <><b>{t('voice.none')}</b><span className="lv-subtle">{t('plan.noVoiceDesc')}</span></>
          )}
          {w.voice?.why ? <span className="lv-subtle lv-truncate lv-why">{t(w.voice.suggested === false ? 'plan.whyNoVoice' : 'plan.whyVoice', { why: w.voice.why })}</span> : null}
        </div>
        {v ? (
          <SoundMenu busy={busy === 'voice'} head={t('plan.menuHead', { service: v.service, lang: langName })} foot={t('plan.switchService')}
            empty={v.provider === 'system' ? t('plan.systemNoChoice') : v.provider === 'openai' ? t('plan.openaiInSettings') : t('plan.noVoices')}
            items={v.options.map(o => ({
              key: o.id, name: o.name, desc: [o.gender, o.note].filter(Boolean).join(' · '), on: voiceOn && v.current?.id === o.id,
              listen: preview(o), pick: () => set('voice', { voice: true, voicePick: { provider: v.provider, id: o.id, model: o.model, lang: v.lang } }),
            }))}
            onDefault={v.picked ? () => set('voice', { voice: true, voicePick: null }) : null} defaultLabel={t('plan.useDefault')} />
        ) : null}
        <Switch checked={voiceOn} busy={busy === 'voice'} label={t('common.voice')} onChange={x => set('voice', { voice: x })} />
      </div>

      <div className={`lv-prow ${musicOn ? '' : 'off'}`}>
        <span className="k">{t('common.music')}</span>
        <div className="m">
          {musicOn ? (
            <>
              {src?.ok && src.model ? <ListenButton size="round" kind="plain" label="" load={musicPreview(src)} /> : null}
              <b>{w.music?.brief || t('common.music')}</b>
              {src ? <span className="lv-subtle lv-truncate">{[src.name, src.note].filter(Boolean).join(' · ')}</span> : null}
            </>
          ) : (
            <><b>{t('music.none')}</b><span className="lv-subtle">{t('plan.noMusicDesc')}</span></>
          )}
          <span className="lv-subtle lv-truncate lv-why">{w.music?.suggested ? t('plan.musicSuggested') : t('plan.noMusicSuggested')}</span>
        </div>
        {m ? (
          <SoundMenu busy={busy === 'music'} head={t('plan.musicMenuHead')} foot={t('plan.musicFoot')}
            items={m.sources.map(x => ({
              key: x.id, name: x.name, desc: x.note, on: musicOn && m.source === x.id, disabled: !x.ok, tag: x.ok ? null : srcTag(x),
              listen: x.ok && x.model ? musicPreview(x) : null, pick: () => set('music', { music: true, musicSource: x.id }),
            }))}
            onDefault={m.picked ? () => set('music', { music: true, musicSource: null }) : null} defaultLabel={t('plan.useDefaultMusic')} />
        ) : null}
        <Switch checked={musicOn} busy={busy === 'music'} label={t('common.music')} onChange={x => set('music', { music: x })} />
      </div>

      {voiceOn && v?.note ? <div className="lv-warn-text lv-pnote">{v.note} · {toSettings}</div> : null}
      {musicOn && src && !src.ok ? <div className="lv-warn-text lv-pnote">{t('plan.noMusicWarn', { reason: src.reason })} · {toSettings}</div> : null}
      {err || soundErr ? <div className="lv-err">{err || soundErr.message}</div> : null}
    </div>
  )
}

/**
 * 「更换」弹出层（配音、配乐共用）：只列这部片子能选的项，每项能试听；
 * 用不了的项（没下载、没填 Key）灰着、点不了；换服务、下载、填 Key 都在底部「去设置」。
 */
function SoundMenu({ busy, head, foot, empty, items, onDefault, defaultLabel }) {
  const t = useT()
  const [open, setOpen] = React.useState(false)
  const box = React.useRef(null)
  React.useEffect(() => {
    if (!open) return undefined
    const close = e => !box.current?.contains(e.target) && setOpen(false)
    const esc = e => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  const choose = fn => {
    setOpen(false)
    fn()
  }
  return (
    <span className="lv-vwrap" ref={box}>
      <Button size="sm" busy={busy} aria-expanded={open} onClick={() => setOpen(o => !o)}>{t('plan.change')} ▾</Button>
      {open ? (
        <div className="lv-vmenu" role="menu">
          <h5>{head}</h5>
          {items.length ? items.map(o => (
            <div key={o.key} role="menuitemradio" aria-checked={o.on} aria-disabled={o.disabled || undefined} tabIndex={o.disabled ? -1 : 0}
              className={`lv-vopt ${o.on ? 'on' : ''} ${o.disabled ? 'na' : ''}`}
              onClick={() => !o.disabled && choose(o.pick)} onKeyDown={e => e.key === 'Enter' && !o.disabled && choose(o.pick)}>
              {o.listen ? <span onClick={e => e.stopPropagation()}><ListenButton size="round" kind="plain" label="" load={o.listen} /></span> : <span className="lv-vgap" />}
              <b>{o.name}</b>
              {o.desc ? <span className="lv-subtle lv-truncate">{o.desc}</span> : null}
              {o.tag ? <span className="lv-vtag">{o.tag}</span> : o.on ? <span className="chk">✓</span> : null}
            </div>
          )) : <div className="lv-subtle" style={{ padding: '6px 8px' }}>{empty}</div>}
          {onDefault ? <div role="menuitem" tabIndex={0} className="lv-vopt" onClick={() => choose(onDefault)} onKeyDown={e => e.key === 'Enter' && choose(onDefault)}><span className="lv-vgap" /><b>{defaultLabel}</b></div> : null}
          <div className="lv-vfoot"><span className="lv-subtle">{foot}</span><a href="#" onClick={e => { e.preventDefault(); setOpen(false); openManager('settings') }}>{t('plan.toSettings')}</a></div>
        </div>
      ) : null}
    </span>
  )
}

/* ---------- 制作进度和成片 ---------- */

export function WorkCard(props) {
  const t = useT()
  const id = done(props) ? pick(resultText(props.block), 'work_id') : null
  if (!done(props)) return <Pending props={props} label={props.toolName === 'lovideo_revise' ? t('tool.revise') : t('tool.produce')} />
  return <LiveWork id={id} />
}

export function LiveWork({ id, compact }) {
  const t = useT()
  const [w, error] = useLive(id ? `works/${id}` : null, m => m.id === id, whileProducing)
  if (error) return <Shell title={t('card.work')} error={error.message} />
  if (!w) return <Shell title={t('card.work')} right={<span className="lv-subtle lv-shimmer">{t('common.loading')}</span>} />
  return (
    <Shell title={w.title} right={<span className="lv-row"><StatusBadge status={w.status} />{w.film ? <span className="lv-subtle lv-mono">{fmtSec(w.film.duration)}</span> : null}</span>}
      foot={<WorkActions w={w} compact={compact} />}>
      <div className="lv-card-body"><WorkBody w={w} /></div>
    </Shell>
  )
}

export function WorkBody({ w }) {
  const t = useT()
  // 做好的段可以先点开看（成片还没拼好时）
  const [preview, setPreview] = React.useState(null)
  const job = w.job
  if (w.status === 'done' && w.film) {
    return (
      <div className="lv" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Player src={fileUrl(w.film.url)} poster={fileUrl(w.film.posterUrl)} subtitles={w.subtitles} hidden={w.switches ? w.switches.subtitles === false : w.subtitlesHidden} portrait={w.aspect === '9:16'} />
        <FilmSwitches w={w} />
      </div>
    )
  }
  if (!job) return <div className="lv-subtle">{t('work.notStarted')}</div>
  const segs = job.segments || []
  const shown = segs.find(s => s.id === preview && s.state === 'done' && s.video) || null
  return (
    <div className="lv" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="lv-row">
        <span style={{ fontWeight: 500 }}>{stepLabel(job.state)}</span>
        {segs.length ? <span className="lv-subtle">{t('work.segments', { done: segs.filter(s => s.state === 'done').length, n: segs.length })}</span> : null}
        <span className="lv-grow" />
        {job.modelCalls ? <span className="lv-subtle">{t('work.modelCalls', { n: job.modelCalls })}</span> : null}
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
                <button type="button" className={`lv-seg-tile ${preview === s.id ? 'on' : ''}`} title={t('work.playScene', { n: s.idx })}
                  onClick={() => setPreview(p => (p === s.id ? null : s.id))}>{media}</button>
              ) : media}
              <div className="lv-subtle lv-row" style={{ marginTop: 3, fontSize: 11.5 }}>
                {s.state === 'render' || s.state === 'draw' || s.state === 'check' ? <Spin /> : null}
                {s.state === 'done' ? `${(s.frames / (job.fps || 30)).toFixed(1)}s${s.carried ? t('work.carried') : ''}` : s.state === 'render' ? t('work.rendering', { pct: Math.round(((s.rendered || 0) / s.frames) * 100) }) : segLabel(s.state)}
                {s.attempts > 1 && s.state !== 'done' ? t('work.attempt', { n: s.attempts }) : ''}
              </div>
            </div>
            )
          })}
        </div>
      ) : null}
      {job.music ? <div className="lv-subtle">{job.music.state === 'making' ? <><Spin /> {t('work.musicMaking')}</> : job.music.state === 'done' ? t('work.musicDone') : job.music.note}{job.music.code === 'not-installed' ? <> · <a href="#" onClick={e => { e.preventDefault(); openManager('settings') }}>{t('work.downloadMusic')}</a></> : null}</div> : null}
      {job.voiceNote ? <div className="lv-subtle">{job.voiceNote}{job.voiceNoteCode === 'not-installed' ? <> · <a href="#" onClick={e => { e.preventDefault(); openManager('settings') }}>{t('work.downloadVoice')}</a></> : null}</div> : null}
      {job.error ? <div className="lv-err">{job.error}</div> : null}
      {w.status === 'producing' ? <div className="lv-subtle">{t('work.producingHint')}</div> : null}
    </div>
  )
}

/**
 * 单段预览：画面和这一段的配音一起播。逐句配音的口播轨从段首开始（自带留白）；
 * 之前做的片子口播轨放在段首 0.3 秒处，这里照同样的偏移对齐。字幕和配乐要等拼成片时才加。
 */
function SegmentPreview({ seg, portrait, onClose }) {
  const VOICE_DELAY = seg.voice?.sentences ? 0 : 0.3
  const t = useT()
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
        <span style={{ fontWeight: 500 }}>{t('preview.head', { n: seg.idx, title: seg.title })}</span>
        <span className="lv-subtle">{t('preview.hint')}</span>
        <span className="lv-grow" />
        <Button size="sm" kind="ghost" onClick={onClose}>{t('preview.collapse')}</Button>
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
  const t = useT()
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
      setNote(t(r.launched ? 'jy.opened' : 'jy.imported', { name: r.name }))
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
      <Button size="sm" busy={busy} disabled={disabled || busy} onClick={start}>{busy ? t('jy.busy') : t('jy.open')}</Button>
      {note ? <span className="lv-subtle lv-enter">{note}</span> : null}
      {err ? <span className="lv-err">{err}</span> : null}
      <Dialog open={dialog?.kind === 'problem'} title={st?.code === 'missing' ? t('jy.missing') : st?.code === 'unsupported' ? t('jy.unsupported') : t('jy.notReady')} onCancel={close}
        actions={<>
          <button type="button" className="lv-btn" onClick={close}>{t('common.close')}</button>
          {st?.code === 'missing' || st?.code === 'unsupported' ? <button type="button" className="lv-btn" onClick={() => { close(); onExportFolder() }}>{t('jy.exportFolder')}</button> : null}
          {st?.code === 'missing' ? <a className="lv-btn pri" href={st.downloadUrl} target="_blank" rel="noopener noreferrer" onClick={close}>{t('jy.download')}</a> : null}
          {st?.code === 'not-initialized' || st?.code === 'no-permission' ? <button type="button" className="lv-btn pri" onClick={start}>{t('jy.retry')}</button> : null}
        </>}>
        <p>{st?.problem}</p>
      </Dialog>
      <Dialog open={dialog?.kind === 'running'} title={t('jy.running')} onCancel={close}
        actions={<>
          <button type="button" className="lv-btn" onClick={close}>{t('common.cancel')}</button>
          <button type="button" className="lv-btn" onClick={() => run(false)}>{t('jy.importOnly')}</button>
          <button type="button" className="lv-btn pri" onClick={() => run(true)}>{t('jy.restart')}</button>
        </>}>
        <p>{t('jy.runningBody')}</p>
      </Dialog>
    </>
  )
}

export function WorkActions({ w, compact }) {
  const t = useT()
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
      {w.status === 'producing' ? <Button size="sm" busy={busy === 'pause'} onClick={act('pause', `works/${w.id}/produce`, { action: 'pause' })}>{t('actions.pause')}</Button> : null}
      {w.status === 'paused' || w.status === 'failed' ? <Button size="sm" kind="pri" busy={busy === 'resume'} onClick={act('resume', `works/${w.id}/produce`, { action: 'start' })}>{w.status === 'failed' ? t('common.retry') : t('actions.resume')}</Button> : null}
      {w.status === 'done' ? (
        <>
          <Button size="sm" kind="pri" busy={exporting && exp.format !== 'jianying'} disabled={exporting} onClick={act('mp4', `works/${w.id}/export`, { format: 'mp4', quality: '1080', burn: true })}>{t('actions.exportMp4')}</Button>
          <OpenInJianying w={w} disabled={exporting} onExportFolder={act('jy', `works/${w.id}/export`, { format: 'jianying' })} />
        </>
      ) : null}
      <span className="lv-grow" />
      {exp?.state === 'done' && exp.results?.length ? (
        exp.results.map(r => <Button key={r.path} size="sm" kind="ghost" onClick={act('reveal', `works/${w.id}/reveal`, { path: r.path })}>{r.kind === 'mp4' ? t('actions.revealMp4') : t('actions.revealJianying')}</Button>)
      ) : null}
      {exp?.state === 'failed' ? <span className="lv-err">{exp.error}</span> : null}
      {!compact ? <Button size="sm" kind="ghost" onClick={() => openManager('works')}>{t('actions.library')}</Button> : null}
      {err ? <span className="lv-err" style={{ width: '100%' }}>{err}</span> : null}
    </div>
  )
}

/* ---------- 导出 ---------- */

export function ExportCard(props) {
  const t = useT()
  const id = done(props) ? pick(resultText(props.block), 'work_id') : null
  const [w] = useLive(id ? `works/${id}` : null, m => m.id === id)
  if (!done(props)) return <Pending props={props} label={t('export.running')} />
  const said = resultText(props.block)
  if (/已在剪映中打开|已导入剪映草稿/.test(said)) {
    return (
      <Shell title={t('jy.open')} right={<Badge tone="ok">{t('export.jyDraft')}</Badge>}>
        <div className="lv-card-body">{said.split('\n').slice(1).join(' ')}</div>
      </Shell>
    )
  }
  const results = (w?.exports || []).filter(e => e.kind !== 'jianying-open').slice(-((w?.exporting?.results || []).length || 1))
  const reveal = path => api(`works/${id}/reveal`, { path })
  return (
    <Shell title={t('export.done')} right={<Badge tone="ok">{t('export.local')}</Badge>}>
      <div className="lv-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {results.map(r => (
          <div key={r.path} className="lv-row">
            <span className="lv-grow">
              <div style={{ fontWeight: 500 }}>{r.kind === 'mp4' ? `MP4 · ${r.quality}${r.burned ? t('export.burned') : ''}` : t('work.jianyingProject')}</div>
              <div className="lv-subtle lv-mono lv-truncate" title={r.path}>{r.path}</div>
              {r.kind === 'jianying' ? <div className="lv-subtle">{t('export.jyHint')}</div> : null}
            </span>
            <Button size="sm" onClick={() => reveal(r.path)}>{t('common.reveal')}</Button>
          </div>
        ))}
      </div>
    </Shell>
  )
}

/* ---------- 作品列表 ---------- */

export function WorksCard(props) {
  const t = useT()
  const [data] = useLive(done(props) ? 'works' : null, () => true)
  if (!done(props)) return <Pending props={props} label={t('tool.works')} />
  const list = (data?.works || []).slice(0, 4)
  return (
    <Shell title={t('worksCard.title')} right={<Button size="sm" kind="ghost" onClick={() => openManager('works')}>{t('worksCard.all')}</Button>}>
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
  const t = useT()
  const slug = done(props) ? pick(resultText(props.block), 'style_slug') : null
  const [data, , reload] = useLive(slug ? 'styles' : null, () => false, 2000)
  const [busy, setBusy] = React.useState(false)
  if (!done(props)) return <Pending props={props} label={t('tool.distill')} />
  const s = data?.mine.find(x => x.slug === slug)
  if (!s) return <Shell title={t('tool.distill')} right={<span className="lv-subtle lv-shimmer">{t('common.loading')}</span>} />
  const d = s.distill || {}
  const STEPS = [['look', t('distill.look')], ['write', t('distill.write')], ['sample', t('distill.sample')], ['done', t('step.done')]]
  const at = STEPS.findIndex(x => x[0] === d.step)
  const file = rel => fileUrl(`styles/mine/${slug}/file/${rel}`)
  const save = async () => {
    setBusy(true)
    try {
      await api(`styles/mine/${slug}/save`, {})
      toast({ text: t('mine.saved', { name: s.name }) })
      reload()
    } catch (e) {
      toast({ text: e.message, tone: 'warning' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Shell title={s.name} right={d.state === 'failed' ? <Badge tone="err">{t('common.failed')}</Badge> : s.draft === false ? <Badge tone="ok">{t('distill.savedBadge')}</Badge> : d.state === 'done' ? <Badge tone="ok">{t('distill.samplesReady')}</Badge> : <Badge tone="warn">{t('mine.distilling')}</Badge>}
      foot={d.state === 'done' && s.draft !== false ? <><span className="lv-grow lv-subtle">{t('distill.saveHint')}</span><Button kind="pri" busy={busy} onClick={save}>{t('mine.save')}</Button></> : s.draft === false ? <><span className="lv-grow lv-subtle">{t('distill.useHint', { name: s.name })}</span><Button size="sm" kind="ghost" onClick={() => openManager('mine')}>{t('style.mineBadge')}</Button></> : null}
      error={d.state === 'failed' ? d.error : null}>
      <div className="lv-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="lv-row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {STEPS.map(([k, label], i) => (
            <Badge key={k} tone={i < at || d.state === 'done' ? 'ok' : i === at && d.state === 'running' ? 'warn' : ''}>
              {i === at && d.state === 'running' ? <Spin /> : i < at || d.state === 'done' ? '✓' : null} {label}
            </Badge>
          ))}
        </div>
        {d.features ? <div className="lv-row" style={{ gap: 4 }}>{d.features.palette.map(p => <span key={p.hex} title={p.hex} style={{ width: 22, height: 22, borderRadius: 6, background: p.hex, border: '1px solid var(--dsw-alias-border-l2)' }} />)}<span className="lv-subtle" style={{ marginLeft: 6 }}>{t('distill.palette')}</span></div> : null}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 96px', gap: 10, alignItems: 'start' }}>
          {d.samples?.[0] ? <video className="lv-media" src={file(d.samples[0].file)} poster={file(d.samples[0].poster)} controls muted loop style={{ width: '100%', borderRadius: 8 }} /> : d.sheet ? <Media src={file(d.sheet)} chip={t('distill.reference')} /> : <Media />}
          {d.samples?.[1] ? <video src={file(d.samples[1].file)} poster={file(d.samples[1].poster)} controls muted loop style={{ width: '100%', borderRadius: 8, aspectRatio: '9/16', background: '#000' }} /> : <Media portrait />}
        </div>
      </div>
    </Shell>
  )
}

/* ---------- 填 Key ---------- */

const KEY_LABELS = { doubao: () => voiceName('doubao'), elevenlabs: () => 'ElevenLabs', openai: () => voiceName('openai'), volcengine: () => musicName('volcengine') }

/** 导演请用户填 Key：卡片上直接粘贴（Key 不经过对话），配好一家就告诉导演；没要 Key 的配置调用不出卡片 */
export function ConfigureCard(props) {
  const t = useT()
  const services = (argsOf(props.block).ask_keys || []).filter(k => KEY_LABELS[k])
  const sessionId = done(props) ? pick(resultText(props.block), 'session_id') : null
  const key = `lovideo-keys-${props.callId}`
  const [told, setTold] = React.useState(() => {
    try {
      return JSON.parse(localStorage.getItem(key) || '[]')
    } catch {
      return []
    }
  })
  const [err, setErr] = React.useState(null)
  if (!services.length) return null
  if (!done(props)) return <Pending props={props} label={t('configure.pending')} />
  const onReady = async service => {
    if (told.includes(service)) return
    setErr(null)
    try {
      if (sessionId) await api('configure/key-ready', { sessionId, service })
      const next = [...told, service]
      setTold(next)
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // 存不了就只在这次页面里记着
      }
    } catch (e) {
      setErr(e.message)
    }
  }
  const left = services.filter(k => !told.includes(k))
  return (
    <Shell title={t('configure.title', { list: services.map(k => KEY_LABELS[k]()).join(t('common.listSep')) })}>
      <div className="lv-card-body">
        <div className="lv-subtle" style={{ marginBottom: 10 }}>{left.length ? t('configure.hint') : t('configure.done')}</div>
        <KeyCard services={services} onReady={onReady} />
        {err ? <div className="lv-err" style={{ marginTop: 6 }}>{err}</div> : null}
      </div>
    </Shell>
  )
}

export const TOOL_VIEWS = {
  lovideo_setup: SetupCard,
  lovideo_configure: ConfigureCard,
  lovideo_styles: StylesCard,
  lovideo_plan: PlanCard,
  lovideo_produce: WorkCard,
  lovideo_revise: WorkCard,
  lovideo_export: ExportCard,
  lovideo_works: WorksCard,
  lovideo_distill: DistillCard,
}
