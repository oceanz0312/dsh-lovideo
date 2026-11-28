// 3:4 画幅：用通用画布引擎的风格在本机做一条 3:4 的片子，成片就是 1080×1440。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.LOVIDEO_DATA_DIR = mkdtempSync(join(tmpdir(), 'lovideo-test-34-'))
// 平台字体用本机已经下好的那份，免得每次测试都下 47 MB
const FONTS = join(homedir(), '.dsh', 'lovideo', 'runtime', 'fonts')
if (!process.env.LOVIDEO_FONTS_DIR && existsSync(FONTS)) process.env.LOVIDEO_FONTS_DIR = FONTS

const base = new URL('../vendor/base-style/', import.meta.url).pathname
const STYLE = join(process.env.LOVIDEO_DATA_DIR, 'test-style')
cpSync(join(base, 'assets'), join(STYLE, 'assets'), { recursive: true })
writeFileSync(join(STYLE, 'SKILL.md'), `---\nname: base-test\ndescription: 测试用的最小风格\n---\n\n# 测试风格\n\n## The style\n\n深色底、一个黄色圆和白色标题。\n\n${readFileSync(join(base, 'PRODUCTION.md'), 'utf8')}`)

const { bindLlm } = await import('../src/host/llm.js')
const { fakeSegmentLlm } = await import('./fake-llm.mjs')
const { importMineFromDir } = await import('../src/host/styles.js')
const { createWork, getWork } = await import('../src/host/works.js')
const { startProduction } = await import('../src/host/produce.js')
const { closeBrowser } = await import('../src/host/render.js')
const { findFfmpeg } = await import('../src/host/runtime.js')

// 假模型：用 draw 把准备好的草稿交回（见 fake-llm.mjs）
const fakeLlm = fakeSegmentLlm('')
bindLlm({ get: k => (k === 'llm' ? fakeLlm : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'fake', model: 'fake' }) } : null) })

test('3:4 的片子在本机做出来是 1080×1440', { timeout: 300_000 }, async () => {
  importMineFromDir('style-test', STYLE, { name: '测试风格', aspects: ['16:9', '9:16', '3:4'] })
  const work = createWork({
    title: '三比四', style: { slug: 'style-test', name: '测试风格', source: 'mine' }, aspect: '3:4', voice: { enabled: false },
    plan: { revision: 1, scenes: [{ id: 'shot-1', title: '开场', description: '一个圆弹进来', narration: '', seconds: 3 }] },
  })
  await startProduction(work.id)
  let w
  for (let i = 0; i < 240; i++) {
    await new Promise(r => setTimeout(r, 1000))
    w = getWork(work.id)
    if (w.status !== 'producing') break
  }
  await closeBrowser()
  assert.equal(w.status, 'done', `制作没完成：${w.job?.error} ${JSON.stringify(w.job?.segments?.map(s => [s.state, s.error]))}`)
  const film = join(process.env.LOVIDEO_DATA_DIR, 'works', work.id, 'film', 'final.mp4')
  assert.ok(existsSync(film))
  // ffmpeg 读成片时在 stderr 里报出画面尺寸
  let info = ''
  try {
    execFileSync(findFfmpeg(), ['-hide_banner', '-i', film], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (e) {
    info = String(e.stderr)
  }
  assert.match(info, /1080x1440/, `成片尺寸不对：${info.slice(-300)}`)
})
