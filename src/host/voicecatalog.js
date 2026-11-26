// 各家配音服务能选的声音：用户只从下拉里选，不用自己去查音色 ID。
//   豆包：和 lovideo 网站上架的同一批（seed-tts-2.0），中文默认 Vivi，英文默认 Megan
//   ElevenLabs：填了 key 以后读用户账号里的声音列表；没填时先给默认的 Rachel
import { readSettings } from './settings.js'

const D = (speaker, name, gender, lang, note) => ({ id: `seed-tts-2.0/${speaker}`, name, gender, lang, note })

export const DOUBAO_VOICES = [
  D('zh_female_vv_uranus_bigtts', 'Vivi', '女声', 'zh', '温暖自然'),
  D('zh_female_xiaohe_uranus_bigtts', '小何', '女声', 'zh', '活泼'),
  D('zh_male_m191_uranus_bigtts', '云舟', '男声', 'zh', '沉稳讲解'),
  D('zh_male_taocheng_uranus_bigtts', '小天', '男声', 'zh', '清爽'),
  D('zh_male_jieshuoxiaoming_uranus_bigtts', '解说小明', '男声', 'zh', '解说'),
  D('zh_male_wennuanahu_uranus_bigtts', '温暖阿虎', '男声', 'zh', '温暖'),
  D('zh_female_sophie_uranus_bigtts', '魅力苏菲', '女声', 'zh', '有魅力'),
  D('zh_male_guanggaojieshuo_uranus_bigtts', '广告解说', '男声', 'zh', '广告'),
  D('en_female_wenrouzhishijieshuonv_uranus_bigtts', 'Megan', '女声', 'en', '轻松讲知识'),
  D('en_female_zendaya_p1_uranus_bigtts', 'Zendaya', '女声', 'en', '随和活泼'),
  D('en_male_ryan_uranus_bigtts', 'Ryan', '男声', 'en', '低沉有磁性'),
  D('ICL_uranus_en_male_michael_tob', 'Michael', '男声', 'en', '亲切'),
  D('en_female_authoritative-british_uranus_bigtts', 'Charlotte', '女声', 'en', '英音'),
  D('en_male_russell_uranus_bigtts', 'Russell', '男声', 'en', '明亮温暖'),
  D('ICL_uranus_en_male_ethan_tob', 'Ethan', '男声', 'en', '儒雅'),
]
export const DOUBAO_DEFAULT = { zh: DOUBAO_VOICES[0].id, en: DOUBAO_VOICES.find(v => v.lang === 'en').id }

/**
 * 豆包这次念哪个声音：用户选的声音会说这种语言就用它，不会说（比如中文声音念英文片）就换成这种语言的默认声音。
 * 自定义的音色 ID 不在目录里，照用户的来。
 */
export function doubaoVoiceFor(chosen, lang) {
  const v = DOUBAO_VOICES.find(x => x.id === chosen)
  if (!chosen) return DOUBAO_DEFAULT[lang] || DOUBAO_DEFAULT.zh
  if (!v || v.lang === lang) return chosen
  return DOUBAO_DEFAULT[lang] || chosen
}

export const ELEVEN_DEFAULT = { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', gender: '女声', note: '平静旁白' }

let elevenCache = { key: null, at: 0, list: null }

/** 用户 ElevenLabs 账号里能用的声音（10 分钟内复用） */
export async function elevenVoices(key = readSettings().keys.elevenlabs) {
  if (!key) return [ELEVEN_DEFAULT]
  if (elevenCache.key === key && Date.now() - elevenCache.at < 600_000) return elevenCache.list
  const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw Object.assign(new Error(res.status === 401 ? 'ElevenLabs 的 Key 不对，请重新复制一遍' : `读取 ElevenLabs 声音列表失败（${res.status}）`), { status: 400 })
  const data = await res.json()
  const gender = g => (g === 'female' ? '女声' : g === 'male' ? '男声' : '')
  const list = (data.voices || []).map(v => ({ id: v.voice_id, name: v.name, gender: gender(v.labels?.gender), note: v.labels?.description || v.labels?.accent || '' }))
  elevenCache = { key, at: Date.now(), list: list.length ? list : [ELEVEN_DEFAULT] }
  return elevenCache.list
}

/** 设置页下拉要的声音列表 */
export async function voiceCatalog(provider) {
  if (provider === 'doubao') return DOUBAO_VOICES
  if (provider === 'elevenlabs') return elevenVoices()
  return []
}
