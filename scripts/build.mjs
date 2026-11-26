// 打包浏览器半边：src/client → dist/client.js（DSH 的 __ModuleLoader__ 格式，React 用宿主的）。
import { build, context } from 'esbuild'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = (await import(join(root, 'package.json'), { with: { type: 'json' } })).default
mkdirSync(join(root, 'dist'), { recursive: true })

const options = {
  entryPoints: [join(root, 'src/client/index.jsx')],
  outfile: join(root, 'dist/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  // React 和宿主的界面组件（Toast 等）都用 DeepSeek Harness 自带的
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  legalComments: 'none',
  minify: !process.argv.includes('--dev'),
  banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:(require)=>{const module={exports:{}};const exports=module.exports;` },
  footer: { js: 'return module.exports}})' },
  logLevel: 'info',
  // 自己写文件：先写临时文件再改名，DeepSeek Harness 轮询到的永远是完整的 bundle（热重载时不会读到半个文件）
  write: false,
  plugins: [{
    name: 'atomic-write',
    setup(b) {
      b.onEnd(result => {
        for (const f of result.outputFiles || []) {
          writeFileSync(`${f.path}.tmp`, f.contents)
          renameSync(`${f.path}.tmp`, f.path)
        }
      })
    },
  }],
}

if (process.argv.includes('--watch')) {
  const ctx = await context(options)
  await ctx.watch()
} else {
  await build(options)
}
