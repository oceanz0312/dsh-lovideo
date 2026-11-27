// 设置页的「配音」「配乐」：默认用离线的，点一下就能用；要用云服务时只填一个 Key、从下拉里选声音。
// 不会弄 Key 的，点「怎么拿到 API Key？」：可以让 agent 打开浏览器替你开通、拿 Key 并填好，也可以照着三步自己弄。
import * as React from 'react'
import { api, fileUrl, useLive } from './api.js'
import { Bar, Button, Dialog } from './ui.jsx'
import { startDirector } from './host.js'
import { toast } from './toast.jsx'

const CSS = `
.lv-snd-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 12px;margin:14px 0 10px}
.lv-snd-head h3{margin:0!important}
.lv-snd-now{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.lv-snd-now b{font-weight:500;color:var(--dsw-alias-label-secondary)}
.lv-chips button{display:inline-flex;align-items:center;gap:6px}
.lv-chips .tag{font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-weight:400}
.lv-more{position:relative}
.lv-menu{position:absolute;top:calc(100% + 4px);left:0;z-index:20;min-width:240px;padding:4px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base));box-shadow:0 12px 30px -10px rgba(0,0,0,.3);display:flex;flex-direction:column;animation:lv-in var(--lv-dur) var(--lv-ease-out)}
.lv-chips .lv-menu button{height:auto;display:flex;flex-direction:column;align-items:flex-start;gap:1px;text-align:left;border:0;border-radius:7px;padding:7px 10px;background:none;color:var(--dsw-alias-label-primary);font-size:13px}
.lv-chips .lv-menu button:hover,.lv-chips .lv-menu button.on{background:var(--dsw-alias-interactive-bg-hover)}
.lv-menu small{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.lv-panel{display:flex;flex-direction:column;gap:10px;margin:12px 0 16px;padding:14px 16px;border-radius:10px;background:var(--dsw-alias-card-fill);animation:lv-fade var(--lv-dur) var(--lv-ease)}
.lv-panel>.desc{color:var(--dsw-alias-label-secondary);font-size:12.5px}
.lv-line{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-height:32px}
.lv-line>.k{flex:none;width:64px;font-size:12.5px;line-height:32px;color:var(--dsw-alias-label-secondary)}
.lv-line>.lv-input,.lv-line>.lv-select{flex:1;min-width:160px;width:auto;max-width:380px}
.lv-line>.lv-col{flex:1;min-width:0;gap:4px;max-width:380px}
.lv-linkbtn{border:0;background:none;padding:0;font:inherit;font-size:12.5px;color:var(--dsw-alias-state-business-primary);cursor:pointer}
.lv-linkbtn:hover{text-decoration:underline}
.lv-ok-text{color:var(--dsw-alias-state-success-primary,#1a7f37);font-size:12.5px}
.lv-dialog:has(.lv-help){width:min(460px,100%)}
.lv-help{display:flex;flex-direction:column;gap:10px}
.lv-or{display:flex;align-items:center;gap:10px;margin-top:6px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.lv-or::before,.lv-or::after{content:"";flex:1;height:1px;background:var(--dsw-alias-border-l2)}
.lv-steps{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-secondary)}
.lv-steps code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;padding:1px 5px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover);user-select:all}
`

