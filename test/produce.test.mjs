// 制作流水线的集成测试：用插件自带的通用画布引擎拼一个风格（和蒸馏出来的风格同一种包），
// 加上系统语音、本机 Chrome 和 ffmpeg；模型换成假的（原样交回草稿）。
// 想用某个真实风格包测：LOVIDEO_TEST_STYLE=<风格的 skill 目录> npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.LOVIDEO_DATA_DIR = mkdtempSync(join(tmpdir(), 'lovideo-test-'))
// 不往真的剪映草稿目录里放
process.env.JIANYING_DRAFT_ROOT = join(process.env.LOVIDEO_DATA_DIR, 'jianying-drafts')
mkdirSync(process.env.JIANYING_DRAFT_ROOT)
// 平台字体用本机已经下好的那份，免得每次测试都下 47 MB
const FONTS = join(homedir(), '.dsh', 'lovideo', 'runtime', 'fonts')
if (!process.env.LOVIDEO_FONTS_DIR && existsSync(FONTS)) process.env.LOVIDEO_FONTS_DIR = FONTS
const STYLE = process.env.LOVIDEO_TEST_STYLE || baseStyle()

/** 用 vendor/base-style 拼一个最小风格包：assets + SKILL.md（风格说明 + 引擎接口） */
function baseStyle() {
  const base = new URL('../vendor/base-style/', import.meta.url).pathname
  const dir = join(process.env.LOVIDEO_DATA_DIR, 'test-style')
  cpSync(join(base, 'assets'), join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: base-test\ndescription: 测试用的最小风格\n---\n\n# 测试风格\n\n## The style\n\n深色底、一个黄色圆和白色标题。\n\n${readFileSync(join(base, 'PRODUCTION.md'), 'utf8')}`)
  return dir
}

const { bindLlm } = await import('../src/host/llm.js')
const { importMineFromDir } = await import('../src/host/styles.js')
const { createWork, getWork } = await import('../src/host/works.js')
const { startProduction } = await import('../src/host/produce.js')
const { closeBrowser } = await import('../src/host/render.js')
const { startExport, waitExport } = await import('../src/host/export.js')
const { updateSettings } = await import('../src/host/settings.js')
const { setSwitches } = await import('../src/host/edit.js')

// 假模型：把用户消息里「段目录现有文件」的 scene.js 原样交回
const fakeLlm = {
  async prepareCall() {
    return {
      config: {},
      async *stream({ messages }) {
        const user = messages[0].content[0].text
        const m = /--- scene\.js ---\n([\s\S]*?)(?=\n\n--- |\n\n# |$)/.exec(user)
        yield { type: 'text-delta', text: `=== FILE: scene.js ===\n${m ? m[1] : ''}\n=== END ===` }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
}
bindLlm({ get: k => (k === 'llm' ? fakeLlm : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'fake', model: 'fake' }) } : null) })

test('确认分镜后在本机做出成片', { timeout: 300_000 }, async () => {
  existsSync(STYLE) || assert.fail(`没有测试风格包 ${STYLE}`)
  importMineFromDir('style-test', STYLE, { name: '测试风格' })
  const work = createWork({
    title: '测试片', style: { slug: 'style-test', name: '测试风格', source: 'mine' }, aspect: '16:9',
    plan: { revision: 1, scenes: [
      { id: 'shot-1', title: '开场', description: '一张纸片弹进来', narration: '月底一翻钱包，钱都花哪了？', seconds: 3 },
      { id: 'shot-2', title: '结尾', description: '纸片飞走', narration: '拍一下小票，就记好了。', seconds: 3 },
    ] },
  })
  await startProduction(work.id)
  let w
  for (let i = 0; i < 240; i++) {
    await new Promise(r => setTimeout(r, 1000))
    w = getWork(work.id)
    if (w.status !== 'producing') break
  }
  assert.equal(w.status, 'done', `制作没完成：${w.job?.error} ${JSON.stringify(w.job?.segments?.map(s => [s.state, s.error]))}`)
  assert.ok(existsSync(join(process.env.LOVIDEO_DATA_DIR, 'works', work.id, 'film', 'final.mp4')))
  assert.ok(w.film.duration > 5, `成片时长 ${w.film.duration}`)
  assert.equal(w.timeline.tracks.find(t => t.type === 'subtitle').clips.length, 2)
  console.log('film', w.film, 'workdir', join(process.env.LOVIDEO_DATA_DIR, 'works', work.id))

  // 导出 MP4（烧字幕）和剪映工程
  updateSettings({ exportDir: join(process.env.LOVIDEO_DATA_DIR, 'exports') })
  await startExport(work.id, { format: 'both', quality: '720', burn: true })
  const e = await waitExport(work.id)
  await closeBrowser()
  assert.equal(e.exporting.state, 'done', `导出失败：${e.exporting.error}`)
  const mp4 = e.exporting.results.find(r => r.kind === 'mp4')
  const jy = e.exporting.results.find(r => r.kind === 'jianying')
  assert.ok(existsSync(mp4.path) && mp4.burned)
  assert.ok(existsSync(join(jy.path, 'lovideo_timeline', 'draft_content.json')), '没有剪映草稿')
  assert.ok(existsSync(join(jy.path, jy.installer)), '没有导入脚本')
  // 在剪映中打开用的导入：复制草稿、填上路径、改名，重名加序号
  const { importDraft } = await import('../src/host/jianying.js')
  const root = process.env.JIANYING_DRAFT_ROOT
  const a = importDraft(join(jy.path, 'lovideo_timeline'), '测试片', root)
  const b = importDraft(join(jy.path, 'lovideo_timeline'), '测试片', root)
  assert.equal(a.name, '测试片')
  assert.equal(b.name, '测试片-2')
  const content = readFileSync(join(a.path, 'draft_content.json'), 'utf8')
  assert.ok(!content.includes('##_draftpath_placeholder_') && !content.includes('##_lovideo_draft_root_##'), '草稿里还有路径占位符')
  assert.ok(content.includes(a.path.replace(/\\/g, '/')), '草稿里的素材路径没有指向导入后的位置')
  assert.match(readFileSync(join(a.path, 'draft_meta_info.json'), 'utf8'), /"draft_name":\s*"测试片"/)
  console.log('exports', e.exporting.results)

  // 成片下面的开关：字幕只改时间线；关配音要重新拼成片（新版本），剪映工程里也没有配音轨
  const v0 = getWork(work.id).film.version
  let x = await setSwitches(work.id, { subtitles: false })
  assert.equal(x.timeline.tracks.find(t => t.type === 'subtitle').hidden, true)
  assert.equal(x.film.version, v0, '只切字幕不该重新拼成片')
  x = await setSwitches(work.id, { voice: false })
  assert.equal(x.timeline.tracks.find(t => t.role === 'voice').hidden, true)
  assert.equal(x.voice.enabled, false)
  assert.notEqual(x.film.version, v0, '关配音后成片要重新拼')
  assert.ok(existsSync(join(process.env.LOVIDEO_DATA_DIR, 'works', work.id, 'film', 'final.mp4')))
  // 设置里选了不配乐：打开配乐会失败，开关和成片都不变
  updateSettings({ music: { provider: 'none' } })
  await setSwitches(work.id, { music: true })
  for (let i = 0; i < 50 && getWork(work.id).remix?.state !== 'failed'; i++) await new Promise(r => setTimeout(r, 100))
  x = getWork(work.id)
  assert.equal(x.remix?.state, 'failed')
  assert.match(x.remix.error, /不配乐/)
  assert.equal(x.timeline.tracks.some(t => t.role === 'bgm'), false)
  await startExport(work.id, { format: 'jianying' })
  const e2 = await waitExport(work.id)
  await closeBrowser()
  const draft = readFileSync(join(e2.exporting.results[0].path, 'lovideo_timeline', 'draft_content.json'), 'utf8')
  assert.ok(!/vo-shot-1|n-shot-1/.test(draft), '关掉的配音不该进剪映工程')
})
