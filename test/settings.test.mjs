// 配音、配乐设置：每家服务各存各的 key 和声音；Key 由用户在卡片上填（不经过对话），界面只露末 4 位
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.LOVIDEO_DATA_DIR = mkdtempSync(join(tmpdir(), 'lovideo-settings-test-'))
const { publicSettings, readSettings, updateSettings, voiceConfig } = await import('../src/host/settings.js')
const { DOUBAO_DEFAULT, doubaoVoiceFor } = await import('../src/host/voicecatalog.js')
const { TOOLS, notifyKeyReady } = await import('../src/host/tools.js')

test('换配音服务不会冲掉另一家的 key，声音也各记各的', () => {
  updateSettings({ voice: { provider: 'elevenlabs', voices: { elevenlabs: 'voice-abc' } }, keys: { elevenlabs: 'el-key-1234' } })
  updateSettings({ voice: { provider: 'doubao' }, keys: { doubao: 'db-key-5678' } })
  const s = readSettings()
  assert.equal(s.keys.elevenlabs, 'el-key-1234')
  assert.equal(s.keys.doubao, 'db-key-5678')
  assert.deepEqual(voiceConfig(s), { provider: 'doubao', key: 'db-key-5678', voice: '', url: '', model: '' })
  updateSettings({ voice: { provider: 'elevenlabs' } })
  assert.equal(voiceConfig().voice, 'voice-abc')
  assert.equal(voiceConfig().key, 'el-key-1234')
})

test('界面只看到末 4 位；掩码原样交回不会改掉 key，null 才删除', () => {
  const pub = publicSettings()
  assert.equal(pub.keys.doubao, '••••5678')
  assert.equal(JSON.stringify(pub).includes('db-key-5678'), false)
  updateSettings({ keys: { doubao: '••••5678' } })
  assert.equal(readSettings().keys.doubao, 'db-key-5678')
  updateSettings({ keys: { doubao: null } })
  assert.equal(readSettings().keys.doubao, '')
})

test('豆包：没选声音用默认；中文声音念英文片时换成英文默认声音', () => {
  assert.equal(doubaoVoiceFor('', 'zh'), DOUBAO_DEFAULT.zh)
  assert.equal(doubaoVoiceFor('', 'en'), DOUBAO_DEFAULT.en)
  assert.equal(doubaoVoiceFor('seed-tts-2.0/zh_male_m191_uranus_bigtts', 'zh'), 'seed-tts-2.0/zh_male_m191_uranus_bigtts')
  assert.equal(doubaoVoiceFor('seed-tts-2.0/zh_male_m191_uranus_bigtts', 'en'), DOUBAO_DEFAULT.en)
  // 自定义音色 ID 不在目录里：照用户的来
  assert.equal(doubaoVoiceFor('seed-tts-2.0/my_custom', 'en'), 'seed-tts-2.0/my_custom')
})

test('lovideo_configure：Key 不能经过参数；要 Key 时出卡片，没 Key 的服务先不切；卡片填好后叫醒导演', async () => {
  const configure = TOOLS.find(t => t.name === 'lovideo_configure')
  updateSettings({ voice: { provider: 'local' }, music: { provider: 'local' }, keys: { doubao: null, volcAk: null, volcSk: null } })
  await assert.rejects(configure.execute({ keys: { doubao: 'sk-1' } }), /keys/)
  const told = []
  const agent = { id: 'sess-1', followup: m => told.push(m.content[0].text) }
  const r = await configure.execute(Object.freeze({ voice_provider: 'doubao', music_provider: 'volcengine', ask_keys: ['doubao', 'volcengine'] }), { agent })
  const s = readSettings()
  assert.equal(s.voice.provider, 'local', '还没填 Key 的服务不切过去')
  assert.equal(s.music.provider, 'local')
  assert.match(r.text, /session_id: sess-1/)
  assert.match(r.text, /豆包语音、火山配乐/)
  // 卡片上填好、试听通过：导演收到通知
  assert.equal(notifyKeyReady('sess-1', 'doubao'), true)
  assert.match(told[0], /\[lovideo 通知\] 用户在卡片上填好了 Key：豆包语音/)
  assert.equal(notifyKeyReady('sess-1', 'nope'), false)
  assert.equal(notifyKeyReady('no-such-session', 'doubao'), false)
  // 已经有 Key 的服务照常切过去
  updateSettings({ keys: { doubao: 'k-5678' } })
  await configure.execute({ voice_provider: 'doubao', ask_keys: ['doubao'] }, { agent })
  assert.equal(readSettings().voice.provider, 'doubao')
  await assert.rejects(configure.execute({ voice_provider: 'nope' }), /voice_provider 只能是/)
})

test('分镜卡上只给这部片子换声音、换配乐来源；设置里换了配音服务，换过的声音不再算数', async () => {
  const { filmSound, musicSourceOf, voicePickOf } = await import('../src/host/filmsound.js')
  updateSettings({ voice: { provider: 'doubao', voices: { doubao: '' } }, music: { provider: 'local' }, keys: { doubao: 'k-1234', volcAk: null, volcSk: null } })
  const work = { plan: { scenes: [{ narration: '你好' }] }, choices: { voicePick: { provider: 'doubao', id: 'seed-tts-2.0/zh_male_m191_uranus_bigtts', lang: 'zh' }, musicSource: 'volcengine' } }
  const s = await filmSound(work)
  assert.equal(s.voice.lang, 'zh')
  assert.equal(s.voice.current.name, '云舟')
  assert.ok(s.voice.options.every(o => !o.id.includes('/en_')), '中文片只列中文声音')
  assert.equal(s.voice.picked, true)
  assert.equal(s.music.source, 'volcengine')
  assert.equal(s.music.sources.find(x => x.id === 'volcengine').ok, false)
  assert.equal(musicSourceOf({ choices: {} }), 'local')
  updateSettings({ voice: { provider: 'system' } })
  assert.equal(voicePickOf(work), null)
  // 以前存过的「不配乐」读出来按离线配乐算；设置里也不能再选「不配乐」
  const file = join(process.env.LOVIDEO_DATA_DIR, 'settings.json')
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), music: { provider: 'none' } }))
  assert.equal(readSettings().music.provider, 'local')
  assert.equal(musicSourceOf({ choices: {} }), 'local')
  assert.throws(() => updateSettings({ music: { provider: 'none' } }), /不支持/)
})
