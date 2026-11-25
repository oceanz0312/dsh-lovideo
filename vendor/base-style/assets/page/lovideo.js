// 给渲染器的 window.lovideo（和网站风格包同一个页面合同）：引擎启动段（window.READY，或 window.BOOT_ERROR），
// 通过 window.render(t) 画段内第 t 秒。
(() => {
  let fps = 30;
  window.lovideo = {
    ready(film) {
      fps = film.fps;
      return new Promise((resolve, reject) => {
        const poll = () => {
          if (window.BOOT_ERROR) reject(new Error(window.BOOT_ERROR));
          else if (window.READY === true) resolve();
          else setTimeout(poll, 50);
        };
        poll();
      });
    },
    seek: frame => window.render(frame / fps),
    assert() {
      if (window.BOOT_ERROR) throw new Error(window.BOOT_ERROR);
      return window.READY === true;
    },
  };
})();
