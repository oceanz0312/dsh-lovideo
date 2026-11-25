// lovideo 插件的 Host 半边（Node 里运行）：
//   - 导演用的工具（lovideo_*），注册在根上，所有预设都能用；「lovideo 导演」预设见 cordis.patch.yml
//   - 随包的 lovideo-director skill（导演的做法）
//   - /lovideo/api/*：管理页和对话卡片的接口
// 浏览器半边（管理页、对话卡片）在 src/client，打包成 dist/client.js。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_ROOT } from './paths.js'
import { bindLlm } from './llm.js'
import { TOOLS, notifyDone, notifyLogin } from './tools.js'
import { loginEvents } from './site.js'
import { BASE, route } from './routes.js'
import { events, listWorks } from './works.js'
import { markInterrupted, pauseAllProductions } from './produce.js'
import { closeBrowser } from './render.js'
import { readFrontmatter } from './styles.js'

export const name = 'dsh-lovideo'
export const inject = ['webServer', 'connection', 'tools', 'skills']

const SKILL_DIR = join(PLUGIN_ROOT, 'skills', 'lovideo-director')

function skillProvider() {
  const file = join(SKILL_DIR, 'SKILL.md')
  const read = () => {
    const text = readFileSync(file, 'utf8')
    const fm = readFrontmatter(text)
    return { name: fm.name, description: fm.description, text }
  }
  const candidate = s => ({
    name: s.name, description: s.description, path: file, invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled', provider: 'dsh-lovideo', rank: 600, locator: SKILL_DIR, resourceBase: { kind: 'directory', path: SKILL_DIR },
  })
  return {
    name: 'dsh-lovideo',
    async list() {
      return existsSync(file) ? [candidate(read())] : []
    },
    async get(c) {
      if (!existsSync(file)) return undefined
      const s = read()
      if (c.name !== s.name) return undefined
      const { rank, locator, ...summary } = candidate(s)
      return { ...summary, content: s.text.replace(/^---[\s\S]*?---\n/, '') }
    },
  }
}

/** Web 服务不替插件鉴权：每个请求先过 connection 的检查，拿不到鉴权服务一律拒绝 */
function rejection(ctx, req) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') return 403
  return connection.requestRejection({ headers: req.headers })
}

export function apply(ctx) {
  bindLlm(ctx)
  for (const tool of TOOLS) ctx.tools.register(tool)
  ctx.effect(() => ctx.skills.registerProvider(skillProvider))

  // 上次没做完的片子标成暂停；之后做完时通知导演
  markInterrupted(listWorks()).catch(() => {})
  const last = new Map(listWorks().map(w => [w.id, w.status]))
  const onChange = ({ id, work }) => {
    const prev = last.has(id) ? { status: last.get(id) } : null
    last.set(id, work?.status ?? null)
    if (prev && work) notifyDone(prev, work, ctx)
  }
  events.on('change', onChange)
  // 网站确认登录后，叫醒因为没登录卡住的导演接着做
  const onLogin = account => notifyLogin(account, ctx)
  loginEvents.on('login', onLogin)
  ctx.effect(() => () => {
    events.off('change', onChange)
    loginEvents.off('login', onLogin)
    // 热重载时旧代码不能在后台接着做：先暂停，新代码起来后可以「继续」
    pauseAllProductions()
    closeBrowser()
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    handler: async (req, res) => {
      try {
        const reject = rejection(ctx, req)
        if (reject) {
          res.statusCode = reject
          res.setHeader('content-type', 'application/json; charset=utf-8')
          return res.end(JSON.stringify({ error: '未授权' }))
        }
        await route(req, res)
      } catch (err) {
        if (res.headersSent) return res.end()
        res.statusCode = err.status || 500
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: err.message, code: err.code }))
      }
    },
  }), 'dsh-lovideo: /lovideo/api routes')
}
