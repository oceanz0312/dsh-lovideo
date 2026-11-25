// 编码器中途退出（比如片子被暂停、取消时 ffmpeg 被杀掉）：后面的写入要报错，
// 而且不能留下没人接的拒绝或管道错误——DeepSeek Harness 会把它们当成致命错误，让整个后端退出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.LOVIDEO_DATA_DIR = mkdtempSync(join(tmpdir(), 'lovideo-enc-test-'))
const { startEncoder } = await import('../src/host/render.js')

test('编码器中途被杀掉：写入报错，不留没人接的拒绝', { timeout: 30_000 }, async () => {
  const unhandled = []
  const onUnhandled = e => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  try {
    const ctl = new AbortController()
    const enc = startEncoder(join(process.env.LOVIDEO_DATA_DIR, 'x.mp4'), 30, ctl.signal)
    await enc.write(Buffer.alloc(1024, 7))
    // 模拟暂停：ffmpeg 被杀掉，结果的拒绝此时还没有人 await
    ctl.abort()
    await new Promise(r => setTimeout(r, 300))
    await assert.rejects(enc.write(Buffer.alloc(1024, 7)), '编码器退出后写入应该报错')
    await assert.rejects(enc.end(), /编码失败/)
    await new Promise(r => setTimeout(r, 50))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})
