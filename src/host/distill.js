// 蒸馏我的风格：给一段喜欢的视频（或一张图），在这台电脑上把它的画法写成一个可以反复用的风格 Skill。
//   1. 看参考：抽 6 帧，算出主色、明暗、运动快慢，拼一张缩略图
//   2. 写画法：模型（用户在 DSH 选的）按这些特征和用户的描述写出风格规则（SKILL.md 的「The style」）
//   3. 出样片：用新风格各做一条 16:9 和 9:16 的短样片
//   4. 用户满意就保存进「我的风格」，以后和平台风格一样用
// 新风格用插件自带的通用画布引擎（vendor/base-style），包格式和网站风格完全一样。
import { spawn } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_ROOT, ensureDir } from './paths.js'
import { listMine, mineDir, saveMine } from './styles.js'
import { callModel, extractJson } from './llm.js'
import { ffmpeg, findFfmpeg, mediaSeconds, runtimeStatus } from './runtime.js'
import { createWork, deleteWork, getWork, workDir } from './works.js'
import { startProduction } from './produce.js'

const BASE = join(PLUGIN_ROOT, 'vendor', 'base-style')
const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i
const running = new Set()

function slugify(name) {
  const ascii = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30)
  return `my-${ascii || 'style'}-${Date.now().toString(36).slice(-5)}`
}

async function setDistill(slug, patch) {
  const cur = listMine().find(s => s.slug === slug) || { slug }
  return saveMine({ ...cur, distill: { ...(cur.distill || {}), ...patch } })
}

/* ---------- 看参考 ---------- */

async function grabFrames(ref, dir, signal) {
  if (IMAGE.test(ref)) {
    const out = join(dir, 'f1.jpg')
    await ffmpeg(['-i', ref, '-vf', 'scale=640:-2', '-frames:v', '1', out], { signal })
    return [out]
  }
  const dur = mediaSeconds(ref) || 6
  const frames = []
  for (let i = 0; i < 6; i++) {
    const at = (dur * (i + 0.5)) / 6
    const out = join(dir, `f${i + 1}.jpg`)
    await ffmpeg(['-ss', at.toFixed(2), '-i', ref, '-vf', 'scale=640:-2', '-frames:v', '1', out], { signal })
    if (existsSync(out)) frames.push(out)
  }
  return frames
}

/** 每帧缩成 8×6 读像素，统计主色、平均亮度、相邻帧的变化量 */
async function analyze(frames, signal) {
  const bin = findFfmpeg()
  const pixels = []
  const grays = []
  for (const f of frames) {
    const r = await new Promise((ok, fail) => {
      const p = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-i', f, '-vf', 'scale=8:6:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true })
      const chunks = []
      p.stdout.on('data', c => chunks.push(c))
      p.on('error', fail)
      p.on('close', () => ok(Buffer.concat(chunks)))
      signal?.addEventListener('abort', () => p.kill('SIGKILL'), { once: true })
    })
    const g = []
    for (let i = 0; i + 2 < r.length; i += 3) {
      pixels.push([r[i], r[i + 1], r[i + 2]])
      g.push(0.299 * r[i] + 0.587 * r[i + 1] + 0.114 * r[i + 2])
    }
    grays.push(g)
  }
  // 量化到 6 档再数，合并相近的颜色
  const bucket = new Map()
  for (const [r, g, b] of pixels) {
    const key = [r, g, b].map(v => Math.round(v / 43)).join(',')
    const e = bucket.get(key) || { n: 0, r: 0, g: 0, b: 0 }
    e.n++
    e.r += r
    e.g += g
    e.b += b
    bucket.set(key, e)
  }
  const hex = v => Math.round(v).toString(16).padStart(2, '0')
  const palette = [...bucket.values()].sort((a, b) => b.n - a.n).slice(0, 6)
    .map(e => ({ hex: `#${hex(e.r / e.n)}${hex(e.g / e.n)}${hex(e.b / e.n)}`, share: Math.round((e.n / pixels.length) * 100) }))
  const brightness = Math.round(grays.flat().reduce((a, b) => a + b, 0) / Math.max(1, grays.flat().length))
  let motion = 0
  for (let i = 1; i < grays.length; i++) motion += grays[i].reduce((a, v, j) => a + Math.abs(v - grays[i - 1][j]), 0) / grays[i].length
  motion = grays.length > 1 ? Math.round(motion / (grays.length - 1)) : 0
  return { palette, brightness, motion }
}

const SYSTEM = `你是 lovideo 的风格炼化程序：根据一段参考视频的特征和用户的描述，写出一个视频风格的画法规则，
以后这个风格会被用来给任意内容做讲解视频。画法由一个 Canvas 2D 引擎实现（下面附了它的接口），规则必须是这个引擎画得出来的。
只输出一个 JSON 对象，不要解释：
{"name": "风格名（中文，2 到 8 个字）", "description": "一句话描述画面（英文，最多 300 字符，用于检索）",
 "style": "SKILL.md 的「## The style」一节（Markdown，英文为主可夹中文；写清：整体气质、配色（给出具体 #hex）、版式和构图（16:9 和 9:16 各怎么放）、字体与文字用法、运动语法（入场、节奏、转场、每段最后怎么收）、质感（颗粒、暗角等）、要避免的东西）"}`

/**
 * 开始蒸馏。立刻返回风格 slug，过程在后台进行。
 * @param {{name?:string, reference:string, brief?:string}} o
 */
