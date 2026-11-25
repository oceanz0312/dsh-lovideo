// 本机配音的挑选规则：按电脑配置推荐，按口播长度挑 3 分钟内能配完的，越好越优先。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.LOVIDEO_DATA_DIR = mkdtempSync(join(tmpdir(), 'lovideo-lv-test-'))
const { BUDGET_SECONDS, chooseModel, estimateSeconds, fit, recommend, MODELS } = await import('../src/host/localvoice.js')

const mac = ramGB => ({ backend: 'mlx', appleSilicon: true, ramGB, gpu: null, freeDiskGB: 200 })
const pc = (ramGB, gpu) => ({ backend: 'torch', appleSilicon: false, ramGB, gpu, freeDiskGB: 200 })
const byId = id => MODELS.find(m => m.id === id)

test('按电脑配置推荐', () => {
  assert.equal(recommend(mac(48)).id, 'qwen3-1.7b')
  assert.equal(recommend(mac(16)).id, 'qwen3-1.7b')
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
