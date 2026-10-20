// The home hero (RM-175): the lit plate (render.js) under the drawn layer
// (story.js). The stage always holds a still of the plate as an <img>; the
// canvases take over only once the first lit frame is drawn, so a browser
// without WebGL, a shader that will not compile or a lost context leaves the
// still in place and the page reads the same.
import { coverFit, createRender } from "./render.js";
import { createOverlay, mixFor, stateAt } from "./story.js";

/**
 * @param {{ canvasRender: HTMLCanvasElement, fg: HTMLCanvasElement, still?: HTMLElement | null,
 *           img: string, quiet: () => Element | null, members?: any[], universe?: string[],
 *           onLive?: (live: boolean) => void }} o
 */
export function createMonument({ canvasRender, fg, still = null, img, quiet, members = [], universe = [], onLive }) {
  let live = false;
  const setLive = (/** @type {boolean} */ v) => { if (v !== live) { live = v; onLive?.(v); } };
  const render = createRender({ canvas: canvasRender, img, onLost: () => setLive(false) });
  const g2d = fg.getContext("2d");
  const overlay = g2d ? createOverlay(g2d) : null;
  let W = 1, H = 1, dpr = 1, narrow = false, time = 0;
  /** @type {{ x: number, y: number } | null} */
  let ptr = null;
  const lean = { x: 0, y: 0 };
  let roster = members, assets = universe, destroyed = false;

  function resize() {
    const r = fg.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height); narrow = W < 720;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    fg.width = Math.round(W * dpr); fg.height = Math.round(H * dpr);
    render?.resize(W, H);
    // The still sits exactly where the lit plate will, so the hand-over is
    // invisible.
    if (still) {
      const f = coverFit(W, H, narrow);
      Object.assign(still.style, { left: `${f.ox}px`, top: `${f.oy}px`, width: `${f.dw}px`, height: `${f.dh}px` });
    }
  }

  // Where the copy ends, so the named take lines start to its right.
  function copyRight() {
    const el = quiet();
    if (!el || narrow) return 0;
    const c = fg.getBoundingClientRect(), q = el.getBoundingClientRect();
    return Math.round(q.right - c.left);
  }

  /** @param {number} dt */
  function step(dt) {
    time += dt;
    const tx = ptr ? ptr.x / W - 0.5 : 0, ty = ptr ? ptr.y / H - 0.5 : 0;
    lean.x += (tx - lean.x) * Math.min(1, dt * 2); lean.y += (ty - lean.y) * Math.min(1, dt * 2);
  }

  function draw() {
    if (destroyed || !render) return;
    const st = stateAt(time);
    const mix = mixFor(st.cycle, assets, narrow ? 4 : 6);
    if (!render.draw({ st, time, ptr, mix, lean })) return;
    setLive(true);
    overlay?.draw({ W, H, dpr, narrow, st, a: render.anchors(), mix, members: roster, copyRight: copyRight() });
  }

  return {
    /** Resolves true once the plate is lit, false when the still stays. Never rejects. */
    ready: render ? render.ready : Promise.resolve(false),
    resize, step, draw,
    /** @param {number | null} x @param {number} [y] */
    pointer(x, y = 0) { ptr = x == null ? null : { x, y }; },
    /** @param {number} t */
    seek(t) { time = t; },
    get time() { return time; },
    get live() { return live; },
    /** @param {any[]} list */
    setMembers(list) { roster = list || []; overlay?.invalidate(); },
    /** @param {string[]} list */
    setUniverse(list) { assets = list || []; },
    destroy() {
      destroyed = true;
      render?.destroy();
      g2d?.clearRect(0, 0, fg.width, fg.height);
      setLive(false);
    },
  };
}