export async function startDistill(o) {
  if (!o.reference || !existsSync(o.reference)) throw Object.assign(new Error('参考视频或图片不存在，请把文件拖进对话里再试'), { status: 400 })
  if (!runtimeStatus().ready) throw Object.assign(new Error('本机渲染环境还没准备好，先在 lovideo 里点「准备渲染环境」'), { status: 409 })
  const slug = slugify(o.name)
  saveMine({ slug, name: o.name || '我的新风格', description: '', aspects: ['16:9', '9:16'], fps: 30, draft: true,
    distill: { state: 'running', step: 'look', reference: o.reference, brief: o.brief || '', startedAt: new Date().toISOString(), samples: [], error: null } })
  run_(slug, o).catch(() => {})
  return listMine().find(s => s.slug === slug)
}

async function run_(slug, o) {
  running.add(slug)
  const dir = mineDir(slug)
  const ctl = new AbortController()
  const signal = ctl.signal
  try {
    // 1. 看参考
    const look = ensureDir(join(dir, 'reference'))
    const frames = await grabFrames(o.reference, look, signal)
    if (!frames.length) throw new Error('没能从参考里取到画面')
    const feat = await analyze(frames, signal)
    if (frames.length > 1) {
      await ffmpeg(['-i', join(look, 'f%d.jpg'), '-vf', 'scale=320:-2,tile=3x2:padding=4:color=white', '-frames:v', '1', join(look, 'sheet.jpg')], { signal }).catch(() => {})
    } else copyFileSync(frames[0], join(look, 'sheet.jpg'))
    await setDistill(slug, { step: 'write', features: feat, sheet: 'reference/sheet.jpg' })

    // 2. 写画法
    const user = [
      `# 用户想要的风格\n名字：${o.name || '（未起名）'}\n描述：${o.brief || '（没写，按参考特征来）'}`,
      `# 参考视频的特征（从 ${frames.length} 帧测得）\n主色（占比%）：${feat.palette.map(p => `${p.hex}(${p.share}%)`).join('、')}\n平均亮度：${feat.brightness}/255\n相邻帧变化：${feat.motion}/255（越大运动越快、切换越多）`,
      `# 引擎接口\n${readFileSync(join(BASE, 'PRODUCTION.md'), 'utf8')}`,
    ].join('\n\n')
    const { text } = await callModel({ system: SYSTEM, user, maxTokens: 12000, signal, light: true })
    const out = extractJson(text)
    const name = String(o.name || out.name || '我的新风格').slice(0, 20)
    const skillDir = join(dir, 'skill')
    rmSync(skillDir, { recursive: true, force: true })
    cpSync(join(BASE, 'assets'), join(skillDir, 'assets'), { recursive: true })
    const md = `---\nname: ${slug}\ndescription: ${String(out.description || name).replace(/\n/g, ' ').slice(0, 300)}\n---\n\n# ${name}\n\n${String(out.style || '').replace(/^#+\s*The style\s*\n/i, '').trim().startsWith('##') ? '' : '## The style\n\n'}${String(out.style || '').trim()}\n\n${readFileSync(join(BASE, 'PRODUCTION.md'), 'utf8')}`
    writeFileSync(join(skillDir, 'SKILL.md'), md)
    writeFileSync(join(skillDir, 'PROVENANCE.md'), `# 来源\n\n本机蒸馏于 ${new Date().toISOString()}，参考文件：${o.reference}\n\n画法由用户在 DeepSeek Harness 选择的模型根据参考特征写成；引擎是 lovideo 插件自带的通用画布引擎。\n`)
    saveMine({ ...listMine().find(s => s.slug === slug), name, description: String(out.description || '').slice(0, 300) })
    await setDistill(slug, { step: 'sample' })

    // 3. 出样片：横竖各一条，不配音
    const samples = []
    for (const aspect of ['16:9', '9:16']) {
      const w = createWork({
        title: `${name} 样片 ${aspect}`, hidden: true, style: { slug, name, source: 'mine' }, aspect, voice: { enabled: false },
        plan: { revision: 1, scenes: [
          { id: 'shot-1', title: '风格样片', description: `展示「${name}」这个风格最典型的画面：${o.brief || '按风格规则自由发挥'}。画一个标题「${name}」和几样随风格变化的图形，有明显的入场和运动。`, narration: '', seconds: 5 },
        ] },
      })
      await startProduction(w.id)
      let cur
      for (let i = 0; i < 600; i++) {
        await new Promise(r => setTimeout(r, 1000))
        cur = getWork(w.id)
        if (cur.status !== 'producing') break
      }
      if (cur?.status !== 'done') throw new Error(`${aspect} 样片没做出来：${cur?.job?.error || '原因不明'}`)
      const file = `samples/${aspect.replace(':', 'x')}.mp4`
      const poster = `samples/${aspect.replace(':', 'x')}.jpg`
      mkdirSync(join(dir, 'samples'), { recursive: true })
      copyFileSync(join(workDir(w.id), cur.film.file), join(dir, file))
      copyFileSync(join(workDir(w.id), cur.film.poster), join(dir, poster))
      deleteWork(w.id)
      samples.push({ aspect, file, poster })
      await setDistill(slug, { samples })
    }
    await setDistill(slug, { state: 'done', step: 'done', endedAt: new Date().toISOString() })
    saveMine({ ...listMine().find(s => s.slug === slug), cover: samples[0]?.poster })
  } catch (err) {
    await setDistill(slug, { state: 'failed', error: err.message })
  } finally {
    running.delete(slug)
  }
}

/** 保存进「我的风格」（去掉草稿标记） */
export function saveDistilled(slug) {
  const s = listMine().find(x => x.slug === slug)
  if (!s) throw Object.assign(new Error('找不到这个风格'), { status: 404 })
  if (s.distill?.state !== 'done') throw Object.assign(new Error('样片还没做好'), { status: 409 })
  return saveMine({ ...s, draft: false, savedAt: new Date().toISOString() })
}

export const distillRunning = slug => running.has(slug)

