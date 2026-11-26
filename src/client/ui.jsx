// 插件自己的小控件。按 DSH 的要求只用宿主主题变量（--dsw-alias-*），不引用宿主的组件包；
// 类名一律 lv- 前缀，样式作为组件里的 <style> 渲染，卸载时一起移除。
import * as React from 'react'
import { fmtSec } from './api.js'

export const CSS = `
.lv-switch{position:relative;flex:none;width:32px;height:18px;border-radius:999px;border:0;padding:0;cursor:pointer;background:var(--dsw-alias-border-l4,rgba(0,0,0,.2));transition:background-color var(--lv-dur) var(--lv-ease)}
.lv-switch i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform var(--lv-dur) var(--lv-ease)}
.lv-switch.on{background:var(--dsw-alias-label-primary,#111)}
.lv-switch.on i{transform:translateX(14px)}
.lv-switch:disabled{cursor:default;opacity:.55}
.lv-switch.busy i{animation:lv-pulse 0.9s var(--lv-ease) infinite alternate}
@keyframes lv-pulse{from{opacity:1}to{opacity:.35}}
.lv-opts{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}
.lv-opt{display:flex;align-items:center;gap:12px;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l2)}
.lv-opt:first-child{border-top:0}
.lv-opt>.k{flex:none;width:34px;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.lv-opt>.v{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.lv-opt>.v b{font-weight:500;font-size:13px}
.lv-opt.off>.v{opacity:.6}
.lv-dur{flex:none;display:flex;align-items:center;gap:10px;width:min(280px,45%)}
.lv-dur input{flex:1;min-width:0;height:18px;margin:0;appearance:none;-webkit-appearance:none;background:transparent;cursor:pointer}
.lv-dur input:disabled{cursor:default;opacity:.5}
.lv-dur input::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:linear-gradient(to right,var(--dsw-alias-label-primary) var(--p),var(--dsw-alias-border-l4) var(--p))}
.lv-dur input::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;margin-top:-6px;border-radius:50%;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l4);box-shadow:0 1px 3px rgba(0,0,0,.2);transition:transform var(--lv-fast) var(--lv-ease)}
.lv-dur input:active::-webkit-slider-thumb{transform:scale(1.15)}
.lv-dur input:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 30%,transparent)}
.lv-dur-v{width:64px;text-align:right;font-variant-numeric:tabular-nums;font-size:12.5px;font-weight:500}
.lv-tile:disabled{cursor:default}
.lv-switches{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.lv-warn-text{color:var(--dsw-alias-state-warn-primary,#b26a00)}
.lv-switches label{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.lv,.lv-page,.lv-modal{--lv-ease:var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1));--lv-ease-out:cubic-bezier(.16,1,.3,1);--lv-fast:var(--ds-transition-duration-fast,.1s);--lv-dur:var(--ds-transition-duration,.2s);--lv-slow:var(--ds-transition-duration-slow,.3s)}
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
.lv-col{display:flex;flex-direction:column;gap:8px}
.lv-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lv-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l4);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background-color var(--lv-dur) var(--lv-ease),border-color var(--lv-dur) var(--lv-ease),color var(--lv-dur) var(--lv-ease),opacity var(--lv-dur) var(--lv-ease),transform var(--lv-fast) var(--lv-ease)}
.lv-btn:active:not(:disabled){transform:scale(.96)}
.lv-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.lv-btn:disabled{opacity:.45;cursor:default}
a.lv-btn{text-decoration:none}
.lv-btn.pri{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}
.lv-btn.pri:hover{background:var(--dsw-alias-button-primary-hover)}
.lv-btn.ghost{border-color:transparent}
.lv-btn.sm{height:24px;padding:0 9px;font-size:12px}
.lv-btn.lg{height:34px;padding:0 16px;font-size:13.5px}
.lv-badge{transition:background-color var(--lv-slow) var(--lv-ease),color var(--lv-slow) var(--lv-ease);display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:999px;font-size:11.5px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.lv-badge.ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.lv-badge.warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}
.lv-badge.err{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.lv-badge.info{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.lv-bar{height:4px;border-radius:99px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}
.lv-bar>i{display:block;height:100%;background:var(--dsw-alias-state-business-primary);border-radius:99px;transition:width var(--lv-slow) var(--lv-ease-out)}
.lv-media{position:relative;aspect-ratio:16/9;border-radius:8px;overflow:hidden;background:var(--dsw-alias-interactive-bg-hover)}
.lv-media.p{aspect-ratio:9/16}
.lv-media img,.lv-media video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;transition:transform var(--lv-slow) var(--lv-ease-out)}
.lv-media .lv-chip{position:absolute;left:6px;top:6px;z-index:2;font-size:11px;color:#fff;background:rgba(0,0,0,.55);border-radius:5px;padding:0 6px;line-height:18px}
.lv-media .lv-chip.r{left:auto;right:6px}
.lv-media .lv-hv{z-index:1;pointer-events:none;background:#000;opacity:0;transition:opacity var(--lv-dur) var(--lv-ease)}
.lv-media .lv-hv.on{opacity:1}
.lv-player{position:relative;border-radius:10px;overflow:hidden;background:#000}
.lv-player video{display:block;width:100%;max-height:420px;background:#000}
.lv-speed{position:absolute;top:8px;right:8px;height:24px;min-width:40px;padding:0 9px;border:0;border-radius:999px;background:rgba(0,0,0,.55);color:#fff;font:inherit;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;cursor:pointer;opacity:.75;transition:opacity var(--lv-dur) var(--lv-ease),background-color var(--lv-dur) var(--lv-ease),transform var(--lv-fast) var(--lv-ease)}
.lv-player:hover .lv-speed,.lv-speed:focus-visible{opacity:1}
.lv-speed:hover{background:rgba(0,0,0,.75)}
.lv-speed:active{transform:scale(.94)}
.lv-player.p video{max-height:520px}
.lv-cap{position:absolute;left:5%;right:5%;bottom:13%;text-align:center;pointer-events:none}
.lv-cap span{display:inline-block;color:#fff;font-weight:600;font-size:clamp(12px,2.2vw,20px);line-height:1.35;text-shadow:0 0 3px #000,0 1px 3px #000,0 0 1px #000;padding:0 4px}
.lv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--lv-min,200px),1fr));gap:16px 14px}
.lv-tile{cursor:pointer;border-radius:10px;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left}
.lv-tile:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:3px}
.lv-tile .lv-media{transition:box-shadow var(--lv-dur) var(--lv-ease),transform var(--lv-dur) var(--lv-ease-out)}
.lv-tile:hover .lv-media{box-shadow:0 0 0 2px var(--dsw-alias-border-l4),0 6px 16px -8px rgba(0,0,0,.25);transform:translateY(-2px)}
.lv-tile:hover .lv-media img{transform:scale(1.03)}
.lv-tile:active .lv-media{transform:translateY(0) scale(.99)}
.lv-tile.on .lv-media{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}
.lv-tile-title{font-weight:500;margin-top:7px;font-size:13px}
.lv-input,.lv-select{height:32px;width:100%;border-radius:8px;border:1px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base);color:inherit;font:inherit;padding:0 10px}
.lv-input,.lv-select{transition:border-color var(--lv-dur) var(--lv-ease),box-shadow var(--lv-dur) var(--lv-ease)}
.lv-input:focus,.lv-select:focus{outline:0;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 25%,transparent);border-color:var(--dsw-alias-state-business-primary)}
.lv-field{display:flex;flex-direction:column;gap:5px}
.lv-field>label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.lv-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px;gap:2px}
.lv-seg button{transition:background-color var(--lv-dur) var(--lv-ease),color var(--lv-dur) var(--lv-ease);height:26px;padding:0 12px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer}
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
.lv-seg-tile{all:unset;display:block;width:100%;cursor:pointer;border-radius:8px}
.lv-seg-tile:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.lv-seg-tile .lv-media{transition:box-shadow var(--lv-dur) var(--lv-ease),transform var(--lv-dur) var(--lv-ease-out)}
.lv-seg-tile:hover .lv-media{transform:translateY(-1px);box-shadow:0 0 0 2px var(--dsw-alias-border-l4)}
.lv-seg-tile.on .lv-media{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}
.lv-seg-tile .lv-play{position:absolute;inset:0;display:grid;place-items:center;opacity:0;background:rgba(0,0,0,.25);transition:opacity var(--lv-dur) var(--lv-ease)}
.lv-seg-tile:hover .lv-play,.lv-seg-tile.on .lv-play{opacity:1}
.lv-play i{width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.92);display:grid;place-items:center}
.lv-play i::before{content:'';margin-left:3px;border-left:10px solid #111;border-top:6px solid transparent;border-bottom:6px solid transparent}
.lv-preview{display:flex;flex-direction:column;gap:6px;animation:lv-in var(--lv-slow) var(--lv-ease-out)}
.lv-empty{padding:40px 16px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.lv-spin{width:12px;height:12px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:lv-spin .8s linear infinite;display:inline-block}
@keyframes lv-spin{to{transform:rotate(360deg)}}
.lv-shimmer{animation:lv-pulse 1.4s ease-in-out infinite}
@keyframes lv-pulse{50%{opacity:.45}}
.lv-err{color:var(--dsw-alias-state-error-primary);font-size:12.5px;animation:lv-in var(--lv-dur) var(--lv-ease-out)}
.lv-enter{animation:lv-in var(--lv-slow) var(--lv-ease-out)}
@keyframes lv-in{from{opacity:0;transform:translateY(4px)}}
@keyframes lv-fade{from{opacity:0}}
@keyframes lv-pop{from{opacity:0;transform:translateY(6px) scale(.97)}}
.lv-modal{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:24px;background:rgba(0,0,0,.32);animation:lv-fade var(--lv-dur) var(--lv-ease)}
.lv-modal.out{opacity:0;transition:opacity var(--lv-dur) var(--lv-ease)}
.lv-dialog{width:min(380px,100%);border-radius:14px;padding:20px 20px 16px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l2);box-shadow:0 20px 50px -12px rgba(0,0,0,.35);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,system-ui);font-size:13px;line-height:1.55;animation:lv-pop var(--lv-slow) var(--lv-ease-out)}
.lv-modal.out .lv-dialog{transform:translateY(4px) scale(.98);transition:transform var(--lv-dur) var(--lv-ease)}
.lv-dialog h3{margin:0 0 6px;font-size:15px;font-weight:600}
.lv-dialog p{margin:0;color:var(--dsw-alias-label-secondary)}
.lv-dialog .acts{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
.lv-btn.danger{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:#fff}
.lv-btn.danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 88%,#000)}
@media (prefers-reduced-motion:reduce){.lv *,.lv-page *,.lv-modal,.lv-modal *{animation:none!important;transition:none!important}}
.lv-code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:22px;letter-spacing:.25em;padding:10px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l4);text-align:center}
.lv-doctor{display:flex;flex-direction:column}
.lv-doctor>div{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l2)}
.lv-doctor>div:first-child{border-top:0;padding-top:0}
.lv-dot{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;flex:none;font-size:11px}
.lv-dot{transition:background-color var(--lv-slow) var(--lv-ease),color var(--lv-slow) var(--lv-ease)}
.lv-dot.ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 15%,transparent);color:var(--dsw-alias-state-success-primary)}
.lv-dot.no{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}
`

