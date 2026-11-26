// 重出分镜后再开拍：要重画的段从干净的目录开始，换了风格的镜头不沿用。
// 曾经的问题：同一部片子从一个风格换到另一个风格重出分镜，段目录里还留着上一个风格的代码和草稿备份，
// 准备脚本因为文件已经在了就不写新草稿，模型拿着旧风格的代码改，一直改不对，整段失败。
// 和 produce.test.mjs 一样用插件自带的通用画布引擎、本机 Chrome 和 ffmpeg；模型换成假的。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.LOVIDEO_DATA_DIR = mkdtempSync(join(tmpdir(), 'lovideo-redraw-'))
const FONTS = join(homedir(), '.dsh', 'lovideo', 'runtime', 'fonts')
if (!process.env.LOVIDEO_FONTS_DIR && existsSync(FONTS)) process.env.LOVIDEO_FONTS_DIR = FONTS

function baseStyle(name) {
  const base = new URL('../vendor/base-style/', import.meta.url).pathname
  const dir = join(process.env.LOVIDEO_DATA_DIR, name)
  cpSync(join(base, 'assets'), join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: 测试用的最小风格\n---\n\n# 测试风格\n\n深色底、一个黄色圆和白色标题。\n\n${readFileSync(join(base, 'PRODUCTION.md'), 'utf8')}`)
  return dir
}

const { bindLlm } = await import('../src/host/llm.js')
const { importMineFromDir } = await import('../src/host/styles.js')
const { createWork, getWork, updateWork, workDir } = await import('../src/host/works.js')
const { startProduction } = await import('../src/host/produce.js')
const { closeBrowser } = await import('../src/host/render.js')

// 假模型：在段目录里现有的 scene.js 末尾加一行注释交回（和草稿不一字不差，算模型自己写的）
const fakeLlm = {
  async prepareCall() {
    return {
      config: {},
      async *stream({ messages }) {
        const user = messages[0].content[0].text
        const m = /--- scene\.js ---\n([\s\S]*?)(?=\n\n--- |\n\n# |$)/.exec(user)
        yield { type: 'text-delta', text: `=== FILE: scene.js ===\n${m ? m[1] : ''}\n// 模型写的\n=== END ===` }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
}
bindLlm({ get: k => (k === 'llm' ? fakeLlm : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'fake', model: 'fake' }) } : null) })

async function produce(id) {
  await startProduction(id)
  let w
  for (let i = 0; i < 180; i++) {
    await new Promise(r => setTimeout(r, 500))
    w = getWork(id)
    if (w.status !== 'producing') break
  }
  return w
}

const revise = (id, patch) => updateWork(id, w => {
  Object.assign(w, patch.work || {})
  w.plan = { ...w.plan, revision: w.plan.revision + 1, scenes: patch.scenes || w.plan.scenes }
  w.status = 'draft'
  return w
})

test('重出分镜（换了风格）后：从这一版的草稿开始画，不拿上一版留下的代码', { timeout: 300_000 }, async () => {
  importMineFromDir('style-a', baseStyle('style-a'), { name: '风格 A' })
  importMineFromDir('style-b', baseStyle('style-b'), { name: '风格 B' })
  const scene = { id: 'shot-1', title: '开场', description: '一张纸片弹进来', narration: '', seconds: 3 }
  const work = createWork({ title: '重画测试', style: { slug: 'style-a', name: '风格 A', source: 'mine' }, aspect: '16:9', voice: { enabled: false },
    plan: { revision: 1, scenes: [scene] } })
  let w = await produce(work.id)
  assert.equal(w.status, 'done', `第一版没做完：${w.job?.error}`)

  // 上一版留下的代码是别的风格的、在这个风格里跑不起来
  const dir = join(workDir(work.id), 'proj', 'shot-1')
  writeFileSync(join(dir, 'scene.js'), "throw new Error('上一个风格的代码')")
  writeFileSync(join(dir, '.draft', 'scene.js'), "throw new Error('上一个风格的草稿')")
  await revise(work.id, { work: { style: { slug: 'style-b', name: '风格 B', source: 'mine' } }, scenes: [{ ...scene, description: '纸片换成一枚硬币' }] })
  w = await produce(work.id)
  const seg = w.job.segments[0]
  assert.equal(w.status, 'done', `第二版没做完：${w.job?.error} ${JSON.stringify(w.job.segments.map(s => s.history))}`)
  assert.equal(seg.attempts, 1, `模型拿到的应该是这一版的草稿，一次就能画好：${JSON.stringify(seg.history)}`)
  assert.ok(!seg.fallback)
  assert.doesNotMatch(readFileSync(join(dir, 'scene.js'), 'utf8'), /上一个风格/)

  // 画面描述没变、只换了风格：做好的镜头不能沿用
  await revise(work.id, { work: { style: { slug: 'style-a', name: '风格 A', source: 'mine' } } })
  w = await produce(work.id)
  await closeBrowser()
  assert.equal(w.status, 'done', `第三版没做完：${w.job?.error}`)
  assert.ok(!w.job.segments[0].carried, '换了风格还沿用了上一个风格的镜头')
})
