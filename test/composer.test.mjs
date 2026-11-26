// 输入框里的开局条件和收藏：存取、检查，以及用户发出第一句话时只交给导演一次。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.LOVIDEO_DATA_DIR = mkdtempSync(join(tmpdir(), 'lovideo-composer-test-'))
const { normalizeBrief, setBrief, getBrief, composerDefaults, installBriefContext } = await import('../src/host/composer.js')
const { listFavorites, setFavorite } = await import('../src/host/favorites.js')

const STYLES = [
  { slug: 'watercolor', name: '水彩笔刷', aspects: ['16:9', '9:16'] },
  { slug: 'research-talk', name: '学术报告', aspects: ['16:9'] },
]

test('开局条件：风格要存在，画幅不支持就换成这个风格的第一个，片长 10 到 300 秒', () => {
  assert.deepEqual(normalizeBrief({ slug: 'watercolor', aspect: '9:16', duration: 45 }, STYLES), { slug: 'watercolor', name: '水彩笔刷', aspect: '9:16', duration: 45 })
  assert.equal(normalizeBrief({ slug: 'research-talk', aspect: '9:16', duration: 30 }, STYLES).aspect, '16:9')
  assert.throws(() => normalizeBrief({ slug: 'nope', aspect: '16:9', duration: 30 }, STYLES), /没有这个风格/)
  assert.throws(() => normalizeBrief({ slug: 'watercolor', aspect: '16:9', duration: 5 }, STYLES), /10 到 300/)
  assert.throws(() => normalizeBrief({ slug: 'watercolor', aspect: '16:9', duration: 301 }, STYLES), /10 到 300/)
})

test('存开局条件：按会话存，同时记成下次的默认值；传 null 清掉', () => {
  setBrief('session-a', { slug: 'watercolor', name: '水彩笔刷', aspect: '9:16', duration: 45 })
  assert.equal(getBrief('session-a').duration, 45)
  assert.deepEqual(composerDefaults(), { slug: 'watercolor', aspect: '9:16', duration: 45 })
  setBrief('session-a', null)
  assert.equal(getBrief('session-a'), null)
  assert.throws(() => setBrief('../x', null), /会话 id/)
})

/** 假的宿主：只记下 agent/pre-step 的处理函数 */
function fakeCtx() {
  const handlers = {}
  return { ctx: { on: (name, fn) => { handlers[name] = fn } }, handlers }
}

test('第一句话发出时，把开局条件插在用户的话后面交给导演，只交一次', async () => {
  const { ctx, handlers } = fakeCtx()
  installBriefContext(ctx)
  setBrief('session-b', { slug: 'watercolor', name: '水彩笔刷', aspect: '16:9', duration: 60 })
  const user = { id: 'u1', role: 'user', content: [{ type: 'text', text: '讲讲银杏' }], source: { kind: 'user' } }
  const step = (n, id = 'session-b') => handlers['agent/pre-step'](
    { agent: { id }, messages: [user], step: n },
    async () => ({ kind: 'enter', messages: [user] }),
  )
  const first = await step(1)
  assert.equal(first.messages.length, 2)
  assert.equal(first.messages[0], user)
  assert.match(first.messages[1].content[0].text, /水彩笔刷.*watercolor.*16:9.*60 秒/)
  assert.equal(first.messages[1].role, 'user')
  assert.equal(first.messages[1].source.kind, 'dsh-lovideo')
  // 同一个会话再发一句：不再重复
  assert.equal((await step(1)).messages.length, 1)
  // 第二步（工具调用之后）不插
  setBrief('session-c', { slug: 'watercolor', name: '水彩笔刷', aspect: '16:9', duration: 60 })
  assert.equal((await step(2, 'session-c')).messages.length, 1)
  // 别的会话、没有开局条件的会话不受影响
  assert.equal((await step(1, 'session-z')).messages.length, 1)
  // 被拒绝的一步原样返回
  const rejected = await handlers['agent/pre-step']({ agent: { id: 'session-c' }, messages: [user], step: 1 }, async () => ({ kind: 'reject' }))
  assert.deepEqual(rejected, { kind: 'reject' })
  assert.equal(getBrief('session-c').sent, false)
})

test('收藏：新收藏的在最前，再点一次取消', () => {
  assert.deepEqual(listFavorites(), [])
  setFavorite('watercolor', true)
  setFavorite('metro-map', true)
  assert.deepEqual(listFavorites(), ['metro-map', 'watercolor'])
  setFavorite('metro-map', false)
  assert.deepEqual(listFavorites(), ['watercolor'])
  assert.throws(() => setFavorite('a/b', true), /风格不对/)
})
