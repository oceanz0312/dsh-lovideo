// lovideo 卡片挂在每一轮对话的末尾（conversation.chat.turnTail），和 DSH 自己的「计划」卡片同一个做法：
// 工具调用在过程区里会被折叠，卡片放在轮次末尾才能一直看得到。
// 卡片数据只从会话记录里已有的 tool/call、tool/result 事件派生，不写新的事件类型。
import * as React from 'react'
import { TOOL_VIEWS } from './cards.jsx'

export const KIND = 'lovideo-card'

const isOurs = name => typeof name === 'string' && Object.prototype.hasOwnProperty.call(TOOL_VIEWS, name)

function record(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 一次 lovideo 工具调用 → 一张轮次末尾的卡片 */
export function cardDefinition() {
  // 已经见过的本插件调用（结果事件里没有工具名，靠 callId 认）
  const ours = new Map()
  return {
    kind: KIND,
    target: 'chat',
    match: event => {
      const d = event.data
      if (!record(d)) return null
      if (event.type === 'tool/call' && isOurs(d.name) && typeof d.callId === 'string') {
        ours.set(d.callId, d.name)
        return { id: d.callId, role: 'start' }
      }
      if (event.type === 'tool/result' && record(d.message)) {
        const id = d.message.toolCallId
        if (typeof id === 'string' && ours.has(id)) return { id, role: 'update' }
      }
      return null
    },
    start: (_context, match) => {
      const d = match.event.data
      return { callId: d.callId, name: d.name, argsRaw: typeof d.arguments === 'string' ? d.arguments : '', result: null }
    },
    update: (context, match) => {
      const d = match.event.data
      if (match.event.type !== 'tool/result' || !context.state) return context.state
      const content = Array.isArray(d.message.content) ? d.message.content : []
      return { ...context.state, result: { content, isError: Boolean(d.message.isError || d.isError) } }
    },
    buildViewNode: context => {
      const start = context.start ?? context.matches[0]
      if (!start || !context.state) return null
      return {
        key: context.key, kind: KIND, id: context.id, target: 'chat',
        anchorSeq: start.event.seq, location: start.location, visibility: 'hidden', data: context.state,
      }
    },
  }
}

/** 把派生出的数据还原成工具卡片需要的 props（和 tool.call.toolview 一样的形状） */
function asToolProps(card) {
  if (card.result) {
    return { phase: 'result', toolName: card.name, callId: card.callId, block: { kind: 'result', callId: card.callId, content: card.result.content, isError: card.result.isError, call: { argsRaw: card.argsRaw } } }
  }
  return { phase: 'start', toolName: card.name, callId: card.callId, block: { callId: card.callId, argsRaw: card.argsRaw } }
}

/** 轮次末尾：这一轮所有 lovideo 卡片，按调用顺序 */
export function TurnCards({ turn, useCards }) {
  const cards = useCards(String(turn.turn))
  if (!cards || !cards.length) return null
  // 同一轮里多次查环境、多次列风格时只留最后一张
  const seen = new Set()
  const list = [...cards].reverse().filter(c => {
    if (c.name !== 'lovideo_setup' && c.name !== 'lovideo_styles') return true
    if (seen.has(c.name)) return false
    seen.add(c.name)
    return true
  }).reverse()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '4px 0 8px' }} data-lovideo-cards>
      {list.map(c => {
        const View = TOOL_VIEWS[c.name]
        return View ? <View key={c.callId} {...asToolProps(c)} /> : null
      })}
    </div>
  )
}

const LABELS = {
  lovideo_setup: '检查这台电脑', lovideo_configure: '配置配音配乐', lovideo_styles: '挑风格', lovideo_plan: '出分镜', lovideo_produce: '开拍',
  lovideo_revise: '修改成片', lovideo_export: '导出', lovideo_works: '找作品', lovideo_distill: '蒸馏风格',
}

/** 过程区里的工具行：一行字，完整卡片在本轮末尾 */
export function ToolRow(props) {
  const settled = props.phase === 'result'
  const failed = settled && props.block.isError
  const label = LABELS[props.toolName] || props.toolName
  return (
    <div className="lv" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--dsw-alias-label-tertiary)', padding: '2px 0' }}>
      <svg width="13" height="13" viewBox="0 0 10 10" aria-hidden><rect width="10" height="10" rx="2.5" fill="#111" /><path d="M3.3 2.4v5.2L8 5z" fill="#ff6b3d" /></svg>
      <span>lovideo · {label}</span>
      <span>{failed ? '· 没成功' : settled ? '' : '…'}</span>
    </div>
  )
}
