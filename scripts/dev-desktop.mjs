// 让 DeepSeek Harness 桌面版（或任意 profile）直接跑这份源码，并打开热重载。
//
//   npm run dev:desktop             开发模式：profile 链接到本仓库，后端源码改了自动重载
//   npm run dev                     另开一个终端：客户端改了自动重新打包，页面自动换上新的
//   npm run dev:desktop:off         回到 npm 上发布的版本（默认最新版）
//   npm run dev:desktop:off -- --tgz <文件>   换成本地打的包，发版前按用户的装法再验一遍
//   npm run dev:desktop:status
//
// 选项：--profile <名字>（默认 desktop）
// 找 dsh 命令：环境变量 DSH_CLI > PATH 里的 dsh > 各系统默认安装位置。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const args = process.argv.slice(2)
const cmd = args[0] || 'status'
const opt = name => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const profile = opt('profile') || 'desktop'
const profileDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', profile)
const patchFile = join(profileDir, 'cordis.patch.yml')
const manifestFile = join(profileDir, 'package.json')
// 写进 profile patch 的这一段带标记，开关时整段加上或删掉，不动用户别的配置
const BEGIN = '# >>> dsh-lovideo 开发模式（npm run dev:desktop:off 会删掉这一段）'
const END = '# <<< dsh-lovideo 开发模式'

function dshCli() {
  if (process.env.DSH_CLI) return process.env.DSH_CLI
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8' })
  const found = which.status === 0 && which.stdout.split(/\r?\n/).find(Boolean)
  if (found) return found.trim()
  const candidates = process.platform === 'darwin'
    ? ['/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh', join(homedir(), 'Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh')]
    : process.platform === 'win32'
      ? [join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')]
      : []
  const hit = candidates.find(p => existsSync(p))
  if (!hit) fail('找不到 dsh 命令：装好 DeepSeek Harness，或用环境变量 DSH_CLI 指向它的 dsh')
  return hit
}

function fail(msg) {
  console.error(msg)
  process.exit(1)
}

/** 用 DSH 自带的插件命令（就是在 profile 目录里跑 pnpm）改依赖 */
function dshPlugin(...pnpmArgs) {
  const r = spawnSync(dshCli(), ['plugin', '--profile', profile, ...pnpmArgs], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    // 只从公共 npm 装，不跟着本机的 npm 镜像设置走
    env: { ...process.env, npm_config_registry: 'https://registry.npmjs.org/' },
  })
  if (r.status !== 0) fail(`dsh plugin ${pnpmArgs.join(' ')} 失败`)
}

function readPatch() {
  return existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
}

function withoutDevBlock(text) {
  const a = text.indexOf(BEGIN)
  const b = text.indexOf(END)
  if (a < 0 || b < 0) return text
  return (text.slice(0, a) + text.slice(b + END.length)).replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')
}

/** 打开 base 组合里的 hmr，监听插件后端源码；客户端的热重载由 DSH 轮询 dist/client.js 完成 */
function devBlock() {
  const host = join(ROOT, 'src', 'host').replace(/\\/g, '/')
  return `${BEGIN}\n- id: hmr\n  config:\n    root:\n      - ${JSON.stringify(host)}\n${END}\n`
}

function ensureBundle() {
  const m = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const bundles = ((m.dsh ??= {}).profile ??= {}).bundles ??= []
  if (!bundles.includes(PKG.name)) {
    bundles.push(PKG.name)
    writeFileSync(manifestFile, `${JSON.stringify(m, null, 2)}\n`)
  }
}

function currentSpec() {
  if (!existsSync(manifestFile)) return null
  return JSON.parse(readFileSync(manifestFile, 'utf8')).dependencies?.[PKG.name] ?? null
}

/** pnpm 去掉 link 依赖时会顺手清掉被链接目录里的 node_modules，事后补回来 */
function ensureOwnDeps() {
  if (existsSync(join(ROOT, 'node_modules', 'puppeteer-core'))) return
  console.log('本仓库的依赖被清掉了，重新安装…')
  const r = spawnSync('npm', ['install'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, npm_config_registry: 'https://registry.npmjs.org/' } })
  if (r.status !== 0) fail('npm install 失败')
}

if (!existsSync(manifestFile)) fail(`没有这个 DeepSeek Harness 配置：${profileDir}（先打开一次 DeepSeek Harness）`)

if (cmd === 'on') {
  if (!existsSync(join(ROOT, 'dist', 'client.js'))) {
    spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--dev'], { stdio: 'inherit' })
  }
  if (currentSpec() !== `link:${ROOT}`) dshPlugin('add', `link:${ROOT}`)
  ensureBundle()
  ensureOwnDeps()
  // 改 profile patch 会让正在运行的 DeepSeek Harness 重新组合插件，换上链接过来的源码
  writeFileSync(patchFile, `${withoutDevBlock(readPatch()).replace(/\s*$/, '\n')}\n${devBlock()}`)
  console.log(`\n开发模式已开启（profile ${profile}）：插件直接用 ${ROOT}`)
  console.log('- 后端（src/host）存盘后自动重载；正在做的片子会先暂停，重载后点「继续」')
  console.log('- 前端：另开终端跑 npm run dev，改动会自动换进已打开的页面')
  console.log('- DeepSeek Harness 没在运行就打开它；已经开着的话一般几秒内生效，没生效就重启一次')
} else if (cmd === 'off') {
  const tgz = opt('tgz')
  const spec = tgz ? resolve(tgz) : `${PKG.name}@${opt('version') || 'latest'}`
  writeFileSync(patchFile, withoutDevBlock(readPatch()))
  dshPlugin('add', spec)
  ensureBundle()
  ensureOwnDeps()
  console.log(`\n已回到 ${tgz ? `本地包 ${spec}` : spec}（profile ${profile}），热重载关闭。重启 DeepSeek Harness 后生效。`)
} else if (cmd === 'status') {
  const spec = currentSpec()
  const dev = readPatch().includes(BEGIN)
  console.log(`profile：${profile}（${profileDir}）`)
  console.log(`插件来源：${spec ?? '没装'}`)
  console.log(`开发模式：${dev && spec === `link:${ROOT}` ? '开（链接本仓库 + 后端热重载）' : dev ? '部分开启（patch 在，但没链接本仓库）' : '关'}`)
} else {
  fail('用法：node scripts/dev-desktop.mjs on|off|status [--profile <名字>] [--tgz <文件>] [--version <版本>]')
}
