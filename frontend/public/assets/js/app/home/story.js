// The home hero's story (RM-175): the Robot Money mark as a monument on a salt
// flat at night. The lit render (render.js) supplies anchors on screen; this
// file supplies the timing, the mix and the drawn layer over it.
//
//   dark      the monument stands unlit, the cut barely glowing;
//   takes     each member's take arrives out of the night as a Beam line and
//             converges on the cut, which brightens as they land;
//   publish   the cut flares and its light falls across the ground toward the
//             viewer: the model portfolio;
//   split     the light on the ground divides into lanes, one per asset;
//   flow      deposits travel up the lanes into the monument as points of
//             green, and the cut fills with green from its base;
//   fade      the light settles, and the loop begins again.
//
// The mix changes every loop: assets from the eligible universe, named and
// never weighted, because the point is that any allocation is possible.
// Members are named from the roster; the faint lines stand for no count.

const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.pow(1 - t, 3));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

const PHASES = [["dark", 1.4], ["takes", 6], ["publish", 1.8], ["split", 1.6], ["flow", 6.8], ["fade", 2.2]];
export const CYCLE = PHASES.reduce((s, [, d]) => s + d, 0);
export const STILL_AT = 13.5;
function startOf(name) { let s = 0; for (const [n, d] of PHASES) { if (n === name) return s; s += d; } return 0; }
export function phaseAt(t) {
  let at = ((t % CYCLE) + CYCLE) % CYCLE, start = 0;
  for (const [name, len] of PHASES) { if (at < len) return { name, p: at / len, at, start }; at -= len; start += len; }
  return { name: "dark", p: 0, at: 0, start: 0 };
}

