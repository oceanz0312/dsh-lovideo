// 设置页的「配音」「配乐」：默认用离线的，点一下就能用；要用云服务时只填一个 Key、从下拉里选声音。
// 不会弄 Key 的，点「怎么拿到 API Key？」：可以让 agent 打开浏览器替你开通、拿 Key 并填好，也可以照着三步自己弄。
import * as React from 'react'
import { api, fileUrl, useLive } from './api.js'
import { Bar, Button, Dialog } from './ui.jsx'
import { startDirector } from './host.js'
import { toast } from './toast.jsx'
import { codeText, lang, t, useT } from './i18n.js'

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

// 配音、配乐服务的名字：按当前界面语言取；不认识的服务照原样显示
const VOICE_NAMES = { local: 'voice.local', system: 'voice.system', doubao: 'voice.doubao', elevenlabs: 'voice.elevenlabs', openai: 'voice.openai', none: 'voice.none' }
const MUSIC_NAMES = { local: 'music.local', volcengine: 'music.volcengine', elevenlabs: 'music.elevenlabs', none: 'music.none' }
export const voiceName = k => (VOICE_NAMES[k] ? t(VOICE_NAMES[k]) : k)
export const musicName = k => (MUSIC_NAMES[k] ? t(MUSIC_NAMES[k]) : k)
// 试听念的句子：选了具体声音的按声音的语言念；系统语音、OpenAI 兼容不知道声音是哪种语言，按界面语言念
const ZH_LINE = '你好，这是 lovideo 的配音试听。'
const EN_LINE = 'Hi, this is a lovideo narration preview.'
const ELEVEN_DEFAULT = { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', gender: null, note: null }
// ElevenLabs 默认声音的性别和说明：显示时按界面语言取
const elevenDefault = () => ({ ...ELEVEN_DEFAULT, gender: t('eleven.defaultGender'), note: t('eleven.defaultNote') })
const CUSTOM = '__custom'

/**
 * 配音、配乐两块设置，加上「怎么拿到 Key」的说明。
 * st 是 /state 的结果；onState 收到保存后的新 state。
 */
export function SoundSettings({ st, onState }) {
  const t = useT()
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
      <p className="lv-subtle" style={{ margin: '-4px 4px 16px' }}>{t('sound.footnote')}</p>
      <HelpDialog which={help} onClose={() => setHelp(null)} />
    </>
  )
}

/* ---------- 对话里的「填 Key」卡片 ---------- */

const KEY_TITLES = { doubao: 'voice.doubao', elevenlabs: 'voice.elevenlabs', openai: 'voice.openai', volcengine: 'music.volcengine' }

/**
 * 导演请用户填哪几家的 Key，卡片上就出哪几家的输入框。和设置页是同一套面板：保存后先试听一句，念出来了才切过去。
 * Key 直接存进本机设置，不经过对话，导演也看不到；某家配好了就调 onReady(那一家)，由外面告诉导演。
 */
