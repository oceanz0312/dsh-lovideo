// 发版分两步，中间留给人在桌面版里按用户的装法验一遍（README「发版」）：
//
//   node scripts/release-github.mjs          第一步（npm run release）：构建界面、提交、只推 main
//   node scripts/release-github.mjs tag      第二步（npm run release:tag）：验过之后打 v<版本号> 标签并推送
//
// 推 main 之后，从 GitHub 装（填仓库地址，或固定到打印出来的那个提交）就能拿到新版，可以先验；
// npm 只在推 v* 标签时由 GitHub Actions 发出去（.github/workflows/publish-npm.yml），
// 所以没验过的版本不会先到 npm 用户手里。
//
// 第一步做的事：
//   1. 把已经提交的代码（git archive HEAD）导到临时目录，在那里构建界面（dist/client.js）。
//      只用提交过的代码构建，工作区里别的会话没提交的改动不会混进去。
//   2. 只把构建出的 dist/client.js 放进 git 暂存区并提交，推送 main。
//
// 从 GitHub 安装不会替你构建，所以 dist/client.js 必须在仓库里。开发时 `npm run dev` 会改写它，
// 本地用 skip-worktree 让 git 忽略这些开发版改动（脚本会自动设置），只有发版时才提交生产版。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tag = `v${pkg.version}`
const step = process.argv[2] || 'main'
const REPO = 'oceanz0312/dsh-lovideo'

if (!['main', 'tag'].includes(step)) throw new Error('用法：node scripts/release-github.mjs [tag]')
if (git('tag', '--list', tag)) throw new Error(`标签 ${tag} 已经有了：先把 package.json 的版本号加一并提交`)
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') throw new Error('请在 main 分支上发版')

/** 用 HEAD 提交过的代码在临时目录里构建，返回生产版 dist/client.js 的内容 */
function buildCommitted(tmp) {
  execFileSync('sh', ['-c', `git archive HEAD | tar -x -C "${tmp}"`], { cwd: root, stdio: 'inherit' })
  symlinkSync(join(root, 'node_modules'), join(tmp, 'node_modules'))
  execFileSync(process.execPath, [join(tmp, 'scripts', 'build.mjs')], { cwd: tmp, stdio: 'inherit' })
  return readFileSync(join(tmp, 'dist', 'client.js'))
}

const tmp = mkdtempSync(join(tmpdir(), 'dsh-lovideo-release-'))
try {
  if (step === 'main') {
    const built = buildCommitted(tmp)
    // 只提交构建产物（不碰工作区里的开发版 dist/client.js）
    const blob = join(tmp, 'client.js')
    writeFileSync(blob, built)
    const hash = execFileSync('git', ['hash-object', '-w', blob], { cwd: root, encoding: 'utf8' }).trim()
    git('update-index', '--add', '--cacheinfo', `100644,${hash},dist/client.js`)
    git('update-index', '--skip-worktree', 'dist/client.js')
    const changed = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).trim()
    if (changed && changed !== 'dist/client.js') throw new Error(`暂存区里还有别的文件，先处理掉再发版：\n${changed}`)
    if (changed) git('commit', '-m', `构建 ${tag} 的界面（dist/client.js）`)
    git('push', 'origin', 'main')
    const sha = git('rev-parse', 'HEAD')
    console.log(`\n已推送 main（${tag}，提交 ${sha.slice(0, 12)}），npm 还没发。`)
    console.log(`按 README「发版」第 4 步在桌面版里验：「插件 → 添加插件」填\n  https://github.com/${REPO}\n或固定到这个提交：github:${REPO}#${sha}`)
    console.log('验过之后运行 npm run release:tag：打标签，npm 随后自动发布')
  } else {
    // 标签要打在验过的那个提交上：本地 main 必须就是远端 main，而且里面的界面就是这份代码的生产版。
    // 中间又提交了东西、或者没跑第一步，都拦住，免得 GitHub 标签里的界面和 npm 包（prepack 重新构建）不一样
    git('fetch', 'origin', 'main', '--tags')
    if (git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) throw new Error(`远端已经有标签 ${tag}`)
    const head = git('rev-parse', 'HEAD')
    if (head !== git('rev-parse', 'origin/main')) throw new Error('本地 main 和 origin/main 不是同一个提交：先 npm run release 推送并验过，再打标签')
    const built = buildCommitted(tmp)
    if (!built.equals(execFileSync('git', ['show', 'HEAD:dist/client.js'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }))) {
      throw new Error('main 上的 dist/client.js 不是这份代码构建出来的：先跑 npm run release')
    }
    git('tag', '-a', tag, '-m', tag, head)
    git('push', 'origin', tag)
    console.log(`\n已推送标签 ${tag}，GitHub Actions 会把它发到 npm（仓库 Actions 页看结果）。`)
    console.log(`马上要用：github:${REPO}#${tag}；npm 上的 ${pkg.name}@${pkg.version} 要过 24 小时桌面版才装得到（原因见 README「发版」）`)
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