export const VOICE_NAMES = { local: '离线配音', system: '系统自带语音', doubao: '豆包语音', elevenlabs: 'ElevenLabs', openai: 'OpenAI 兼容', none: '不配音' }
export const MUSIC_NAMES = { local: '离线配乐', volcengine: '火山配乐', elevenlabs: 'ElevenLabs', none: '不配乐' }
const ZH_LINE = '你好，这是 lovideo 的配音试听。'
const EN_LINE = 'Hi, this is a lovideo narration preview.'
const ELEVEN_DEFAULT = { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', gender: '女声', note: '平静旁白' }
const CUSTOM = '__custom'

/**
 * 配音、配乐两块设置，加上「怎么拿到 Key」的说明。
 * st 是 /state 的结果；onState 收到保存后的新 state。
 */
export function SoundSettings({ st, onState }) {
  const [help, setHelp] = React.useState(null)
  const save = async patch => {
    const next = await api('settings', patch)
    onState(next)
    return next
  }
  const refresh = async () => onState(await api('state'))
  return (
    <>
      <style>{CSS}</style>
      <VoiceSettings st={st} save={save} refresh={refresh} onHelp={setHelp} />
      <MusicSettings st={st} save={save} refresh={refresh} onHelp={setHelp} />
      <p className="lv-subtle" style={{ margin: '-4px 4px 16px' }}>每部片子要不要配音、配乐，在分镜卡和成片下面的开关里定；这里只选用什么来做。</p>
      <HelpDialog which={help} onClose={() => setHelp(null)} />
    </>
  )
}

/* ---------- 配音 ---------- */

function VoiceSettings({ st, save, refresh, onHelp }) {
  const cur = st.settings.voice.provider
  const keys = st.settings.keys
  const [view, setView] = React.useState(cur === 'none' ? 'local' : cur)
  const local = useLocal('voice', refresh)
  const eleven = useElevenVoices(keys.elevenlabs)
  const [doubao] = useLive('voice/catalog?provider=doubao', () => false)
  const pick = async k => {
    setView(k)
    // 不用再填东西就能用的，点了马上切过去；要 Key 的等保存 Key 时再切
    const ready = k === 'system' || (k === 'local' && local.data?.active) || (k === 'doubao' && keys.doubao) || (k === 'elevenlabs' && keys.elevenlabs) || (k === 'openai' && keys.openai && st.settings.voice.openaiUrl)
    if (!ready || k === cur) return
    try {
      await save({ voice: { provider: k } })
      local.reload()
      toast({ text: `配音换成${VOICE_NAMES[k]}` })
    } catch (e) {
      toast({ text: e.message, tone: 'warning' })
    }
  }
  return (
    <div className="lv-section">
      <div className="lv-snd-head"><h3>配音</h3><span className="lv-snd-now">现在用：<b>{voiceNow(st, local.data, eleven.list, doubao?.voices)}</b></span></div>
      <Chips value={view} onPick={pick}
        items={[['local', '离线配音', '推荐'], ['doubao', '豆包语音'], ['elevenlabs', 'ElevenLabs']]}
        more={[['system', '系统自带语音', '电脑自带的声音，不用下载，比较机械'], ['openai', 'OpenAI 兼容', '自己填接口地址、模型和声音']]} />
      <div className="lv-panel" key={view}>
        {view === 'local' ? <LocalPanel kind="voice" local={local} onChanged={refresh} /> : null}
        {view === 'doubao' ? <DoubaoPanel st={st} save={save} list={doubao?.voices || []} onHelp={() => onHelp('doubao')} /> : null}
        {view === 'elevenlabs' ? <ElevenPanel st={st} save={save} eleven={eleven} onHelp={() => onHelp('elevenlabs')} /> : null}
        {view === 'system' ? <SystemPanel /> : null}
        {view === 'openai' ? <OpenAIPanel st={st} save={save} /> : null}
      </div>
    </div>
  )
}

/** 「现在用：…」：已经保存、开拍时真正会用的那个 */
function voiceNow(st, local, elevenList, doubaoList) {
  const v = st.settings.voice
  const keys = st.settings.keys
  const chosen = v.voices?.[v.provider] || ''
  if (v.provider === 'local') {
    const m = local?.models.find(x => x.id === local.active)
    if (!m) return '离线配音（还没下载，先用系统自带语音）'
    const names = Object.fromEntries((m.voices?.zh || []).concat(m.voices?.en || []))
    const vs = [m.chosenVoices?.zh, m.chosenVoices?.en].filter(id => id && names[id] && Object.keys(names).length > 2).map(id => names[id].split(' · ').pop())
    return ['离线配音', m.name, vs.join(' / ')].filter(Boolean).join(' · ')
  }
  if (v.provider === 'doubao') {
    if (!keys.doubao) return '豆包语音（还没填 Key）'
    const d = (doubaoList || []).find(x => x.id === chosen)?.name
    return `豆包语音 · ${chosen ? d || '自定义音色' : '中文 Vivi / 英文 Megan'}`
  }
  if (v.provider === 'elevenlabs') {
    if (!keys.elevenlabs) return 'ElevenLabs（还没填 Key）'
    const id = chosen || ELEVEN_DEFAULT.id
    return `ElevenLabs · ${(elevenList || []).find(x => x.id === id)?.name || (id === ELEVEN_DEFAULT.id ? ELEVEN_DEFAULT.name : '自定义声音')}`
  }
  if (v.provider === 'openai') return keys.openai ? `OpenAI 兼容 · ${v.openaiModel || 'gpt-4o-mini-tts'}` : 'OpenAI 兼容（还没填 Key）'
  return VOICE_NAMES[v.provider] || v.provider
}

function DoubaoPanel({ st, save, list, onHelp }) {
  const has = Boolean(st.settings.keys.doubao)
  const chosen = st.settings.voice.voices?.doubao || ''
  const [err, setErr] = React.useState(null)
  const v = list.find(x => x.id === chosen)
  const lang = v?.lang === 'en' ? 'en' : 'zh'
  const test = () => preview({ provider: 'doubao', voice: chosen, text: lang === 'en' ? EN_LINE : ZH_LINE }, has, setErr)
  const verify = useVerify(save, 'doubao')
  const pickVoice = async id => {
    setErr(null)
    try {
      await save({ voice: { voices: { doubao: id }, ...(has ? { provider: 'doubao' } : {}) } })
    } catch (e) {
      setErr(e.message)
    }
  }
  return (
    <>
      <div className="desc">火山引擎的配音，中文最自然，按字数付费，新开通有免费额度。</div>
      <KeyLine masked={st.settings.keys.doubao} placeholder="粘贴豆包语音的 API Key" help="怎么拿到 API Key？" onHelp={onHelp}
        onSave={async key => {
          await save({ keys: { doubao: key } })
          verify.start()
        }} />
      <VoiceSelect value={chosen} known={Boolean(v) || !chosen} onPick={pickVoice} customHint="seed-tts-2.0/你的音色" listen={<ListenButton load={test} trigger={verify.trigger} onLoaded={verify.done} />}>
        <option value="">自动：中文 Vivi，英文 Megan</option>
        {[['zh', '中文'], ['en', '英文']].map(([l, label]) => (
          <optgroup key={l} label={label}>
            {list.filter(x => x.lang === l).map(x => <option key={x.id} value={x.id}>{[x.gender, x.name, x.note].filter(Boolean).join(' · ')}</option>)}
          </optgroup>
        ))}
      </VoiceSelect>
      {chosen && v ? <div className="lv-line"><span className="k" /><span className="lv-subtle">片子是另一种语言时，自动换成那种语言的默认声音</span></div> : null}
      {err ? <div className="lv-err">{err}</div> : null}
    </>
  )
}

/** ElevenLabs 账号里能用的声音：填了 Key 才去读 */
function useElevenVoices(masked) {
  const [data, error] = useLive(masked ? `voice/catalog?provider=elevenlabs&k=${encodeURIComponent(masked)}` : null, () => false)
  return { list: data?.voices || null, error }
}

function ElevenPanel({ st, save, eleven, onHelp }) {
  const has = Boolean(st.settings.keys.elevenlabs)
  const chosen = st.settings.voice.voices?.elevenlabs || ''
  const [err, setErr] = React.useState(null)
  const verify = useVerify(save, 'elevenlabs')
  const list = eleven.list || [ELEVEN_DEFAULT]
  const value = chosen || ELEVEN_DEFAULT.id
  const all = list.some(x => x.id === ELEVEN_DEFAULT.id) ? list : [ELEVEN_DEFAULT, ...list]
  const test = () => preview({ provider: 'elevenlabs', voice: value, text: EN_LINE }, has, setErr)
  const pickVoice = async id => {
    setErr(null)
    try {
      await save({ voice: { voices: { elevenlabs: id }, ...(has ? { provider: 'elevenlabs' } : {}) } })
    } catch (e) {
      setErr(e.message)
    }
  }
  return (
    <>
      <div className="desc">英文最好，中文也能念，按字数扣 ElevenLabs 的额度。</div>
      <KeyLine masked={st.settings.keys.elevenlabs} placeholder="粘贴 ElevenLabs 的 API Key" help="怎么拿到 API Key？" onHelp={onHelp}
        onSave={async key => {
          await save({ keys: { elevenlabs: key } })
          verify.start()
        }} />
      <VoiceSelect value={value} known={all.some(x => x.id === value)} onPick={pickVoice} customHint="voice ID" listen={<ListenButton load={test} trigger={verify.trigger} onLoaded={verify.done} />}>
        {all.map(x => <option key={x.id} value={x.id}>{[x.name, x.gender, x.note].filter(Boolean).join(' · ')}</option>)}
      </VoiceSelect>
      {has && !eleven.list && !eleven.error ? <div className="lv-line"><span className="k" /><span className="lv-subtle lv-shimmer">正在读你账号里的声音…</span></div> : null}
      {eleven.error ? <div className="lv-err">{eleven.error.message}</div> : null}
      {err ? <div className="lv-err">{err}</div> : null}
    </>
  )
}

function SystemPanel() {
  const [err, setErr] = React.useState(null)
  return (
    <>
      <div className="desc">电脑自带的声音，不用下载，听起来比较机械。中文自动用系统的中文声音，英文用英文声音。</div>
      <div className="lv-line"><ListenButton load={() => preview({ provider: 'system', text: ZH_LINE }, true, setErr)} /></div>
      {err ? <div className="lv-err">{err}</div> : null}
    </>
  )
}

function OpenAIPanel({ st, save }) {
  const v = st.settings.voice
  const masked = st.settings.keys.openai
  const [form, setForm] = React.useState(() => ({ url: v.openaiUrl || '', key: '', model: v.openaiModel || '', voice: v.voices?.openai || '' }))
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState(null)
  const verify = useVerify(save, 'openai')
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }))
  const submit = async () => {
    setBusy(true)
    setErr(null)
    try {
      await save({ voice: { openaiUrl: form.url, openaiModel: form.model, voices: { openai: form.voice } }, keys: { openai: form.key } })
      setForm(f => ({ ...f, key: '' }))
      verify.start()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="desc">任何兼容 OpenAI 语音接口（/audio/speech）的服务。</div>
      <div className="lv-line"><span className="k">地址</span><input className="lv-input lv-mono" placeholder="https://api.openai.com/v1" value={form.url} onChange={set('url')} /></div>
      <div className="lv-line"><span className="k">Key</span><input className="lv-input" type="password" autoComplete="off" placeholder={masked ? `已保存 ${masked}，粘贴新的会替换` : 'sk-…'} value={form.key} onChange={set('key')} /></div>
      <div className="lv-line"><span className="k">模型</span><input className="lv-input" placeholder="gpt-4o-mini-tts" value={form.model} onChange={set('model')} /></div>
      <div className="lv-line"><span className="k">声音</span><input className="lv-input" placeholder="alloy" value={form.voice} onChange={set('voice')} />
        <Button kind="pri" busy={busy} disabled={!(form.key || masked)} onClick={submit}>保存</Button>
        <ListenButton load={() => preview({ provider: 'openai', text: ZH_LINE }, Boolean(masked), setErr)} trigger={verify.trigger} onLoaded={verify.done} />
      </div>
      {err ? <div className="lv-err">{err}</div> : null}
    </>
  )
}

