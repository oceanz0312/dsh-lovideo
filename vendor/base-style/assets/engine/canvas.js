// 通用画布引擎：蒸馏出来的「我的风格」都用它作画。一段 = 一个 scene.js，按段内秒数 t 画一帧，不保留帧间状态。
//
//   import * as K from '/engine/canvas.js'
//   K.start(k => ({ draw(t) { ... } }))
//
// k：W、H（画布尺寸）、portrait、dur（段长秒）、g（CanvasRenderingContext2D）、seg、params，以及下面的画图方法。
const q = new URLSearchParams(location.search);
const W = Number(q.get("w")) || 1920;
const H = Number(q.get("h")) || 1080;
const DUR = Number(q.get("seconds")) || 5;

export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
/** t 在 a..b 之间从 0 走到 1 */
export const prog = (t, a, b) => clamp((t - a) / Math.max(1e-6, b - a));
export const lerp = (a, b, p) => a + (b - a) * p;
export const easeOut = p => 1 - Math.pow(1 - p, 3);
export const easeIn = p => p * p * p;
export const easeInOut = p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
/** 先冲过头再回弹 */
export const snap = p => {
  const c = 1.70158 + 1;
  return p <= 0 ? 0 : 1 + c * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2);
};
/** 固定种子的随机数（不要用 Math.random，否则每帧画的不一样） */
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC",sans-serif';

export function start(make) {
  const canvas = document.getElementById("out");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d");
  const k = {
    W, H, portrait: H > W, dur: DUR, g, seg: q.get("seg"),
    /** 整张铺底色（可以是渐变：传 [色1, 色2]） */
    bg(color) {
      if (Array.isArray(color)) {
        const gr = g.createLinearGradient(0, 0, W * 0.3, H);
        color.forEach((c, i) => gr.addColorStop(i / Math.max(1, color.length - 1), c));
        g.fillStyle = gr;
      } else g.fillStyle = color;
      g.fillRect(0, 0, W, H);
    },
    rect(x, y, w, h, color, r = 0) {
      g.fillStyle = color;
      g.beginPath();
      g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h);
      g.fill();
    },
    circle(x, y, r, color) {
      g.fillStyle = color;
      g.beginPath();
      g.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
      g.fill();
    },
    line(x0, y0, x1, y1, color, w = 6) {
      g.strokeStyle = color;
      g.lineWidth = w;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    },
    /** 写字：{size, color, weight, align, font, alpha, maxWidth} */
    text(str, x, y, o = {}) {
      g.save();
      g.globalAlpha = o.alpha ?? 1;
      g.fillStyle = o.color || "#fff";
      g.textAlign = o.align || "center";
      g.textBaseline = "middle";
      g.font = `${o.weight || 600} ${o.size || 72}px ${o.font || FONT}`;
      g.fillText(String(str), x, y, o.maxWidth);
      g.restore();
    },
    /** 胶片颗粒：amount 0..1 */
    grain(t, amount = 0.06) {
      const r = rng(Math.floor(t * 24) + 7);
      g.save();
      g.globalAlpha = amount;
      for (let i = 0; i < 1400; i++) {
        g.fillStyle = r() > 0.5 ? "#fff" : "#000";
        g.fillRect(r() * W, r() * H, 2, 2);
      }
      g.restore();
    },
    /** 暗角 */
    vignette(strength = 0.45) {
      const gr = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
      gr.addColorStop(0, "rgba(0,0,0,0)");
      gr.addColorStop(1, `rgba(0,0,0,${strength})`);
      g.fillStyle = gr;
      g.fillRect(0, 0, W, H);
    },
  };
  let scene;
  try {
    scene = make(k);
    if (!scene || typeof scene.draw !== "function") throw new Error("K.start 的回调要返回 { draw(t) }");
    // 启动自检：段首、段中、段尾都能画
    for (const t of [0, DUR / 2, Math.max(0, DUR - 1 / 30)]) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      scene.draw(t);
    }
  } catch (e) {
    window.BOOT_ERROR = `scene.js: ${e.message}`;
    return;
  }
  window.render = t => {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.clearRect(0, 0, W, H);
    scene.draw(Math.min(t, DUR));
  };
  window.READY = true;
}
