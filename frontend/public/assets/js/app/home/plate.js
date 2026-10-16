// A home section's photograph, lit (RM-175). It comes into view behind a
// vertical front of light that crosses it once, with a thin Beam fringe; after
// that a soft sheen passes now and then, and the pointer carries a faint torch
// and a little parallax. Every tone is the photograph's own plus light.
//
// The image is fetched only when the figure first nears the viewport, so a
// visitor who never scrolls never pays for it. Without WebGL (or with a shader
// that will not compile) the photograph is the figure's CSS background. The
// returned function undoes everything.

const VERT = `attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }`;
const FRAG = `
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform vec4 uFit;
uniform vec2 uPar;
uniform float uReveal;
uniform float uTime;
uniform vec3 uPtr;
uniform float uDpr;
const vec3 FRINGE = vec3(0.55, 0.95, 1.0);
void main() {
  vec2 q = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 uv = (q - uFit.xy + uPar) / uFit.zw;
  vec3 c = texture2D(uTex, clamp(uv, vec2(0.001), vec2(0.999))).rgb;
  // The reveal: a front of light crossing left to right, slightly slanted.
  float x = q.x / uRes.x + (q.y / uRes.y - 0.5) * 0.08;
  float front = uReveal * 1.25 - 0.1;
  float shown = smoothstep(front, front - 0.06, x);
  float edge = exp(-pow((x - front) * 70.0, 2.0));
  vec3 col = c * shown + edge * mix(vec3(1.0), FRINGE, 0.6) * 0.9 * step(0.001, uReveal) * (1.0 - step(1.0, uReveal));
  // A sheen every few seconds, along the diagonal.
  float s = fract(uTime / 7.0) * 2.4 - 0.7;
  float sheen = exp(-pow((x + q.y / uRes.y * 0.3 - s) * 9.0, 2.0)) * 0.07;
  col += c * sheen * 3.0 * shown;
  // The torch.
  float r = length(q - uPtr.xy);
  col += c * uPtr.z * 0.45 * exp(-(r * r) / (220.0 * 220.0 * uDpr * uDpr));
  gl_FragColor = vec4(col, 1.0);
}`;

const UNIFORMS = ["uTex", "uRes", "uFit", "uPar", "uReveal", "uTime", "uPtr", "uDpr"];
const clamp = (/** @type {number} */ v, /** @type {number} */ a, /** @type {number} */ b) => (v < a ? a : v > b ? b : v);

/** @param {WebGLRenderingContext} gl */
function compile(gl) {
  const sh = (/** @type {number} */ type, /** @type {string} */ src) => {
    const s = gl.createShader(type);
    if (!s) throw new Error("shader");
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("shader");
    return s;
  };
  const p = gl.createProgram();
  if (!p) throw new Error("program");
  gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link");
  gl.useProgram(p);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const a = gl.getAttribLocation(p, "a");
  gl.enableVertexAttribArray(a);
  gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  /** @type {Record<string, WebGLUniformLocation | null>} */
  const loc = {};
  for (const n of UNIFORMS) loc[n] = gl.getUniformLocation(p, n);
  return loc;
}

/**
 * @param {HTMLElement} figure  holds one <canvas>
 * @param {string} src
 * @param {{ fx?: number, fy?: number, reduce?: boolean, onRevealed?: () => void }} [o]
 * @returns {() => void}
 */
