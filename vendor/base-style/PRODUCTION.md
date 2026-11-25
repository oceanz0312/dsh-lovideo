## Production

Each segment is drawn on its own from `scene.js` in the segment's folder. The page passes the segment
length and the canvas size; the same `scene.js` must draw at 1920 x 1080 (16:9) and 1080 x 1920 (9:16):
read `k.portrait` and place things for the canvas. Times are segment seconds (0 = first frame, `k.dur`
the end). Keep no state between frames and never use `Math.random` (use `K.rng(seed)`).

The voice-over and its subtitles are added by the platform; keep the bottom 14% of the frame free of
the style's own text, and do not write the narration on screen.

### Write the scene

```js
import * as K from '/engine/canvas.js'
const { prog, lerp, easeOut, easeInOut, snap, rng, clamp } = K

K.start(k => {
  const { W, H, g } = k
  return {
    draw(t) {
      k.bg(['#101820', '#24324a'])                 // a colour or a gradient
      const a = easeOut(prog(t, 0.2, 0.9))            // 0 -> 1 between 0.2 s and 0.9 s
      k.circle(lerp(-200, W * 0.5, a), H * 0.45, 140, '#f2c14e')
      k.text('Title', W / 2, H * 0.2, { size: 96, color: '#fff', alpha: prog(t, 0.6, 1.1) })
      k.grain(t, 0.05)
    },
  }
})
```

| Call on `k` | Draws |
| --- | --- |
| `bg(color \| [c1, c2, ...])` | fills the frame with a colour or a vertical gradient |
| `rect(x, y, w, h, color, r)` | a rectangle (r = corner radius) |
| `circle(x, y, r, color)` | a disc |
| `line(x0, y0, x1, y1, color, w)` | a rounded line |
| `text(str, x, y, {size, color, weight, align, font, alpha, maxWidth})` | text, centred vertically |
| `grain(t, amount)` | film grain |
| `vignette(strength)` | darkened corners |
| `g` | the raw CanvasRenderingContext2D for anything else (paths, gradients, transforms) |

Helpers from the module: `prog`, `lerp`, `clamp`, `easeOut`, `easeIn`, `easeInOut`, `snap`, `rng(seed)`, `FONT`.

### Render

```
lovideo-job render --unit <id> --clock unit --page '/index.html?seg={unit}&seconds={seconds}&w={width}&h={height}' \
  --mount /={skill}/assets/page --mount /p/={project} --mount /engine/={skill}/assets/engine
```

The page checks the scene at its first, middle and last frame before rendering; an error names the line to fix.
