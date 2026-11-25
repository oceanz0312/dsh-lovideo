// 剪映专业版：检测安装和草稿目录、把导出的草稿导入剪映、打开或重开剪映。macOS 和 Windows 都支持；
// Linux 没有剪映专业版。导入在 Node 里完成（复制草稿目录、填上路径占位符），
// 不调用导出包里的 bash / PowerShell 脚本，免得被 Windows 的脚本执行策略拦住。
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAC = process.platform === 'darwin'
const WIN = process.platform === 'win32'

// 网站导出器写进草稿文件里的两个占位符（见 vendor/jianying/jianying_install 的导入脚本）
const DRAFT_PATH_PLACEHOLDER = '##_draftpath_placeholder_0E685133-18CE-45ED-8CB8-2904A212EC80_##'
const DRAFT_ROOT_PLACEHOLDER = '##_lovideo_draft_root_##'
const FILES_WITH_PATHS = ['draft_info.json', 'draft_content.json', 'template-2.tmp', 'draft_meta_info.json']

// 剪映专业版的进程名：macOS 是 VideoFusion-macOS，Windows 是 JianyingPro.exe
const MAC_PROCESS = 'VideoFusion-macOS'
const WIN_PROCESS = 'JianyingPro.exe'
export const DOWNLOAD_URL = 'https://www.capcut.cn/'

function userDataDir() {
  if (MAC) return join(homedir(), 'Movies', 'JianyingPro', 'User Data')
  if (WIN && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'JianyingPro', 'User Data')
  return null
}

/** 剪映草稿目录：设置里改过位置就用改过的（Config/globalSetting 的 currentCustomDraftPath），否则用默认位置 */
export function draftRoot() {
  if (process.env.JIANYING_DRAFT_ROOT) return process.env.JIANYING_DRAFT_ROOT
  const data = userDataDir()
  if (!data) return null
  try {
    const m = /^currentCustomDraftPath=(.+)$/m.exec(readFileSync(join(data, 'Config', 'globalSetting'), 'utf8'))
    if (m && m[1].trim()) return m[1].trim()
  } catch {
    // 没改过位置
  }
  return join(data, 'Projects', 'com.lveditor.draft')
}

/** 剪映专业版装在哪（找不到返回 null） */
export function findApp() {
  if (process.env.JIANYING_APP) return existsSync(process.env.JIANYING_APP) ? process.env.JIANYING_APP : null
  if (MAC) {
    const names = ['VideoFusion-macOS.app', '剪映专业版.app', 'JianyingPro.app']
    for (const dir of ['/Applications', join(homedir(), 'Applications')]) {
      for (const n of names) if (existsSync(join(dir, n))) return join(dir, n)
    }
    // 装在别处：用 Spotlight 按进程名找
    const r = spawnSync('mdfind', [`kMDItemFSName == "${MAC_PROCESS}.app"`], { encoding: 'utf8', timeout: 5000 })
    const hit = (r.stdout || '').split('\n').find(p => p.endsWith('.app') && existsSync(p))
    return hit || null
  }
  if (WIN) {
    const local = process.env.LOCALAPPDATA || ''
    const candidates = [
      join(local, 'JianyingPro', 'Apps', 'JianyingPro.exe'),
      join(process.env.ProgramFiles || 'C:\\Program Files', 'JianyingPro', 'JianyingPro.exe'),
      join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'JianyingPro', 'JianyingPro.exe'),
    ]
    return candidates.find(p => existsSync(p)) || null
  }
  return null
}

