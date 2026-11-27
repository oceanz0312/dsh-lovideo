// 新版本提醒：插件每次随 DeepSeek Harness 启动时，在后台去 npm 查一次有没有新版本，
// 界面在这次启动里弹一次提醒（刷新页面不重复弹），管理页顶部常驻一个「有新版本」的入口。
//
// - 只提醒发布满 24 小时的版本：DSH 自带的 pnpm 默认不装 24 小时内刚发布的版本（填确切版本号也一样），提早提醒用户也装不上。
// - npm 官方源和 npmmirror 同时问，谁先答用谁；都连不上就当没有新版本，不打扰用户。
// - 更新本身由用户在 DSH「插件」页点「更新」发起（官方规定装插件要用户在插件页明确发起），这里只判断能不能直接更新：
//   从 npm 包名装的可以；从 GitHub 地址、安装包地址装的不能，界面教用户移除后填包名重装。
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PLUGIN_ROOT } from './paths.js'

export const PKG = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'))
// 环境变量 LOVIDEO_REGISTRY 可以指定只问哪个源（公司内网的私有源，或本机测试用的假源）
const registries = () => (process.env.LOVIDEO_REGISTRY ? [process.env.LOVIDEO_REGISTRY.replace(/\/?$/, '/')] : ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/'])
export const RELEASE_AGE_MS = 24 * 60 * 60 * 1000

/** 这次启动的编号：界面按它判断「这次启动里提醒过没有」 */
export const START_ID = randomBytes(6).toString('hex')

/** 比较两个 x.y.z 版本号；预发布版不参与（返回 null） */
export function compareVersions(a, b) {
  const parse = v => (/^\d+\.\d+\.\d+$/.test(String(v)) ? String(v).split('.').map(Number) : null)
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

/**
 * 从 npm 的包信息里挑出能提醒的新版本：比当前版本新、不是预发布、没被弃用、发布满 24 小时，取最新的那个。
 * @returns {{ version: string, publishedAt: string, notes: { zh?: string, en?: string } | null } | null}
 */
export function pickUpdate(packument, current, now = Date.now()) {
  let best = null
  for (const [v, manifest] of Object.entries(packument?.versions || {})) {
    const newer = compareVersions(v, current)
    if (newer === null || newer <= 0 || manifest?.deprecated) continue
    const at = Date.parse(packument.time?.[v] || '')
    if (!Number.isFinite(at) || now - at < RELEASE_AGE_MS) continue
    if (best && compareVersions(v, best.version) <= 0) continue
    const notes = manifest?.lovideo?.whatsNew
    best = { version: v, publishedAt: new Date(at).toISOString(), notes: notes && typeof notes === 'object' ? notes : null }
  }
  return best
}

/**
 * 这份插件是怎么装的：看装它的 DSH 配置（profile）里 package.json 记的来源。
 * npm：填包名装的，插件页能一键更新；git：GitHub 地址；tarball：安装包地址或本地文件；dev：开发模式链接源码（不提醒）。
 */
export function installKind(spec) {
  if (typeof spec !== 'string' || !spec) return 'dev'
  if (/^(link|workspace|portal):/.test(spec)) return 'dev'
  if (/^(github:|gitlab:|bitbucket:|git\+|git:)/.test(spec) || /^https?:\/\/.*\.git(#.*)?$/.test(spec) || /^https:\/\/github\.com\//.test(spec)) return 'git'
  if (/^(https?:|file:)/.test(spec) || /\.tgz$/.test(spec)) return 'tarball'
  return 'npm'
}

/** 往上找装了这个插件的 profile 目录，读出依赖来源；找不到（开发模式链接源码）返回 null */
export function installSpec(root = PLUGIN_ROOT, name = PKG.name) {
  let dir = dirname(root)
  // pnpm 的两种布局：profile/node_modules/<包>，或 profile/node_modules/.pnpm/<包@版本>/node_modules/<包>
  for (let i = 0; i < 6; i++) {
    const file = join(dir, 'package.json')
    if (existsSync(file)) {
      try {
        const spec = JSON.parse(readFileSync(file, 'utf8')).dependencies?.[name]
        if (spec) return spec
      } catch {
        // 不是合法的 package.json，接着往上找
      }
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

async function fetchPackument(name) {
  // 两个源同时问，谁先答用谁；单个源 8 秒没答就放弃
  return Promise.any(registries().map(async base => {
    const res = await fetch(`${base}${encodeURIComponent(name)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }))
}

let checking = null

/** 这次启动查一次（之后都用这次的结果）；查不到就是没有新版本 */
export function checkUpdate() {
  checking ??= (async () => {
    const kind = installKind(installSpec())
    const base = { startId: START_ID, current: PKG.version, kind, update: null }
    if (kind === 'dev') return base
    try {
      return { ...base, update: pickUpdate(await fetchPackument(PKG.name), PKG.version) }
    } catch {
      return base
    }
  })()
  return checking
}
