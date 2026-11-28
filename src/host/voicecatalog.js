// 各家配音服务能选的声音：用户只从下拉里选，不用自己去查音色 ID。
//   豆包：和 lovideo 网站上架的同一批（seed-tts-2.0），中文默认 Vivi，英文默认 Megan；
//         试听用火山官方放在 CDN 上的样音（和网站音色表 trial_url 一致），不调接口、不花用户额度
//   ElevenLabs：填了 key 以后读用户账号里的声音列表；没填时先给默认的 Rachel
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readSettings } from './settings.js'
import { ensureDir, tmpDir } from './paths.js'
import { download } from './download.js'

// 火山官方样音的 CDN 目录；file 是目录下的相对路径（有的在 audio/ 子目录，扩展名也不一样）
const TRIAL_CDN = 'https://lf3-static.bytednsdoc.com/obj/eden-cn/lm_hz_ihsph/ljhwZthlaukjlkulzlp/portal/bigtts/'
const D = (speaker, name, gender, lang, note, file) => ({ id: `seed-tts-2.0/${speaker}`, name, gender, lang, note, sample: TRIAL_CDN + file })

export const DOUBAO_VOICES = [
  D('zh_female_vv_uranus_bigtts', 'Vivi', '女声', 'zh', '温暖自然', 'zh_female_vv_uranus_bigtts.wav'),
  D('zh_female_xiaohe_uranus_bigtts', '小何', '女声', 'zh', '活泼', 'zh_female_xiaohe_uranus_bigtts.mp3'),
  D('zh_male_m191_uranus_bigtts', '云舟', '男声', 'zh', '沉稳讲解', 'zh_male_m191_uranus_bigtts.mp3'),
  D('zh_male_taocheng_uranus_bigtts', '小天', '男声', 'zh', '清爽', 'zh_male_taocheng_uranus_bigtts.mp3'),
  D('zh_male_jieshuoxiaoming_uranus_bigtts', '解说小明', '男声', 'zh', '解说', 'zh_male_jieshuoxiaoming_uranus_bigtts.mp3'),
  D('zh_male_wennuanahu_uranus_bigtts', '温暖阿虎', '男声', 'zh', '温暖', 'audio/zh_male_wennuanahu_uranus_bigtts.mp3'),
  D('zh_female_sophie_uranus_bigtts', '魅力苏菲', '女声', 'zh', '有魅力', 'zh_male_sophie_uranus_bigtts.mp3'),
  D('zh_male_guanggaojieshuo_uranus_bigtts', '广告解说', '男声', 'zh', '广告', 'zh_male_guanggaojieshuo_uranus_bigtts.mp3'),
  D('en_female_wenrouzhishijieshuonv_uranus_bigtts', 'Megan', '女声', 'en', '轻松讲知识', 'audio/en_female_wenrouzhishijieshuonv_uranus_bigtts.wav'),
  D('en_female_zendaya_p1_uranus_bigtts', 'Zendaya', '女声', 'en', '随和活泼', 'audio/en_female_zendaya_p1_uranus_bigtts.wav'),
  D('en_male_ryan_uranus_bigtts', 'Ryan', '男声', 'en', '低沉有磁性', 'audio/en_male_ryan_uranus_bigtts.mp3'),
  D('ICL_uranus_en_male_michael_tob', 'Michael', '男声', 'en', '亲切', 'audio/ICL_uranus_en_male_michael_tob.wav'),
  D('en_female_authoritative-british_uranus_bigtts', 'Charlotte', '女声', 'en', '英音', 'audio/en_female_authoritative-british_uranus_bigtts.wav'),
  D('en_male_russell_uranus_bigtts', 'Russell', '男声', 'en', '明亮温暖', 'audio/en_male_russell_uranus_bigtts.wav'),
  D('ICL_uranus_en_male_ethan_tob', 'Ethan', '男声', 'en', '儒雅', 'audio/ICL_uranus_en_male_ethan_tob.wav'),
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
  // preview_url 是 ElevenLabs 给每个声音放好的样音，试听直接用它，不花额度
  const list = (data.voices || []).map(v => ({ id: v.voice_id, name: v.name, gender: gender(v.labels?.gender), note: v.labels?.description || v.labels?.accent || '', sample: v.preview_url || null }))
  elevenCache = { key, at: Date.now(), list: list.length ? list : [ELEVEN_DEFAULT] }
  return elevenCache.list
}

/** 设置页下拉要的声音列表 */
export async function voiceCatalog(provider) {
  if (provider === 'doubao') return DOUBAO_VOICES
  if (provider === 'elevenlabs') return elevenVoices()
  return []
}

/** 某个声音的官方样音地址：豆包在目录里，ElevenLabs 从账号的声音列表里读；没有就是 null */
export async function sampleUrl(provider, id) {
  if (provider === 'doubao') return DOUBAO_VOICES.find(v => v.id === id)?.sample || null
  if (provider === 'elevenlabs') {
    const list = await elevenVoices().catch(() => [])
    return list.find(v => v.id === id)?.sample || null
  }
  return null
}

/**
 * 把官方样音下到本机再给页面放（存一次以后都从本机读）：页面不用直连外站，
 * 声纹动画也能读到音量。没有样音时返回 null，调用方再决定要不要真念一句。
 * @returns {Promise<string|null>} tmp/ 下的相对路径
 */
export async function voiceSample(provider, id) {
  const url = await sampleUrl(provider, id)
  if (!url) return null
  const ext = (/\.(mp3|wav|m4a|ogg)(?:$|\?)/i.exec(new URL(url).pathname) || [, 'mp3'])[1].toLowerCase()
  const name = `${provider}-${createHash('sha1').update(url).digest('hex').slice(0, 16)}.${ext}`
  const file = join(ensureDir(join(tmpDir(), 'voice-samples')), name)
  if (!existsSync(file)) await download([url], file, { label: '试听样音', probeMs: 0 })
  return `tmp/voice-samples/${name}`
}
