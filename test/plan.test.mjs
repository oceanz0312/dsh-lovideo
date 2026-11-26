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

const scene = (n, narration = '一句不长的口播。') => ({ title: `第${n}镜`, description: '画面', narration, seconds: 15 })
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
  const long = '这是一段很长很长的口播'.repeat(20)
  await assert.rejects(plan.execute(args({ scenes: [scene(1, long), scene(2, long)] })), /长太多/)
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