/** 剪映是不是正开着 */
export function isRunning() {
  if (MAC) return spawnSync('pgrep', ['-x', MAC_PROCESS]).status === 0
  if (WIN) {
    const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${WIN_PROCESS}`, '/NH'], { encoding: 'utf8', windowsHide: true })
    return (r.stdout || '').toLowerCase().includes(WIN_PROCESS.toLowerCase())
  }
  return false
}

function writable(dir) {
  try {
    accessSync(dir, constants.W_OK)
    const probe = join(dir, `.lovideo-write-test-${process.pid}`)
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 导入前的检查。problem 是给用户看的一句话（没有问题时为 null），code 给页面决定显示什么按钮。
 * running 不算问题：导入后要重开剪映才看得到，由页面问用户要不要帮他重开。
 */
export function jianyingStatus() {
  const supported = MAC || WIN
  const app = supported ? findApp() : null
  const root = supported ? draftRoot() : null
  const rootExists = Boolean(root && existsSync(root))
  const status = { supported, installed: Boolean(app), app, draftRoot: root, rootExists, writable: rootExists && writable(root), running: supported && isRunning(), downloadUrl: DOWNLOAD_URL }
  let code = null
  let problem = null
  if (!supported) [code, problem] = ['unsupported', '剪映专业版只有 Windows 和 macOS 版，这台电脑上可以先导出剪映工程文件夹，拿到装了剪映的电脑上导入。']
  else if (!app && !rootExists) [code, problem] = ['missing', '这台电脑上没有找到剪映专业版。装好并打开一次后，再点「在剪映中打开」。']
  else if (!rootExists) [code, problem] = ['not-initialized', '找到了剪映，但它还没创建草稿目录。先打开一次剪映（进到首页就行），再回来点一次。']
  else if (!status.writable) [code, problem] = ['no-permission', `没有权限写入剪映的草稿目录：${root}。${MAC ? '请在「系统设置 → 隐私与安全性 → 文件与文件夹」里允许 DeepSeek Harness 访问这个位置' : '请检查这个文件夹的权限，或在剪映设置里换一个草稿位置'}，然后再试。`]
  return { ...status, code, problem }
}

/** 把导出器生成的 lovideo_timeline 草稿导入剪映草稿目录，名字重复就加序号。返回 { name, path } */
export function importDraft(srcDraftDir, title, root = draftRoot()) {
  if (!root || !existsSync(root)) throw Object.assign(new Error('找不到剪映的草稿目录，请先打开一次剪映'), { code: 'not-initialized' })
  const base = String(title || 'lovideo').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim().slice(0, 60) || 'lovideo'
  let name = base
  for (let i = 2; existsSync(join(root, name)); i++) name = `${base}-${i}`
  const dest = join(root, name)
  cpSync(srcDraftDir, dest, { recursive: true })
  // 剪映的草稿文件里路径一律用正斜杠（Windows 也是）
  const destJ = dest.replace(/\\/g, '/')
  const rootJ = root.replace(/\\/g, '/')
  for (const f of FILES_WITH_PATHS) {
    const p = join(dest, f)
    if (!existsSync(p)) continue
    let s = readFileSync(p, 'utf8').split(DRAFT_PATH_PLACEHOLDER).join(destJ).split(DRAFT_ROOT_PLACEHOLDER).join(rootJ)
    if (f === 'draft_meta_info.json') s = s.replace(/"draft_name":\s*"[^"]*"/, `"draft_name": ${JSON.stringify(name)}`)
    writeFileSync(p, s)
  }
  return { name, path: dest }
}

/** 打开剪映（已经开着就只是切到前台） */
export function launch(app = findApp()) {
  if (!app) throw Object.assign(new Error('没有找到剪映专业版'), { code: 'missing' })
  const child = MAC
    ? spawn('open', ['-a', app], { detached: true, stdio: 'ignore' })
    : spawn(app, [], { detached: true, stdio: 'ignore', windowsHide: false })
  child.on('error', () => {})
  child.unref()
}

/** 正常退出剪映（让它自己保存草稿），最多等 timeoutMs；返回是否已经退出 */
export async function quit(timeoutMs = 20_000, app = findApp()) {
  if (!isRunning()) return true
  // 按安装路径找应用再让它退出，不依赖应用在系统里叫什么名字
  if (MAC) spawnSync('osascript', ['-e', `tell application (POSIX file ${JSON.stringify(app || `/Applications/${MAC_PROCESS}.app`)} as text) to quit`], { timeout: 10_000 })
  else if (WIN) spawnSync('taskkill', ['/IM', WIN_PROCESS], { windowsHide: true, timeout: 10_000 })
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (!isRunning()) return true
    await new Promise(r => setTimeout(r, 500))
  }
  return !isRunning()
}