function seeded(n) {
  let seed = (n * 2654435761 + 4049) >>> 0;
  return () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** The light and story values at time t, shared by both mediums. */
export function stateAt(t) {
  const ph = phaseAt(t);
  const at = ((t % CYCLE) + CYCLE) % CYCLE;
  const fade = ph.name === "fade" ? 1 - ease(ph.p) : 1;
  const ps = startOf("publish"), ss = startOf("split"), fs = startOf("flow"), ts = startOf("takes");
  const glow = ph.name === "dark" ? 0.06
    : ph.name === "takes" ? 0.06 + 0.42 * smooth(0.15, 1, ph.p)
    : ph.name === "publish" ? 0.48 + 0.52 * ease(ph.p * 1.6)
    : ph.name === "fade" ? 0.06 + 0.94 * (1 - ease(ph.p)) : 1;
  const beam = ph.name === "dark" || ph.name === "takes" ? 0 : clamp((at - ps) / 1.4, 0, 1);
  const beamK = ph.name === "split" ? 1 - 0.75 * ease(ph.p) : ph.name === "flow" ? 0.25 : ph.name === "fade" ? 0.25 * fade : 1;
  const laneP = at >= ss ? ease(clamp((at - ss) / 1.4, 0, 1)) : 0;
  const flow = at >= fs ? smooth(fs, fs + 0.8, at) * fade : 0;
  const green = at >= fs ? (ph.name === "fade" ? 0.85 * fade : 0.85 * smooth(fs + 0.4, fs + 6.4, at)) : 0;
  return { ph, glow, beam: ease(beam), beamK, laneP, laneK: fade, flow, green, sinceTakes: at - ts, cycle: Math.floor(t / CYCLE) };
}

/** This loop's mix: a few assets with shares summing to one, seeded by the loop. */
const mixCache = new Map();
export function mixFor(cycle, universe, n) {
  if (!universe.length) return [];
  // Keyed on the names, not the count: the universe arrives from the API.
  const key = `${cycle}:${n}:${universe.join("|")}`;
  if (mixCache.has(key)) return mixCache.get(key);
  const rnd = seeded(cycle + 7);
  const pool = universe.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const k = Math.min(n, pool.length);
  const raw = pool.slice(0, k).map(() => 0.3 + Math.pow(-Math.log(1 - rnd() * 0.999), 1.6));
  const sum = raw.reduce((a, b) => a + b, 0);
  const mix = pool.slice(0, k).map((name, i) => ({ name, w: raw[i] / sum }));
  mixCache.set(key, mix);
  if (mixCache.size > 12) mixCache.delete(mixCache.keys().next().value);
  return mix;
}

/**
 * The drawn layer: take lines, beacon points and labels, over either medium.
 * @param {CanvasRenderingContext2D} ctx
 */
export function createOverlay(ctx) {
  let lines = [];
  let built = "";

  // Where takes come from: the named members from the open sky right of the
  // copy, and fainter lines from the whole upper frame for the many models.
  function build(W, H, members, copyRight, narrow) {
    const key = `${W}x${H}:${members.length}:${copyRight}`;
    if (key === built) return;
    built = key;
    const rnd = seeded(W * 31 + H);
    const x0 = narrow ? W * 0.08 : Math.max(copyRight + 60, W * 0.45), x1 = W * 0.97;
    lines = members.slice(0, 20).map((m, i) => ({
      member: m, x: x0 + ((x1 - x0) * (i + 0.5)) / members.length + (rnd() - 0.5) * 40,
      y: H * (narrow ? 0.08 : 0.07) + rnd() * H * (narrow ? 0.14 : 0.2), order: i / Math.max(1, members.length), strong: true,
    }));
    const faint = narrow ? 14 : 30;
    for (let i = 0; i < faint; i++) {
      const edge = rnd();
      lines.push({ member: null, x: edge < 0.7 ? x0 - 80 + rnd() * (W - x0 + 80) : W + 4, y: edge < 0.7 ? -4 : rnd() * H * 0.45,
        order: rnd(), strong: false });
    }
  }

  const LABEL_FONT = '500 10px "JetBrains Mono", ui-monospace, monospace';
  const LENS_FONT = '400 11px "Space Grotesk", ui-sans-serif, system-ui';
  const measure = (text, font = LABEL_FONT) => {
    ctx.font = font;
    try { ctx.letterSpacing = "0.14em"; } catch { /* older canvas */ }
    const w = ctx.measureText(text).width;
    try { ctx.letterSpacing = "0px"; } catch { /* */ }
    return w;
  };
  const label = (text, x, y, align, color, font) => {
    ctx.font = font || LABEL_FONT;
    try { ctx.letterSpacing = "0.14em"; } catch { /* older canvas */ }
    ctx.textAlign = align; ctx.fillStyle = color; ctx.fillText(text, x, y);
    try { ctx.letterSpacing = "0px"; } catch { /* */ }
  };

  /**
   * @param {{ W:number, H:number, dpr:number, narrow:boolean, st:any, a:any, mix:any[], members:any[], copyRight:number }} o
   */
  function draw({ W, H, dpr, narrow, st, a, mix, members, copyRight }) {
    build(W, H, members, copyRight, narrow);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const c = a.center;
    // Take lines, in Beam, each with a soft bloom: the light is allowed to bend.
    const show = st.ph.name === "takes" ? 1 : st.ph.name === "publish" ? 1 - ease(st.ph.p) : 0;
    if (show > 0) {
      ctx.globalCompositeOperation = "lighter";
      for (const l of lines) {
        const start = l.order * 4.2 + (l.strong ? 0 : 0.4);
        const p = ease(clamp((st.sinceTakes - start) / (l.strong ? 1.2 : 2), 0, 1));
        if (p <= 0) continue;
        const hx = l.x + (c.x - l.x) * p, hy = l.y + (c.y - l.y) * p;
        const al = (l.strong ? 0.85 : 0.22) * show;
        ctx.strokeStyle = `rgba(0,229,255,${al * 0.25})`; ctx.lineWidth = l.strong ? 5 : 3;
        ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(hx, hy); ctx.stroke();
        ctx.strokeStyle = `rgba(150,245,255,${al})`; ctx.lineWidth = l.strong ? 1.2 : 0.8;
        ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(hx, hy); ctx.stroke();
        if (p < 1) { ctx.fillStyle = `rgba(210,250,255,${al})`; ctx.beginPath(); ctx.arc(hx, hy, l.strong ? 2.6 : 1.6, 0, TAU); ctx.fill(); }
      }
      ctx.globalCompositeOperation = "source-over";
      // A Beacon point blinks once where each member files, and its name.
      for (const l of lines) {
        if (!l.strong) continue;
        const since = st.sinceTakes - l.order * 4.2;
        if (since < 0) continue;
        const blink = since < 0.9 ? 1 - since / 0.9 : 0;
        if (blink > 0) { ctx.fillStyle = `rgba(255,122,41,${blink})`; ctx.beginPath(); ctx.arc(l.x, l.y, 3.5, 0, TAU); ctx.fill(); }
        const na = clamp(1 - (since - 1.4) / 0.8, 0, 1) * show;
        if (na > 0 && l.member) {
          // A name that would run off the right edge reads leftward from its point.
          const lens = l.member.lens && !narrow ? l.member.lens : "";
          const room = W - 16 - (l.x + 8);
          const flip = Math.max(measure(l.member.name.toUpperCase()), lens ? measure(lens, LENS_FONT) : 0) > room;
          const lx = flip ? l.x - 8 : l.x + 8, al = flip ? "right" : "left";
          label(l.member.name.toUpperCase(), lx, l.y - 8, al, `rgba(237,239,241,${0.9 * na})`);
          if (lens) label(lens, lx, l.y + 6, al, `rgba(237,239,241,${0.5 * na})`, LENS_FONT);
        }
      }
    }
    // One allocation, as the light reaches the ground.
    const pub = st.ph.name === "publish" ? clamp((st.ph.p - 0.3) / 0.3, 0, 1) : st.ph.name === "split" ? 1 - ease(st.ph.p) : 0;
    if (pub > 0) label("THE MODEL PORTFOLIO", a.base.x + 18, a.base.y - 14, "left", `rgba(237,239,241,${0.85 * pub})`);
    // Each asset at the near end of its lane.
    const lk = st.laneP > 0.7 ? clamp((st.laneP - 0.7) / 0.3, 0, 1) * st.laneK : 0;
    if (lk > 0 && mix.length) {
      const yL = H - (narrow ? 26 : 34);
      const ends = a.laneEnds(mix.length);
      let lastX = -1e9;
      ends.forEach((e, i) => {
        const t = clamp((yL - a.base.y) / ((e.y - a.base.y) || 1), 0, 1);
        const x = a.base.x + (e.x - a.base.x) * t;
        if (x < 24 || x > W - 24 || x - lastX < (narrow ? 52 : 64)) return;
        lastX = x;
        label(mix[i].name.toUpperCase(), x, yL, "center", `rgba(237,239,241,${0.88 * lk})`);
      });
      if (!narrow) label("Any liquid, permissionless asset on Base", W - 28, yL - 26, "right", `rgba(237,239,241,${0.6 * lk})`, '400 12px "Space Grotesk", ui-sans-serif, system-ui');
    }
  }

  // The roster can arrive after the loop has started; the next frame rebuilds.
  return { draw, invalidate() { built = ""; } };
}
