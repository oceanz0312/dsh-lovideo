// 改片：不做时间线编辑器，用户在对话里说一句，导演调用这些操作。
//   trim      把某一镜裁短（秒）
//   move      把某一镜挪到第几个
//   caption   改某一镜的字幕
//   subtitles 字幕整体显示 / 隐藏（导出时用）
//   redraw    让导演重画某一镜（只重做这一段，其余不动）
// 前四种只改时间线、马上重新拼一遍成片（几秒）；redraw 在后台重做这一段。
import { requireWork, updateWork } from './works.js'
import { assembleFilm, normalizeTimeline } from './assemble.js'
import { startProduction } from './produce.js'

/** 「第 2 镜」「shot-2」「2」都能认出来 */
function sceneId(work, ref) {
  const scenes = work.plan.scenes
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) return scenes[Number(ref) - 1]?.id
  return scenes.find(s => s.id === ref)?.id
}

export async function reviseFilm(id, ops = []) {
  const work = requireWork(id)
  if (!work.timeline || !work.film) throw Object.assign(new Error('成片还没做好，做好后再改'), { status: 409 })
  if (work.status === 'producing') throw Object.assign(new Error('还在制作中，等这一轮做完再改'), { status: 409 })
  if (!Array.isArray(ops) || !ops.length) throw Object.assign(new Error('没有要改的内容'), { status: 400 })
  const tl = structuredClone(work.timeline)
  const scene = tl.tracks.find(t => t.type === 'scene')
  const subs = tl.tracks.find(t => t.type === 'subtitle')
  const redraw = []
  const done = []
  const segs = new Map(work.job.segments.map(s => [s.id, s]))
  for (const op of ops) {
    const sid = op.scene !== undefined ? sceneId(work, op.scene) : null
    const clip = sid && scene.clips.find(c => c.sceneId === sid)
    const n = sid ? work.plan.scenes.findIndex(s => s.id === sid) + 1 : 0
    if (op.op !== 'subtitles' && !clip) throw Object.assign(new Error(`找不到第 ${op.scene} 镜`), { status: 400 })
    if (op.op === 'trim') {
      const full = segs.get(sid).frames / work.job.fps
      const sec = Math.max(1, Math.min(full, Number(op.seconds)))
      if (!Number.isFinite(sec)) throw Object.assign(new Error('trim 要给 seconds'), { status: 400 })
      clip.dur = Math.round(sec * 1000) / 1000
      done.push(`第 ${n} 镜改成 ${clip.dur.toFixed(1)} 秒`)
    } else if (op.op === 'move') {
      const order = [...scene.clips].sort((a, b) => a.start - b.start)
      const from = order.indexOf(clip)
      const to = Math.max(0, Math.min(order.length - 1, Number(op.to) - 1))
      order.splice(from, 1)
      order.splice(to, 0, clip)
      // 用小数 start 排好顺序，normalizeTimeline 再首尾相接
      const old = new Map(order.map(c => [c.sceneId, c.start]))
      order.forEach((c, i) => (c.start = i + c.start / 1e6))
      for (const t of tl.tracks) if (t.type !== 'scene') for (const c of t.clips) if (c.of && old.has(c.of)) c.start = c.start - old.get(c.of) + scene.clips.find(x => x.sceneId === c.of).start
      done.push(`第 ${n} 镜挪到第 ${to + 1} 个`)
    } else if (op.op === 'caption') {
      if (!subs) throw Object.assign(new Error('这部片子没有字幕'), { status: 400 })
      const c = subs.clips.find(x => x.of === sid)
      if (!c) throw Object.assign(new Error(`第 ${n} 镜没有字幕`), { status: 400 })
      c.text = String(op.text || '').trim().slice(0, 200)
      done.push(`第 ${n} 镜字幕改成「${c.text}」`)
    } else if (op.op === 'subtitles') {
      if (subs) subs.hidden = op.show === false
      done.push(op.show === false ? '隐藏字幕' : '显示字幕')
    } else if (op.op === 'redraw') {
      redraw.push({ scene: sid, brief: String(op.brief || '').slice(0, 1000) })
      done.push(`重画第 ${n} 镜${op.brief ? `：${op.brief}` : ''}`)
    } else throw Object.assign(new Error(`不认识的操作 ${op.op}`), { status: 400 })
  }
  normalizeTimeline(tl)
  tl.version = (tl.version || 1) + 1
  await updateWork(id, w => {
    w.timeline = tl
    w.edits = [...(w.edits || []), { at: new Date().toISOString(), ops: done }].slice(-50)
    return w
  })
  if (redraw.length) {
    await startProduction(id, { redraw })
    return { work: requireWork(id), done, background: true }
  }
  await updateWork(id, w => ((w.status = 'producing'), (w.job.state = 'assembling'), w))
  try {
    const film = await assembleFilm(id, tl)
    await updateWork(id, w => ((w.film = film), (w.status = 'done'), (w.job.state = 'done'), w))
  } catch (err) {
    await updateWork(id, w => ((w.status = 'done'), (w.job.state = 'done'), (w.job.error = `重新拼接失败：${err.message}`), w))
    throw err
  }
  return { work: requireWork(id), done, background: false }
}
