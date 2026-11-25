// 没登录时下载平台风格：要正常报错，而且不能留下没人接的 promise——
// DeepSeek Harness 把没人接的拒绝当成致命错误，会让整个后端退出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.LOVIDEO_DATA_DIR = mkdtempSync(join(tmpdir(), 'lovideo-styles-test-'))
const { installPlatformStyle } = await import('../src/host/styles.js')

test('没登录下载平台风格：报「还没有登录」，不留没人接的拒绝', async () => {
  const unhandled = []
  const onUnhandled = err => unhandled.push(err)
  process.on('unhandledRejection', onUnhandled)
  try {
    await assert.rejects(installPlatformStyle({ slug: 'dark-keynote', revision: 'a'.repeat(64) }), /还没有登录/)
    // 让派生 promise 的拒绝有机会冒出来
    await new Promise(r => setTimeout(r, 50))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})
