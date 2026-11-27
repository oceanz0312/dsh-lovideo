// 给页面的一次性提示（Toast）：登录成功、环境准备好、成片做好、导出完成，以及它们失败的时候。
// 只推给当时开着的页面，不存、不重放；页面据此弹一条提示，具体内容仍以卡片和管理页为准。
import { EventEmitter } from 'node:events'

export const notices = new EventEmitter()

/**
 * 发一条提示。页面按 kind 和参数（title、format、error、email）用界面语言拼文字；text 是中文原文，页面不认识这个 kind 时显示它。
 * @param {{ kind: string, tone: 'success' | 'warning', text: string, title?: string | null, format?: string, error?: string, email?: string | null, workId?: string, sessionId?: string | null, path?: string }} notice
 */
export function notify(notice) {
  notices.emit('notice', notice)
}