/* ---------- 配乐 ---------- */

function MusicSettings({ st, save, refresh, onHelp }) {
  const cur = st.settings.music.provider
  const keys = st.settings.keys
  const [view, setView] = React.useState(cur === 'none' ? 'local' : cur)
  const local = useLocal('music', refresh)
  const pick = async k => {
    setView(k)
    const ready = (k === 'local' && local.data?.active) || (k === 'volcengine' && keys.volcAk && keys.volcSk) || (k === 'elevenlabs' && keys.elevenlabs)
    if (!ready || k === cur) return
    try {
      await save({ music: { provider: k } })
      local.reload()
      toast({ text: `配乐换成${MUSIC_NAMES[k]}` })
    } catch (e) {
      toast({ text: e.message, tone: 'warning' })
    }
  }
  return (
    <div className="lv-section">
      <div className="lv-snd-head"><h3>配乐</h3><span className="lv-snd-now">现在用：<b>{musicNow(st, local.data)}</b></span></div>
      <Chips value={view} onPick={pick} items={[['local', '离线配乐', '推荐'], ['volcengine', '火山配乐'], ['elevenlabs', 'ElevenLabs']]} />
      <div className="lv-panel" key={view}>
        {view === 'local' ? <LocalPanel kind="music" local={local} onChanged={refresh} /> : null}
        {view === 'volcengine' ? <VolcPanel st={st} save={save} onHelp={() => onHelp('volcengine')} /> : null}
        {view === 'elevenlabs' ? <ElevenMusicPanel st={st} save={save} onHelp={() => onHelp('elevenlabs')} /> : null}
      </div>
    </div>
  )
}