export function KeyCard({ services, onReady }) {
  const t = useT()
  const [st, setSt] = React.useState(null)
  const [err, setErr] = React.useState(null)
  const [help, setHelp] = React.useState(null)
  React.useEffect(() => {
    api('state').then(setSt, e => setErr(e.message))
  }, [])
  const eleven = useElevenVoices(st?.settings.keys.elevenlabs)
  const [doubao] = useLive(services.includes('doubao') ? 'voice/catalog?provider=doubao' : null, () => false)
  if (err) return <div className="lv-err">{err}</div>
  if (!st) return <div className="lv-subtle lv-shimmer">{t('common.loading')}</div>
  const save = async patch => {
    const next = await api('settings', patch)
    setSt(next)
    // 配音服务：试听念出来了才会切过去（useVerify）；火山配乐：AK、SK 都有了才切过去
    const ready = patch.voice?.provider || (patch.music?.provider === 'volcengine' ? 'volcengine' : null)
    if (ready && services.includes(ready)) onReady(ready)
    return next
  }
  return (
    <>
      <style>{CSS}</style>
      {services.map(k => (
        <div key={k} className="lv-panel" style={{ marginTop: 0, marginBottom: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{t(KEY_TITLES[k])}</div>
          {k === 'doubao' ? <DoubaoPanel st={st} save={save} list={doubao?.voices || []} onHelp={() => setHelp('doubao')} /> : null}
          {k === 'elevenlabs' ? <ElevenPanel st={st} save={save} eleven={eleven} onHelp={() => setHelp('elevenlabs')} /> : null}
          {k === 'openai' ? <OpenAIPanel st={st} save={save} /> : null}
          {k === 'volcengine' ? <VolcPanel st={st} save={save} onHelp={() => setHelp('volcengine')} /> : null}
        </div>
      ))}
      <HelpDialog which={help} onClose={() => setHelp(null)} />
    </>
  )
}

/* ---------- 配音 ---------- */

function VoiceSettings({ st, save, refresh, onHelp }) {
  const t = useT()
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
      toast({ text: t('sound.voiceSwitched', { name: voiceName(k) }) })
    } catch (e) {
      toast({ text: e.message, tone: 'warning' })
    }
  }
  return (
    <div className="lv-section">
      <div className="lv-snd-head"><h3>{t('common.voice')}</h3><span className="lv-snd-now">{t('sound.now')}<b>{voiceNow(st, local.data, eleven.list, doubao?.voices)}</b></span></div>
      <Chips value={view} onPick={pick}
        items={[['local', voiceName('local'), t('common.recommended')], ['doubao', voiceName('doubao')], ['elevenlabs', voiceName('elevenlabs')]]}
        more={[['system', voiceName('system'), t('sound.systemNote')], ['openai', voiceName('openai'), t('sound.openaiNote')]]} />
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
    if (!m) return t('sound.localNotDownloaded')
    const names = Object.fromEntries((m.voices?.zh || []).concat(m.voices?.en || []))
    const vs = [m.chosenVoices?.zh, m.chosenVoices?.en].filter(id => id && names[id] && Object.keys(names).length > 2).map(id => names[id].split(' · ').pop())
    return [voiceName('local'), m.name, vs.join(' / ')].filter(Boolean).join(' · ')
  }
  if (v.provider === 'doubao') {
    if (!keys.doubao) return t('sound.noKey', { name: voiceName('doubao') })
    const d = (doubaoList || []).find(x => x.id === chosen)?.name
    return `${voiceName('doubao')} · ${chosen ? d || t('sound.customVoice') : t('sound.doubaoDefault')}`
  }
  if (v.provider === 'elevenlabs') {
    if (!keys.elevenlabs) return t('sound.noKey', { name: 'ElevenLabs' })
    const id = chosen || ELEVEN_DEFAULT.id
    return `ElevenLabs · ${(elevenList || []).find(x => x.id === id)?.name || (id === ELEVEN_DEFAULT.id ? ELEVEN_DEFAULT.name : t('sound.customVoiceEleven'))}`
  }
  if (v.provider === 'openai') return keys.openai ? `${voiceName('openai')} · ${v.openaiModel || 'gpt-4o-mini-tts'}` : t('sound.noKey', { name: voiceName('openai') })
  return voiceName(v.provider)
}

