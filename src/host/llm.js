// 调模型：用用户在 DeepSeek Harness 里选的模型（ctx.llm），插件自己不存模型密钥。
// 用户可以在 lovideo 设置里给制作单独指定一个模型，默认跟随 DSH 当前模型。
import { randomUUID } from 'node:crypto'
import { readSettings } from './settings.js'

export const SESSION_ID = `dsh-lovideo-${randomUUID()}`

let hostCtx = null
export function bindLlm(ctx) {
  hostCtx = ctx
}

function selection(ctx) {
  const pinned = readSettings().model
  if (pinned) return pinned
  try {
    const s = ctx.get('agentDefaultModel')?.currentSelection()
    return s?.provider && s?.model ? { provider: s.provider, model: s.model } : null
  } catch {
    return null
  }
}

export function modelInfo() {
  const ctx = hostCtx
  if (!ctx || !ctx.get('llm')) return null
  const s = selection(ctx)
  return s ? { ...s, label: s.model } : null
}

/** 列出 DSH 里已经配好的模型，给设置页选 */
export async function listModels() {
  const llm = hostCtx?.get('llm')
  if (!llm) return []
  const out = []
  try {
    for (const p of await llm.listProviders()) {
      const id = p.id ?? p
      try {
        for (const m of await llm.listModels(id)) out.push({ provider: id, model: m.id ?? m, label: m.label ?? m.name ?? m.id ?? m })
      } catch {
        // 某个服务商列不出来就跳过
      }
    }
  } catch {
    // 老版本没有这两个接口
  }
  return out
}

export const usage = { calls: 0, inputTokens: 0, outputTokens: 0 }

/**
 * 调一次模型，返回完整文本。
 * @param {{system:string, user:string, maxTokens?:number, signal?:AbortSignal, onText?:(d:string)=>void}} req
 */
export async function callModel({ system, user, maxTokens = 16000, signal, onText, light = false }) {
  const ctx = hostCtx
  const llm = ctx?.get('llm')
  const info = modelInfo()
  if (!llm || !info) throw new Error('DeepSeek Harness 里还没有可用的模型')
  // 写画面代码、写风格规则不需要长思考：用最低一档推理，免得思考把输出长度用光
  const call = await llm.prepareCall({ provider: info.provider, model: info.model, maxTokens }, signal, (controls, model) => {
    const effort = light ? model?.reasoning?.efforts?.[0]?.id : undefined
    return effort === undefined ? controls : { ...controls, reasoningEffort: effort }
  })
  let text = ''
  let reasoning = 0
  let finish = null
  usage.calls++
  for await (const chunk of call.stream({
    ...call.config,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'dsh-lovideo' } }],
    sessionId: SESSION_ID,
    signal,
  })) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
      onText?.(chunk.text)
    } else if (chunk.type === 'usage') {
      usage.inputTokens += chunk.usage?.inputTokens ?? chunk.inputTokens ?? 0
      usage.outputTokens += chunk.usage?.outputTokens ?? chunk.outputTokens ?? 0
    } else if (chunk.type === 'reasoning-delta') {
      reasoning += (chunk.text || '').length
    } else if (chunk.type === 'finish') {
      finish = chunk.reason?.kind ?? null
      if (['error', 'aborted'].includes(finish)) throw new Error(chunk.reason.failure?.message || '模型调用失败')
    }
  }
  if (!text.trim()) {
    throw new Error(reasoning ? `模型只输出了思考过程、没有给出内容（结束原因：${finish || '未知'}），可能是长度上限不够` : `模型没有输出内容（结束原因：${finish || '未知'}）`)
  }
  return { text, model: info.label, finish }
}

/** 从模型输出里取 JSON：容忍外面包了代码块或前后有说明 */
export function extractJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.search(/[{[]/)
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'))
  if (start < 0 || end < start) throw new Error('模型没有返回 JSON')
  return JSON.parse(body.slice(start, end + 1))
}

/**
 * 从模型输出里取文件：
 *   === FILE: scene.js ===
 *   ...内容...
 *   === END ===
 * 比 JSON 更适合大段代码（不用转义）。
 */
export function extractFiles(text) {
  const files = []
  const re = /^=== FILE:\s*(.+?)\s*===\s*\n([\s\S]*?)\n=== END ===/gm
  let m
  while ((m = re.exec(text))) files.push({ path: m[1].trim(), content: m[2].replace(/^```[a-z]*\n/, '').replace(/\n```\s*$/, '') })
  return files
}
