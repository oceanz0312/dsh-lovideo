// 改片：不做时间线编辑器，用户在对话里说一句，导演调用这些操作。
//   trim      把某一镜裁短（秒）
//   move      把某一镜挪到第几个
//   caption   改某一镜的字幕
//   subtitles 字幕整体显示 / 隐藏（播放和导出 MP4、剪映都照它；不用重新拼成片）
//   redraw    让导演重画某一镜（只重做这一段，其余不动）
// 前四种只改时间线、马上重新拼一遍成片（几秒）；redraw 在后台重做这一段。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir } from './paths.js'
import { requireWork, updateWork, workDir } from './works.js'
import { SWITCHES, assembleFilm, buildTimeline, captionCues, normalizeTimeline, syncSwitches, trackOf } from './assemble.js'
import { startProduction } from './produce.js'
import { generateMusic } from './music.js'
import { readSettings } from './settings.js'

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
  let showSubs = null
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
      // 一镜的字幕按句子分成几条；改字幕时在原来那段时间里重新按句子切开
      const mine = subs.clips.filter(x => x.of === sid)
      if (!mine.length) throw Object.assign(new Error(`第 ${n} 镜没有字幕`), { status: 400 })
      const text = String(op.text || '').trim().slice(0, 200)
      const from = Math.min(...mine.map(x => x.start))
      const to = Math.max(...mine.map(x => x.start + x.dur))
      subs.clips = [...subs.clips.filter(x => x.of !== sid), ...captionCues(text, from, to - from, sid)].sort((a, b) => a.start - b.start)
      done.push(`第 ${n} 镜字幕改成「${text}」`)
    } else if (op.op === 'subtitles') {
      if (subs) subs.hidden = op.show === false
      showSubs = op.show !== false
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
    if (showSubs !== null) w.subtitles = { ...(w.subtitles || {}), enabled: showSubs }
    w.edits = [...(w.edits || []), { at: new Date().toISOString(), ops: done }].slice(-50)
    return w
  })
  if (redraw.length) {
    await startProduction(id, { redraw })
    return { work: requireWork(id), done, background: true }
  }
  // 只切字幕显示：字幕不烧进成片（播放时叠上去、导出时按开关烧），不用重新拼
  if (ops.every(op => op.op === 'subtitles')) return { work: requireWork(id), done, background: false }
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

/* ---------- 成片下面的配音、配乐、字幕开关 ---------- */

// 同一部作品同时只重拼一次；后来的开关等前一次拼完再按最新状态拼
const remixing = new Map()

/**
 * 切换成片的配音 / 配乐 / 字幕：关掉就不播放、不进成片、不进导出。
 * 字幕只改时间线；配音、配乐混在成片里，要按开关重新拼一遍（几秒）。
 * 打开配乐而这部片子还没有配乐时，先按导演写的描述生成一首（后台进行）。
 * 拼成功才存开关；失败时开关不变、原成片不动。
 */
export async function setSwitches(id, patch = {}) {
  const work = requireWork(id)
  if (!work.timeline || !work.film) throw Object.assign(new Error('成片还没做好，做好后再切换'), { status: 409 })
  if (work.status === 'producing') throw Object.assign(new Error('还在制作中，等这一轮做完再切换'), { status: 409 })
  // 现在的状态以时间线为准：没有这条轨道就算关着（比如配乐没做成）
  const now = k => Boolean(trackOf(work.timeline, k) && !trackOf(work.timeline, k).hidden)
  const keys = Object.keys(SWITCHES).filter(k => typeof patch[k] === 'boolean' && now(k) !== patch[k])
  if (!keys.length) return requireWork(id)
  const needMusic = patch.music === true && !trackOf(work.timeline, 'music')
  // 只动字幕：改时间线就行
  if (keys.every(k => k === 'subtitles')) {
    return updateWork(id, w => {
      w.subtitles = { ...(w.subtitles || {}), enabled: patch.subtitles }
      w.choices = { ...(w.choices || {}), subtitles: patch.subtitles }
      syncSwitches(w.timeline, w)
      w.timeline.version = (w.timeline.version || 1) + 1
      return w
    })
  }
  if (remixing.has(id)) throw Object.assign(new Error('正在按上一个开关重新拼成片，稍等几秒再切'), { status: 409 })
  const task = (async () => {
    await updateWork(id, w => ((w.remix = { keys, state: needMusic ? 'music' : 'mixing', error: null }), w))
    try {
      const next = structuredClone(requireWork(id))
      for (const k of keys) next[k] = { ...(next[k] || {}), enabled: patch[k] }
      if (needMusic) {
        // 片子还没有配乐：按导演写的描述做一首，长度对上成片
        const file = join('music', 'bgm.wav')
        ensureDir(join(workDir(id), 'music'))
        const settings = readSettings()
        if (settings.music.provider === 'none') throw new Error('设置里选了不配乐，先在 lovideo 设置的「配乐」里选一个来源')
        const r = await generateMusic({ brief: next.music?.brief, mood: next.music?.mood || next.music?.brief || 'gentle instrumental background music, warm, unobtrusive', seconds: next.film.duration, out: join(workDir(id), file), settings })
        next.music = { ...next.music, file, seconds: r.seconds, model: r.model, source: settings.music.provider }
      }
      // 时间线上补出配乐轨（新做的配乐），再按开关打 hidden
      const tl = structuredClone(next.timeline)
      if (needMusic) {
        const fresh = buildTimeline(next)
        const bgm = fresh.tracks.find(t => t.role === 'bgm')
        if (bgm) {
          tl.assets = { ...tl.assets, bgm: fresh.assets.bgm }
          tl.tracks.push(bgm)
        }
      }
      syncSwitches(tl, next)
      tl.version = (tl.version || 1) + 1
      await updateWork(id, w => ((w.remix = { keys, state: 'mixing', error: null }), w))
      const film = await assembleFilm(id, tl)
      return updateWork(id, w => {
        for (const k of keys) {
          w[k] = { ...(w[k] || {}), enabled: patch[k] }
          w.choices = { ...(w.choices || {}), [k]: patch[k] }
        }
        if (needMusic) w.music = { ...w.music, file: next.music.file, seconds: next.music.seconds, model: next.music.model, source: next.music.source }
        w.timeline = tl
        w.film = film
        w.remix = null
        return w
      })
    } catch (err) {
      await updateWork(id, w => ((w.remix = { keys, state: 'failed', error: err.message.slice(0, 200) }), w)).catch(() => {})
      throw err
    } finally {
      remixing.delete(id)
    }
  })()
  remixing.set(id, task)
  // 生成配乐要一会儿：先返回，卡片看 work.remix 显示进度；只重拼几秒，等它拼完再返回
  if (needMusic) {
    task.catch(() => {})
    return requireWork(id)
  }
  return task
}