export function mountPlate(figure, src, { fx = 0.5, fy = 0.5, reduce = false, onRevealed } = {}) {
  const canvas = figure.querySelector("canvas");
  const fallback = () => {
    figure.style.backgroundImage = `url("${src}")`;
    figure.style.backgroundSize = "cover";
    figure.style.backgroundPosition = `${fx * 100}% ${fy * 100}%`;
    canvas?.remove();
  };
  /** @type {WebGLRenderingContext | null} */
  let gl = null;
  try { gl = canvas?.getContext("webgl", { antialias: false, alpha: false }) ?? null; } catch { gl = null; }
  /** @type {Record<string, WebGLUniformLocation | null> | null} */
  let loc = null;
  if (gl) { try { loc = compile(gl); } catch { loc = null; } }

  let started = false, visible = false, done = false, revealedSent = false;
  /** @type {WebGLTexture | null} */
  let tex = null;
  let W = 1, H = 1, dpr = 1, t0 = 0, raf = 0;
  /** @type {{ ox: number, oy: number, dw: number, dh: number } | null} */
  let fit = null;
  /** @type {{ x: number, y: number } | null} */
  let ptr = null;
  const par = { x: 0, y: 0 };
  const img = new Image();
  img.decoding = "async";

  const size = () => {
    if (!canvas || !gl) return;
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    dpr = Math.min(window.devicePixelRatio || 1, 1.6);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const iw = img.naturalWidth || 1672, ih = img.naturalHeight || 941;
    const s = Math.max(W / iw, H / ih) * 1.04, dw = iw * s, dh = ih * s;
    fit = { ox: (W - dw) * fx, oy: (H - dh) * fy, dw, dh };
  };

  const frame = (/** @type {number} */ now) => {
    raf = 0;
    if (done || !tex || !fit || !gl || !loc || !canvas) return;
    const reveal = reduce ? 1 : t0 ? clamp((now - t0) / 1600, 0, 1) : 0;
    if (reveal >= 1 && !revealedSent) { revealedSent = true; onRevealed?.(); }
    const tp = ptr ? { x: ptr.x / W - 0.5, y: ptr.y / H - 0.5 } : { x: 0, y: 0 };
    par.x += (tp.x * 18 - par.x) * 0.08; par.y += (tp.y * 10 - par.y) * 0.08;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform1i(loc.uTex, 0);
    gl.uniform2f(loc.uRes, canvas.width, canvas.height);
    gl.uniform4f(loc.uFit, fit.ox * dpr, fit.oy * dpr, fit.dw * dpr, fit.dh * dpr);
    gl.uniform2f(loc.uPar, par.x * dpr, par.y * dpr);
    gl.uniform1f(loc.uReveal, reveal >= 1 ? 1.0001 : reveal);
    gl.uniform1f(loc.uTime, reduce ? 0 : now / 1000);
    gl.uniform3f(loc.uPtr, (ptr?.x ?? -1e4) * dpr, (ptr?.y ?? -1e4) * dpr, ptr ? 1 : 0);
    gl.uniform1f(loc.uDpr, dpr);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (visible && !reduce) raf = requestAnimationFrame(frame);
  };
  const kick = () => { if (!done && !raf) raf = requestAnimationFrame(frame); };

  // The first time the figure nears the viewport: fetch, then light it.
  const start = () => {
    if (started) return;
    started = true;
    if (!gl || !loc) { fallback(); onRevealed?.(); return; }
    const ctx = gl;
    img.src = src;
    img.decode().then(() => {
      if (done) return;
      tex = ctx.createTexture();
      ctx.bindTexture(ctx.TEXTURE_2D, tex);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE);
      ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGB, ctx.RGB, ctx.UNSIGNED_BYTE, img);
      size();
      kick();
    }, () => { if (!done) { fallback(); onRevealed?.(); } });
  };

  const near = new IntersectionObserver(([e]) => { if (e.isIntersecting) { start(); near.disconnect(); } }, { rootMargin: "400px 0px" });
  near.observe(figure);
  const seen = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && !t0) t0 = performance.now();
    if (visible) kick();
  }, { threshold: 0.25 });
  seen.observe(figure);
  const ro = new ResizeObserver(() => { if (tex) { size(); kick(); } });
  if (canvas) ro.observe(canvas);
  const onMove = (/** @type {PointerEvent} */ e) => {
    if (!canvas) return;
    const b = canvas.getBoundingClientRect();
    ptr = { x: e.clientX - b.left, y: e.clientY - b.top };
    kick();
  };
  const onLeave = () => { ptr = null; kick(); };
  figure.addEventListener("pointermove", onMove, { passive: true });
  figure.addEventListener("pointerleave", onLeave);

  return () => {
    done = true;
    near.disconnect(); seen.disconnect(); ro.disconnect();
    if (raf) cancelAnimationFrame(raf);
    figure.removeEventListener("pointermove", onMove);
    figure.removeEventListener("pointerleave", onLeave);
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  };
}
