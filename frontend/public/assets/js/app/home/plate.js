// A home section's photograph, lit (RM-175). It develops once, the first time
// it is seen, the way an eye adjusts to the dark: the brightest light in the
// picture first, then the mid-tones, the shadows last. After that it holds
// still but for a slow settle tied to the scroll, a slight zoom that eases out
// as its section passes. Every tone is the photograph's own.
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
uniform float uReveal;
void main() {
  vec2 q = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 uv = (q - uFit.xy) / uFit.zw;
  vec3 c = texture2D(uTex, clamp(uv, vec2(0.001), vec2(0.999))).rgb;
  // A threshold falls from white to below black; each pixel comes up as it
  // passes, over a soft band, so the light leads and the dark follows.
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float th = 1.0 - uReveal * 1.45;
  float shown = smoothstep(th, th + 0.45, lum);
  gl_FragColor = vec4(c * shown, 1.0);
}`;

const UNIFORMS = ["uTex", "uRes", "uFit", "uReveal"];
const REVEAL_MS = 1800;
// How far past its resting size the picture starts, before the scroll settles it.
const DRIFT = 0.06;
const clamp = (/** @type {number} */ v, /** @type {number} */ a, /** @type {number} */ b) => (v < a ? a : v > b ? b : v);
const easeOut = (/** @type {number} */ t) => 1 - Math.pow(1 - t, 3);

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

  let started = false, visible = false, due = false, done = false, revealedSent = false;
  /** @type {WebGLTexture | null} */
  let tex = null;
  let W = 1, H = 1, dpr = 1, t0 = 0, raf = 0;
  /** @type {{ ox: number, oy: number, dw: number, dh: number } | null} */
  let fit = null;
  // The drift follows the section, not the figure: a sticky plate's own box
  // stands still while its section scrolls past.
  const track = /** @type {HTMLElement} */ (figure.closest("section") || figure);
  const img = new Image();
  img.decoding = "async";

  const size = () => {
    if (!canvas || !gl) return;
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    dpr = Math.min(window.devicePixelRatio || 1, 1.6);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const iw = img.naturalWidth || 1672, ih = img.naturalHeight || 941;
    const s = Math.max(W / iw, H / ih), dw = iw * s, dh = ih * s;
    fit = { ox: (W - dw) * fx, oy: (H - dh) * fy, dw, dh };
  };

  const frame = (/** @type {number} */ now) => {
    raf = 0;
    if (done || !tex || !fit || !gl || !loc || !canvas) return;
    // The clock starts on the first frame drawn in view, not when the figure
    // crossed the line: a slow image would otherwise arrive half developed.
    if (due && !t0) t0 = now;
    const linear = reduce ? 1 : t0 ? clamp((now - t0) / REVEAL_MS, 0, 1) : 0;
    if (linear >= 1 && !revealedSent) { revealedSent = true; onRevealed?.(); }
    let zoom = 1;
    if (!reduce) {
      const r = track.getBoundingClientRect();
      const p = clamp((window.innerHeight - r.top) / (window.innerHeight + r.height), 0, 1);
      zoom = 1 + DRIFT * (1 - easeOut(p));
    }
    // Scaled about the focal point, so the subject stays where it was framed.
    const dw = fit.dw * zoom, dh = fit.dh * zoom;
    const ox = fit.ox + (fit.dw - dw) * fx, oy = fit.oy + (fit.dh - dh) * fy;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform1i(loc.uTex, 0);
    gl.uniform2f(loc.uRes, canvas.width, canvas.height);
    gl.uniform4f(loc.uFit, ox * dpr, oy * dpr, dw * dpr, dh * dpr);
    gl.uniform1f(loc.uReveal, easeOut(linear));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Frames run only while it develops; after that the scroll asks for them.
    if (visible && (linear < 1 || !t0)) raf = requestAnimationFrame(frame);
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
  // Drawn from its first pixel on screen, so the drift never jumps; it starts
  // to develop once a quarter of it is in view.
  const seen = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (e.intersectionRatio >= 0.25) due = true;
    if (visible) kick();
  }, { threshold: [0, 0.25] });
  seen.observe(figure);
  const ro = new ResizeObserver(() => { if (tex) { size(); kick(); } });
  if (canvas) ro.observe(canvas);
  const onScroll = () => { if (visible && !reduce) kick(); };
  window.addEventListener("scroll", onScroll, { passive: true });

  return () => {
    done = true;
    near.disconnect(); seen.disconnect(); ro.disconnect();
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener("scroll", onScroll);
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  };
}