function DoubaoPanel({ st, save, list, onHelp }) {
  const t = useT()
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
      <div className="desc">{t('doubao.desc')}</div>
      <KeyLine masked={st.settings.keys.doubao} placeholder={t('doubao.keyPlaceholder')} help={t('sound.howToKey')} onHelp={onHelp}
        onSave={async key => {
          await save({ keys: { doubao: key } })
          verify.start()
        }} />
      <VoiceSelect value={chosen} known={Boolean(v) || !chosen} onPick={pickVoice} customHint={t('doubao.customHint')} listen={<ListenButton load={test} trigger={verify.trigger} onLoaded={verify.done} />}>
        <option value="">{t('doubao.auto')}</option>
        {[['zh', t('common.chinese')], ['en', t('common.english')]].map(([l, label]) => (
          <optgroup key={l} label={label}>
            {list.filter(x => x.lang === l).map(x => <option key={x.id} value={x.id}>{[x.gender, x.name, x.note].filter(Boolean).join(' · ')}</option>)}
          </optgroup>
        ))}
      </VoiceSelect>
      {chosen && v ? <div className="lv-line"><span className="k" /><span className="lv-subtle">{t('doubao.otherLang')}</span></div> : null}
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
  const t = useT()
  const has = Boolean(st.settings.keys.elevenlabs)
  const chosen = st.settings.voice.voices?.elevenlabs || ''
  const [err, setErr] = React.useState(null)
  const verify = useVerify(save, 'elevenlabs')
  const list = eleven.list || [elevenDefault()]
  const value = chosen || ELEVEN_DEFAULT.id
  const all = list.some(x => x.id === ELEVEN_DEFAULT.id) ? list : [elevenDefault(), ...list]
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
      <div className="desc">{t('eleven.desc')}</div>
      <KeyLine masked={st.settings.keys.elevenlabs} placeholder={t('eleven.keyPlaceholder')} help={t('sound.howToKey')} onHelp={onHelp}
        onSave={async key => {
          await save({ keys: { elevenlabs: key } })
          verify.start()
        }} />
      <VoiceSelect value={value} known={all.some(x => x.id === value)} onPick={pickVoice} customHint="voice ID" listen={<ListenButton load={test} trigger={verify.trigger} onLoaded={verify.done} />}>
        {all.map(x => <option key={x.id} value={x.id}>{[x.name, x.gender, x.note].filter(Boolean).join(' · ')}</option>)}
      </VoiceSelect>
      {has && !eleven.list && !eleven.error ? <div className="lv-line"><span className="k" /><span className="lv-subtle lv-shimmer">{t('eleven.loadingVoices')}</span></div> : null}
      {eleven.error ? <div className="lv-err">{eleven.error.message}</div> : null}
      {err ? <div className="lv-err">{err}</div> : null}
    </>
  )
}

function SystemPanel() {
  const t = useT()
  const [err, setErr] = React.useState(null)
  return (
    <>
      <div className="desc">{t('system.desc')}</div>
      <div className="lv-line"><ListenButton load={() => preview({ provider: 'system', text: lang() === 'en' ? EN_LINE : ZH_LINE }, true, setErr)} /></div>
      {err ? <div className="lv-err">{err}</div> : null}
    </>
  )
}

function OpenAIPanel({ st, save }) {
  const t = useT()
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
      <div className="desc">{t('openai.desc')}</div>
      <div className="lv-line"><span className="k">{t('openai.url')}</span><input className="lv-input lv-mono" placeholder="https://api.openai.com/v1" value={form.url} onChange={set('url')} /></div>
      <div className="lv-line"><span className="k">Key</span><input className="lv-input" type="password" autoComplete="off" placeholder={masked ? t('sound.savedMasked', { masked }) : 'sk-…'} value={form.key} onChange={set('key')} /></div>
      <div className="lv-line"><span className="k">{t('common.model')}</span><input className="lv-input" placeholder="gpt-4o-mini-tts" value={form.model} onChange={set('model')} /></div>
      <div className="lv-line"><span className="k">{t('sound.voiceLabel')}</span><input className="lv-input" placeholder="alloy" value={form.voice} onChange={set('voice')} />
        <Button kind="pri" busy={busy} disabled={!(form.key || masked)} onClick={submit}>{t('common.save')}</Button>
        <ListenButton load={() => preview({ provider: 'openai', text: lang() === 'en' ? EN_LINE : ZH_LINE }, Boolean(masked), setErr)} trigger={verify.trigger} onLoaded={verify.done} />
      </div>
      {err ? <div className="lv-err">{err}</div> : null}
    </>
  )
}

/* ---------- 配乐 ---------- */

