// 和网站对齐的制作检查：铺满画面的围栏、交段前看检查图、画面跟不跟着旁白动、段会话里的路径和写文件规则。
// 围栏和看检查图用本机 Chrome、ffmpeg 真渲染；模型换成假的（能看图，第一次看检查图报一个毛病）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.LOVIDEO_DATA_DIR = mkdtempSync(join(tmpdir(), 'lovideo-quality-'))
const FONTS = join(homedir(), '.dsh', 'lovideo', 'runtime', 'fonts')
if (!process.env.LOVIDEO_FONTS_DIR && existsSync(FONTS)) process.env.LOVIDEO_FONTS_DIR = FONTS

const { sheetFrames, stillSentences, motionSteps } = await import('../src/host/quality.js')
const { placeFor, applyDraw } = await import('../src/host/segment.js')
const { sentencesOf, wordsOf, joinSentences } = await import('../src/host/narration.js')
const { renderPage, startSite, closeBrowser } = await import('../src/host/render.js')
const { bindLlm } = await import('../src/host/llm.js')

test('口播拆句、句内逐词时间、句子连成一段', () => {
  assert.deepEqual(sentencesOf({ narration: '月底一翻钱包，钱都花哪了？拍一下小票，就记好了。' }), ['月底一翻钱包，钱都花哪了？', '拍一下小票，就记好了。'])
  assert.deepEqual(sentencesOf({ narration: 'Snap the receipt. It is logged.' }), ['Snap the receipt.', 'It is logged.'])
  assert.deepEqual(sentencesOf({ sentences: ['一句', '两句'], narration: '一句两句' }), ['一句', '两句'])
  assert.equal(joinSentences(['Snap the receipt.', 'It is logged.']), 'Snap the receipt. It is logged.')
  assert.equal(joinSentences(['第一句。', '第二句。']), '第一句。第二句。')
  const w = wordsOf('钱包，空了', 1, 2)
  assert.deepEqual(w.map(x => x.w), ['钱', '包，', '空', '了'])
  assert.equal(w[0].start, 1)
  assert.equal(w.at(-1).end, 2)
})

test('检查图取帧：短段 6 帧、10 秒以上 9 帧，开头结尾都看得到', () => {
  const short = sheetFrames(90, 30)
  assert.equal(short.length, 6)
  assert.ok(short[0] < 15 && short.at(-1) > 75)
  assert.equal(sheetFrames(450, 30).length, 9)
})

test('画面不动的句子占旁白三分之一以上才退回', () => {
  // 每 0.2 秒一步：前 2 秒在动，后 4 秒不动
  const steps = [...Array(10).fill(true), ...Array(20).fill(false)]
  const lines = [{ id: 'a', text: '动', start: 0, end: 2 }, { id: 'b', text: '停', start: 2, end: 6 }]
  assert.deepEqual(stillSentences(steps, lines, 0).map(x => x.sentence.id), ['b'])
  // 不动的只占一小段：放行
  assert.deepEqual(stillSentences([...Array(25).fill(true), ...Array(5).fill(false)], [{ id: 'a', text: '', start: 0, end: 5 }, { id: 'b', text: '', start: 5, end: 6.6 }], 0), [])
  // 相邻两帧有一小块变了就算在动
  const frame = 100 * 100
  const a = Buffer.alloc(frame)
  const b = Buffer.alloc(frame)
  for (let i = 0; i < 10; i++) b[i] = 200
  assert.deepEqual(motionSteps(Buffer.concat([a, b, b]), frame), [true, false])
})

test('段会话只能写自己的段目录，路径用网站沙箱的写法', () => {
  const root = mkdtempSync(join(tmpdir(), 'lovideo-place-'))
  const proj = join(root, 'proj')
  const style = join(root, 'style')
  mkdirSync(join(proj, 'shot-1'), { recursive: true })
  mkdirSync(style)
  writeFileSync(join(style, 'SKILL.md'), '# s')
  const place = placeFor({ proj, segId: 'shot-1', styleDir: style, styleSlug: 'demo', workDir: root })
  assert.equal(place.write('/work/proj/shot-1/scene.js'), join(proj, 'shot-1', 'scene.js'))
  assert.equal(place.write('scene.js'), join(proj, 'shot-1', 'scene.js'))
  assert.throws(() => place.write('/work/proj/shot-2/scene.js'), /only inside/)
  assert.throws(() => place.write('../shot-2/x.js'), /only inside/)
  assert.throws(() => place.write('/work/.agents/skills/demo/SKILL.md'), /only inside/)
  assert.equal(place.read('/work/.agents/skills/demo/SKILL.md'), join(style, 'SKILL.md'))
  assert.throws(() => place.read('/etc/passwd'), /not readable/)
  applyDraw({ files: [{ path: 'scene.js', content: 'a = 1\nb = 2\n' }] }, place)
  applyDraw({ edits: [{ path: 'scene.js', old: 'b = 2', new: 'b = 3' }] }, place)
  assert.equal(readFileSync(join(proj, 'shot-1', 'scene.js'), 'utf8'), 'a = 1\nb = 3\n')
  // 漏写 path：用给的后备路径；没有后备就报清楚缺什么
  assert.equal(applyDraw({ edits: [{ old: 'b = 3', new: 'b = 4' }] }, place, '/work/proj/shot-1/scene.js'), '/work/proj/shot-1/scene.js')
  assert.equal(readFileSync(join(proj, 'shot-1', 'scene.js'), 'utf8'), 'a = 1\nb = 4\n')
  assert.throws(() => applyDraw({ edits: [{ old: 'b = 4', new: 'b = 5' }] }, place), /edits\[0\] has no "path"/)
  applyDraw({ edits: [{ path: 'scene.js', old: 'b = 4', new: 'b = 3' }] }, place)
  // 一处不对就一个都不写
  assert.throws(() => applyDraw({ files: [{ path: 'ok.js', content: 'x' }], edits: [{ path: 'scene.js', old: 'nope', new: '' }] }, place), /Nothing was written/)
  assert.ok(!existsSync(join(proj, 'shot-1', 'ok.js')))
})

