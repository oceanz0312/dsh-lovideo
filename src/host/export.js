// 导出：MP4（可选清晰度、可选把字幕烧进画面）和剪映工程。全部在本机完成。
// 剪映工程用的是网站同一份导出器（vendor/jianying，来自 lovideo 仓库 workers/sandbox/job），
// 所以插件和网站导出的工程完全一样。第一次导出剪映时会用 Python 装一次 pyJianYingDraft。
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PLUGIN_ROOT, defaultExportDir, ensureDir, runtimeDir, tmpDir } from './paths.js'
import { readSettings } from './settings.js'
import { requireWork, updateWork, workDir } from './works.js'
import { ffmpeg, findPythonForNative, mediaSeconds, run } from './runtime.js'
import { getBrowser } from './render.js'

const running = new Map()

function safeName(title) {
  return String(title || 'lovideo').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim().slice(0, 60) || 'lovideo'
}

function uniquePath(dir, base, ext) {
  let p = join(dir, `${base}${ext}`)
  for (let i = 2; existsSync(p); i++) p = join(dir, `${base}-${i}${ext}`)
  return p
}

export function exportDir() {
  return ensureDir(readSettings().exportDir || defaultExportDir())
}

/** 字幕画成透明 PNG：字幕单行居中于画高 90%，和网站字幕的位置一致 */
async function captionImages(timeline, outDir) {
  const subs = timeline.tracks.find(t => t.type === 'subtitle')
  if (!subs || subs.hidden || !subs.clips.length) return []
  const { width, height } = timeline.output
  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 })
    const size = Math.round(Math.min(width, height) * 0.037)
    const list = []
    for (const [i, c] of subs.clips.entries()) {
      const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}
        div{position:absolute;left:5%;right:5%;top:${Math.round(height * 0.9)}px;transform:translateY(-50%);text-align:center;
        font:600 ${size}px/1.3 "PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC",sans-serif;color:#fff;
        -webkit-text-stroke:${Math.max(2, Math.round(size / 12))}px rgba(0,0,0,.85);paint-order:stroke fill;
        text-shadow:0 2px 6px rgba(0,0,0,.45)}</style><div></div>`
      await page.setContent(html)
      await page.evaluate(t => (document.querySelector('div').textContent = t), c.text)
      const file = join(outDir, `cap-${i}.png`)
      await page.screenshot({ path: file, omitBackground: true, type: 'png' })
      list.push({ file, start: c.start, end: c.start + c.dur })
    }
    return list
  } finally {
    await page.close().catch(() => {})
  }
}

async function exportMp4(work, { quality = '1080', burn = true }, signal) {
  const dir = workDir(work.id)
  const src = join(dir, work.film.file)
  const tmp = ensureDir(join(tmpDir(), `export-${work.id}-${Date.now()}`))
  try {
    const caps = burn ? await captionImages(work.timeline, tmp) : []
    const portrait = work.timeline.output.height > work.timeline.output.width
    const q = Number(quality) || 1080
    const scale = portrait ? `scale=${q}:-2` : `scale=-2:${q}`
    const args = ['-i', src]
    caps.forEach(c => args.push('-i', c.file))
    const chain = []
    let last = '0:v'
    caps.forEach((c, i) => {
      chain.push(`[${last}][${i + 1}:v]overlay=0:0:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'[o${i}]`)
      last = `o${i}`
    })
    chain.push(`[${last}]${scale},format=yuv420p[v]`)
    const out = uniquePath(exportDir(), safeName(work.title), '.mp4')
    await ffmpeg([...args, '-filter_complex', chain.join(';'), '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'medium',
      '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], { signal })
    return { kind: 'mp4', path: out, quality: `${q}p`, burned: caps.length > 0, seconds: mediaSeconds(out) }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** 装一次 pyJianYingDraft 到插件自己的目录（不动系统 Python） */
async function ensureJianyingLib(py, signal) {
  const v = await run(py, ['-c', 'import sys;print("%d.%d"%sys.version_info[:2])'], { signal })
  const lib = join(runtimeDir(), `py${v.stdout.trim() || ''}`)
  if (existsSync(join(lib, 'pyJianYingDraft'))) return lib
  ensureDir(lib)
  const r = await run(py, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--target', lib, 'pyJianYingDraft==0.3.1'], { signal, timeoutMs: 600_000 })
  if (r.code !== 0) throw new Error(`安装剪映导出组件失败：${r.stderr.trim().slice(-300)}`)
  return lib
}

async function exportJianying(work, signal) {
  const py = findPythonForNative()
  if (!py) throw new Error('导出剪映工程需要 Python 3，这台电脑上没有找到（macOS 可以在终端运行 xcode-select --install 安装）')
  const lib = await ensureJianyingLib(py, signal)
  const dir = workDir(work.id)
  // 素材换成本机绝对路径，交给网站同一份导出器
  const doc = structuredClone(work.timeline)
  for (const a of Object.values(doc.assets)) a.localPath = join(dir, a.uri || a.r2)
  for (const t of doc.tracks) for (const c of t.clips) delete c.of
  const tmp = ensureDir(join(tmpDir(), `jy-${work.id}-${Date.now()}`))
  const docFile = join(tmp, 'timeline.json')
  writeFileSync(docFile, JSON.stringify(doc))
  const out = uniquePath(exportDir(), `${safeName(work.title)}-剪映工程`, '')
  mkdirSync(out, { recursive: true })
  try {
    const r = await run(py, [join(PLUGIN_ROOT, 'vendor', 'jianying', 'timeline_export.py'), docFile, out], {
      signal, timeoutMs: 600_000, env: { PYTHONPATH: lib, PYTHONIOENCODING: 'utf-8' },
    })
    if (r.code !== 0) throw new Error(`导出剪映工程失败：${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  // 网站版是给下载用的（zip + 说明）；本机直接摊开：草稿和导入脚本放在最外层
  const inner = join(out, 'jianying_draft')
  if (existsSync(inner)) {
    for (const f of readdirSync(inner)) renameSync(join(inner, f), join(out, f))
    rmSync(inner, { recursive: true, force: true })
  }
  rmSync(join(out, 'jianying_draft.zip'), { force: true })
  rmSync(join(out, 'README.md'), { force: true })
  const installer = process.platform === 'win32' ? 'install_windows.bat' : 'install_mac.command'
  if (existsSync(join(out, 'install_mac.command'))) chmodSync(join(out, 'install_mac.command'), 0o755)
  writeFileSync(join(out, '说明.txt'), [
    `《${work.title}》的剪映专业版工程（lovideo 导出）。`,
    '',
    `导入：退出剪映，双击 ${installer}，再打开剪映，在草稿列表里就能看到。`,
    '不要手动复制 lovideo_timeline 文件夹：素材路径要靠导入脚本填好。',
    'jianying_report.json 里写了哪些效果在剪映里是近似的或没带过去。',
    '',
  ].join('\n'))
  // 这台电脑装了剪映：直接放进剪映的草稿列表
  const imported = await importToJianying(out, safeName(work.title), signal).catch(() => null)
  return { kind: 'jianying', path: out, installer, imported }
}

/** 剪映草稿目录（没装剪映返回 null；Linux 没有剪映） */
function jianyingDraftRoot() {
  if (process.env.JIANYING_DRAFT_ROOT) return process.env.JIANYING_DRAFT_ROOT
  const root = process.platform === 'darwin'
    ? join(homedir(), 'Movies', 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft')
    : process.platform === 'win32' && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft')
      : null
  return root && existsSync(root) ? root : null
}

async function importToJianying(out, title, signal) {
  const root = jianyingDraftRoot()
  if (!root) return null
  let name = title
  for (let i = 2; existsSync(join(root, name)); i++) name = `${title}-${i}`
  const r = process.platform === 'win32'
    ? await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(out, 'install_windows.ps1'), name], { signal, timeoutMs: 120_000, env: { JIANYING_DRAFT_ROOT: root } })
    : await run('/bin/bash', [join(out, 'install_mac.command'), name], { signal, timeoutMs: 120_000, env: { JIANYING_DRAFT_ROOT: root } })
  return r.code === 0 ? { name, path: join(root, name) } : null
}

/**
 * 导出一部作品。立刻返回，导出在后台进行，进度写在作品的 exporting 字段里。
 * @param {{format?:'mp4'|'jianying'|'both', quality?:string, burn?:boolean}} opts
 */
export async function startExport(id, opts = {}) {
  const work = requireWork(id)
  if (!work.film || !work.timeline) throw Object.assign(new Error('成片还没做好，做好后再导出'), { status: 409 })
  if (running.has(id)) return requireWork(id)
  const format = ['mp4', 'jianying', 'both'].includes(opts.format) ? opts.format : 'mp4'
  const ctl = new AbortController()
  running.set(id, ctl)
  await updateWork(id, w => ((w.exporting = { format, quality: opts.quality || '1080', burn: opts.burn !== false, state: 'running', startedAt: new Date().toISOString(), results: [], error: null }), w))
  ;(async () => {
    try {
      if (format === 'mp4' || format === 'both') {
        const r = await exportMp4(requireWork(id), { quality: opts.quality, burn: opts.burn !== false }, ctl.signal)
        await updateWork(id, w => ((w.exporting.results.push(r)), w))
      }
      if (format === 'jianying' || format === 'both') {
        const r = await exportJianying(requireWork(id), ctl.signal)
        await updateWork(id, w => ((w.exporting.results.push(r)), w))
      }
      await updateWork(id, w => {
        w.exporting.state = 'done'
        w.exports = [...(w.exports || []), ...w.exporting.results.map(r => ({ ...r, at: new Date().toISOString() }))].slice(-20)
        return w
      })
    } catch (err) {
      await updateWork(id, w => ((w.exporting = { ...w.exporting, state: 'failed', error: err.message }), w)).catch(() => {})
    } finally {
      running.delete(id)
    }
  })()
  return requireWork(id)
}

/** 等一次导出结束（工具调用用：导出通常几十秒） */
export async function waitExport(id, timeoutMs = 600_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const w = requireWork(id)
    if (!running.has(id) && w.exporting?.state !== 'running') return w
    await new Promise(r => setTimeout(r, 800))
  }
  return requireWork(id)
}
