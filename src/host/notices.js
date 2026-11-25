// 给页面的一次性提示（Toast）：登录成功、环境准备好、成片做好、导出完成，以及它们失败的时候。
// 只推给当时开着的页面，不存、不重放；页面据此弹一条提示，具体内容仍以卡片和管理页为准。
import { EventEmitter } from 'node:events'

export const notices = new EventEmitter()

/**
 * 发一条提示。
 * @param {{ kind: string, tone: 'success' | 'warning', text: string, workId?: string, sessionId?: string | null, path?: string }} notice
 */
export function notify(notice) {
  notices.emit('notice', notice)
}
