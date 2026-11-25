// 插件自己的小控件。按 DSH 的要求只用宿主主题变量（--dsw-alias-*），不引用宿主的组件包；
// 类名一律 lv- 前缀，样式作为组件里的 <style> 渲染，卸载时一起移除。
import * as React from 'react'
import { fmtSec } from './api.js'

export const CSS = `
.lv{font-family:var(--dsw-font-family,system-ui);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.lv *{box-sizing:border-box}
.lv-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base));border-radius:var(--dsw-radius-md,12px);overflow:hidden}
.lv-card-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);min-height:42px}
.lv-card-title{font-weight:600;font-size:13.5px}
.lv-card-body{padding:12px 14px}
.lv-card-foot{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-card-fill)}
.lv-mark{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:5px;background:#111;flex:none}
.lv-mark svg{width:9px;height:9px}
.lv-muted{color:var(--dsw-alias-label-secondary)}
.lv-subtle{color:var(--dsw-alias-label-tertiary);font-size:12px}
.lv-mono{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-variant-numeric:tabular-nums}
.lv-row{display:flex;align-items:center;gap:8px}
.lv-grow{flex:1;min-width:0}
.lv-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lv-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l4);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background .15s}
.lv-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.lv-btn:disabled{opacity:.45;cursor:default}
a.lv-btn{text-decoration:none}
.lv-btn.pri{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}
.lv-btn.pri:hover{background:var(--dsw-alias-button-primary-hover)}
.lv-btn.ghost{border-color:transparent}
.lv-btn.sm{height:24px;padding:0 9px;font-size:12px}
.lv-btn.lg{height:34px;padding:0 16px;font-size:13.5px}
.lv-badge{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:999px;font-size:11.5px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.lv-badge.ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.lv-badge.warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}
.lv-badge.err{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.lv-badge.info{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.lv-bar{height:4px;border-radius:99px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}
.lv-bar>i{display:block;height:100%;background:var(--dsw-alias-state-business-primary);border-radius:99px;transition:width .4s}
.lv-media{position:relative;aspect-ratio:16/9;border-radius:8px;overflow:hidden;background:var(--dsw-alias-interactive-bg-hover)}
.lv-media.p{aspect-ratio:9/16}
.lv-media img,.lv-media video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.lv-media .lv-chip{position:absolute;left:6px;top:6px;font-size:11px;color:#fff;background:rgba(0,0,0,.55);border-radius:5px;padding:0 6px;line-height:18px}
.lv-media .lv-chip.r{left:auto;right:6px}
.lv-player{position:relative;border-radius:10px;overflow:hidden;background:#000}
.lv-player video{display:block;width:100%;max-height:420px;background:#000}
.lv-player.p video{max-height:520px}
.lv-cap{position:absolute;left:5%;right:5%;bottom:13%;text-align:center;pointer-events:none}
.lv-cap span{display:inline-block;color:#fff;font-weight:600;font-size:clamp(12px,2.2vw,20px);line-height:1.35;text-shadow:0 0 3px #000,0 1px 3px #000,0 0 1px #000;padding:0 4px}
.lv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--lv-min,200px),1fr));gap:16px 14px}
.lv-tile{cursor:pointer;border-radius:10px;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left}
.lv-tile:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:3px}
.lv-tile .lv-media{transition:box-shadow .15s}
.lv-tile:hover .lv-media{box-shadow:0 0 0 2px var(--dsw-alias-border-l4)}
.lv-tile.on .lv-media{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}
.lv-tile-title{font-weight:500;margin-top:7px;font-size:13px}
.lv-input,.lv-select{height:32px;width:100%;border-radius:8px;border:1px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base);color:inherit;font:inherit;padding:0 10px}
.lv-input:focus,.lv-select:focus{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,transparent);border-color:var(--dsw-alias-state-business-primary)}
.lv-field{display:flex;flex-direction:column;gap:5px}
.lv-field>label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.lv-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px;gap:2px}
.lv-seg button{height:26px;padding:0 12px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer}
.lv-seg button.on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:500}
.lv-scenes{display:flex;flex-direction:column}
.lv-scene{display:grid;grid-template-columns:22px 1fr auto;gap:4px 10px;padding:9px 14px;border-top:1px solid var(--dsw-alias-border-l2)}
.lv-scene:first-child{border-top:0}
.lv-scene .n{font-size:12px;color:var(--dsw-alias-label-tertiary);padding-top:1px}
.lv-scene .t{font-weight:500}
.lv-scene .d{grid-column:2/4;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.lv-scene .v{grid-column:2/4;font-size:12.5px}
.lv-scene .v::before{content:'“'}.lv-scene .v::after{content:'”'}
.lv-segs{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px}
.lv-empty{padding:40px 16px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.lv-spin{width:12px;height:12px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:lv-spin .8s linear infinite;display:inline-block}
@keyframes lv-spin{to{transform:rotate(360deg)}}
.lv-shimmer{animation:lv-pulse 1.4s ease-in-out infinite}
@keyframes lv-pulse{50%{opacity:.45}}
.lv-err{color:var(--dsw-alias-state-error-primary);font-size:12.5px}
.lv-code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:22px;letter-spacing:.25em;padding:10px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l4);text-align:center}
.lv-doctor{display:flex;flex-direction:column}
.lv-doctor>div{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l2)}
.lv-doctor>div:first-child{border-top:0;padding-top:0}
.lv-dot{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;flex:none;font-size:11px}
.lv-dot.ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 15%,transparent);color:var(--dsw-alias-state-success-primary)}
.lv-dot.no{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}
`

