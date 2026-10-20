// The home hero's light (RM-175), as a GLSL chunk: the lanes the model
// portfolio divides into on the ground, the deposits travelling up them, and
// helpers. Everything here is in screen space (device pixels, y down), so the
// render hands in the same anchors it gives the drawn layer.

export const MAX_LANES = 8;

export const LIGHT_GLSL = `
uniform vec2 uBase;                 // where the cut meets the ground
uniform vec2 uLaneEnd[${MAX_LANES}];   // each lane's near end, toward the viewer
uniform float uLaneW[${MAX_LANES}];    // each lane's share of the allocation
uniform float uLaneN;
uniform float uLaneP;               // how far the lanes have run, 0 to 1
uniform float uLaneK;               // lanes' strength (fades out)
uniform float uFlow;                // deposits travelling
uniform float uTime;
uniform float uDpr;

const vec3 BEAM = vec3(0.0, 0.898, 1.0);
const vec3 BEAM_WHITE = vec3(0.78, 0.97, 1.0);
const vec3 GREEN = vec3(0.063, 0.725, 0.506);

float segT(vec2 q, vec2 a, vec2 b, float p, out float t) {
  vec2 ab = b - a;
  float h = clamp(dot(q - a, ab) / dot(ab, ab), 0.0, p);
  t = h;
  return length(q - (a + ab * h));
}

// 2D signed distance to a triangle (negative inside).
float sdTri(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
  vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                   vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                   vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}

// The lanes and the deposits on them.
vec3 lanes(vec2 q) {
  vec3 c = vec3(0.0);
  if (uLaneP <= 0.0 || uLaneK <= 0.0) return c;
  for (int i = 0; i < ${MAX_LANES}; i++) {
    if (float(i) >= uLaneN) break;
    vec2 e = uLaneEnd[i];
    float w8 = uLaneW[i];
    float t;
    float d = segT(q, uBase, e, uLaneP, t);
    // Wider toward the viewer, as a lane on the ground would look.
    float w = (0.5 + 5.5 * sqrt(w8)) * uDpr * (0.35 + 1.9 * t);
    float core = exp(-(d * d) / (w * w));
    float halo = 0.22 * exp(-d / (w * 5.0));
    c += mix(BEAM, BEAM_WHITE, 0.55) * (core + halo) * (0.4 + 0.9 * sqrt(w8)) * uLaneK;
    // Deposits: points of green moving up the lane into the monument.
    if (uFlow > 0.0) {
      for (int k = 0; k < 3; k++) {
        float s = 1.0 - fract(uTime * (0.16 + 0.32 * w8) + float(k) / 3.0 + float(i) * 0.137);
        if (s > uLaneP) continue;
        vec2 pk = uBase + (e - uBase) * s;
        float r = length(q - pk);
        float sz = (2.0 + 6.0 * s) * uDpr;
        c += GREEN * 2.4 * uFlow * exp(-(r * r) / (sz * sz));
      }
    }
  }
  return c;
}
`;

/** Set the shared uniforms. `ends` are screen points in CSS px. */
export function setLanes(gl, loc, { dpr, time, base, ends, mix, st }) {
  gl.uniform2f(loc.uBase, base.x * dpr, base.y * dpr);
  const e = new Float32Array(MAX_LANES * 2), w = new Float32Array(MAX_LANES);
  ends.slice(0, MAX_LANES).forEach((p, i) => { e[i * 2] = p.x * dpr; e[i * 2 + 1] = p.y * dpr; w[i] = mix[i]?.w ?? 0; });
  gl.uniform2fv(loc.uLaneEnd, e);
  gl.uniform1fv(loc.uLaneW, w);
  gl.uniform1f(loc.uLaneN, Math.min(ends.length, MAX_LANES));
  gl.uniform1f(loc.uLaneP, st.laneP);
  gl.uniform1f(loc.uLaneK, st.laneK);
  gl.uniform1f(loc.uFlow, st.flow);
  gl.uniform1f(loc.uTime, time);
  gl.uniform1f(loc.uDpr, dpr);
}

export const LIGHT_UNIFORMS = ["uBase", "uLaneEnd", "uLaneW", "uLaneN", "uLaneP", "uLaneK", "uFlow", "uTime", "uDpr"];

export function program(gl, vert, frag, names) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader");
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vert));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link");
  gl.useProgram(p);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const a = gl.getAttribLocation(p, "a");
  gl.enableVertexAttribArray(a);
  gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  const loc = {};
  for (const n of names) loc[n] = gl.getUniformLocation(p, n);
  return { p, loc };
}

export const VERT = `attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }`;
