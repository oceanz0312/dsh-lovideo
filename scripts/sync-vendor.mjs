// 把网站仓库里的剪映导出器原样拷进 vendor/jianying（见 docs/PROTOCOL.md 第 5 条）。
// 用法：npm run sync-vendor -- <lovideo 网站包目录>（网站仓库是私有的，需要能访问它的本地检出）
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (!process.argv[2]) {
  console.error('用法：npm run sync-vendor -- <lovideo 网站包目录>')
  process.exit(1)
}
const site = resolve(process.argv[2])
const src = join(site, 'workers', 'sandbox', 'job')
if (!existsSync(join(src, 'timeline_export.py'))) {
  console.error(`没找到网站的导出器：${src}`)
  process.exit(1)
}
const FILES = [
  'timeline_export.py', 'export_media.py', 'jianying_v2.py', 'jianying_validate.py', 'effects_runtime.py',
  'adapters/jianying/jianying_map.py', 'effects', 'jianying_install',
]
const out = join(root, 'vendor', 'jianying')
rmSync(out, { recursive: true, force: true })
for (const f of FILES) cpSync(join(src, f), join(out, f), { recursive: true, filter: p => !p.includes('__pycache__') })
console.log(`已从 ${src} 同步 ${FILES.length} 项到 vendor/jianying`)