export function Styles() {
  return <style>{CSS}</style>
}

export function Mark() {
  return (
    <span className="lv-mark" aria-hidden>
      <svg viewBox="0 0 10 10"><path d="M2.5 1.2v7.6L9 5z" fill="#ff6b3d" /></svg>
    </span>
  )
}

export function Badge({ tone, children }) {
  return <span className={`lv-badge ${tone || ''}`}>{children}</span>
}

export function Bar({ value }) {
  return <div className="lv-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((value || 0) * 100)}><i style={{ width: `${Math.round((value || 0) * 100)}%` }} /></div>
}

export function Spin() {
  return <span className="lv-spin" aria-hidden />
}

/** 长得像按钮的外部链接：点击本身就是用户操作，桌面版和网页版都会交给系统浏览器 */
export function LinkButton({ kind, size, href, children }) {
  return (
    <a className={`lv-btn ${kind || ''} ${size || ''}`} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

export function Button({ kind, size, busy, children, ...rest }) {
  return (
    <button type="button" className={`lv-btn ${kind || ''} ${size || ''}`} disabled={busy || rest.disabled} {...rest}>
      {busy ? <Spin /> : null}
      {children}
    </button>
  )
}

/** 带字幕的播放器：字幕是成片时间线上的，叠在画面上显示（成片本身不烧字幕） */
export function Player({ src, poster, subtitles, hidden, portrait, autoPlay }) {
  const [t, setT] = React.useState(0)
  const cap = !hidden && (subtitles || []).find(s => t >= s.start && t < s.end)
  return (
    <div className={`lv-player ${portrait ? 'p' : ''}`}>
      <video src={src} poster={poster || undefined} controls playsInline preload="metadata" autoPlay={autoPlay}
        onTimeUpdate={e => setT(e.currentTarget.currentTime)} />
      {cap ? <div className="lv-cap"><span>{cap.text}</span></div> : null}
    </div>
  )
}

export function Media({ src, portrait, chip, chipRight, children, style }) {
  return (
    <div className={`lv-media ${portrait ? 'p' : ''}`} style={style}>
      {src ? <img src={src} alt="" loading="lazy" /> : null}
      {chip ? <span className="lv-chip">{chip}</span> : null}
      {chipRight ? <span className="lv-chip r">{chipRight}</span> : null}
      {children}
    </div>
  )
}

export const STATUS = {
  draft: ['分镜待确认', 'info'],
  producing: ['制作中', 'warn'],
  paused: ['已暂停', ''],
  done: ['已完成', 'ok'],
  failed: ['制作失败', 'err'],
}

export function StatusBadge({ status }) {
  const [label, tone] = STATUS[status] || [status, '']
  return <Badge tone={tone}>{label}</Badge>
}

export const STEP = { voicing: '配音中', preparing: '准备工程', drawing: '画画面', assembling: '拼成片', done: '完成', paused: '已暂停', failed: '失败' }
export const SEG = { wait: '排队', draw: '写画法', render: '渲染中', done: '', failed: '失败' }

export { fmtSec }