/**
 * 对话框：淡入、轻微弹出；Esc、点空白处都算取消；打开时焦点放在第一个按钮（通常是「取消」）上，免得误按回车。
 * 关闭时先播放淡出再卸载。actions 是底部按钮，从左到右。
 */
export function Dialog({ open, title, children, actions, onCancel }) {
  const [shown, setShown] = React.useState(open)
  const [leaving, setLeaving] = React.useState(false)
  const box = React.useRef(null)
  React.useEffect(() => {
    if (open) {
      setShown(true)
      setLeaving(false)
      return undefined
    }
    if (!shown) return undefined
    setLeaving(true)
    const t = setTimeout(() => setShown(false), 180)
    return () => clearTimeout(t)
  }, [open])
  React.useEffect(() => {
    if (!open) return undefined
    box.current?.querySelector('.acts button, .acts a')?.focus()
    const onKey = e => e.key === 'Escape' && onCancel?.()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])
  if (!shown) return null
  return (
    <div className={`lv-modal ${leaving ? 'out' : ''}`} onMouseDown={e => e.target === e.currentTarget && onCancel?.()}>
      <Styles />
      <div ref={box} className="lv-dialog" role="alertdialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {children}
        <div className="acts">{actions}</div>
      </div>
    </div>
  )
}

