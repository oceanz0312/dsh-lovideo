// 跨进程的锁和「谁在做」。DSH 桌面版和网页版（dsh web）是两个进程，会同时加载这个插件、
// 读写同一个数据目录，所以「读出来-改-写回」要排队，正在做的片子也要记下是哪个进程在做。
//
// 宿主自己的 @deepseek-ai/dsh-atomic-write 有 withFileLock，但它是宿主内部包，插件不依赖它；
// 这里用 Node 自带的能力做一个同样思路的小锁：独占创建（wx）<文件>.lock，里面写 pid。
// 锁只包住读改写这几毫秒（同步代码，不跨 await），渲染这种长活不在锁里。
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { dataDir } from './paths.js'

/** 这个插件实例：pid 加一个启动时生成的随机 id（pid 会被别的进程复用，随机 id 不会） */
export const SELF = Object.freeze({ pid: process.pid, instance: randomBytes(6).toString('hex') })

/** 进程还在不在。EPERM 是别的用户的进程，也算活着 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/* ---------- 文件锁 ---------- */

const WAIT_MS = 5000
// 锁里只有几毫秒的同步读写，30 秒还没放说明持有者卡死了，或者 pid 被别的进程复用了
const STALE_MS = 30_000
const nap = new Int32Array(new SharedArrayBuffer(4))
const sleep = ms => Atomics.wait(nap, 0, 0, ms)
// 本进程正拿着的锁：同步代码里嵌套拿同一把锁时直接进去，不自己等自己
const held = new Map()

const readLock = lock => {
  try {
    return { raw: readFileSync(lock, 'utf8'), mtime: statSync(lock).mtimeMs }
  } catch {
    return null
  }
}

/** 锁的持有者已经不在（或锁太旧）就拆掉。返回 true 表示可以马上再抢一次 */
function takeOver(lock) {
  const cur = readLock(lock)
  if (!cur) return true
  let pid = 0
  try {
    pid = JSON.parse(cur.raw).pid
  } catch {
    // 刚建好还没写进 pid 的锁：只按时间判断
  }
  // 锁是同步拿同步放的，本进程没拿着却写着本进程 pid，只能是以前用过这个 pid 的进程崩了留下的
  const dead = pid ? pid === process.pid || !pidAlive(pid) : false
  if (!dead && Date.now() - cur.mtime < STALE_MS) return false
  // 几个进程同时看到同一把旧锁：先建出认领文件的那个来拆，免得拆掉别人刚抢到的新锁
  const claim = `${lock}.takeover-${createHash('sha1').update(`${cur.raw}|${cur.mtime}`).digest('hex').slice(0, 12)}`
  try {
    closeSync(openSync(claim, 'wx'))
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    // 拆锁的进程自己也崩了，认领文件留着：太旧就清掉
    const c = readLock(claim)
    if (c && Date.now() - c.mtime > STALE_MS) rmSync(claim, { force: true })
    return false
  }
  try {
    const again = readLock(lock)
    if (again && again.raw === cur.raw && again.mtime === cur.mtime) rmSync(lock, { force: true })
  } finally {
    rmSync(claim, { force: true })
  }
  return true
}

/**
 * 拿着 <file>.lock 同步执行 fn：跨进程同一时间只有一个能进。
 * 别人拿着就退避重试，超过 waitMs 报错；持有者进程已退出、或锁放了太久没放，就接管。
 * 文件所在目录要已经存在。
 */
export function withFileLock(file, fn, { waitMs = WAIT_MS } = {}) {
  const lock = `${file}.lock`
  if (held.has(lock)) {
    held.set(lock, held.get(lock) + 1)
    try {
      return fn()
    } finally {
      held.set(lock, held.get(lock) - 1)
      if (!held.get(lock)) held.delete(lock)
    }
  }
  const token = randomBytes(6).toString('hex')
  const record = JSON.stringify({ pid: process.pid, instance: SELF.instance, token, at: new Date().toISOString() })
  const deadline = Date.now() + waitMs
  for (let delay = 2; ; delay = Math.min(delay * 2, 50)) {
    try {
      const fd = openSync(lock, 'wx')
      try {
        writeSync(fd, record)
      } finally {
        closeSync(fd)
      }
      break
    } catch (e) {
      // Windows 上锁正被删时独占创建会报 EPERM，当成有人拿着
      if (e.code !== 'EEXIST' && !(e.code === 'EPERM' && readLock(lock))) throw e
    }
    if (takeOver(lock)) continue
    if (Date.now() > deadline) throw Object.assign(new Error(`${file} 正被另一个进程占用，稍后再试`), { code: 'ELOCKED', status: 409 })
    sleep(delay)
  }
  held.set(lock, 1)
  try {
    return fn()
  } finally {
    held.delete(lock)
    // 只删自己的锁：万一卡太久被别人接管了，不能把别人的锁删掉
    if (readLock(lock)?.raw === record) rmSync(lock, { force: true })
  }
}

/* ---------- 谁在做 ---------- */

// 正在做片子的实例定时在 hosts/<随机 id>.json 里报到。判断别的实例还在不在：
// 进程活着，而且报到没断（pid 被别的程序复用时，那个程序不会来报到）
const BEAT_MS = 15_000
const BEAT_STALE_MS = 120_000
const hostsDir = () => join(dataDir(), 'hosts')
const beatFile = instance => join(hostsDir(), `${instance}.json`)
let beat = null

function writeBeat() {
  try {
    mkdirSync(hostsDir(), { recursive: true })
    const file = beatFile(SELF.instance)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
    renameSync(tmp, file)
  } catch {
    // 报到失败最多让别的窗口以为这里不在了，不影响这里继续做
  }
}

/** 开始报到（开拍时调用；重复调用没关系） */
export function keepAlive() {
  if (beat) return
  // 顺手清掉崩溃的进程留下的报到文件，免得越积越多
  try {
    for (const f of readdirSync(hostsDir())) {
      const path = join(hostsDir(), f)
      if (Date.now() - statSync(path).mtimeMs > BEAT_STALE_MS) rmSync(path, { force: true })
    }
  } catch {
    // 目录还没有，或者正被别的窗口清理：不要紧
  }
  writeBeat()
  beat = setInterval(writeBeat, BEAT_MS)
  beat.unref()
}

/** 插件卸载时停掉报到，别的实例就知道这里不再做了 */
export function stopKeepAlive() {
  if (beat) clearInterval(beat)
  beat = null
  rmSync(beatFile(SELF.instance), { force: true })
}

/** 开拍时写进 work.producer 的「谁在做」；记下的同时开始报到 */
export function producerRecord() {
  keepAlive()
  return { pid: SELF.pid, instance: SELF.instance, at: new Date().toISOString() }
}

/** 作品里记下的制作者（{ pid, instance }）是不是另一个还活着的实例 */
export function ownedElsewhere(owner) {
  if (!owner?.instance || owner.instance === SELF.instance) return false
  if (!pidAlive(owner.pid)) return false
  try {
    const b = JSON.parse(readFileSync(beatFile(owner.instance), 'utf8'))
    return b.pid === owner.pid && Date.now() - Date.parse(b.at) < BEAT_STALE_MS
  } catch {
    return false
  }
}

export const busyElsewhereError = () =>
  Object.assign(new Error('这部片子正在另一个 DeepSeek Harness 窗口里制作，要暂停或继续请到那个窗口里操作'), { status: 409, code: 'busy_elsewhere' })
