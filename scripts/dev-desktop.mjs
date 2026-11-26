// 让 DeepSeek Harness 桌面版（或任意 profile）直接跑这份源码，并打开热重载。
//
//   npm run dev:desktop             开发模式：profile 链接到本仓库，后端源码改了自动重载
//   npm run dev                     另开一个终端：客户端改了自动重新打包，页面自动换上新的
//   npm run dev:desktop:off         回到 GitHub 上发布的版本，和用户的装法一样（默认 main 最新）
//   npm run dev:desktop:off -- --version v0.2.0   换成 GitHub 上某个版本标签
//   npm run dev:desktop:off -- --tgz <文件>   换成本地打的包
//
// 换插件来源一律走这个脚本：它会同时关掉后端热重载。只换依赖、不关热重载时，DeepSeek Harness
// 仍会从本仓库的 src/host 加载后端，而 pnpm 换掉链接依赖时又会删掉本仓库的 node_modules，
// 后端就找不到 puppeteer-core 等依赖，制作直接失败。
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
const GITHUB = 'github:oceanz0312/dsh-lovideo'

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

/**
 * 删掉开发模式那一段：只删两行标记和我们自己写的 hmr 条目。
 * DSH 或用户后来往标记中间加的配置（比如模型服务商）原样留下，不能跟着删。
 */
function withoutDevBlock(text) {
  const a = text.indexOf(BEGIN)
  const b = text.indexOf(END)
  if (a < 0 || b < 0) return text
  const inner = text.slice(a + BEGIN.length, b).replace(devEntry(), '').replace(/^\n+/, '')
  return (text.slice(0, a) + inner + text.slice(b + END.length)).replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')
}

/** 打开 base 组合里的 hmr，监听插件后端源码；客户端的热重载由 DSH 轮询 dist/client.js 完成 */
function devEntry() {
  const host = join(ROOT, 'src', 'host').replace(/\\/g, '/')
  return `- id: hmr\n  config:\n    root:\n      - ${JSON.stringify(host)}\n`
}

function devBlock() {
  return `${BEGIN}\n${devEntry()}${END}\n`
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

/**
 * 0.3.x 及以前包名叫 dsh-lovideo，0.4.0 起改成 @oceanz0312/dsh-lovideo。
 * profile 里留着旧名字的依赖或 bundle 时，DeepSeek Harness 会因为找不到旧包而整个配置加载失败，所以先清掉。
 */
const LEGACY = 'dsh-lovideo'
function dropLegacy() {
  if (PKG.name === LEGACY) return
  const m = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const bundles = m.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.includes(LEGACY)) {
    m.dsh.profile.bundles = bundles.filter(b => b !== LEGACY)
    writeFileSync(manifestFile, `${JSON.stringify(m, null, 2)}\n`)
  }
  if (m.dependencies?.[LEGACY]) dshPlugin('remove', LEGACY)
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
  dropLegacy()
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
  const version = opt('version')
  // 发版走 GitHub（见 README「发版」），用户也是从 GitHub 装的
  const spec = tgz ? resolve(tgz) : `${GITHUB}${version ? `#${version}` : ''}`
  // 先关热重载，再换依赖：顺序反过来的话，换依赖的那一刻后端会从已经没有依赖的源码目录重新加载
  writeFileSync(patchFile, withoutDevBlock(readPatch()))
  dropLegacy()
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
  if (dev && spec !== `link:${ROOT}`) {
    console.log('  ↳ 这个状态会出错：后端仍从本仓库加载，用的却不是装好的插件。运行 npm run dev:desktop:off 切干净')
  }
} else {
  fail('用法：node scripts/dev-desktop.mjs on|off|status [--profile <名字>] [--tgz <文件>] [--version <版本>]')
}
