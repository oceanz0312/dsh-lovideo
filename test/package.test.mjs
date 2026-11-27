// 发到 npm 之前的产物检查：界面打包格式对不对、包里装没装齐、清单写没写对。
// GitHub Actions 发 npm 前会跑这个文件；本机 npm test 也会跑，几秒就完。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('界面打包成 DSH 的 __ModuleLoader__ 格式，id 就是包名', t => {
  // 构建到临时目录：工作区里的 dist/client.js 是开发版（skip-worktree），不能被测试改写
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-lovideo-package-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  // 后缀用 .cjs：.js 在没有 package.json 的目录里会被 Node 按 ESM 语法自动识别，--check 就查不出 export
  const out = join(tmp, 'client.cjs')
  execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs'), '--out', out], { cwd: root, stdio: 'pipe' })
  const code = readFileSync(out, 'utf8')

  // 官方约定：客户端注册的 id 必须等于包名，否则 DSH 找不到这个插件的界面
  assert.ok(code.startsWith(`window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},`), `开头不对：${code.slice(0, 80)}`)
  // DSH 把它当普通脚本执行：顶层出现 import / export 声明就是语法错误，整个界面加载不出来
  assert.doesNotThrow(() => new vm.Script(code, { filename: 'client.js' }), '产物里有顶层 import/export')
  execFileSync(process.execPath, ['--check', out], { stdio: 'pipe' })
})

test('npm 包里装齐了运行要用的文件，不带测试和开发脚本', () => {
  // --ignore-scripts：不跑 prepack，免得改写工作区的 dist/client.js；文件清单和真正打包时一样
  const json = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })
  const files = new Set(JSON.parse(json)[0].files.map(f => f.path.replace(/\\/g, '/')))
  const has = p => files.has(p)

  for (const p of ['package.json', 'cordis.patch.yml', 'dist/client.js', 'icon.svg', 'docs/DETAIL.md', 'locale/en.json', 'locale/zh.json', 'vendor/tts/worker.py']) {
    assert.ok(has(p), `包里少了 ${p}`)
  }
  // 清单里指向的文件都要在包里：入口、各个 exports、patch、图标
  const targets = [pkg.main, pkg.icon, pkg.dsh.bundle.patch, ...Object.values(pkg.exports).filter(v => !v.includes('*'))]
  for (const p of targets) assert.ok(has(p.replace(/^\.\//, '')), `package.json 指向的 ${p} 不在包里`)
  for (const lang of ['en', 'zh']) {
    const detail = JSON.parse(readFileSync(join(root, 'locale', `${lang}.json`), 'utf8')).meta?.detail
    if (detail) assert.ok(has(detail), `locale/${lang}.json 的 meta.detail（${detail}）不在包里`)
  }

  // 后端、Skill、vendor 是按目录整个运行的：仓库里有的每个文件都要打进去
  const tracked = execFileSync('git', ['ls-files', 'src/host', 'skills', 'vendor'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  assert.ok(tracked.some(p => p.startsWith('skills/')) && tracked.some(p => p.startsWith('vendor/jianying/')), 'git ls-files 没读到文件')
  const missing = tracked.filter(p => !has(p))
  assert.deepEqual(missing, [], `这些文件没打进包：\n${missing.join('\n')}`)

  const unwanted = [...files].filter(p => /^(test|\.github|scripts|src\/client|node_modules)\//.test(p) || p.endsWith('.tgz'))
  assert.deepEqual(unwanted, [], `这些文件不该进包：\n${unwanted.join('\n')}`)
})

test('package.json：声明支持的 DSH 版本，DSH 自己的包不装进依赖', () => {
  // 没有 engines.dsh，DSH 不会在安装时挡住不兼容的版本
  assert.equal(typeof pkg.engines?.dsh, 'string')
  assert.ok(pkg.engines.dsh.trim(), 'engines.dsh 是空的')
  // @deepseek-ai/* 由运行中的 DSH 提供；装进 dependencies 会多一份副本，和宿主的实例对不上
  const own = Object.keys(pkg.dependencies || {}).filter(n => n.startsWith('@deepseek-ai/'))
  assert.deepEqual(own, [], `这些 DSH 包不该写在 dependencies 里：${own.join(', ')}`)
})