/** 确认对话框：「取消」+ 一个确认按钮 */
export function ConfirmDialog({ open, title, children, confirmText = '确定', danger, busy, onConfirm, onCancel }) {
  return (
    <Dialog open={open} title={title} onCancel={onCancel} actions={<>
      <button type="button" className="lv-btn" onClick={onCancel}>取消</button>
      <button type="button" className={`lv-btn ${danger ? 'danger' : 'pri'}`} disabled={busy} onClick={onConfirm}>{busy ? <Spin /> : null}{confirmText}</button>
    </>}>
      {children}
    </Dialog>
  )
}

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

/** 开关：busy 时转圈且不能点 */
export function Switch({ checked, onChange, disabled, busy, label }) {
  return (
    <button type="button" role="switch" aria-checked={Boolean(checked)} aria-label={label} disabled={disabled || busy}
      className={`lv-switch ${checked ? 'on' : ''} ${busy ? 'busy' : ''}`} onClick={() => onChange(!checked)}>
      <i />
    </button>
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
/* ---------- 倍速：和 lovideo 网站一样五档，点一下换下一档 ---------- */

export const PLAYER_RATES = [0.5, 1, 1.5, 2, 3]
// 同一页面里换片子时沿用上次选的倍速
let lastRate = 1

/** 倍速状态：把倍速设到给定的几个媒体元素上（视频，以及要跟着一起变速的配音） */
export function usePlaybackRate(...refs) {
  const [rate, setRate] = React.useState(lastRate)
  const apply = React.useCallback(() => {
    for (const r of refs) if (r.current) r.current.defaultPlaybackRate = r.current.playbackRate = rate
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rate])
  React.useEffect(apply, [apply])
  const next = () => {
    const at = PLAYER_RATES.indexOf(rate)
    const r = at < 0 ? 1 : PLAYER_RATES[(at + 1) % PLAYER_RATES.length]
    lastRate = r
    setRate(r)
  }
  return { rate, next, apply }
}

export function SpeedButton({ rate, onNext }) {
  return <button type="button" className="lv-speed" title="播放速度（点一下换一档）" onClick={onNext}>{rate}×</button>
}

export function Player({ src, poster, subtitles, hidden, portrait, autoPlay }) {
  const [t, setT] = React.useState(0)
  const video = React.useRef(null)
  const speed = usePlaybackRate(video)
  // 成片换了新版本（比如切了配音、配乐开关重新拼过）：接着原来的位置和播放状态，不从头播
  const last = React.useRef({ src, time: 0, playing: false })
  const loaded = e => {
    speed.apply()
    const v = e.currentTarget
    if (last.current.src !== src) {
      if (last.current.time > 0) v.currentTime = Math.min(last.current.time, Math.max(0, (v.duration || 0) - 0.1))
      if (last.current.playing) v.play().catch(() => {})
      last.current.src = src
    }
  }
  const cap = !hidden && (subtitles || []).find(s => t >= s.start && t < s.end)
  return (
    <div className={`lv-player ${portrait ? 'p' : ''}`}>
      <video ref={video} src={src} poster={poster || undefined} controls playsInline preload="metadata" autoPlay={autoPlay}
        onLoadedMetadata={loaded}
        onPlay={() => (last.current.playing = true)} onPause={e => { if (!e.currentTarget.ended && e.currentTarget.src.endsWith(last.current.src || '')) last.current.playing = false }}
        onTimeUpdate={e => { setT(e.currentTarget.currentTime); last.current.time = e.currentTarget.currentTime }} />
      {cap ? <div className="lv-cap"><span>{cap.text}</span></div> : null}
      <SpeedButton rate={speed.rate} onNext={speed.next} />
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
