// 画幅适合的发布平台：清单和画幅对得上，标志文件都在，界面语言不同标的平台不同。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { ASPECTS } = await import('../src/host/composer.js')
const { ASPECTS: SIZES } = await import('../src/host/produce.js')
const source = readFileSync(join(root, 'src/client/platforms.js'), 'utf8')

test('能选的画幅、成片尺寸、界面上的按钮是同一组', () => {
  assert.deepEqual(Object.keys(SIZES).sort(), [...ASPECTS].sort())
  assert.deepEqual(SIZES['3:4'], { width: 1080, height: 1440 })
  const order = JSON.parse(/ASPECT_ORDER = (\[[^\]]+\])/.exec(source)[1].replaceAll("'", '"'))
  assert.deepEqual([...order].sort(), [...ASPECTS].sort())
  for (const a of ASPECTS) {
    assert.match(source, new RegExp(`'${a}': \\[\\d+, \\d+\\]`), `${a} 没有画幅小框的尺寸`)
    assert.match(source, new RegExp(`'${a}': \\['`), `${a} 没有标平台`)
  }
})

test('平台标志都是随包带的文件，名字在中英文字典里都有', async () => {
  const zh = (await import('../src/client/locale/zh.js')).default
  const en = (await import('../src/client/locale/en.js')).default
  const icons = [...source.matchAll(/from '\.\/icons\/([\w-]+\.svg)'/g)].map(m => m[1])
  assert.ok(icons.length >= 9)
  for (const f of icons) assert.ok(existsSync(join(root, 'src/client/icons', f)), `缺 ${f}`)
  const names = [...source.matchAll(/name: '(publish\.\w+)'/g)].map(m => m[1])
  assert.equal(names.length, 10)
  for (const k of names) assert.ok(zh[k] && en[k], `字典里缺 ${k}`)
})
