// 测试用的假模型：和真的制作会话一样只用 draw 工具。
// 从第一条消息里找出准备好的草稿 scene.js（「Draft it wrote, as it is now, …」或「Current …」），
// 加上 suffix 原样交回；被退回（比如画面不动）就再交一次。
export function fakeSegmentLlm(suffix = '') {
  return {
    async prepareCall() {
      return {
        config: {},
        async *stream({ messages }) {
          const first = messages[0].content.map(b => b.text || '').join('\n')
          const m = /(?:Draft it wrote, as it is now,|Current) (\/work\/proj\/[^\s:]+\/scene\.js):\n```js\n([\s\S]*?)\n```/.exec(first)
          const args = m ? { files: [{ path: m[1], content: `${m[2]}${suffix}` }] } : { files: [] }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `call-${messages.length}`, name: 'draw', arguments: JSON.stringify(args) } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        },
      }
    },
  }
}
