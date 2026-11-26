// 一部片子的配音和配乐：设置里是默认（用哪家服务、哪个声音），分镜卡上可以只给这部片子换声音、换配乐来源。
//   work.choices.voicePick   { provider, id, model?, lang }   这部片子用的声音（只在设置里的配音服务还是它时生效）
//   work.choices.musicSource 'local' | 'volcengine' | 'elevenlabs'   这部片子的配乐来源（不填用设置里的）
import { readSettings } from './settings.js'
import { DOUBAO_DEFAULT, DOUBAO_VOICES, ELEVEN_DEFAULT, elevenVoices } from './voicecatalog.js'
import { localVoiceStatus, musicReady } from './localvoice.js'

export const VOICE_LABEL = { local: '离线配音', system: '系统自带语音', doubao: '豆包语音', elevenlabs: 'ElevenLabs', openai: 'OpenAI 兼容', none: '不配音' }
export const MUSIC_LABEL = { local: '离线配乐', volcengine: '火山配乐', elevenlabs: 'ElevenLabs' }
export const MUSIC_SOURCES = ['local', 'volcengine', 'elevenlabs']

/** 片子用哪种语言（口播里有中文就是中文） */
export const filmLang = work => (/[一-鿿]/.test(JSON.stringify(work.plan?.scenes || [])) ? 'zh' : 'en')

/** 这部片子的配乐来源：分镜卡上选过就用它，否则用设置里的 */
export function musicSourceOf(work, s = readSettings()) {
  const picked = work?.choices?.musicSource
  return MUSIC_SOURCES.includes(picked) ? picked : s.music.provider
}

/** 设置换成这部片子的配乐来源（制作、补配乐时用） */
export const withMusicSource = (s, work) => ({ ...s, music: { ...s.music, provider: musicSourceOf(work, s) } })

/** 某个配乐来源现在能不能用：离线要先下载，云服务要填 Key */
export function musicSourceReady(provider, s = readSettings(), seconds = 60) {
  if (provider === 'local') {
    const r = musicReady(seconds)
    return r.ok ? { ok: true, source: MUSIC_LABEL.local } : { ok: false, reason: r.code === 'not-installed' ? '还没下载离线配乐' : r.reason, code: r.code }
  }
  if (provider === 'volcengine' && !(s.keys.volcAk && s.keys.volcSk)) return { ok: false, reason: '火山配乐还没填 Key', code: 'no-key' }
  if (provider === 'elevenlabs' && !s.keys.elevenlabs) return { ok: false, reason: 'ElevenLabs 还没填 Key', code: 'no-key' }
  return { ok: true, source: MUSIC_LABEL[provider] || provider }
}

/** 分镜卡上给这部片子换的声音，在现在的配音服务下还有没有效 */
export function voicePickOf(work, s = readSettings()) {
  const pick = work?.choices?.voicePick
  return pick && pick.provider === s.voice.provider ? pick : null
}

const split = name => {
  const [a, b] = String(name).split(' · ')
  return b ? { gender: a, name: b } : { gender: '', name: a }
}

/**
 * 分镜卡上配音、配乐两行要的东西：现在用哪个声音、能换哪些（这部片子的语言）、配乐来源各自能不能用。
 */
export async function filmSound(work) {
  const s = readSettings()
  const lang = filmLang(work)
  const p = s.voice.provider
  const pick = voicePickOf(work, s)
  let options = []
  let currentId = null
  let service = VOICE_LABEL[p] || p
  let note = null
  if (p === 'local') {
    const st = localVoiceStatus('voice')
    const m = st.models.find(x => x.id === st.active && x.installed)
    if (m) {
      service = `离线配音 · ${m.name}`
      options = (m.voices?.[lang] || []).map(([id, label]) => ({ id, ...split(label), model: m.id }))
      currentId = pick?.model === m.id ? pick.id : m.chosenVoices?.[lang]
    } else note = '离线配音还没下载，这部片子会先用系统自带语音'
  } else if (p === 'doubao') {
    options = DOUBAO_VOICES.filter(v => v.lang === lang).map(v => ({ id: v.id, name: v.name, gender: v.gender, note: v.note }))
    const saved = s.voice.voices.doubao
    currentId = pick?.id || (saved && (options.some(o => o.id === saved) || !DOUBAO_VOICES.some(v => v.id === saved)) ? saved : DOUBAO_DEFAULT[lang])
    if (!s.keys.doubao) note = '豆包语音还没填 Key'
  } else if (p === 'elevenlabs') {
    const list = await elevenVoices().catch(() => [ELEVEN_DEFAULT])
    options = (list.some(v => v.id === ELEVEN_DEFAULT.id) ? list : [ELEVEN_DEFAULT, ...list]).map(v => ({ id: v.id, name: v.name, gender: v.gender, note: v.note }))
    currentId = pick?.id || s.voice.voices.elevenlabs || ELEVEN_DEFAULT.id
    if (!s.keys.elevenlabs) note = 'ElevenLabs 还没填 Key'
  } else if (p === 'openai') {
    currentId = s.voice.voices.openai || 'alloy'
  }
  const known = options.find(o => o.id === currentId)
  const current = p === 'system' ? { id: null, name: '系统自带语音', gender: '', note: '电脑自带的声音' }
    : known || (currentId ? { id: currentId, name: p === 'local' ? currentId : '自定义声音', gender: '', note: '' } : null)
  const source = musicSourceOf(work, s)
  return {
    voice: { provider: p, service, lang, current, options, picked: Boolean(pick), note },
    music: {
      source,
      picked: MUSIC_SOURCES.includes(work?.choices?.musicSource),
      sources: MUSIC_SOURCES.map(id => ({ id, name: MUSIC_LABEL[id], ...musicSourceReady(id, s) })),
    },
  }
}
