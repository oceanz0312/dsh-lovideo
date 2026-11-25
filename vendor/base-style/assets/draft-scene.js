// 草稿：能直接渲染的一段（标题卡片 + 几样形状入场、段尾收场）。制作时模型在它的基础上按风格改写；
// 模型几次都没写对时，用它兜底，保证片子能做完。
import * as K from '/engine/canvas.js'
const { prog, lerp, easeOut, snap, rng } = K

const q = new URLSearchParams(location.search)

K.start(k => {
  const { W, H } = k
  const r = rng(7)
  const dots = Array.from({ length: 9 }, () => ({ x: r(), y: r(), s: 0.4 + r() * 0.8, d: r() * 0.6 }))
  const title = q.get('title') || ''
  return {
    draw(t) {
      k.bg(['#1f2a2e', '#2f3e44'])
      for (const p of dots) {
        const a = easeOut(prog(t, 0.2 + p.d, 0.8 + p.d))
        k.circle(p.x * W, lerp(H * 1.2, p.y * H * 0.8, a), 26 * p.s * (k.portrait ? 1.2 : 1), '#e9d8a6')
      }
      const s = snap(prog(t, 0.3, 0.9))
      const w = Math.min(W * 0.72, 1100)
      const y = lerp(-H * 0.3, H * 0.42, s)
      k.rect(W / 2 - w / 2, y - 90, w, 180, '#f4efe3', 18)
      if (title) k.text(title, W / 2, y, { size: k.portrait ? 72 : 84, color: '#1f2a2e', weight: 700, maxWidth: w - 60 })
      const out = prog(t, k.dur - 0.6, k.dur)
      if (out > 0) k.rect(0, 0, W, H, `rgba(0,0,0,${out * 0.6})`)
      k.grain(t, 0.04)
    },
  }
})
