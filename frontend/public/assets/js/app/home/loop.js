// Drives the home hero (RM-175): steps and draws while the stage is on screen
// and the tab is visible; under reduced motion, seeks one moment and holds it.
// Returns a stop() that undoes every observer and listener it added, because
// the router swaps views without reloading the page.

/**
 * @param {{ ready: Promise<boolean>, resize(): void, step(dt: number): void, draw(): void,
 *           seek(t: number): void, pointer(x: number | null, y?: number): void }} scene
 * @param {{ stage: HTMLElement, host: HTMLElement, stillAt: number, reduce: boolean }} o
 */
export function runHero(scene, { stage, host, stillAt, reduce }) {
  let raf = 0, visible = true, last = performance.now(), stopped = false, started = false;
  const frame = (/** @type {number} */ now) => {
    raf = 0;
    if (stopped) return;
    scene.step(Math.min(0.05, Math.max(0, (now - last) / 1000)));
    last = now;
    scene.draw();
    if (visible && !document.hidden) raf = requestAnimationFrame(frame);
  };
  const wake = () => {
    if (stopped || !started || reduce || raf || !visible || document.hidden) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };
  const still = () => { if (!stopped && started && reduce) scene.draw(); };

  scene.ready.then((ok) => {
    if (stopped || !ok) return;
    started = true;
    scene.resize();
    if (reduce) { scene.seek(stillAt); scene.draw(); } else wake();
  });

  const ro = new ResizeObserver(() => { scene.resize(); still(); });
  ro.observe(stage);
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; wake(); });
  io.observe(stage);
  document.addEventListener("visibilitychange", wake);
  document.fonts?.ready.then(still);
  const onMove = (/** @type {PointerEvent} */ e) => {
    const b = stage.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;
    scene.pointer(x >= 0 && y >= 0 && x <= b.width && y <= b.height ? x : null, y);
    still();
  };
  const onLeave = () => { scene.pointer(null); still(); };
  host.addEventListener("pointermove", onMove, { passive: true });
  host.addEventListener("pointerleave", onLeave);

  return function stop() {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    ro.disconnect();
    io.disconnect();
    document.removeEventListener("visibilitychange", wake);
    host.removeEventListener("pointermove", onMove);
    host.removeEventListener("pointerleave", onLeave);
  };
}
