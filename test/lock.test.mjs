// 跨进程：DSH 桌面版和网页版两个进程同时加载插件、读写同一个数据目录。
// 用 child_process 起真的 Node 进程，验证读改写不丢、崩溃留下的锁能接管、只暂停没人在做的片子。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'

process.env.LOVIDEO_DATA_DIR = mkdtempSync(join(tmpdir(), 'lovideo-lock-test-'))
const { createWork, getWork, listWorks, updateWork, workDir } = await import('../src/host/works.js')
const { withFileLock } = await import('../src/host/lock.js')
const { markInterrupted, pauseProduction, startProduction } = await import('../src/host/produce.js')
const { readSettings, updateSettings } = await import('../src/host/settings.js')

const src = name => new URL(`../src/host/${name}`, import.meta.url).href

/** 起一个子进程跑一段 ESM 代码；stdout 一行一行交回 */
function child(code) {
  const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] })
  p.lines = []
  let buf = ''
  p.stdout.on('data', d => {
    buf += d
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) p.stdout.emit('line', buf.slice(0, i))
  })
  p.nextLine = () => once(p.stdout, 'line').then(([l]) => l)
  return p
}

const exited = p => (p.exitCode !== null ? Promise.resolve(p.exitCode) : once(p, 'exit').then(([c]) => c))

test('两个进程同时对同一部作品自增，一次都不丢', async () => {
  const w = createWork({ n: 0 })
  const N = 300
  const code = `
    const { updateWork } = await import(${JSON.stringify(src('works.js'))})
    for (let i = 0; i < ${N}; i++) await updateWork(${JSON.stringify(w.id)}, w => ((w.n += 1), w))
  `
  const kids = [child(code), child(code)]
  // 本进程也一起抢
  for (let i = 0; i < 100; i++) await updateWork(w.id, x => ((x.n += 1), x))
  assert.deepEqual(await Promise.all(kids.map(exited)), [0, 0])
  assert.equal(getWork(w.id).n, 2 * N + 100)
  assert.equal(existsSync(join(workDir(w.id), 'work.json.lock')), false)
})

test('设置：两个进程各改各的项，互相不冲掉', async () => {
  const code = which => `
    const { changeSettings } = await import(${JSON.stringify(src('settings.js'))})
    for (let i = 0; i < 100; i++) changeSettings(s => { s.counts = { ...(s.counts || {}), ${which}: ((s.counts || {}).${which} || 0) + 1 } })
  `
  const kids = [child(code('a')), child(code('b'))]
  assert.deepEqual(await Promise.all(kids.map(exited)), [0, 0])
  assert.deepEqual(readSettings().counts, { a: 100, b: 100 })
  // 原来的对外行为不变
  updateSettings({ parallel: 3 })
  assert.equal(readSettings().parallel, 3)
  assert.deepEqual(readSettings().counts, { a: 100, b: 100 })
})

test('持锁的进程被杀掉，锁能被接管；活着时别人拿不到', async () => {
  const file = join(process.env.LOVIDEO_DATA_DIR, 'x.json')
  const p = child(`
    const { withFileLock } = await import(${JSON.stringify(src('lock.js'))})
    withFileLock(${JSON.stringify(file)}, () => {
      process.stdout.write('locked\\n')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000)
    })
  `)
  assert.equal(await p.nextLine(), 'locked')
  assert.equal(existsSync(`${file}.lock`), true)
  assert.throws(() => withFileLock(file, () => 1, { waitMs: 200 }), e => e.code === 'ELOCKED')
  p.kill('SIGKILL')
  await exited(p)
  const t0 = Date.now()
  assert.equal(withFileLock(file, () => 'mine', { waitMs: 3000 }), 'mine')
  assert.ok(Date.now() - t0 < 1000, '进程已退出的锁应该马上接管，不用等超时')
  assert.equal(existsSync(`${file}.lock`), false)
})

test('启动时只暂停没人在做的片子，另一个活着的窗口在做的不碰，也不能在这里开拍或暂停', async () => {
  // 另一个「窗口」：开拍时记下自己，并一直报到
  const other = child(`
    const { producerRecord } = await import(${JSON.stringify(src('lock.js'))})
    process.stdout.write(JSON.stringify(producerRecord()) + '\\n')
    setInterval(() => {}, 1000)
  `)
  const owner = JSON.parse(await other.nextLine())
  // 一个已经退出的进程
  const gone = child('')
  await exited(gone)
  try {
    const plan = { revision: 1, scenes: [{ id: 's1', title: 't', description: 'd', narration: '', seconds: 5 }] }
    const busy = createWork({ status: 'producing', plan, producer: owner, job: { state: 'drawing', planRevision: 1, segments: [] } })
    const dead = createWork({ status: 'producing', plan, producer: { pid: gone.pid, instance: 'deadbeef' }, job: { state: 'drawing' } })
    // pid 还活着但被别的程序复用了（那个程序不会来报到）
    const reused = createWork({ status: 'producing', plan, producer: { pid: other.pid, instance: 'someoneelse' }, job: { state: 'drawing' } })
    const none = createWork({ status: 'producing', plan, job: { state: 'drawing' } })

    await markInterrupted(listWorks())
    assert.equal(getWork(busy.id).status, 'producing')
    assert.deepEqual(getWork(busy.id).producer, owner)
    for (const w of [dead, reused, none]) {
      assert.equal(getWork(w.id).status, 'paused', w.id)
      assert.equal(getWork(w.id).job.state, 'paused')
      assert.equal(getWork(w.id).producer, null)
    }

    await assert.rejects(startProduction(busy.id), /正在另一个 DeepSeek Harness 窗口里制作/)
    assert.throws(() => pauseProduction(busy.id), /正在另一个 DeepSeek Harness 窗口里制作/)
    assert.equal(getWork(busy.id).status, 'producing')

    // 那个窗口关了：再启动时就会把它标成暂停
    other.kill('SIGKILL')
    await exited(other)
    await markInterrupted(listWorks())
    assert.equal(getWork(busy.id).status, 'paused')
    assert.equal(pauseProduction(busy.id), false)
  } finally {
    other.kill('SIGKILL')
  }
})
