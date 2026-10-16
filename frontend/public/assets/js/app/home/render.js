// The home hero's plate, lit live (RM-175). The render's cut glows only
// faintly; the shader builds its light, throws it across the salt flat toward
// the viewer, fills the cut with green as deposits arrive, and adds the lanes.
// Its anchors are measured points on the render, in image u/v, so a new plate
// must keep the composition (and a changed one needs a new file name: images
// are not stamped, docs/technical/static-asset-cache.md C6).
import { LIGHT_GLSL, LIGHT_UNIFORMS, VERT, program, setLanes } from "./light.js";
import { clamp } from "./story.js";

export const PLATE = {
  w: 1672, h: 941,
  cutA: [0.7357, 0.0533], cutB: [0.7871, 0.099], cutC: [0.6714, 0.675],
  disc: [0.682, 0.392, 0.344], // centre u, v and radius in v
  horizon: 0.676,
};

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uTex;
uniform vec2 uRes;
uniform vec4 uFit;
uniform vec2 uPar;
uniform vec2 uCutA; uniform vec2 uCutB; uniform vec2 uCutC;
uniform vec2 uBeamL; uniform vec2 uBeamR;
uniform float uGlow;
uniform float uBeam;
uniform float uBeamK;
uniform float uGreen;
uniform float uHorizon;
uniform vec3 uPtr;
${LIGHT_GLSL}

