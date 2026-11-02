// A hero photograph lit as the home page's are (RM-189, the early-access hero;
// the home hero and section plates are RM-175). It develops once, the first
// time it is seen, the way an eye adjusts to the dark: the brightest light in
// the picture first, then the mid-tones, the shadows last. After that it holds
// at its own tones, and the pointer only leans it, a few pixels toward where
// it is, with a faint torch under it and the home hero's film grain. Every
// tone is the photograph's own.
//
// Without WebGL (or with a shader that will not compile, or a lost context)
// the <img> still under the canvas is the hero. With reduced motion the
// photograph is drawn once, developed, and does not lean.

const VERT = `attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }`;
const FRAG = `
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform vec4 uFit;
uniform vec2 uPar;
uniform float uReveal;
uniform vec3 uPtr;
uniform float uTime;
uniform float uDpr;
void main() {
  vec2 q = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 uv = (q - uFit.xy + uPar) / uFit.zw;
  vec3 c = texture2D(uTex, clamp(uv, vec2(0.001), vec2(0.999))).rgb;
  // A threshold falls from white to below black; each pixel comes up as it
  // passes, over a soft band, so the light leads and the dark follows.
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float th = 1.0 - uReveal * 1.45;
  vec3 col = c * smoothstep(th, th + 0.45, lum);
  // The pointer is a faint torch.
  float pr = length(q - uPtr.xy);
  col += uPtr.z * 0.035 * exp(-(pr * pr) / (170.0 * 170.0 * uDpr * uDpr));
  // Film grain, at the strength the brand sheet allows.
  float n = fract(sin(dot(q + uTime * 61.0, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) * 0.035;
  gl_FragColor = vec4(col, 1.0);
}`;

const UNIFORMS = ["uTex", "uRes", "uFit", "uPar", "uReveal", "uPtr", "uTime", "uDpr"];
const REVEAL_MS = 1800;
// The lean at its widest, in CSS px, as the home hero's (render.js).
const LEAN_X = 16, LEAN_Y = 8;
// Drawn a touch larger than the cover crop, so a full lean never shows an edge.
const OVERSCAN = 1.03;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

function compile(gl) {
  const sh = (type, src) => {
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
  const loc = {};
  for (const n of UNIFORMS) loc[n] = gl.getUniformLocation(p, n);
  return loc;
}

/**
 * @param {HTMLElement} host     the hero: the pointer is read over all of it
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLImageElement} still  the photograph, already in the page
 * @param {{ fx?: number, fy?: number, reduce?: boolean }} [o]
 *   fx/fy: the focal point the cover crop keeps (as CSS object-position).
 * @returns {() => void} undoes everything
 */
export function mountLitPlate(host, canvas, still, { fx = 0.5, fy = 0.5, reduce = false } = {}) {
  /** @type {WebGLRenderingContext | null} */
  let gl = null;
  try { gl = canvas.getContext("webgl", { antialias: false, alpha: false }) ?? null; } catch { gl = null; }
  let loc = null;
  if (gl) { try { loc = compile(gl); } catch { loc = null; } }
  if (!gl || !loc) return () => {};
  const ctx = gl;

  let W = 1, H = 1, dpr = 1, fit = null, tex = null;
  let raf = 0, last = 0, t0 = 0, time = 0, visible = false, due = false, done = false;
  /** @type {{ x: number, y: number } | null} */
  let ptr = null;
  const lean = { x: 0, y: 0 };

  const size = () => {
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    dpr = Math.min(window.devicePixelRatio || 1, 1.6);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const iw = still.naturalWidth || 1672, ih = still.naturalHeight || 941;
    const s = Math.max(W / iw, H / ih) * OVERSCAN, dw = iw * s, dh = ih * s;
    fit = { ox: (W - dw) * fx, oy: (H - dh) * fy, dw, dh };
  };

  const draw = (reveal) => {
    ctx.viewport(0, 0, canvas.width, canvas.height);
    ctx.uniform1i(loc.uTex, 0);
    ctx.uniform2f(loc.uRes, canvas.width, canvas.height);
    ctx.uniform4f(loc.uFit, fit.ox * dpr, fit.oy * dpr, fit.dw * dpr, fit.dh * dpr);
    ctx.uniform2f(loc.uPar, lean.x * LEAN_X * dpr, lean.y * LEAN_Y * dpr);
    ctx.uniform1f(loc.uReveal, reveal);
    ctx.uniform3f(loc.uPtr, (ptr?.x ?? -1e4) * dpr, (ptr?.y ?? -1e4) * dpr, ptr ? 1 : 0);
    ctx.uniform1f(loc.uTime, time);
    ctx.uniform1f(loc.uDpr, dpr);
    ctx.drawArrays(ctx.TRIANGLE_STRIP, 0, 4);
  };

  const frame = (now) => {
    raf = 0;
    if (done || !tex || !fit || !visible) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    time += dt;
    // The clock starts on the first frame drawn in view, not when the figure
    // crossed the line: a slow image would otherwise arrive half developed.
    if (due && !t0) t0 = now;
    const reveal = t0 ? easeOut(clamp((now - t0) / REVEAL_MS, 0, 1)) : 0;
    // The lean eases toward the pointer, at the home hero's rate (scene.js).
    const tx = ptr ? ptr.x / W - 0.5 : 0, ty = ptr ? ptr.y / H - 0.5 : 0;
    const k = Math.min(1, dt * 2);
    lean.x += (tx - lean.x) * k; lean.y += (ty - lean.y) * k;
    draw(reveal);
    raf = requestAnimationFrame(frame);
  };
  const kick = () => { if (!done && !reduce && visible && tex && !raf) raf = requestAnimationFrame(frame); };

  const onMove = (e) => {
    const r = canvas.getBoundingClientRect();
    ptr = { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onLeave = () => { ptr = null; };

  const start = () => {
    if (done) return;
    tex = ctx.createTexture();
    ctx.activeTexture(ctx.TEXTURE0);
    ctx.bindTexture(ctx.TEXTURE_2D, tex);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE);
    ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGB, ctx.RGB, ctx.UNSIGNED_BYTE, still);
    size();
    // The canvas takes over from the still here, while it is still dark, so
    // the photograph develops on it rather than appearing and then dimming.
    host.classList.add("is-lit");
    if (reduce) draw(1); else kick();
  };
  if (still.complete && still.naturalWidth) start();
  else still.addEventListener("load", start, { once: true });

  // It starts to develop once a quarter of it is in view, as the home plates.
  const seen = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (e.intersectionRatio >= 0.25) due = true;
    last = 0;
    kick();
  }, { threshold: [0, 0.25] });
  seen.observe(host);
  const ro = new ResizeObserver(() => { if (tex) { size(); if (reduce) draw(1); else kick(); } });
  ro.observe(canvas);
  if (!reduce) {
    host.addEventListener("pointermove", onMove, { passive: true });
    host.addEventListener("pointerleave", onLeave);
  }
  const onLost = () => { done = true; host.classList.remove("is-lit"); };
  canvas.addEventListener("webglcontextlost", onLost);

  return () => {
    done = true;
    seen.disconnect(); ro.disconnect();
    if (raf) cancelAnimationFrame(raf);
    host.removeEventListener("pointermove", onMove);
    host.removeEventListener("pointerleave", onLeave);
    canvas.removeEventListener("webglcontextlost", onLost);
    host.classList.remove("is-lit");
    ctx.getExtension("WEBGL_lose_context")?.loseContext();
  };
}
