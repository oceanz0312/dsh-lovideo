// 打包浏览器半边：src/client → dist/client.js（DSH 的 __ModuleLoader__ 格式，React 用宿主的）。
import { build, context } from 'esbuild'
import { mkdirSync } from 'node:fs'
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
  external: ['react'],
  legalComments: 'none',
  minify: !process.argv.includes('--dev'),
  banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:(require)=>{const module={exports:{}};const exports=module.exports;` },
  footer: { js: 'return module.exports}})' },
  logLevel: 'info',
}

if (process.argv.includes('--watch')) {
  const ctx = await context(options)
  await ctx.watch()
} else {
  await build(options)
}