function MusicSettings({ st, save, refresh, onHelp }) {
  const t = useT()
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
      toast({ text: t('sound.musicSwitched', { name: musicName(k) }) })
    } catch (e) {
      toast({ text: e.message, tone: 'warning' })
    }
  }
  return (
    <div className="lv-section">
      <div className="lv-snd-head"><h3>{t('common.music')}</h3><span className="lv-snd-now">{t('sound.now')}<b>{musicNow(st, local.data)}</b></span></div>
      <Chips value={view} onPick={pick} items={[['local', musicName('local'), t('common.recommended')], ['volcengine', musicName('volcengine')], ['elevenlabs', musicName('elevenlabs')]]} />
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
    return m ? `${musicName('local')} · ${m.name}` : t('sound.musicNotDownloaded')
  }
  if (p === 'volcengine') return keys.volcAk && keys.volcSk ? musicName('volcengine') : t('sound.noKey', { name: musicName('volcengine') })
  if (p === 'elevenlabs') return keys.elevenlabs ? 'ElevenLabs' : t('sound.noKey', { name: 'ElevenLabs' })
  return musicName(p)
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
  const t = useT()
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
        toast({ text: t('volc.ready') })
      } else toast({ text: t('volc.oneMore') })
      setForm({ ak: '', sk: '' })
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }
  const ph = (m, name) => (m ? t('sound.savedMasked', { masked: m }) : name)
  return (
    <>
      <div className="desc">{t('volc.desc')}</div>
      <div className="lv-line"><span className="k">AK</span><input className="lv-input" type="password" autoComplete="off" placeholder={ph(keys.volcAk, 'AccessKey ID')} value={form.ak} onChange={e => setForm(f => ({ ...f, ak: e.target.value }))} /></div>
      <div className="lv-line"><span className="k">SK</span><input className="lv-input" type="password" autoComplete="off" placeholder={ph(keys.volcSk, 'SecretAccessKey')} value={form.sk} onChange={e => setForm(f => ({ ...f, sk: e.target.value }))} onKeyDown={e => e.key === 'Enter' && (form.ak || form.sk) && submit()} />
        <Button kind="pri" busy={busy} disabled={!(form.ak.trim() || form.sk.trim())} onClick={submit}>{t('common.save')}</Button>
      </div>
      <div className="lv-line"><span className="k" /><button type="button" className="lv-linkbtn" onClick={onHelp}>{t('volc.howToKeys')}</button></div>
      {ready ? <div className="lv-line"><span className="k" /><ListenButton label={t('sound.listen30')} load={musicTest('volcengine', setErr)} /></div> : null}
      {err ? <div className="lv-err">{err}</div> : null}
    </>
  )
}

function ElevenMusicPanel({ st, save, onHelp }) {
  const t = useT()
  const masked = st.settings.keys.elevenlabs
  const [err, setErr] = React.useState(null)
  return (
    <>
      <div className="desc">{t('elevenMusic.desc')}</div>
      {masked ? (
        <div className="lv-line"><span className="lv-ok-text">{t('elevenMusic.shared', { masked })}</span><ListenButton label={t('sound.listen30')} load={musicTest('elevenlabs', setErr)} /></div>
      ) : (
        <KeyLine placeholder={t('elevenMusic.keyPlaceholder')} help={t('sound.howToKey')} onHelp={onHelp}
          onSave={async key => {
            await save({ keys: { elevenlabs: key }, music: { provider: 'elevenlabs' } })
            toast({ text: t('elevenMusic.ready') })
          }} />
      )}
      {err ? <div className="lv-err">{err}</div> : null}
    </>
  )
}

/* ---------- 离线（配音、配乐共用） ---------- */

const LOCAL_STEP = { queued: 'local.step.queued', uv: 'local.step.uv', packages: 'local.step.packages', model: 'local.step.model', test: 'local.step.test' }
const gradeLabel = (m, d) => t(m.grade === 'unable' ? 'local.grade.unable' : m.grade === 'heavy' ? 'local.grade.heavy' : d.recommended === m.id ? 'common.recommended' : 'local.grade.smooth')

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
  return `${t(LOCAL_STEP[job.step] || 'local.step.preparing')}${job.step === 'model' ? ` ${Math.round((job.progress || 0) * 100)}%` : ''}`
}

