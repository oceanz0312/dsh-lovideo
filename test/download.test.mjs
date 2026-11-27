// 共用下载函数：用本地 http 服务模拟国内网络常见的几种坏情况，确认会换地址、会按时放弃、错误里列出每个地址
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, createGunzip } from 'node:zlib'
import { clearProbeCache, download, downloadText, fasterFirst } from '../src/host/download.js'

const BODY = Buffer.alloc(256 * 1024, 7)
let server
let base
const open = new Set()

before(async () => {
  server = createServer((req, res) => {
    const path = req.url.split('?')[0]
    if (path.startsWith('/hang')) return // 一直不回响应头
    if (path.startsWith('/stall')) {
      // 回了响应头、发了一点数据后再也不发
      res.writeHead(200, { 'content-length': String(BODY.length) })
      res.write(BODY.subarray(0, 1024))
      return
    }
    if (path.startsWith('/missing')) {
      res.writeHead(404)
      return res.end('not found')
    }
    if (path.startsWith('/ok.gz')) {
      const gz = gzipSync(BODY)
      res.writeHead(200, { 'content-length': String(gz.length) })
      return res.end(gz)
    }
    if (path.startsWith('/ok')) {
      res.writeHead(200, { 'content-length': String(BODY.length) })
      return res.end(BODY)
    }
    res.writeHead(500)
    res.end()
  })
  server.on('connection', s => {
    open.add(s)
    s.on('close', () => open.delete(s))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  for (const s of open) s.destroy()
  server.close()
})

beforeEach(() => clearProbeCache())

const fast = { headerTimeoutMs: 300, stallTimeoutMs: 300, probeMs: 0 }
const tmp = () => mkdtempSync(join(tmpdir(), 'lv-dl-test-'))

test('第一个地址不回响应头时换下一个，并且写完才改名', async () => {
  const dir = tmp()
  try {
    const dest = join(dir, 'f.bin')
    const t0 = Date.now()
    const { url } = await download([`${base}/hang`, `${base}/ok`], dest, fast)
    assert.equal(url, `${base}/ok`)
    assert.ok(Date.now() - t0 < 3000)
    assert.deepEqual(readFileSync(dest), BODY)
    assert.equal(existsSync(`${dest}.part`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('回了响应头后不再发数据时判定卡住、换下一个；404 也换', async () => {
  const dir = tmp()
  try {
    const dest = join(dir, 'f.bin')
    const { url } = await download([`${base}/stall`, `${base}/missing`, `${base}/ok`], dest, fast)
    assert.equal(url, `${base}/ok`)
    assert.deepEqual(readFileSync(dest), BODY)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('全部失败时在设定时间内报错，错误信息列出每个地址和原因', async () => {
  const dir = tmp()
  try {
    const dest = join(dir, 'f.bin')
    const urls = [`${base}/hang`, `${base}/stall`, `${base}/missing`]
    const t0 = Date.now()
    await assert.rejects(download(urls, dest, { ...fast, label: 'ffmpeg ', hint: '也可以自己安装 ffmpeg 后再点一次' }), err => {
      for (const u of urls) assert.ok(err.message.includes(u), `错误里应有 ${u}：${err.message}`)
      assert.match(err.message, /ffmpeg 下载失败，试了 3 个地址都不行/)
      assert.match(err.message, /没有回应/)
      assert.match(err.message, /没有新数据/)
      assert.match(err.message, /404/)
      assert.match(err.message, /自己安装 ffmpeg/)
      assert.equal(err.tried.length, 3)
      return true
    })
    assert.ok(Date.now() - t0 < 3000, `应在设定时间内失败，用了 ${Date.now() - t0} 毫秒`)
    assert.equal(existsSync(dest), false)
    assert.equal(existsSync(`${dest}.part`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('探测时先用回应快的站点：一直不回的站点排到后面；文件 404 的地址也排到后面', async () => {
  // 另起一个什么都不回的站点，模拟国内连不上的 GitHub
  const dead = createServer(() => {})
  const sockets = new Set()
  dead.on('connection', s => sockets.add(s))
  await new Promise(r => dead.listen(0, '127.0.0.1', r))
  const deadBase = `http://127.0.0.1:${dead.address().port}`
  const dir = tmp()
  try {
    const order = await fasterFirst([`${deadBase}/a`, `${base}/missing`, `${base}/ok`], { probeMs: 300 })
    assert.deepEqual(order, [`${base}/ok`, `${deadBase}/a`, `${base}/missing`])
    // 带探测的下载：不用等那个站点的响应头超时
    clearProbeCache()
    const t0 = Date.now()
    const { url } = await download([`${deadBase}/a`, `${base}/ok`], join(dir, 'f.bin'), { headerTimeoutMs: 5000, stallTimeoutMs: 5000, probeMs: 300 })
    assert.equal(url, `${base}/ok`)
    assert.ok(Date.now() - t0 < 2000)
  } finally {
    for (const s of sockets) s.destroy()
    dead.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写盘前可以解压，进度回调到 100%', async () => {
  const dir = tmp()
  try {
    const dest = join(dir, 'f.bin')
    let last = 0
    await download([`${base}/ok.gz`], dest, { ...fast, transforms: [() => createGunzip()], onProgress: p => (last = p) })
    assert.deepEqual(readFileSync(dest), BODY)
    assert.equal(last, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AbortSignal 取消时立刻停下，不再试下一个地址', async () => {
  const dir = tmp()
  try {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const t0 = Date.now()
    await assert.rejects(download([`${base}/hang`, `${base}/ok`], join(dir, 'f.bin'), { headerTimeoutMs: 5000, stallTimeoutMs: 5000, probeMs: 0, signal: ac.signal }), { name: 'AbortError' })
    assert.ok(Date.now() - t0 < 1000)
    assert.equal(existsSync(join(dir, 'f.bin')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('downloadText 读小文件', async () => {
  const { url, text } = await downloadText([`${base}/missing`, `${base}/ok`], fast)
  assert.equal(url, `${base}/ok`)
  assert.equal(text.length, BODY.length)
})