test('平台围栏：写死横版尺寸的页面在竖版里判失败，铺满的通过', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lovideo-fill-'))
  const page = size => `<!doctype html><html><body style="margin:0;overflow:hidden"><div id="s" style="${size};background:#123"></div>
<script>window.lovideo = { ready: async f => { window.f = f }, seek: n => { document.getElementById('s').textContent = n } }</script></body></html>`
  writeFileSync(join(dir, 'fixed.html'), page('width:1920px;height:1080px'))
  writeFileSync(join(dir, 'fill.html'), page('width:100vw;height:100vh'))
  const site = await startSite([{ prefix: '/', dir }])
  const film = { unit: 'shot-1', fps: 30, width: 1080, height: 1920, start: 0, frames: 30, clock: 'unit' }
  try {
    await assert.rejects(renderPage({ origin: site.origin, entry: '/fixed.html', film, pick: [0] }), /does not fill the 1080x1920 frame after ready/)
    const shots = await renderPage({ origin: site.origin, entry: '/fill.html', film, pick: [0, 15, 29] })
    assert.equal(shots.length, 3)
  } finally {
    site.server.close()
    await closeBrowser()
  }
})

test('交段前看检查图：有毛病不渲染，毛病交回同一个会话；改完渲染出来再看一次，没毛病才交段', { timeout: 300_000 }, async () => {
  const { importMineFromDir } = await import('../src/host/styles.js')
  const { createWork, getWork } = await import('../src/host/works.js')
  const { startProduction } = await import('../src/host/produce.js')
  const base = new URL('../vendor/base-style/', import.meta.url).pathname
  const dir = join(process.env.LOVIDEO_DATA_DIR, 'style')
  cpSync(join(base, 'assets'), join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: t\ndescription: t\n---\n\n# 测试\n\n${readFileSync(join(base, 'PRODUCTION.md'), 'utf8')}`)
  importMineFromDir('style-q', dir, { name: '测试风格' })

  const seen = { sheets: 0, toolResults: [] }
  const fake = {
    async resolveModelInfo() {
      return { inputModalities: ['text', 'image'] }
    },
    async prepareCall() {
      return {
        config: {},
        async *stream({ messages, tools }) {
          const first = messages[0].content
          if (!tools && first.some(b => b.type === 'image')) {
            // 看检查图：第一次报一个毛病
            seen.sheets++
            yield { type: 'text-delta', text: seen.sheets === 1 ? '2: the title is cut off by the right edge; move it in' : 'OK' }
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
          }
          for (const m of messages) if (m.role === 'tool') seen.toolResults.push(m.content[0].text)
          const text = first.map(b => b.text || '').join('\n')
          const m = /(?:Draft it wrote, as it is now,|Current) (\/work\/proj\/[^\s:]+\/scene\.js):\n```js\n([\s\S]*?)\n```/.exec(text)
          const args = messages.length === 1 ? { files: [{ path: m[1], content: m[2] }] } : { edits: [{ path: m[1], old: m[2].slice(0, 40), new: m[2].slice(0, 40) + ' ' }] }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `c${messages.length}`, name: 'draw', arguments: JSON.stringify(args) } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        },
      }
    },
  }
  const attachments = { async saveImages(list) { return list.map((x, i) => ({ attachmentId: `a${i}`, mediaType: x.mediaType, bytes: x.data.length, width: 1, height: 1 })) } }
  bindLlm({ get: k => (k === 'llm' ? fake : k === 'attachments' ? attachments : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'fake', model: 'fake' }) } : null) })

  const work = createWork({
    title: '检查图测试', style: { slug: 'style-q', name: '测试风格', source: 'mine' }, aspect: '16:9', voice: { enabled: false },
    plan: { revision: 1, scenes: [{ id: 'shot-1', title: '开场', description: '一张纸片弹进来', narration: '', seconds: 3 }] },
  })
  await startProduction(work.id)
  let w
  for (let i = 0; i < 240; i++) {
    await new Promise(r => setTimeout(r, 500))
    w = getWork(work.id)
    if (w.status !== 'producing') break
  }
  await closeBrowser()
  assert.equal(w.status, 'done', `没做完：${w.job?.error} ${JSON.stringify(w.job.segments.map(s => s.history))}`)
  assert.equal(seen.sheets, 2, '被退回、画面改过以后，渲染好的视频再看一次（最多两次）')
  assert.match(seen.toolResults[0], /reviewer looked at a contact sheet/)
  assert.match(seen.toolResults[0], /cut off by the right edge/)
  assert.equal(w.job.segments[0].attempts, 2)
})
