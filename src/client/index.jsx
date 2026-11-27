// lovideo 插件的浏览器半边：侧栏「lovideo 视频」管理页，加上对话里每个 lovideo 工具的卡片。
import * as React from 'react'
import { TOOL_VIEWS } from './cards.jsx'
import { KIND, ToolRow, TurnCards, cardDefinition } from './turn-cards.jsx'
import { ManagePage } from './manage.jsx'
import { PANEL, host } from './host.js'
import { ToastOverlay } from './toast.jsx'
import { Mark } from './ui.jsx'
import { ComposerPopover, DurationChip, StyleChip } from './composer.jsx'
import { attachLocale, t } from './i18n.js'

function Icon({ size = 18 }) {
  return <Mark size={size} />
}

export const inject = ['slots']

/**
 * 一个会话的两件事：选的是哪个模式（agentPreset），会话还是不是空白的。
 * 宿主的 useSyncExternalStore 要求同样的情况返回同一个对象，所以缓存一份。
 */
function sessionFacts(binding) {
  const none = { preset: null, blank: false }
  if (!binding) return { getSnapshot: () => none, subscribe: () => () => {} }
  const face = binding.session.projections.faceOf('agentPreset')
  let cache = none
  const read = () => {
    const p = face.getSnapshot()
    const preset = typeof p === 'string' ? p : null
    const blank = Boolean(binding.session.getSnapshot?.()?.blank)
    if (cache.preset !== preset || cache.blank !== blank) cache = { preset, blank }
    return cache
  }
  return {
    getSnapshot: read,
    subscribe: fn => {
      const a = face.subscribe(fn)
      const b = typeof binding.session.subscribe === 'function' ? binding.session.subscribe(fn) : () => {}
      return () => {
        a()
        b()
      }
    },
  }
}

export function apply(ctx) {
  host.ctx = ctx
  // 界面字典注册到宿主的语言服务；侧栏标签每次渲染时按当前语言取
  attachLocale(ctx)
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 7, label: () => t('panel.label') }, Icon))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, ManagePage))
  // 全局提示条：登录成功、成片做好、导出完成等，在哪个页面都能看到
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-lovideo.toast' }, ToastOverlay))
  // 输入框里风格、片长的弹出层：工具栏在会裁切的容器里，弹出层画在全局浮层上
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-lovideo.composer-popover' }, ComposerPopover))
  // 过程区里的工具行只占一行；完整卡片挂在本轮末尾（不会被折叠）
  for (const tool of Object.keys(TOOL_VIEWS)) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: tool }, ToolRow))
  }
  ctx.inject(['uiConversation', 'sessions'], c => {
    c.effect(() => c.uiConversation.events.register(cardDefinition()), 'dsh-lovideo: conversation cards')
    // 「lovideo 导演」模式的输入框：会话选的模式和是不是空白会话，决定画不画风格、片长和下面的作品与风格墙（风格墙由风格选项画到输入框下面那一栏）
    const composerInject = sessionId => {
      const binding = c.sessions.binding(sessionId)
      return { lvSessionId: sessionId, hooks: { lvSession: sessionFacts(binding) } }
    }
    c.slots.inject('conversation.input.left', () => c.slots.register({ name: 'conversation.input.left', id: 'dsh-lovideo.style', order: 50, inject: composerInject }, StyleChip))
    c.slots.inject('conversation.input.left', () => c.slots.register({ name: 'conversation.input.left', id: 'dsh-lovideo.duration', order: 51, inject: composerInject }, DurationChip))
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