void main() {
  vec2 q = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 uv = (q - uFit.xy + uPar) / uFit.zw;
  vec3 plate = texture2D(uTex, clamp(uv, vec2(0.001), vec2(0.999))).rgb;
  vec3 col = plate;

  // The cut: its light, a soft bloom round it, and the green fill rising
  // from its point as deposits arrive.
  float sd = sdTri(q, uCutA, uCutB, uCutC);
  float inside = smoothstep(1.5 * uDpr, -1.5 * uDpr, sd);
  vec2 top = 0.5 * (uCutA + uCutB);
  float h = clamp(dot(q - uCutC, top - uCutC) / dot(top - uCutC, top - uCutC), 0.0, 1.0);
  float fill = smoothstep(uGreen, uGreen - 0.02, h) * step(0.001, uGreen);
  vec3 light = mix(BEAM_WHITE, GREEN * 1.4, fill);
  float flicker = 0.97 + 0.03 * sin(uTime * 7.0 + h * 20.0);
  col = mix(col, light * (0.55 + 0.75 * uGlow) * flicker, inside * clamp(uGlow * 1.3, 0.0, 1.0));
  float bloom = exp(-max(sd, 0.0) / (34.0 * uDpr)) * (1.0 - inside);
  col += mix(BEAM, GREEN, fill * 0.6) * bloom * uGlow * 0.42;
  col += BEAM_WHITE * exp(-max(sd, 0.0) / (6.0 * uDpr)) * (1.0 - inside) * uGlow * 0.35;

  // The light on the ground: a wedge from the cut's point toward the viewer,
  // lighting the salt crackle in the render, running out as uBeam grows.
  if (q.y > uHorizon) {
    float sg = sdTri(q, uCutC, uBeamL, uBeamR);
    float g = smoothstep(18.0 * uDpr, -18.0 * uDpr, sg);
    float along = clamp((q.y - uCutC.y) / (uBeamL.y - uCutC.y), 0.0, 1.0);
    float reach = smoothstep(uBeam + 0.04, uBeam - 0.04, along);
    float lum = dot(plate, vec3(0.299, 0.587, 0.114));
    float k = g * reach * uBeamK * uGlow * (1.0 - 0.55 * along);
    vec3 gcol = mix(BEAM_WHITE, GREEN, 0.5 * uGreen * (1.0 - along));
    col += gcol * (lum * 5.0 + 0.05) * k;
    // Haze above the lit ground: the shaft of light, seen side-on.
    col += BEAM * 0.06 * g * reach * uBeamK * uGlow;
    // A wet sheen: the cut mirrored in the salt near its point.
    float mirror = exp(-abs(q.x - uCutC.x - (q.y - uCutC.y) * 0.05) / (14.0 * uDpr)) * exp(-(q.y - uHorizon) / (90.0 * uDpr));
    col += BEAM_WHITE * mirror * uGlow * 0.25;
  }

  col += lanes(q);
  col = 1.0 - exp(-col * 1.15);
  // The pointer is a faint torch.
  float pr = length(q - uPtr.xy);
  col += uPtr.z * 0.035 * exp(-(pr * pr) / (170.0 * 170.0 * uDpr * uDpr));
  // Film grain, at the strength the brand sheet allows.
  float n = fract(sin(dot(q + uTime * 61.0, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) * 0.035;
  gl_FragColor = vec4(col, 1.0);
}`;

// Never throws. No WebGL, a shader that will not compile, or an image that
// will not decode all come back as "no renderer" or `ready` resolving false,
// and the page keeps the still image the stage already shows.
/**
 * @param {{ canvas: HTMLCanvasElement, img: string, onLost?: () => void }} o
 */
export function createRender({ canvas, img, onLost }) {
  /** @type {WebGLRenderingContext | null} */
  let gl = null;
  try { gl = canvas.getContext("webgl", { antialias: false, alpha: false }); } catch { gl = null; }
  if (!gl) return null;
  const names = ["uTex", "uRes", "uFit", "uPar", "uCutA", "uCutB", "uCutC", "uBeamL", "uBeamR", "uGlow", "uBeam", "uBeamK", "uGreen", "uHorizon", "uPtr", ...LIGHT_UNIFORMS];
  /** @type {Record<string, WebGLUniformLocation | null>} */
  let loc;
  try { ({ loc } = program(gl, VERT, FRAG, names)); } catch { return null; }
  const ctx = gl;
  let tex = /** @type {WebGLTexture | null} */ (null), W = 1, H = 1, dpr = 1, narrow = false, lost = false;
  /** @type {{ ox: number, oy: number, dw: number, dh: number } | null} */
  let fit = null;
  const par = { x: 0, y: 0 };
  const onContextLost = (/** @type {Event} */ e) => { e.preventDefault(); lost = true; onLost?.(); };
  canvas.addEventListener("webglcontextlost", onContextLost);
  const image = new Image();
  image.decoding = "async";
  image.src = img;
  /** @type {Promise<boolean>} */
  const ready = image.decode().then(() => {
    if (lost) return false;
    tex = ctx.createTexture();
    ctx.bindTexture(ctx.TEXTURE_2D, tex);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE);
    ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGB, ctx.RGB, ctx.UNSIGNED_BYTE, image);
    return true;
  }, () => false);

  /** @param {number} w @param {number} h */
  function resize(w, h) {
    W = w; H = h; narrow = W < 720;
    dpr = Math.min(window.devicePixelRatio || 1, narrow ? 1.5 : 1.6);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    fit = coverFit(W, H, narrow);
  }

  /** @param {number} u @param {number} v */
  const S = (u, v) => ({ x: /** @type {any} */ (fit).ox + u * /** @type {any} */ (fit).dw - par.x, y: /** @type {any} */ (fit).oy + v * /** @type {any} */ (fit).dh - par.y });

  /** Anchors for the story, in CSS px. */
  function anchors() {
    const A = S(PLATE.cutA[0], PLATE.cutA[1]), B = S(PLATE.cutB[0], PLATE.cutB[1]), C = S(PLATE.cutC[0], PLATE.cutC[1]);
    const center = { x: (A.x + B.x + C.x) / 3, y: (A.y + B.y + C.y) / 3 - (C.y - A.y) * 0.08 };
    const horizon = S(0, PLATE.horizon).y;
    return {
      cutA: A, cutB: B, cutC: C, center, base: C, horizon,
      // Lanes fan out on the ground from the cut's point to below the frame.
      /** @param {number} n */
      laneEnds(n) {
        const yEnd = H + 40, spread = narrow ? 1.05 : 0.5;
        const x0 = C.x - W * spread * (narrow ? 0.52 : 0.62), x1 = C.x + W * spread * (narrow ? 0.48 : 0.38);
        return Array.from({ length: n }, (_, i) => ({ x: x0 + ((x1 - x0) * (n === 1 ? 0.5 : i / (n - 1))), y: yEnd }));
      },
      beam: { l: { x: C.x - W * 0.3, y: H + 40 }, r: { x: C.x + W * 0.02, y: H + 40 } },
    };
  }

  /** @param {{ st: any, time: number, ptr: { x: number, y: number } | null, mix: any[], lean: { x: number, y: number } }} f */
  function draw({ st, time, ptr, mix, lean }) {
    if (!tex || !fit || lost) return false;
    par.x = lean.x * 16; par.y = lean.y * 8;
    const a = anchors();
    ctx.viewport(0, 0, canvas.width, canvas.height);
    ctx.uniform1i(loc.uTex, 0);
    ctx.uniform2f(loc.uRes, canvas.width, canvas.height);
    ctx.uniform4f(loc.uFit, fit.ox * dpr, fit.oy * dpr, fit.dw * dpr, fit.dh * dpr);
    ctx.uniform2f(loc.uPar, par.x * dpr, par.y * dpr);
    for (const [k, p] of /** @type {[string, { x: number, y: number }][]} */ ([["uCutA", a.cutA], ["uCutB", a.cutB], ["uCutC", a.cutC], ["uBeamL", a.beam.l], ["uBeamR", a.beam.r]])) ctx.uniform2f(loc[k], p.x * dpr, p.y * dpr);
    ctx.uniform1f(loc.uGlow, st.glow);
    ctx.uniform1f(loc.uBeam, st.beam);
    ctx.uniform1f(loc.uBeamK, st.beamK);
    ctx.uniform1f(loc.uGreen, st.green);
    ctx.uniform1f(loc.uHorizon, a.horizon * dpr);
    ctx.uniform3f(loc.uPtr, (ptr?.x ?? -1e4) * dpr, (ptr?.y ?? -1e4) * dpr, ptr ? 1 : 0);
    setLanes(ctx, loc, { dpr, time, base: a.base, ends: a.laneEnds(mix.length), mix, st });
    ctx.drawArrays(ctx.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  function destroy() {
    canvas.removeEventListener("webglcontextlost", onContextLost);
    if (!lost) ctx.getExtension("WEBGL_lose_context")?.loseContext();
    lost = true;
  }

  return { ready, resize, anchors, draw, destroy };
}

// Where the plate sits: covering the stage, the disc right of the copy on a
// wide screen and centred on a phone. The still <img> under the canvas is
// placed by the same numbers (home.css), so the hand-over is seamless.
/** @param {number} W @param {number} H @param {boolean} narrow */
export function coverFit(W, H, narrow) {
  const s = Math.max(W / PLATE.w, H / PLATE.h), dw = PLATE.w * s, dh = PLATE.h * s;
  const want = narrow ? 0.5 : 0.69;
  const ox = dw > W + 1 ? clamp(W * want - PLATE.disc[0] * dw, W - dw, 0) : (W - dw) / 2;
  return { ox, oy: (H - dh) * 0.45, dw, dh };
}