function musicNow(st, local) {
  const p = st.settings.music.provider
  const keys = st.settings.keys
  if (p === 'local') {
    const m = local?.models.find(x => x.id === local.active)
    return m ? `离线配乐 · ${m.name}` : '离线配乐（还没下载）'
  }
  if (p === 'volcengine') return keys.volcAk && keys.volcSk ? '火山配乐' : '火山配乐（还没填 Key）'
  if (p === 'elevenlabs') return keys.elevenlabs ? 'ElevenLabs' : 'ElevenLabs（还没填 Key）'
  return MUSIC_NAMES[p] || p
}

const musicTest = (provider, setErr) => async () => {
  setErr(null)
  try {
    return fileUrl((await api('settings/test-music', { provider })).url)
  } catch (e) {
    setErr(e.message)
    return null
  }
}

function VolcPanel({ st, save, onHelp }) {
  const keys = st.settings.keys
  const [form, setForm] = React.useState({ ak: '', sk: '' })
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState(null)
  const ready = Boolean(keys.volcAk && keys.volcSk)
  const submit = async () => {
    setBusy(true)
    setErr(null)
    try {
      const next = await save({ keys: { volcAk: form.ak, volcSk: form.sk } })
      // 两个都有了才切过去，只填了一个时先存着
      if (next.settings.keys.volcAk && next.settings.keys.volcSk) {
        await save({ music: { provider: 'volcengine' } })
        toast({ text: '火山配乐已配好，可以试听一首 30 秒的' })
      } else toast({ text: '已保存，还差另一个 Key' })
      setForm({ ak: '', sk: '' })
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }
  const ph = (m, name) => (m ? `已保存 ${m}，粘贴新的会替换` : name)
  return (
    <>
      <div className="desc">火山引擎生成纯音乐，按生成秒数付费，约 ¥0.12/分钟。</div>
      <div className="lv-line"><span className="k">AK</span><input className="lv-input" type="password" autoComplete="off" placeholder={ph(keys.volcAk, 'AccessKey ID')} value={form.ak} onChange={e => setForm(f => ({ ...f, ak: e.target.value }))} /></div>
      <div className="lv-line"><span className="k">SK</span><input className="lv-input" type="password" autoComplete="off" placeholder={ph(keys.volcSk, 'SecretAccessKey')} value={form.sk} onChange={e => setForm(f => ({ ...f, sk: e.target.value }))} onKeyDown={e => e.key === 'Enter' && (form.ak || form.sk) && submit()} />
        <Button kind="pri" busy={busy} disabled={!(form.ak.trim() || form.sk.trim())} onClick={submit}>保存</Button>
      </div>
      <div className="lv-line"><span className="k" /><button type="button" className="lv-linkbtn" onClick={onHelp}>怎么拿到这两个 Key？</button></div>
      {ready ? <div className="lv-line"><span className="k" /><ListenButton label="试听 30 秒" load={musicTest('volcengine', setErr)} /></div> : null}
      {err ? <div className="lv-err">{err}</div> : null}
    </>
  )
}

function ElevenMusicPanel({ st, save, onHelp }) {
  const masked = st.settings.keys.elevenlabs
  const [err, setErr] = React.useState(null)
  return (
    <>
      <div className="desc">音乐质量高，按生成时长扣 ElevenLabs 的额度。</div>
      {masked ? (
        <div className="lv-line"><span className="lv-ok-text">✓ 用配音里填的 ElevenLabs Key（{masked}），不用再填</span><ListenButton label="试听 30 秒" load={musicTest('elevenlabs', setErr)} /></div>
      ) : (
        <KeyLine placeholder="粘贴 ElevenLabs 的 API Key（配音、配乐共用一个）" help="怎么拿到 API Key？" onHelp={onHelp}
          onSave={async key => {
            await save({ keys: { elevenlabs: key }, music: { provider: 'elevenlabs' } })
            toast({ text: 'ElevenLabs 配乐已配好，可以试听一首 30 秒的' })
          }} />
      )}
      {err ? <div className="lv-err">{err}</div> : null}
    </>
  )
}

/* ---------- 离线（配音、配乐共用） ---------- */

const LOCAL_STEP = { queued: '排队中', uv: '准备下载工具', packages: '安装运行环境', model: '下载模型', test: '测速' }
const gradeLabel = (m, d) => (m.grade === 'unable' ? '跑不动' : m.grade === 'heavy' ? '吃力' : d.recommended === m.id ? '推荐' : '流畅')

/** 离线模型的状态；有模型在下载时每秒刷新，某个下载结束时让外面重读设置（装好会自动用上） */
function useLocal(kind, onFinish) {
  const [data, error, reload] = useLive(kind === 'music' ? 'local-voice?kind=music' : 'local-voice', () => false,
    d => (d?.models?.some(m => m.job?.running) ? 1000 : 0))
  const running = (data?.models || []).filter(m => m.job?.running).map(m => m.id).join(',')
  const was = React.useRef(running)
  React.useEffect(() => {
    if (was.current && was.current !== running) onFinish?.()
    was.current = running
  }, [running])
  return { data, error, reload }
}

export function jobText(job) {
  if (!job) return ''
  return `${LOCAL_STEP[job.step] || '准备中'}${job.step === 'model' ? ` ${Math.round((job.progress || 0) * 100)}%` : ''}`
}

function LocalPanel({ kind, local, onChanged }) {
  const music = kind === 'music'
  const what = music ? '配乐' : '配音'
  const d = local.data
  const [sel, setSel] = React.useState(null)
  const [busy, setBusy] = React.useState(null)
  const [err, setErr] = React.useState(null)
  const shown = d && (d.models.find(m => m.id === sel) || d.models.find(m => m.id === d.active) || d.models.find(m => m.id === d.recommended) || d.models[0])
  const act = async (key, path, body, done) => {
    setBusy(key)
    setErr(null)
    try {
      await api(path, body)
      done?.()
      local.reload()
      // 换模型会顺带把配音或配乐切到离线：「现在用」要跟着变
      onChanged?.()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }
  const use = (m, voices) => act(`use-${m.id}`, 'local-voice/use', { model: m.id, ...(voices ? { voices } : {}) }, voices ? null : () => toast({ text: `${what}换成 ${m.name}` }))
  // 用户选中的模型下载完：直接用上它
  const jobRunning = Boolean(shown?.job?.running)
  const wasRunning = React.useRef(false)
  React.useEffect(() => {
    if (wasRunning.current && !jobRunning && shown?.installed && !(d.usingLocal && d.active === shown.id)) use(shown)
    wasRunning.current = jobRunning
  }, [jobRunning])
  if (local.error) return <div className="lv-err">{local.error.message}</div>
  if (!d) return <div className="lv-subtle lv-shimmer">正在看这台电脑的配置…</div>
  const hw = d.hardware
  if (!d.minimum.ok) {
    return <div className="desc">这台电脑配置偏低（{d.minimum.reason}），离线{what}跑不动，{music ? '可以换成火山配乐或 ElevenLabs' : '配音先用系统自带语音，也可以换成豆包语音或 ElevenLabs'}。离线{what}最低要 {d.minimum.spec.ramGB}GB 内存、{d.minimum.spec.cores} 核 CPU、{d.minimum.spec.freeDiskGB}GB 磁盘剩余。</div>
  }
  const m = shown
  const using = d.usingLocal && d.active === m.id
  const pickModel = id => {
    setSel(id)
    const next = d.models.find(x => x.id === id)
    if (next?.installed && !(d.usingLocal && d.active === id)) use(next)
  }
  const listen = lang => async () => {
    setErr(null)
    try {
      const r = await api('local-voice/preview', music ? { kind: 'music', model: m.id } : { model: m.id, lang, voice: m.chosenVoices[lang] })
      return fileUrl(r.url)
    } catch (e) {
      setErr(e.message)
      return null
    }
  }
  const speed = m.installed ? (music ? `做 1 分钟配乐约 ${Math.max(1, m.installed.oneMinute)} 秒` : `配 1 分钟口播约 ${m.installed.oneMinute} 秒`) : ''
  return (
    <>
      <div className="desc">{music ? '在这台电脑上几秒做好一首纯音乐，不联网、不用 key。' : '在这台电脑上生成，不联网、不用 key。'}<span className="lv-subtle"> 这台电脑：{hw.chip || hw.platform} · {hw.ramGB}GB 内存{hw.gpu ? ` · ${hw.gpu.name}` : ''}</span></div>
      <div className="lv-line"><span className="k">模型</span>
        <select className="lv-select" value={m.id} onChange={e => pickModel(e.target.value)} disabled={Boolean(busy)}>
          {d.models.map(x => <option key={x.id} value={x.id} disabled={x.grade === 'unable'}>{[x.name, gradeLabel(x, d), x.installed ? '已装好' : x.job?.running ? '下载中' : `未下载 ${x.downloadGB}GB`].join(' · ')}</option>)}
        </select>
        {m.installed && !m.job?.running ? <Button size="sm" kind="ghost" busy={busy === m.id} onClick={() => act(m.id, 'local-voice/setup', { model: m.id })}>重新测速</Button> : null}
      </div>
      <div className="lv-line"><span className="k" /><span className="lv-subtle">{[m.note, speed, m.gradeReason].filter(Boolean).join(' · ')}</span></div>
      {!m.installed ? (
        <div className="lv-line"><span className="k" />
          {m.job?.running ? (
            <div className="lv-col"><span className="lv-subtle">{jobText(m.job)}…</span>{m.job.step === 'model' ? <Bar value={m.job.progress} /> : null}</div>
          ) : m.grade === 'unable' ? <span className="lv-subtle">这台电脑跑不了这个模型</span> : (
            <Button kind="pri" busy={busy === m.id} onClick={() => act(m.id, 'local-voice/setup', { model: m.id })}>下载（约 {m.downloadGB}GB）</Button>
          )}
        </div>
      ) : m.job?.running ? <div className="lv-line"><span className="k" /><span className="lv-subtle">{jobText(m.job)}…</span></div> : null}
      {m.installed && !music ? [['zh', '中文声音'], ['en', '英文声音']].filter(([l]) => (m.voices?.[l] || []).length > 0).map(([l, label]) => (
        <div key={l} className="lv-line"><span className="k">{label}</span>
          <select className="lv-select" value={m.chosenVoices?.[l] || ''} disabled={(m.voices[l] || []).length < 2 || Boolean(busy)} onChange={e => use(m, { [l]: e.target.value })}>
            {m.voices[l].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <ListenButton load={listen(l)} />
        </div>
      )) : null}
      {m.installed && (music || !using) ? (
        <div className="lv-line"><span className="k" />
          {!using ? <Button kind="pri" busy={busy === `use-${m.id}`} onClick={() => use(m)}>用这个</Button> : null}
          {music ? <ListenButton label="试听 15 秒" load={listen()} /> : null}
        </div>
      ) : null}
      {m.job?.error && !m.job.running ? <div className="lv-err">{m.job.error}</div> : null}
      {err ? <div className="lv-err">{err}</div> : null}
    </>
  )
}

/* ---------- 小部件 ---------- */

/** 横排的服务选项；more 收进「更多」菜单 */
function Chips({ value, onPick, items, more = [] }) {
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
  const inMore = more.find(([k]) => k === value)
  return (
    <div className="lv-chips">
      {items.map(([k, label, tag]) => <button key={k} type="button" className={value === k ? 'on' : ''} onClick={() => onPick(k)}>{label}{tag ? <span className="tag">{tag}</span> : null}</button>)}
      {more.length ? (
        <span className="lv-more" ref={box}>
          <button type="button" className={inMore ? 'on' : ''} aria-expanded={open} onClick={() => setOpen(o => !o)}>{inMore ? inMore[1] : '更多'} ▾</button>
          {open ? (
            <div className="lv-menu" role="menu">
              {more.map(([k, label, note]) => <button key={k} type="button" role="menuitem" className={value === k ? 'on' : ''} onClick={() => { setOpen(false); onPick(k) }}>{label}<small>{note}</small></button>)}
            </div>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}

/** 一行「API Key」：粘贴、保存；下面一行是「怎么拿到」 */
function KeyLine({ masked, placeholder, help, onHelp, onSave }) {
  const [v, setV] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState(null)
  const submit = async () => {
    if (!v.trim()) return
    setBusy(true)
    setErr(null)
    try {
      await onSave(v.trim())
      setV('')
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="lv-line"><span className="k">API Key</span>
        <input className="lv-input" type="password" autoComplete="off" spellCheck={false} placeholder={masked ? `已保存 ${masked}，粘贴新的会替换` : placeholder} value={v} onChange={e => setV(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
        <Button kind="pri" busy={busy} disabled={!v.trim()} onClick={submit}>保存</Button>
      </div>
      <div className="lv-line"><span className="k" /><button type="button" className="lv-linkbtn" onClick={onHelp}>{help}</button></div>
      {err ? <div className="lv-err">{err}</div> : null}
    </>
  )
}

/** 声音下拉；最后一项「自定义…」打开一个输入框，填平台上的音色 ID */
function VoiceSelect({ value, known, onPick, customHint, listen, children }) {
  const [custom, setCustom] = React.useState(!known)
  const [id, setId] = React.useState(known ? '' : value)
  React.useEffect(() => {
    // 声音列表读回来后，选的声音在列表里就收起输入框；不在列表里就是自定义的
    setCustom(!known)
    setId(known ? '' : value)
  }, [known, value])
  return (
    <>
      <div className="lv-line"><span className="k">声音</span>
        <select className="lv-select" value={custom ? CUSTOM : value} onChange={e => {
          if (e.target.value === CUSTOM) return setCustom(true)
          setCustom(false)
          onPick(e.target.value)
        }}>
          {children}
          <option value={CUSTOM}>自定义音色 ID…</option>
        </select>
        {listen}
      </div>
      {custom ? (
        <div className="lv-line"><span className="k" />
          <input className="lv-input lv-mono" placeholder={customHint} value={id} onChange={e => setId(e.target.value)} onKeyDown={e => e.key === 'Enter' && id.trim() && onPick(id.trim())} />
          <Button disabled={!id.trim() || id.trim() === value} onClick={() => onPick(id.trim())}>用这个</Button>
        </div>
      ) : null}
    </>
  )
}

/**
 * 保存 Key 以后自动试听一句：念出来了才把配音切到这家服务；Key 不对时报错，配音还用原来的。
 * start() 在保存后调用；trigger、done 交给 ListenButton。
 */
function useVerify(save, provider) {
  const [trigger, setTrigger] = React.useState(0)
  const pending = React.useRef(false)
  return {
    trigger,
    start() {
      pending.current = true
      setTrigger(n => n + 1)
    },
    async done(url) {
      if (!pending.current) return
      pending.current = false
      if (!url) return
      try {
        await save({ voice: { provider } })
        toast({ text: `Key 能用，配音换成${VOICE_NAMES[provider]}` })
      } catch (e) {
        toast({ text: e.message, tone: 'warning' })
      }
    },
  }
}

/** 试听某个配音服务（还没切过去的也能听）；没 Key 时直接提示 */
async function preview(body, hasKey, setErr) {
  setErr(null)
  if (!hasKey) {
    setErr('先粘贴 API Key 并保存')
    return null
  }
  try {
    return fileUrl((await api('settings/test-voice', body)).url)
  } catch (e) {
    setErr(e.message)
    return null
  }
}

/* ---------- 怎么拿到 Key ---------- */

const HELP = {
  doubao: {
    title: '拿豆包语音的 API Key',
    ask: '按 lovideo-setup 向导，帮我开通豆包语音，拿到 API Key，配好 lovideo 的配音并试听一句。',
    steps: [
      <>打开 <code>console.volcengine.com/speech</code>，注册或登录火山引擎（要实名认证）</>,
      <>开通「语音合成大模型」，再到「API Key 管理」→「创建 API Key」，复制</>,
      <>粘贴到上面的 API Key，点保存（会自动试听一句）</>,
    ],
    copy: `帮我开通火山引擎的「豆包语音」，拿到配音用的 API Key：
1. 打开 https://console.volcengine.com/speech ，登录或注册火山引擎（实名认证要我本人来做，到这一步停下来叫我）。
2. 开通「语音合成大模型」（有免费额度，超出按字数计费；要付费时先告诉我价格）。
3. 进入「API Key 管理」，新建一个 API Key 并复制。新版控制台只要这一个 Key，不需要 App ID 和 Access Token。
4. 把 Key 填进 lovideo 插件：设置 → 配音 → 豆包语音 → API Key，点保存（会自动试听一句）。如果你能调用 lovideo_configure 工具，就用它填：voice_provider 设为 doubao，keys.doubao 填这个 Key。
不要在回复里把完整的 Key 念出来，只说末 4 位。`,
  },
  elevenlabs: {
    title: '拿 ElevenLabs 的 API Key',
    ask: '按 lovideo-setup 向导，帮我拿到 ElevenLabs 的 API Key，配好 lovideo 的配音（也能用来配乐）并试听一句。',
    steps: [
      <>打开 <code>elevenlabs.io/app/settings/api-keys</code>，用 Google 账号登录</>,
      <>点「Create API Key」，权限勾上 Text to Speech、Voices，要配乐再勾 Music；复制（只显示一次）</>,
      <>粘贴到上面的 API Key，点保存（配音、配乐共用这一个）</>,
    ],
    copy: `帮我拿到 ElevenLabs 的 API Key：
1. 打开 https://elevenlabs.io/app/settings/api-keys ，登录（可以用 Google 账号；需要我本人登录时停下来叫我）。
2. 点「Create API Key」，权限至少勾上 Text to Speech 和 Voices（读）；要用它做配乐再勾 Music。复制 Key（只显示一次）。
3. 把 Key 填进 lovideo 插件：设置 → 配音 → ElevenLabs → API Key，点保存；配乐选 ElevenLabs 时会用同一个 Key。如果你能调用 lovideo_configure 工具，就用它填：voice_provider 设为 elevenlabs，keys.elevenlabs 填这个 Key。
要付费升级套餐时先问我。不要在回复里把完整的 Key 念出来，只说末 4 位。`,
  },
  volcengine: {
    title: '拿火山配乐的两个 Key',
    ask: '按 lovideo-setup 向导，帮我开通火山引擎的「生成纯音乐」，拿到 AccessKey 和 SecretKey，配好 lovideo 的配乐并试一首。',
    steps: [
      <>在 <code>console.volcengine.com</code> 顶部搜索「音乐生成」，开通「生成纯音乐」</>,
      <>打开 <code>console.volcengine.com/iam/keymanage</code>，新建密钥，复制 AccessKey ID 和 SecretAccessKey</>,
      <>分别粘贴到上面的 AK、SK，点保存</>,
    ],
    copy: `帮我开通火山引擎的「生成纯音乐」，拿到配乐用的 AccessKey 和 SecretKey：
1. 打开 https://console.volcengine.com ，登录或注册（实名认证要我本人来做，到这一步停下来叫我）。在顶部搜索「音乐生成」或「智能创作」，开通「生成纯音乐」（接口 GenBGMForTime，约 ¥0.002/秒，开通前告诉我价格）。
2. 打开 https://console.volcengine.com/iam/keymanage/ ，新建访问密钥，复制 AccessKey ID 和 SecretAccessKey（SecretKey 只显示一次）。更稳妥的做法是新建一个只有编程访问的子用户，只给 imagination:GenBGMForTime 和 imagination:QuerySong 权限，用子用户的密钥。
3. 填进 lovideo 插件：设置 → 配乐 → 火山配乐，分别粘贴 AK、SK，点保存。如果你能调用 lovideo_configure 工具，就用它填：music_provider 设为 volcengine，keys.volcengine_ak、keys.volcengine_sk 分别填两个值。
不要在回复里把完整的 Key 念出来，只说末 4 位。`,
  },
}

function HelpDialog({ which, onClose }) {
  const [last, setLast] = React.useState(which)
  React.useEffect(() => {
    if (which) setLast(which)
  }, [which])
  const h = HELP[which || last]
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(h.copy)
    } catch {
      // 剪贴板不让写时，用选中文字再复制的老办法
      const ta = document.createElement('textarea')
      ta.value = h.copy
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } finally {
        ta.remove()
      }
    }
    toast({ text: '已复制，发给任何能用浏览器的 agent 都行' })
  }
  const ask = () => {
    startDirector(h.ask)
    onClose()
    toast({ text: '已新开会话，发出去 agent 就开始帮你配' })
  }
  if (!h) return null
  return (
    <Dialog open={Boolean(which)} title={h.title} onCancel={onClose} actions={<>
      <button type="button" className="lv-btn" onClick={onClose}>关闭</button>
      <button type="button" className="lv-btn" onClick={copy}>复制说明</button>
      <button type="button" className="lv-btn pri" onClick={ask}>让 agent 帮我配</button>
    </>}>
      <div className="lv-help">
        <p>agent 会打开浏览器帮你注册、开通、拿到 Key 并填好；遇到实名认证、扫码或付款会停下来问你。「复制说明」可以发给别的 agent。</p>
        <div className="lv-or">或者自己弄</div>
        <ol className="lv-steps">{h.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
      </div>
    </Dialog>
  )
}

/* ---------- 试听 ---------- */

// 同一时间只放一段试听：点另一个试听时，前一个停下
let stopCurrent = null

/**
 * 试听按钮：点一下生成并播放，再点停止；播放时图标换成跳动的声纹。不用浏览器自带的播放条。
 * load 返回音频地址，失败返回 null（错误由调用方显示）。trigger 变大时自动点一下（保存 Key 后自动试听）。
 */
export function ListenButton({ load, size, kind, label = '试听', trigger = 0, onLoaded }) {
  const [state, setState] = React.useState('idle')
  const audio = React.useRef(null)
  const stop = React.useCallback(() => {
    audio.current?.pause()
    audio.current = null
    setState('idle')
  }, [])
  React.useEffect(() => () => audio.current?.pause(), [])
  const click = async () => {
    if (state === 'playing') return stop()
    if (state === 'loading') return undefined
    stopCurrent?.()
    setState('loading')
    const url = await load()
    onLoaded?.(url)
    if (!url) return setState('idle')
    const a = new Audio(url)
    audio.current = a
    stopCurrent = stop
    a.onended = stop
    a.onerror = stop
    setState('playing')
    a.play().catch(stop)
    return undefined
  }
  React.useEffect(() => {
    if (trigger) click()
  }, [trigger])
  return (
    <Button className={`lv-btn lv-listen ${kind || 'ghost'} ${size || ''}`} busy={state === 'loading'} onClick={click} aria-label={label || (state === 'playing' ? '停止' : '试听')}>
      {state === 'playing' ? <Wave audio={audio.current} /> : state === 'idle' ? <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 1.3v7.4L8.7 5z" fill="currentColor" /></svg> : null}
      {label ? (state === 'playing' ? '停止' : state === 'loading' ? '准备中' : label) : null}
    </Button>
  )
}

// 整页共用一个 AudioContext（浏览器对个数有限制）；同一个 audio 元素只能接一次
let audioCtx = null
const sources = new WeakMap()

/** 声纹：几根竖条跟着正在放的声音实时跳动；读不到音量时退回固定的起伏动画 */
function Wave({ audio }) {
  const bars = React.useRef([])
  React.useEffect(() => {
    if (!audio) return undefined
    let analyser = null
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)()
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
      let src = sources.get(audio)
      if (!src) {
        src = audioCtx.createMediaElementSource(audio)
        sources.set(audio, src)
      }
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 64
      analyser.smoothingTimeConstant = 0.6
      src.connect(analyser)
      analyser.connect(audioCtx.destination)
    } catch {
      analyser = null
    }
    const data = new Uint8Array(32)
    // 人声能量集中在低频：最强的频段放中间，两边放弱一些的，看起来像声纹而不是一条斜坡
    const bins = [5, 2, 1, 3, 7]
    let raf = 0
    const t0 = performance.now()
    const tick = now => {
      if (analyser) analyser.getByteFrequencyData(data)
      bars.current.forEach((el, i) => {
        if (!el) return
        const v = analyser ? data[bins[i]] / 255 : 0.5 + 0.5 * Math.sin((now - t0) / 140 + i * 1.3)
        el.style.height = `${3 + Math.round(v * 9)}px`
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      try {
        analyser?.disconnect()
        // 断开分析器后要把声音重新接到扬声器，否则下次播放没声
        sources.get(audio)?.connect(audioCtx.destination)
      } catch { /* 已断开 */ }
    }
  }, [audio])
  return <span className="lv-wave" aria-hidden="true">{[0, 1, 2, 3, 4].map(i => <i key={i} ref={el => { bars.current[i] = el }} />)}</span>
}