function LocalPanel({ kind, local, onChanged }) {
  const t = useT()
  const music = kind === 'music'
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
  const use = (m, voices) => act(`use-${m.id}`, 'local-voice/use', { model: m.id, ...(voices ? { voices } : {}) }, voices ? null : () => toast({ text: t(music ? 'local.musicSwitched' : 'local.voiceSwitched', { name: m.name }) }))
  // 用户选中的模型下载完：直接用上它
  const jobRunning = Boolean(shown?.job?.running)
  const wasRunning = React.useRef(false)
  React.useEffect(() => {
    if (wasRunning.current && !jobRunning && shown?.installed && !(d.usingLocal && d.active === shown.id)) use(shown)
    wasRunning.current = jobRunning
  }, [jobRunning])
  if (local.error) return <div className="lv-err">{local.error.message}</div>
  if (!d) return <div className="lv-subtle lv-shimmer">{t('local.checking')}</div>
  const hw = d.hardware
  if (!d.minimum.ok) {
    const spec = { reason: d.minimum.reason, ram: d.minimum.spec.ramGB, cores: d.minimum.spec.cores, disk: d.minimum.spec.freeDiskGB }
    return <div className="desc">{t(music ? 'local.tooWeakMusic' : 'local.tooWeakVoice', spec)}</div>
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
  const speed = m.installed ? (music ? t('local.speedMusic', { s: Math.max(1, m.installed.oneMinute) }) : t('local.speedVoice', { s: m.installed.oneMinute })) : ''
  return (
    <>
      <div className="desc">{music ? t('local.descMusic') : t('local.descVoice')}<span className="lv-subtle">{t('local.hardware', { chip: hw.chip || hw.platform, ram: hw.ramGB, gpu: hw.gpu ? ` · ${hw.gpu.name}` : '' })}</span></div>
      <div className="lv-line"><span className="k">{t('common.model')}</span>
        <select className="lv-select" value={m.id} onChange={e => pickModel(e.target.value)} disabled={Boolean(busy)}>
          {d.models.map(x => <option key={x.id} value={x.id} disabled={x.grade === 'unable'}>{[x.name, gradeLabel(x, d), x.installed ? t('local.installed') : x.job?.running ? t('local.downloading') : t('local.notDownloaded', { gb: x.downloadGB })].join(' · ')}</option>)}
        </select>
        {m.installed && !m.job?.running ? <Button size="sm" kind="ghost" busy={busy === m.id} onClick={() => act(m.id, 'local-voice/setup', { model: m.id })}>{t('local.retest')}</Button> : null}
      </div>
      <div className="lv-line"><span className="k" /><span className="lv-subtle">{[m.note, speed, m.gradeReason].filter(Boolean).join(' · ')}</span></div>
      {!m.installed ? (
        <div className="lv-line"><span className="k" />
          {m.job?.running ? (
            <div className="lv-col"><span className="lv-subtle">{jobText(m.job)}…</span>{m.job.step === 'model' ? <Bar value={m.job.progress} /> : null}</div>
          ) : m.grade === 'unable' ? <span className="lv-subtle">{t('local.cannotRun')}</span> : (
            <Button kind="pri" busy={busy === m.id} onClick={() => act(m.id, 'local-voice/setup', { model: m.id })}>{t('local.download', { gb: m.downloadGB })}</Button>
          )}
        </div>
      ) : m.job?.running ? <div className="lv-line"><span className="k" /><span className="lv-subtle">{jobText(m.job)}…</span></div> : null}
      {m.installed && !music ? [['zh', t('local.zhVoice')], ['en', t('local.enVoice')]].filter(([l]) => (m.voices?.[l] || []).length > 0).map(([l, label]) => (
        <div key={l} className="lv-line"><span className="k">{label}</span>
          <select className="lv-select" value={m.chosenVoices?.[l] || ''} disabled={(m.voices[l] || []).length < 2 || Boolean(busy)} onChange={e => use(m, { [l]: e.target.value })}>
            {m.voices[l].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <ListenButton load={listen(l)} />
        </div>
      )) : null}
      {m.installed && (music || !using) ? (
        <div className="lv-line"><span className="k" />
          {!using ? <Button kind="pri" busy={busy === `use-${m.id}`} onClick={() => use(m)}>{t('common.useThis')}</Button> : null}
          {music ? <ListenButton label={t('local.listen15')} load={listen()} /> : null}
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
  const inMore = more.find(([k]) => k === value)
  return (
    <div className="lv-chips">
      {items.map(([k, label, tag]) => <button key={k} type="button" className={value === k ? 'on' : ''} onClick={() => onPick(k)}>{label}{tag ? <span className="tag">{tag}</span> : null}</button>)}
      {more.length ? (
        <span className="lv-more" ref={box}>
          <button type="button" className={inMore ? 'on' : ''} aria-expanded={open} onClick={() => setOpen(o => !o)}>{inMore ? inMore[1] : t('common.more')} ▾</button>
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
  const t = useT()
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
        <input className="lv-input" type="password" autoComplete="off" spellCheck={false} placeholder={masked ? t('sound.savedMasked', { masked }) : placeholder} value={v} onChange={e => setV(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
        <Button kind="pri" busy={busy} disabled={!v.trim()} onClick={submit}>{t('common.save')}</Button>
      </div>
      <div className="lv-line"><span className="k" /><button type="button" className="lv-linkbtn" onClick={onHelp}>{help}</button></div>
      {err ? <div className="lv-err">{err}</div> : null}
    </>
  )
}

/** 声音下拉；最后一项「自定义…」打开一个输入框，填平台上的音色 ID */
function VoiceSelect({ value, known, onPick, customHint, listen, children }) {
  const t = useT()
  const [custom, setCustom] = React.useState(!known)
  const [id, setId] = React.useState(known ? '' : value)
  React.useEffect(() => {
    // 声音列表读回来后，选的声音在列表里就收起输入框；不在列表里就是自定义的
    setCustom(!known)
    setId(known ? '' : value)
  }, [known, value])
  return (
    <>
      <div className="lv-line"><span className="k">{t('sound.voiceLabel')}</span>
        <select className="lv-select" value={custom ? CUSTOM : value} onChange={e => {
          if (e.target.value === CUSTOM) return setCustom(true)
          setCustom(false)
          onPick(e.target.value)
        }}>
          {children}
          <option value={CUSTOM}>{t('sound.customId')}</option>
        </select>
        {listen}
      </div>
      {custom ? (
        <div className="lv-line"><span className="k" />
          <input className="lv-input lv-mono" placeholder={customHint} value={id} onChange={e => setId(e.target.value)} onKeyDown={e => e.key === 'Enter' && id.trim() && onPick(id.trim())} />
          <Button disabled={!id.trim() || id.trim() === value} onClick={() => onPick(id.trim())}>{t('common.useThis')}</Button>
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
        toast({ text: t('sound.keyWorks', { name: voiceName(provider) }) })
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
    setErr(t('sound.needKey'))
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

// 每家服务的说明都在字典里：help.<服务>.title / ask / step1–3 / copy。
// ask 和 copy 是以用户身份发给 agent 的话，跟着界面语言变；步骤里用反引号标出的是网址，画成 <code>
const HELP = ['doubao', 'elevenlabs', 'volcengine']
const helpOf = k => (HELP.includes(k) ? {
  title: t(`help.${k}.title`),
  ask: t(`help.${k}.ask`),
  steps: [1, 2, 3].map(i => codeText(t(`help.${k}.step${i}`))),
  copy: t(`help.${k}.copy`),
} : null)

function HelpDialog({ which, onClose }) {
  const t = useT()
  const [last, setLast] = React.useState(which)
  React.useEffect(() => {
    if (which) setLast(which)
  }, [which])
  const h = helpOf(which || last)
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
    toast({ text: t('help.copied') })
  }
  const ask = () => {
    startDirector(h.ask)
    onClose()
    toast({ text: t('help.started') })
  }
  if (!h) return null
  return (
    <Dialog open={Boolean(which)} title={h.title} onCancel={onClose} actions={<>
      <button type="button" className="lv-btn" onClick={onClose}>{t('common.close')}</button>
      <button type="button" className="lv-btn" onClick={copy}>{t('help.copy')}</button>
      <button type="button" className="lv-btn pri" onClick={ask}>{t('help.ask')}</button>
    </>}>
      <div className="lv-help">
        <p>{t('help.intro')}</p>
        <div className="lv-or">{t('help.or')}</div>
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
export function ListenButton({ load, size, kind, label, trigger = 0, onLoaded }) {
  const t = useT()
  // 没传 label 时显示「试听」；传空字符串是只要图标的圆按钮
  const text = label ?? t('listen.label')
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
    <Button className={`lv-btn lv-listen ${kind || 'ghost'} ${size || ''}`} busy={state === 'loading'} onClick={click} aria-label={text || (state === 'playing' ? t('listen.stop') : t('listen.label'))}>
      {state === 'playing' ? <Wave audio={audio.current} /> : state === 'idle' ? <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 1.3v7.4L8.7 5z" fill="currentColor" /></svg> : null}
      {text ? (state === 'playing' ? t('listen.stop') : state === 'loading' ? t('listen.loading') : text) : null}
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
