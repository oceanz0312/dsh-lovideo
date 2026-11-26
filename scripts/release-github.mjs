// 发版到 GitHub：用户在 DeepSeek Harness「添加插件」里填仓库地址就能装（不走 npm）。
//
//   node scripts/release-github.mjs          用 package.json 里的版本号
//
// 做的事：
//   1. 把已经提交的代码（git archive HEAD）导到临时目录，在那里构建界面（dist/client.js）。
//      只用提交过的代码构建，工作区里别的会话没提交的改动不会混进去。
//   2. 只把构建出的 dist/client.js 放进 git 暂存区并提交，打 v<版本号> 标签，推送 main 和标签。
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

if (git('tag', '--list', tag)) throw new Error(`标签 ${tag} 已经有了：先把 package.json 的版本号加一并提交`)
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') throw new Error('请在 main 分支上发版')

// 1. 用提交过的代码构建
const tmp = mkdtempSync(join(tmpdir(), 'dsh-lovideo-release-'))
try {
  execFileSync('sh', ['-c', `git archive HEAD | tar -x -C "${tmp}"`], { cwd: root, stdio: 'inherit' })
  symlinkSync(join(root, 'node_modules'), join(tmp, 'node_modules'))
  execFileSync(process.execPath, [join(tmp, 'scripts', 'build.mjs')], { cwd: tmp, stdio: 'inherit' })
  const built = readFileSync(join(tmp, 'dist', 'client.js'))

  // 2. 只提交构建产物（不碰工作区里的开发版 dist/client.js）
  const blob = join(tmp, 'client.js')
  writeFileSync(blob, built)
  const hash = execFileSync('git', ['hash-object', '-w', blob], { cwd: root, encoding: 'utf8' }).trim()
  git('update-index', '--add', '--cacheinfo', `100644,${hash},dist/client.js`)
  git('update-index', '--skip-worktree', 'dist/client.js')
  const changed = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).trim()
  if (changed && changed !== 'dist/client.js') throw new Error(`暂存区里还有别的文件，先处理掉再发版：\n${changed}`)
  if (changed) git('commit', '-m', `构建 ${tag} 的界面（dist/client.js）`)
  git('tag', '-a', tag, '-m', tag)
  git('push', 'origin', 'main', tag)
  console.log(`\n已发布 ${tag}。用户在 DeepSeek Harness「插件 → 添加插件」里填：\n  https://github.com/oceanz0312/dsh-lovideo\n要装指定版本：github:oceanz0312/dsh-lovideo#${tag}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
