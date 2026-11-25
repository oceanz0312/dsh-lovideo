// 本机配音的挑选规则：按电脑配置推荐，按口播长度挑 3 分钟内能配完的，越好越优先。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.LOVIDEO_DATA_DIR = mkdtempSync(join(tmpdir(), 'lovideo-lv-test-'))
const { BUDGET_SECONDS, DEFAULT_MODEL, chooseModel, estimateSeconds, fit, grade, meetsMinimum, recommend, useModel, voicesFor, MODELS } = await import('../src/host/localvoice.js')
const { readSettings, writeSettings } = await import('../src/host/settings.js')

const mac = ramGB => ({ backend: 'mlx', arch: 'arm64', cores: 10, appleSilicon: true, ramGB, gpu: null, freeDiskGB: 200 })
const pc = (ramGB, gpu, cores = 8) => ({ backend: 'torch', arch: 'x64', cores, appleSilicon: false, ramGB, gpu, freeDiskGB: 200 })
const byId = id => MODELS.find(m => m.id === id)

test('按电脑配置推荐', () => {
  assert.equal(recommend(mac(48)).id, 'qwen3-1.7b')
  // 16GB 的 Mac 跑 1.7B 吃力，推荐跑得流畅里最好的
  assert.equal(recommend(mac(16)).id, 'ming3-0.5b')
  assert.equal(recommend(mac(8)).id, 'kokoro')
  assert.equal(recommend(pc(32, { vendor: 'nvidia', name: 'RTX 4070', vramGB: 12 })).id, 'qwen3-1.7b')
  assert.equal(recommend(pc(16, { vendor: 'nvidia', name: 'RTX 3050', vramGB: 6 })).id, 'qwen3-0.6b')
  assert.equal(recommend(pc(16, null)).id, 'kokoro')
  assert.equal(recommend(pc(4, null)), null)
})

test('跑不了时给出原因', () => {
  assert.match(fit(byId('qwen3-1.7b'), pc(32, null)).reason, /NVIDIA/)
  assert.match(fit(byId('qwen3-1.7b'), mac(8)).reason, /内存要 16GB/)
  assert.match(fit(byId('ming3-0.5b'), pc(32, { vendor: 'nvidia', name: 'x', vramGB: 24 })).reason, /Apple 芯片/)
  assert.match(fit(byId('kokoro'), { ...mac(16), freeDiskGB: 1 }).reason, /磁盘/)
})

test('估计口播时长：中文按字、英文按词', () => {
  assert.ok(Math.abs(estimateSeconds(['一'.repeat(45)]) - 10) < 0.01)
  assert.ok(Math.abs(estimateSeconds([Array(26).fill('word').join(' ')]) - 10) < 0.01)
})

test('按口播长度挑模型：好的来得及就用好的，来不及就往下降', () => {
  const installed = { 'qwen3-1.7b': { rtf: 0.6, load: 10 }, kokoro: { rtf: 0.1, load: 2 } }
  assert.equal(chooseModel(installed, 60).id, 'qwen3-1.7b')
  // 5 分钟口播：0.6×300×1.15 + 10 > 180，降到 Kokoro
  assert.equal(chooseModel(installed, 300).id, 'kokoro')
  // 都来不及：返回 null，开拍时退回系统语音
  assert.equal(chooseModel({ kokoro: { rtf: 2, load: 2 } }, 300), null)
  assert.equal(chooseModel({}, 10), null)
  assert.ok(chooseModel(installed, 60).predicted <= BUDGET_SECONDS)
})

test('配置低于门槛：不推荐本机模型，原因写清楚', () => {
  for (const hw of [pc(4, null), pc(16, null, 2), { ...mac(16), freeDiskGB: 2 }, { ...pc(16, null), arch: 'ia32' }]) {
    assert.equal(meetsMinimum(hw).ok, false)
    assert.equal(recommend(hw), null)
    assert.match(fit(MODELS.find(m => m.id === 'kokoro'), hw).reason, /配置偏低/)
  }
  assert.match(meetsMinimum(pc(16, null, 2)).reason, /CPU 2 核/)
  assert.equal(meetsMinimum(pc(8, null, 4)).ok, true)
})

test('按配置评级：推荐 / 吃力 / 跑不动', () => {
  assert.equal(grade(byId('qwen3-1.7b'), mac(48)).grade, 'ok')
  assert.equal(grade(byId('qwen3-1.7b'), mac(16)).grade, 'heavy')
  assert.match(grade(byId('qwen3-1.7b'), mac(16)).reason, /24GB/)
  assert.equal(grade(byId('qwen3-1.7b'), mac(8)).grade, 'unable')
  assert.equal(grade(byId('kokoro'), pc(16, null, 4)).grade, 'heavy')
  assert.equal(grade(byId('qwen3-0.6b'), pc(16, { vendor: 'nvidia', name: 'x', vramGB: 4 })).grade, 'heavy')
  // 测过速、3 分钟口播配不完的也算吃力
  assert.equal(grade(byId('qwen3-1.7b'), mac(48), { rtf: 1.2, load: 20 }).grade, 'heavy')
  // 哪台电脑都能跑的默认下载就是 Kokoro
  assert.equal(DEFAULT_MODEL, 'kokoro')
  assert.equal(grade(byId(DEFAULT_MODEL), pc(8, null, 8)).grade, 'ok')
})

test('先用用户选的模型，来不及才换更快的', () => {
  const installed = { 'qwen3-1.7b': { rtf: 0.6, load: 10 }, kokoro: { rtf: 0.1, load: 2 } }
  // 用户选了 Kokoro：哪怕 Qwen 更好也用 Kokoro
  assert.deepEqual(chooseModel(installed, 60, 'kokoro').id, 'kokoro')
  assert.equal(chooseModel(installed, 60, 'kokoro').degraded, false)
  // 用户选了 Qwen，5 分钟口播来不及，换 Kokoro 并标出来
  const c = chooseModel(installed, 300, 'qwen3-1.7b')
  assert.equal(c.id, 'kokoro')
  assert.equal(c.degraded, true)
})

test('选模型和声音：没选过用默认声音，选了就记住', () => {
  assert.deepEqual(voicesFor('kokoro'), { zh: 'zm_yunjian', en: 'af_heart' })
  assert.throws(() => useModel('kokoro'), /还没下载/)
  const s = readSettings()
  s.local = { ...s.local, models: { kokoro: { rtf: 0.1, load: 2 } } }
  writeSettings(s)
  useModel('kokoro', { zh: 'zf_xiaoxiao' })
  const after = readSettings()
  assert.equal(after.local.active, 'kokoro')
  assert.equal(after.voice.provider, 'local')
  assert.deepEqual(voicesFor('kokoro'), { zh: 'zf_xiaoxiao', en: 'af_heart' })
  // 不认识的声音回到默认
  useModel('kokoro', { zh: 'nobody' })
  assert.equal(voicesFor('kokoro').zh, 'zm_yunjian')
})
