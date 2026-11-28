// 风格目录：本机读过就直接用（过期了在后台更新），网慢时输入框、风格墙不用干等网站
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.LOVIDEO_DATA_DIR = mkdtempSync(join(tmpdir(), 'lovideo-catalog-test-'))
const catalog = join(process.env.LOVIDEO_DATA_DIR, 'styles', 'catalog.json')

// 假网站：每次要等 1.5 秒才回目录
let hits = 0
const site = createServer((req, res) => {
  hits += 1
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ styles: [{ slug: 'fresh', name: '新目录' }] }))
  }, 1500)
})
await new Promise(r => site.listen(0, '127.0.0.1', r))
process.env.LOVIDEO_SITE = `http://127.0.0.1:${site.address().port}`
const { listStyles } = await import('../src/host/styles.js')

test('目录过期：马上返回本机的，后台去网站更新，下次读到新的', async () => {
  mkdirSync(join(process.env.LOVIDEO_DATA_DIR, 'styles'), { recursive: true })
  writeFileSync(catalog, JSON.stringify({ at: '2026-01-01T00:00:00.000Z', lang: 'zh', styles: [{ slug: 'old', name: '旧目录' }] }))
  const t = Date.now()
  const r = await listStyles('zh')
  assert.ok(Date.now() - t < 500, '不该等网站')
  assert.deepEqual(r.platform.map(s => s.slug), ['old'])
  // 同时再读一次：后台只发一次请求
  await listStyles('zh')
  await new Promise(r => setTimeout(r, 2000))
  assert.equal(hits, 1)
  assert.equal(JSON.parse(readFileSync(catalog, 'utf8')).styles[0].slug, 'fresh')
  assert.deepEqual((await listStyles('zh')).platform.map(s => s.slug), ['fresh'])
})

test('本机从没读过目录：等网站回来', async () => {
  writeFileSync(catalog, JSON.stringify({ at: new Date().toISOString(), lang: 'en', styles: [] }))
  const r = await listStyles('zh')
  assert.deepEqual(r.platform.map(s => s.slug), ['fresh'])
  site.close()
})
