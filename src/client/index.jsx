// lovideo 插件的浏览器半边：侧栏「lovideo 视频」管理页，加上对话里每个 lovideo 工具的卡片。
import * as React from 'react'
import { TOOL_VIEWS } from './cards.jsx'
import { KIND, ToolRow, TurnCards, cardDefinition } from './turn-cards.jsx'
import { ManagePage } from './manage.jsx'
import { PANEL, host } from './host.js'
import { ToastOverlay } from './toast.jsx'

function Icon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M10 9.2v5.6l4.6-2.8z" fill="currentColor" stroke="none" />
    </svg>
  )
}

const LABEL = { zh: 'lovideo 视频', en: 'lovideo video' }

export const inject = ['slots']

export function apply(ctx) {
  host.ctx = ctx
  // 每次渲染时读宿主当前语言；没有 locale 服务时看页面语言
  const lang = () => {
    let active = ''
    try {
      active = String(ctx.get?.('locale')?.getSnapshot?.()?.active || '')
    } catch {
      active = ''
    }
    return /^zh/i.test(active || document.documentElement.lang || navigator.language) ? 'zh' : 'en'
  }
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 7, label: () => LABEL[lang()] }, Icon))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, ManagePage))
  // 全局提示条：登录成功、成片做好、导出完成等，在哪个页面都能看到
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-lovideo.toast' }, ToastOverlay))
  // 过程区里的工具行只占一行；完整卡片挂在本轮末尾（不会被折叠）
  for (const tool of Object.keys(TOOL_VIEWS)) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: tool }, ToolRow))
  }
  ctx.inject(['uiConversation', 'sessions'], c => {
    c.effect(() => c.uiConversation.events.register(cardDefinition()), 'dsh-lovideo: conversation cards')
    c.slots.inject('conversation.chat.turnTail', () => c.slots.register({
      name: 'conversation.chat.turnTail',
      id: 'dsh-lovideo',
      inject: sessionId => {
        const binding = c.sessions.binding(sessionId)
        if (binding === undefined) throw new Error(`dsh-lovideo: unknown session ${sessionId}`)
        const chat = c.uiConversation.binding(binding).target('chat')
        return {
          keyedHooks: {
            cards: turn => {
              const snapshot = chat.getSnapshot()
              if (snapshot === undefined) throw new Error('dsh-lovideo: Chat target is unavailable')
              return snapshot.nodes.turnDataSource(Number(turn), KIND)
            },
          },
        }
      },
    }, TurnCards))
  })
}
