// 导演出分镜的规则：片长档位和镜头数、用户在分镜卡上定的设置优先（和 lovideo 网站一样）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.LOVIDEO_DATA_DIR = mkdtempSync(join(tmpdir(), 'lovideo-plan-test-'))
const { importMineFromDir } = await import('../src/host/styles.js')
const { TOOLS } = await import('../src/host/tools.js')
const { requireWork, updateWork } = await import('../src/host/works.js')

const base = new URL('../vendor/base-style/', import.meta.url).pathname
const dir = join(process.env.LOVIDEO_DATA_DIR, 'style')
cpSync(join(base, 'assets'), join(dir, 'assets'), { recursive: true })
writeFileSync(join(dir, 'SKILL.md'), `---\nname: t\ndescription: t\n---\n\n# 测试\n\n${readFileSync(join(base, 'PRODUCTION.md'), 'utf8')}`)
importMineFromDir('style-test', dir, { name: '测试风格' })
const plan = TOOLS.find(t => t.name === 'lovideo_plan')

// 默认口播约 15 秒（一镜至少 15 秒，口播太短会被退回）
// 口播一句一项（每句最多 60 个字符）
const LINE = ['天宫空间站由天和核心舱、问天实验舱和梦天实验舱组成，三个舱拼成一个 T 字。', '总重约六十八吨，航天员可以在三个舱之间来回走动。']
const scene = (n, narration = LINE) => ({ title: `第${n}镜`, description: '画面', narration, seconds: 15 })
const args = extra => ({
  title: '测试', style: 'style-test', duration: 30, subtitles: true,
  voice: { use: true, why: '讲解片' }, music: { use: true, brief: '轻快钢琴', prompt: 'light piano' },
  scenes: [scene(1), scene(2)], ...extra,
})

test('片长决定最多几镜：30 秒最多 2 镜', async () => {
  await assert.rejects(plan.execute(args({ scenes: [scene(1), scene(2), scene(3)] })), /最多 2 镜/)
  const r = await plan.execute(args({ duration: 60, scenes: [scene(1), scene(2), scene(3), scene(4)] }))
  assert.equal(requireWork(r.work_id).duration, 60)
})

test('口播比目标片长长太多时打回', async () => {
  const long = Array(6).fill('这是一段很长很长的口播，一句话里塞了很多很多的字，念起来要好几秒钟。')
  await assert.rejects(plan.execute(args({ scenes: [scene(1, long), scene(2, long)] })), /比目标片长 30 秒长/)
})

test('口播太短的镜头被退回，退回带记号、不算给用户看的失败', async () => {
  await assert.rejects(plan.execute(args({ scenes: [scene(1, ['一句话。']), scene(2)] })), e => /口播太短/.test(e.message) && e.message.startsWith('【请改好后再调用】'))
})

test('一句口播超过 60 个字符整版退回（和网站一样），分镜里按句存', async () => {
  const tooLong = '天宫空间站由天和核心舱、问天实验舱和梦天实验舱组成，三个舱拼成一个 T 字，总重约六十八吨，航天员可以在三个舱之间来回走动。'
  await assert.rejects(plan.execute(args({ scenes: [scene(1, [tooLong]), scene(2)] })), e => /超过 60 个字符/.test(e.message) && e.message.startsWith('【请改好后再调用】'))
  const r = await plan.execute(args({ direction: '深色底、黄色强调色、粗黑体大标题' }))
  const w = requireWork(r.work_id)
  assert.deepEqual(w.plan.scenes[0].sentences, LINE)
  assert.equal(w.plan.scenes[0].narration, LINE.join(''))
  assert.equal(w.plan.direction, '深色底、黄色强调色、粗黑体大标题')
})

test('有口播的镜头长度按口播算，不按导演给的秒数拉长', async () => {
  const r = await plan.execute(args({ scenes: [{ ...scene(1), seconds: 60 }, scene(2)] }))
  const s = requireWork(r.work_id).plan.scenes[0]
  assert.ok(s.seconds < 30, `第 1 镜被拉到 ${s.seconds} 秒`)
})

test('片长只能在 10 秒到 10 分钟之间', async () => {
  await assert.rejects(plan.execute(args({ duration: 5 })), /duration 不能小于 10/)
  await assert.rejects(plan.execute(args({ duration: 900 })), /duration 不能大于 600/)
})

test('用户在卡片上定的时长和开关，导演改分镜时照用户的来', async () => {
  const r = await plan.execute(args())
  await updateWork(r.work_id, w => ((w.choices = { duration: 60, music: false, subtitles: false }), w))
  const r2 = await plan.execute(args({ work_id: r.work_id, duration: 30, scenes: [scene(1), scene(2), scene(3)] }))
  const w = requireWork(r2.work_id)
  assert.equal(w.duration, 60)
  assert.equal(w.music.enabled, false)
  assert.equal(w.music.suggested, true)
  assert.equal(w.subtitles.enabled, false)
  assert.equal(w.voice.enabled, true)
  assert.match(r2.text, /用户在卡片上定的/)
})

test('给导演的硬性约束：描述 200 字、一镜 6 句、凑数短句、屏幕文字 14 字，不合格整版退回', async () => {
  const bad = e => e.message.startsWith('【请改好后再调用】')
  await assert.rejects(plan.execute(args({ scenes: [{ ...scene(1), description: '画'.repeat(201) }, scene(2)] })), e => /画面描述 201 个字/.test(e.message) && bad(e))
  await assert.rejects(plan.execute(args({ duration: 60, scenes: [scene(1, Array(7).fill('天宫空间站由三个舱段组成。')), scene(2)] })), e => /一镜最多 6 句/.test(e.message) && bad(e))
  await assert.rejects(plan.execute(args({ scenes: [scene(1, [...LINE, '慢慢来。']), scene(2)] })), e => /这几句太短：「慢慢来。」/.test(e.message) && bad(e))
  await assert.rejects(plan.execute(args({ scenes: [{ ...scene(1), screen_text: ['天和核心舱、问天实验舱和梦天实验舱'] }, scene(2)] })), e => /屏幕文字太长/.test(e.message) && bad(e))
})

test('事实清单和屏幕文字：带数字的事实没用上就退回，用上了按网站的格式存（inputs、copy）', async () => {
  const only68 = [scene(1, ['天宫空间站由天和核心舱、问天实验舱和梦天实验舱组成，三个舱拼成一个 T 字。', '总重约 68 吨，航天员可以在三个舱之间来回走动。']), scene(2)]
  await assert.rejects(plan.execute(args({ facts: ['天宫空间站总重约 68 吨', '轨道高度约 400 公里'], scenes: only68 })), e => /「轨道高度约 400 公里」/.test(e.message) && !/68 吨/.test(e.message))
  const withTexts = [{ ...scene(1, ['天宫空间站由天和核心舱、问天实验舱和梦天实验舱组成，三个舱拼成一个 T 字。', '总重约 68 吨，飞在约 400 公里高的轨道上，航天员可以来回走动。']), screen_text: ['总重约 68 吨', '轨道 400 公里'] }, scene(2)]
  const r = await plan.execute(args({ facts: ['天宫空间站总重约 68 吨', '轨道高度约 400 公里'], scenes: withTexts }))
  const w = requireWork(r.work_id)
  assert.deepEqual(w.plan.inputs.map(x => x.value), ['天宫空间站总重约 68 吨', '轨道高度约 400 公里'])
  assert.deepEqual(w.plan.scenes[0].copy, { text1: '总重约 68 吨', text2: '轨道 400 公里' })
  assert.deepEqual(w.plan.scenes[1].copy, {})
})
