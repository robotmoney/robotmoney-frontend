// Shared Alpine lifecycle for p5-backed components. Retaining the retry timer
// prevents a sketch from starting in detached DOM after a route change.
export function p5Lifecycle() {
  return {
    _p5: null,
    _p5Timer: null,
    _p5Destroyed: false,
    init() {
      this._p5Destroyed = false;
      const host = this.$el;
      host.innerHTML = '<div class="hero-art__canvas" style="position:absolute;inset:0"></div>';
      const container = host.firstElementChild;
      const startWhenReady = () => {
        if (this._p5Destroyed) return;
        if (window.p5) this._start(container);
        else this._p5Timer = setTimeout(startWhenReady, 50);
      };
      startWhenReady();
    },
    destroy() {
      this._p5Destroyed = true;
      clearTimeout(this._p5Timer);
      this._p5Timer = null;
      if (this._p5) {
        this._p5.remove();
        this._p5 = null;
      }
    },
  };
}
