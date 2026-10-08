var p=`
uniform vec2 uBase;                 // where the cut meets the ground
uniform vec2 uLaneEnd[8];   // each lane's near end, toward the viewer
uniform float uLaneW[8];    // each lane's share of the allocation
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
  for (int i = 0; i < 8; i++) {
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
`;function v(o,e,{dpr:i,time:s,base:k,ends:r,mix:n,st:t}){o.uniform2f(e.uBase,k.x*i,k.y*i);let a=new Float32Array(16),h=new Float32Array(8);r.slice(0,8).forEach((c,u)=>{a[u*2]=c.x*i,a[u*2+1]=c.y*i,h[u]=n[u]?.w??0}),o.uniform2fv(e.uLaneEnd,a),o.uniform1fv(e.uLaneW,h),o.uniform1f(e.uLaneN,Math.min(r.length,8)),o.uniform1f(e.uLaneP,t.laneP),o.uniform1f(e.uLaneK,t.laneK),o.uniform1f(e.uFlow,t.flow),o.uniform1f(e.uTime,s),o.uniform1f(e.uDpr,i)}var G=["uBase","uLaneEnd","uLaneW","uLaneN","uLaneP","uLaneK","uFlow","uTime","uDpr"];function L(o,e,i,s){let k=(h,c)=>{let u=o.createShader(h);if(o.shaderSource(u,c),o.compileShader(u),!o.getShaderParameter(u,o.COMPILE_STATUS))throw Error(o.getShaderInfoLog(u)||"shader");return u},r=o.createProgram();if(o.attachShader(r,k(o.VERTEX_SHADER,e)),o.attachShader(r,k(o.FRAGMENT_SHADER,i)),o.linkProgram(r),!o.getProgramParameter(r,o.LINK_STATUS))throw Error(o.getProgramInfoLog(r)||"link");o.useProgram(r);let n=o.createBuffer();o.bindBuffer(o.ARRAY_BUFFER,n),o.bufferData(o.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),o.STATIC_DRAW);let t=o.getAttribLocation(r,"a");o.enableVertexAttribArray(t),o.vertexAttribPointer(t,2,o.FLOAT,!1,0,0);let a={};for(let h of s)a[h]=o.getUniformLocation(r,h);return{p:r,loc:a}}var H="attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }";var c0=Math.PI*2,Y=(o,e,i)=>o<e?e:o>i?i:o,B=(o)=>o<=0?0:o>=1?1:1-Math.pow(1-o,3),x=(o,e,i)=>{let s=Y((i-o)/(e-o),0,1);return s*s*(3-2*s)},o0=[["dark",1.4],["takes",6],["publish",1.8],["split",1.6],["flow",6.8],["fade",2.2]],M=o0.reduce((o,[,e])=>o+e,0),h0=13.5;function w(o){let e=0;for(let[i,s]of o0){if(i===o)return e;e+=s}return 0}function Q0(o){let e=(o%M+M)%M,i=0;for(let[s,k]of o0){if(e<k)return{name:s,p:e/k,at:e,start:i};e-=k,i+=k}return{name:"dark",p:0,at:0,start:0}}function r0(o){let e=o*2654435761+4049>>>0;return()=>{e=e+1831565813>>>0;let i=e;return i=Math.imul(i^i>>>15,i|1),i^=i+Math.imul(i^i>>>7,i|61),((i^i>>>14)>>>0)/4294967296}}function s0(o){let e=Q0(o),i=(o%M+M)%M,s=e.name==="fade"?1-B(e.p):1,k=w("publish"),r=w("split"),n=w("flow"),t=w("takes"),a=e.name==="dark"?0.06:e.name==="takes"?0.06+0.42*x(0.15,1,e.p):e.name==="publish"?0.48+0.52*B(e.p*1.6):e.name==="fade"?0.06+0.94*(1-B(e.p)):1,h=e.name==="dark"||e.name==="takes"?0:Y((i-k)/1.4,0,1),c=e.name==="split"?1-0.75*B(e.p):e.name==="flow"?0.25:e.name==="fade"?0.25*s:1,u=i>=r?B(Y((i-r)/1.4,0,1)):0,_=i>=n?x(n,n+0.8,i)*s:0,P=i>=n?e.name==="fade"?0.85*s:0.85*x(n+0.4,n+6.4,i):0;return{ph:e,glow:a,beam:B(h),beamK:c,laneP:u,laneK:s,flow:_,green:P,sinceTakes:i-t,cycle:Math.floor(o/M)}}var C=new Map;function m0(o,e,i){if(!e.length)return[];let s=`${o}:${i}:${e.length}`;if(C.has(s))return C.get(s);let k=r0(o+7),r=e.slice();for(let c=r.length-1;c>0;c--){let u=Math.floor(k()*(c+1));[r[c],r[u]]=[r[u],r[c]]}let n=Math.min(i,r.length),t=r.slice(0,n).map(()=>0.3+Math.pow(-Math.log(1-k()*0.999),1.6)),a=t.reduce((c,u)=>c+u,0),h=r.slice(0,n).map((c,u)=>({name:c,w:t[u]/a}));if(C.set(s,h),C.size>12)C.delete(C.keys().next().value);return h}function k0(o){let e=[],i="";function s(n,t,a,h,c){let u=`${n}x${t}:${a.length}:${h}`;if(u===i)return;i=u;let _=r0(n*31+t),P=c?n*0.08:Math.max(h+60,n*0.45),D=n*0.97;e=a.slice(0,20).map((A,Z)=>({member:A,x:P+(D-P)*(Z+0.5)/a.length+(_()-0.5)*40,y:t*(c?0.08:0.07)+_()*t*(c?0.14:0.2),order:Z/Math.max(1,a.length),strong:!0}));let d=c?14:30;for(let A=0;A<d;A++){let Z=_();e.push({member:null,x:Z<0.7?P-80+_()*(n-P+80):n+4,y:Z<0.7?-4:_()*t*0.45,order:_(),strong:!1})}}let k=(n,t,a,h,c,u)=>{o.font=u||'500 10px "JetBrains Mono", ui-monospace, monospace';try{o.letterSpacing="0.14em"}catch{}o.textAlign=h,o.fillStyle=c,o.fillText(n,t,a);try{o.letterSpacing="0px"}catch{}};function r({W:n,H:t,dpr:a,narrow:h,st:c,a:u,mix:_,members:P,copyRight:D}){s(n,t,P,D,h),o.setTransform(a,0,0,a,0,0),o.clearRect(0,0,n,t);let d=u.center,A=c.ph.name==="takes"?1:c.ph.name==="publish"?1-B(c.ph.p):0;if(A>0){o.globalCompositeOperation="lighter";for(let m of e){let T=m.order*4.2+(m.strong?0:0.4),q=B(Y((c.sinceTakes-T)/(m.strong?1.2:2),0,1));if(q<=0)continue;let f=m.x+(d.x-m.x)*q,b=m.y+(d.y-m.y)*q,U=(m.strong?0.85:0.22)*A;if(o.strokeStyle=`rgba(0,229,255,${U*0.25})`,o.lineWidth=m.strong?5:3,o.beginPath(),o.moveTo(m.x,m.y),o.lineTo(f,b),o.stroke(),o.strokeStyle=`rgba(150,245,255,${U})`,o.lineWidth=m.strong?1.2:0.8,o.beginPath(),o.moveTo(m.x,m.y),o.lineTo(f,b),o.stroke(),q<1)o.fillStyle=`rgba(210,250,255,${U})`,o.beginPath(),o.arc(f,b,m.strong?2.6:1.6,0,c0),o.fill()}o.globalCompositeOperation="source-over";for(let m of e){if(!m.strong)continue;let T=c.sinceTakes-m.order*4.2;if(T<0)continue;let q=T<0.9?1-T/0.9:0;if(q>0)o.fillStyle=`rgba(255,122,41,${q})`,o.beginPath(),o.arc(m.x,m.y,3.5,0,c0),o.fill();let f=Y(1-(T-1.4)/0.8,0,1)*A;if(f>0&&m.member){if(k(m.member.name.toUpperCase(),m.x+8,m.y-8,"left",`rgba(237,239,241,${0.9*f})`),m.member.lens&&!h)k(m.member.lens,m.x+8,m.y+6,"left",`rgba(237,239,241,${0.5*f})`,'400 11px "Schibsted Grotesk", ui-sans-serif, system-ui')}}}let Z=c.ph.name==="publish"?Y((c.ph.p-0.3)/0.3,0,1):c.ph.name==="split"?1-B(c.ph.p):0;if(Z>0)k("ONE ALLOCATION",u.base.x+18,u.base.y-14,"left",`rgba(237,239,241,${0.85*Z})`);let S=c.laneP>0.7?Y((c.laneP-0.7)/0.3,0,1)*c.laneK:0;if(S>0&&_.length){let m=t-(h?26:34),T=u.laneEnds(_.length),q=-1e9;if(T.forEach((f,b)=>{let U=Y((m-u.base.y)/(f.y-u.base.y||1),0,1),V=u.base.x+(f.x-u.base.x)*U;if(V<24||V>n-24||V-q<(h?52:64))return;q=V,k(_[b].name.toUpperCase(),V,m,"center",`rgba(237,239,241,${0.88*S})`)}),!h)k("Any mix of liquid, permissionless assets on Base",n-28,m-26,"right",`rgba(237,239,241,${0.6*S})`,'400 12px "Schibsted Grotesk", ui-sans-serif, system-ui')}}return{draw:r}}var K={w:1672,h:941,cutA:[0.7357,0.0533],cutB:[0.7871,0.099],cutC:[0.6714,0.675],disc:[0.682,0.392,0.344],horizon:0.676},Y0=`
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
${p}

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
}`;function _0({canvas:o,img:e}){let i=o.getContext("webgl",{antialias:!1,alpha:!1}),s=new Image;if(s.src=e,!i)return null;let k=["uTex","uRes","uFit","uPar","uCutA","uCutB","uCutC","uBeamL","uBeamR","uGlow","uBeam","uBeamK","uGreen","uHorizon","uPtr",...G],{loc:r}=L(i,H,Y0,k),n=null,t=1,a=1,h=1,c=!1,u=null,_={x:0,y:0},P=s.decode().then(()=>{n=i.createTexture(),i.bindTexture(i.TEXTURE_2D,n),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MIN_FILTER,i.LINEAR),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_S,i.CLAMP_TO_EDGE),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_T,i.CLAMP_TO_EDGE),i.texImage2D(i.TEXTURE_2D,0,i.RGB,i.RGB,i.UNSIGNED_BYTE,s)});function D(S,m){t=S,a=m,c=t<720,h=Math.min(window.devicePixelRatio||1,c?1.5:1.6),o.width=Math.round(t*h),o.height=Math.round(a*h);let T=Math.max(t/K.w,a/K.h),q=K.w*T,f=K.h*T,b=c?0.5:0.69;u={ox:q>t+1?Y(t*b-K.disc[0]*q,t-q,0):(t-q)/2,oy:(a-f)*0.45,dw:q,dh:f}}let d=(S,m)=>({x:u.ox+S*u.dw-_.x,y:u.oy+m*u.dh-_.y});function A(){let S=d(...K.cutA),m=d(...K.cutB),T=d(...K.cutC),q={x:(S.x+m.x+T.x)/3,y:(S.y+m.y+T.y)/3-(T.y-S.y)*0.08},f=d(0,K.horizon).y;return{cutA:S,cutB:m,cutC:T,center:q,base:T,horizon:f,laneEnds(b){let U=a+40,V=c?1.05:0.5,l=T.x-t*V*(c?0.52:0.62),O=T.x+t*V*(c?0.48:0.38);return Array.from({length:b},(n0,g)=>({x:l+(O-l)*(b===1?0.5:g/(b-1)),y:U}))},beam:{l:{x:T.x-t*0.3,y:a+40},r:{x:T.x+t*0.02,y:a+40}}}}function Z({st:S,time:m,ptr:T,mix:q,lean:f}){if(!n||!u)return;_.x=f.x*16,_.y=f.y*8;let b=A();i.viewport(0,0,o.width,o.height),i.uniform1i(r.uTex,0),i.uniform2f(r.uRes,o.width,o.height),i.uniform4f(r.uFit,u.ox*h,u.oy*h,u.dw*h,u.dh*h),i.uniform2f(r.uPar,_.x*h,_.y*h);for(let[U,V]of[["uCutA",b.cutA],["uCutB",b.cutB],["uCutC",b.cutC],["uBeamL",b.beam.l],["uBeamR",b.beam.r]])i.uniform2f(r[U],V.x*h,V.y*h);i.uniform1f(r.uGlow,S.glow),i.uniform1f(r.uBeam,S.beam),i.uniform1f(r.uBeamK,S.beamK),i.uniform1f(r.uGreen,S.green),i.uniform1f(r.uHorizon,b.horizon*h),i.uniform3f(r.uPtr,(T?.x??-1e4)*h,(T?.y??-1e4)*h,T?1:0),v(i,r,{dpr:h,time:m,base:b.base,ends:b.laneEnds(q.length),mix:q,st:S}),i.drawArrays(i.TRIANGLE_STRIP,0,4)}return{ready:P,resize:D,anchors:A,draw:Z,destroy(){i.getExtension("WEBGL_lose_context")?.loseContext()}}}var z=30,y0=2.6,J=[[-0.386,-0.212],[0.79,0.612],[-0.004,-0.996]],e0=[40,95,-300],B0=`
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes;
uniform vec3 uEye; uniform vec3 uFwd; uniform vec3 uRight; uniform vec3 uUp;
uniform vec2 uCenter;   // principal point, device px, y down
uniform float uFocal;
uniform float uGlow; uniform float uBeam; uniform float uBeamK; uniform float uGreen;
uniform vec3 uPtr;
${p}

const float R = ${z.toFixed(1)};
const float T = ${y0.toFixed(1)};
const vec2 WA = vec2(${J[0][0]}, ${J[0][1]});
const vec2 WB = vec2(${J[1][0]}, ${J[1][1]});
const vec2 WC = vec2(${J[2][0]}, ${J[2][1]});
const vec3 LP = vec3(${e0[0].toFixed(1)}, ${e0[1].toFixed(1)}, ${e0[2].toFixed(1)});

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }

vec2 local(vec3 p) { return vec2(p.x, p.y - R) / R; }
float wedgeSd(vec2 l) { return sdTri(l, WA, WB, WC); }
// How far up the cut a point sits, 0 at its point, 1 at its rim edge.
float cutH(vec2 l) { vec2 top = 0.5 * (WA + WB); return clamp(dot(l - WC, top - WC) / dot(top - WC, top - WC), 0.0, 1.0); }

// Light reaching p through the cut: 0 to 1, with the green share of it.
float through(vec3 p, out float g) {
  g = 0.0;
  if (p.z <= 0.0) return 0.0;
  float s = p.z / (p.z - LP.z);
  vec3 q = p + (LP - p) * s;
  vec2 l = local(q);
  float m = smoothstep(0.012, -0.012, wedgeSd(l)) * step(length(l), 1.0);
  g = smoothstep(uGreen, uGreen - 0.03, cutH(l)) * step(0.001, uGreen);
  return m;
}

vec3 lightCol(float g) { return mix(vec3(0.8, 0.96, 1.0), GREEN * 1.5, g); }

vec3 sky(vec3 d) {
  float h = d.y;
  vec3 c = mix(vec3(0.022, 0.04, 0.07), vec3(0.003, 0.006, 0.014), smoothstep(-0.02, 0.45, h));
  // Stars.
  vec2 sp = vec2(atan(d.x, d.z), asin(clamp(d.y, -1.0, 1.0))) * 260.0;
  vec2 cell = floor(sp);
  float r = hash(cell);
  if (r > 0.985 && h > 0.02) {
    vec2 f = fract(sp) - 0.5 - (vec2(hash(cell + 3.1), hash(cell + 7.7)) - 0.5) * 0.6;
    c += vec3(0.7, 0.8, 1.0) * (r - 0.985) * 60.0 * exp(-dot(f, f) * 40.0) * smoothstep(0.02, 0.15, h);
  }
  // The far mountain line.
  float az = atan(d.x, d.z);
  float mh = 0.012 + 0.018 * fbm(vec2(az * 6.0, 1.3)) + 0.008 * fbm(vec2(az * 22.0, 4.1));
  if (h < mh) c = mix(c, vec3(0.012, 0.02, 0.035), 0.92);
  return c;
}

float salt(vec2 p) {
  // Voronoi edges: the raised ridges of a salt crust, warped and of uneven
  // width, so it reads as crust and not as tiles.
  p += vec2(fbm(p * 0.7), fbm(p * 0.7 + 9.0)) * 0.9;
  vec2 g = floor(p), f = fract(p);
  float d1 = 9.0, d2 = 9.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i), float(j));
    vec2 r = o + vec2(hash(g + o), hash(g + o + 19.3)) - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  float w = 0.03 + 0.05 * noise(p * 1.7);
  return 1.0 - smoothstep(0.0, w, sqrt(d2) - sqrt(d1));
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec3 d = normalize(uFwd + ((px.x - uCenter.x) / uFocal) * uRight + ((uCenter.y - px.y) / uFocal) * uUp);
  vec3 o = uEye;
  float tHit = 1e5; int what = 0; // 1 face, 2 rim, 3 wall, 4 hole, 5 ground
  vec2 hitL = vec2(0.0);

  // The disc: front face, its rim, and the cut through it.
  if (d.z < 0.0) {
    float tf = -o.z / d.z;
    vec3 p = o + d * tf;
    vec2 l = local(p);
    if (length(l) < 1.0) {
      if (wedgeSd(l) > 0.0) { tHit = tf; what = 1; hitL = l; }
      else {
        float tb = (-T - o.z) / d.z;
        vec2 l2 = local(o + d * tb);
        if (length(l2) < 1.0 && wedgeSd(l2) > 0.0) { tHit = tf + 0.001; what = 3; hitL = l; }
        else { tHit = tb; what = 4; hitL = l; }
      }
    } else {
      // The rim: a cylinder about the disc's axis, between its two faces.
      vec2 oc = vec2(o.x, o.y - R), dc = d.xy;
      float a = dot(dc, dc), b = dot(oc, dc), c = dot(oc, oc) - R * R;
      float disc = b * b - a * c;
      if (disc > 0.0) {
        float tc = (-b - sqrt(disc)) / a;
        vec3 pc = o + d * tc;
        if (tc > 0.0 && pc.z < 0.0 && pc.z > -T && wedgeSd(local(pc)) > 0.0) { tHit = tc; what = 2; hitL = local(pc); }
      }
    }
  }
  // The ground.
  float tg = d.y < 0.0 ? -o.y / d.y : 1e5;
  if (tg < tHit) { tHit = tg; what = 5; }

  vec3 col;
  float glow = uGlow;
  if (what == 1) {
    // Basalt: near black, with fine grey veins.
    float v = fbm(hitL * 14.0);
    float vein = pow(1.0 - abs(fbm(hitL * 7.0 + v * 1.5) * 2.0 - 1.0), 40.0);
    float grain = noise(hitL * 260.0);
    col = vec3(0.011, 0.013, 0.018) * (0.8 + 0.4 * grain) + vec3(0.13, 0.14, 0.16) * vein + vec3(0.008, 0.01, 0.016) * v;
    // Light bleeding round the cut, and the back light wrapping the rim.
    float sd = wedgeSd(hitL);
    float gk = smoothstep(uGreen, uGreen - 0.03, cutH(hitL)) * step(0.001, uGreen);
    col += lightCol(gk) * (exp(-sd / 0.012) * 0.6 + exp(-sd / 0.06) * 0.22) * glow;
    col += vec3(0.5, 0.85, 1.0) * smoothstep(0.975, 1.0, length(hitL)) * (0.02 + 0.35 * glow);
  } else if (what == 2) {
    col = vec3(0.012, 0.016, 0.022) + vec3(0.4, 0.75, 0.95) * (0.05 + 0.6 * glow) * pow(max(0.0, dot(normalize(vec2(hitL.x, hitL.y)), normalize(vec2(-0.3, 1.0)))), 2.0);
  } else if (what == 3) {
    float gk = smoothstep(uGreen, uGreen - 0.03, cutH(hitL)) * step(0.001, uGreen);
    col = lightCol(gk) * (0.08 + 0.5 * glow);
  } else if (what == 4) {
    // Through the cut: the light itself.
    float gk = smoothstep(uGreen, uGreen - 0.03, cutH(hitL)) * step(0.001, uGreen);
    vec3 ld = normalize(LP - uEye);
    float toward = pow(max(dot(d, ld), 0.0), 6.0);
    float along = cutH(hitL);
    float edge = clamp(-wedgeSd(hitL) / 0.06, 0.0, 1.0);
    vec3 lc = mix(lightCol(gk), mix(vec3(0.0, 0.75, 0.95), GREEN * 1.3, gk), (1.0 - along) * 0.55);
    float k = 0.015 + pow(glow, 1.4) * (0.3 + 1.4 * toward + 0.5 * along) * (1.15 - 0.3 * edge);
    col = sky(d) * (1.0 - glow) + lc * k * (0.97 + 0.03 * sin(uTime * 7.0 + hitL.y * 30.0));
  } else if (what == 5) {
    vec3 p = o + d * tHit;
    // Finer crust near the viewer, faded with distance before it can alias.
    float near = smoothstep(420.0, 60.0, tHit);
    float s = salt(p.xz * 0.55) * near * (0.55 + 0.45 * noise(p.xz * 0.2));
    float fine = fbm(p.xz * 2.1);
    vec3 alb = vec3(0.10, 0.115, 0.14) * (0.75 + 0.5 * fine) + vec3(0.55, 0.6, 0.64) * s * (0.6 + 0.4 * fine);
    float gk;
    float lit = through(p, gk);
    // The beam runs out across the ground as the allocation is published.
    float reach = smoothstep(uBeam * 330.0 + 12.0, uBeam * 330.0 - 12.0, p.z);
    vec3 L = vec3(0.010, 0.016, 0.028) + vec3(0.012, 0.018, 0.03) * s;
    float spread = 1.0 / (1.0 + pow(max(p.z, 0.0) / 140.0, 2.0));
    L += lightCol(gk) * lit * reach * uBeamK * glow * 0.85 * (0.35 + 0.65 * spread);
    col = alb * L * 3.0;
    // The cut mirrored in the wet salt.
    vec3 rd = reflect(d, vec3(0.0, 1.0, 0.0));
    if (rd.z < 0.0) {
      float tr = -p.z / rd.z;
      vec2 lr = local(p + rd * tr);
      if (length(lr) < 1.0 && wedgeSd(lr) < 0.0) col += vec3(0.6, 0.9, 1.0) * glow * 0.18 * (0.4 + 0.6 * fine);
    }
    col = mix(col, sky(vec3(d.x, 0.0, d.z)), 1.0 - exp(-tHit / 900.0));
  } else {
    col = sky(d);
  }

  // Haze: the shaft through the cut, and the halo round the disc behind it.
  float tEnd = min(tHit, 700.0);
  float jit = hash(px + fract(uTime) * 13.0);
  vec3 acc = vec3(0.0);
  const int N = 30;
  for (int i = 0; i < N; i++) {
    float t = tEnd * (float(i) + jit) / float(N);
    vec3 p = o + d * t;
    float dens = exp(-max(p.y, 0.0) / 55.0);
    vec3 ld = normalize(p - LP);
    float ct = dot(ld, -d);
    float phase = 0.08 + pow(max(-ct, 0.0), 24.0) * 3.0 + pow(max(-ct, 0.0), 4.0) * 0.5;
    if (p.z > 0.0) {
      float gk;
      float lit = through(p, gk);
      float reach = smoothstep(uBeam * 330.0 + 20.0, uBeam * 330.0 - 20.0, p.z);
      acc += lightCol(gk) * lit * reach * uBeamK * dens * phase * 0.03;
    } else {
      vec3 ax = normalize(vec3(0.0, R, 0.0) - LP);
      float cone = smoothstep(0.991, 0.9985, dot(ld, ax));
      acc += vec3(0.5, 0.85, 1.0) * cone * dens * phase * 0.006;
    }
  }
  col += acc * tEnd / float(N) * 0.08 * (0.25 + glow);

  col += lanes(px);
  col = 1.0 - exp(-col * 1.2);
  float pr = length(px - uPtr.xy);
  col += uPtr.z * 0.03 * exp(-(pr * pr) / (170.0 * 170.0 * uDpr * uDpr));
  float n = fract(sin(dot(px + uTime * 61.0, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) * 0.035;
  gl_FragColor = vec4(pow(col, vec3(0.95)), 1.0);
}`,d0=(o,e)=>[o[0]-e[0],o[1]-e[1],o[2]-e[2]],T0=(o)=>{let e=Math.hypot(...o)||1;return[o[0]/e,o[1]/e,o[2]/e]},U0=(o,e)=>[o[1]*e[2]-o[2]*e[1],o[2]*e[0]-o[0]*e[2],o[0]*e[1]-o[1]*e[0]],t0=(o,e)=>o[0]*e[0]+o[1]*e[1]+o[2]*e[2];function A0({canvas:o}){let e=o.getContext("webgl",{antialias:!1,alpha:!1});if(!e)return null;let i=["uRes","uEye","uFwd","uRight","uUp","uCenter","uFocal","uGlow","uBeam","uBeamK","uGreen","uPtr",...G],{loc:s}=L(e,H,B0,i),k=1,r=1,n=1,t=!1,a=null;function h(d,A){k=d,r=A,t=k<720,n=Math.min(window.devicePixelRatio||1,1.25)*(t?0.85:0.9),o.width=Math.round(k*n),o.height=Math.round(r*n)}function c(d,A){let Z=t?230:172,S=-0.2+0.07*Math.sin(d*0.045)+A.x*0.1,m=[t?0:4,25+A.y*2,0],T=[m[0]+Math.sin(S)*Z,4.5,Math.cos(S)*Z],q=T0(d0(m,T)),f=T0(U0(q,[0,1,0])),b=U0(f,q),U=r/2/Math.tan((t?40:34)*Math.PI/360),V={x:k*(t?0.5:0.67),y:r*(t?0.4:0.41)};return{eye:T,fwd:q,right:f,up:b,focal:U,center:V}}function u(d){let A=d0(d,a.eye),Z=t0(A,a.fwd);if(Z<0.1)return{x:-1e4,y:-1e4};return{x:a.center.x+t0(A,a.right)/Z*a.focal,y:a.center.y-t0(A,a.up)/Z*a.focal}}let _=(d)=>[d[0]*z,z+d[1]*z,0];function P(){let d=u(_(J[0])),A=u(_(J[1])),Z=u(_(J[2])),S=[(J[0][0]+J[1][0]+J[2][0])/3,(J[0][1]+J[1][1]+J[2][1])/3],m=u(_(S)),T=u([J[2][0]*z,0,0.5]),q=u([a.eye[0]+a.fwd[0]*5000,0,a.eye[2]+a.fwd[2]*5000]).y;return{cutA:d,cutB:A,cutC:Z,center:m,base:T,horizon:q,laneEnds(f){let b=r+40,U=T.x-k*(t?0.4:0.3),V=T.x+k*(t?0.4:0.2);return Array.from({length:f},(l,O)=>({x:U+(V-U)*(f===1?0.5:O/(f-1)),y:b}))}}}function D({st:d,time:A,ptr:Z,mix:S,lean:m}){a=c(A,m);let T=P();e.viewport(0,0,o.width,o.height),e.uniform2f(s.uRes,o.width,o.height),e.uniform3f(s.uEye,...a.eye),e.uniform3f(s.uFwd,...a.fwd),e.uniform3f(s.uRight,...a.right),e.uniform3f(s.uUp,...a.up),e.uniform2f(s.uCenter,a.center.x*n,a.center.y*n),e.uniform1f(s.uFocal,a.focal*n),e.uniform1f(s.uGlow,d.glow),e.uniform1f(s.uBeam,d.beam),e.uniform1f(s.uBeamK,d.beamK),e.uniform1f(s.uGreen,d.green),e.uniform3f(s.uPtr,(Z?.x??-1e4)*n,(Z?.y??-1e4)*n,Z?1:0),v(e,s,{dpr:n,time:A,base:T.base,ends:T.laneEnds(S.length),mix:S,st:d}),e.drawArrays(e.TRIANGLE_STRIP,0,4)}return{ready:Promise.resolve(),resize:h,anchors:()=>{if(!a)a=c(0,{x:0,y:0});return P()},draw:D,destroy(){e.getExtension("WEBGL_lose_context")?.loseContext()}}}function S0({canvasRender:o,canvas3d:e,fg:i,img:s,quiet:k,members:r,universe:n,medium:t="render"}){let a=_0({canvas:o,img:s}),h=A0({canvas:e}),c=k0(i.getContext("2d")),u=1,_=1,P=1,D=!1,d=0,A=null,Z={x:0,y:0},S=t==="3d"&&h?"3d":"render";function m(){o.hidden=S!=="render",e.hidden=S!=="3d"}m();function T(){let U=i.getBoundingClientRect();u=Math.max(1,U.width),_=Math.max(1,U.height),D=u<720,P=Math.min(window.devicePixelRatio||1,2),i.width=Math.round(u*P),i.height=Math.round(_*P),a?.resize(u,_),h?.resize(u,_)}function q(){let U=k();if(!U||D)return 0;let V=i.getBoundingClientRect();return U.getBoundingClientRect().right-V.left}function f(U){d+=U;let V=A?A.x/u-0.5:0,l=A?A.y/_-0.5:0;Z.x+=(V-Z.x)*Math.min(1,U*2),Z.y+=(l-Z.y)*Math.min(1,U*2)}function b(){let U=s0(d),V=m0(U.cycle,n,D?4:6),l=S==="3d"?h:a;if(!l)return;l.draw({st:U,time:d,ptr:A,mix:V,lean:Z}),c.draw({W:u,H:_,dpr:P,narrow:D,st:U,a:l.anchors(),mix:V,members:r,copyRight:q()})}return{ready:a?a.ready:Promise.resolve(),resize:T,step:f,draw:b,pointer(U,V){A=U==null?null:{x:U,y:V}},seek(U){d=U},get time(){return d},get medium(){return S},setMedium(U){if(U==="3d"&&!h)return;S=U,m(),b()}}}var $={"/api/dashboards/allocation":{strategy:[{label:"Conservative DeFi Yield",targetPct:95},{label:"Agent Tokens",targetPct:5},{label:"Protocol Tokens",targetPct:0},{label:"Real World Assets",targetPct:0}],buckets:[{key:"defi-yield",label:"Conservative DeFi Yield",items:[{label:"Aave",targetPct:25},{label:"Morpho",targetPct:25},{label:"Compound",targetPct:25},{label:"Sky",targetPct:25}]},{key:"agent-tokens",label:"Agent Tokens",items:[{label:"RobotMoney",targetPct:14.29},{label:"Juno",targetPct:14.29},{label:"Woon",targetPct:14.29},{label:"Peaq",targetPct:14.29},{label:"Zyfai",targetPct:14.29},{label:"Giza",targetPct:14.28},{label:"DEUS",targetPct:14.27}]},{key:"protocol-tokens",label:"Protocol Tokens",items:[{label:"BTC",targetPct:33.33},{label:"ETH",targetPct:33.33},{label:"HYPE",targetPct:33.34}]},{key:"rwa",label:"Real World Assets",items:[{label:"SPY",targetPct:50},{label:"Gold",targetPct:50}]}],asOf:"2026-06-02",source:"stub",managed:!0},"/api/swarm/members":{members:[{id:"athena",status:"active",name:"Athena",tagline:null,lens:"macro risk",mandate:null,biases:null,voiceMd:null,mode:null,operator:null,avatar:null,appliedAt:null,activatedAt:null},{id:"boreas",status:"active",name:"Boreas",tagline:null,lens:"on-chain flows",mandate:null,biases:null,voiceMd:null,mode:null,operator:null,avatar:null,appliedAt:null,activatedAt:null},{id:"cygnus",status:"active",name:"Cygnus",tagline:null,lens:"momentum",mandate:null,biases:null,voiceMd:null,mode:null,operator:null,avatar:null,appliedAt:null,activatedAt:null},{id:"draco",status:"active",name:"Draco",tagline:null,lens:"contrarian",mandate:null,biases:null,voiceMd:null,mode:null,operator:null,avatar:null,appliedAt:null,activatedAt:null},{id:"helios",status:"active",name:"Helios",tagline:null,lens:"liquidity",mandate:null,biases:null,voiceMd:null,mode:null,operator:null,avatar:null,appliedAt:"2026-07-09T12:02:38.687Z",activatedAt:"2026-07-09T12:02:49.927Z"}]},"/api/swarm/sessions":{sessions:[{id:"2344ca37-2c64-450f-9fe6-a31302ef476d",date:"2026-07-10",subjectId:"woon",subjectName:"Woon Treasury",state:"published",windowClosesAt:"2026-07-09T13:04:15.399Z",publishedAt:"2026-07-09T12:04:21.451Z",regimeSummary:{regime:"risk_on",history:[{date:"2026-06-27",macro:0.5446,factor:0.4329,regime:"risk_on",onchain:0.5785,composite:0.5615},{date:"2026-06-28",macro:0.5773,factor:0.4127,regime:"risk_on",onchain:0.625,composite:0.6011},{date:"2026-06-29",macro:0.6429,factor:0.3821,regime:"risk_on",onchain:0.6501,composite:0.6465},{date:"2026-06-30",macro:0.678,factor:0.3409,regime:"risk_on",onchain:0.6309,composite:0.6544},{date:"2026-07-01",macro:0.6772,factor:0.301,regime:"risk_on",onchain:0.5758,composite:0.6265},{date:"2026-07-02",macro:0.6855,factor:0.3567,regime:"risk_on",onchain:0.5969,composite:0.6412},{date:"2026-07-03",macro:0.6853,factor:0.4341,regime:"risk_on",onchain:0.6081,composite:0.6467},{date:"2026-07-04",macro:0.6467,factor:0.3923,regime:"risk_on",onchain:0.5959,composite:0.6213},{date:"2026-07-05",macro:0.6242,factor:0.3895,regime:"risk_on",onchain:0.5645,composite:0.5944},{date:"2026-07-06",macro:0.5704,factor:0.3492,regime:"risk_on",onchain:0.5254,composite:0.5479},{date:"2026-07-07",macro:0.5726,factor:0.3644,regime:"risk_on",onchain:0.5369,composite:0.5548},{date:"2026-07-08",macro:0.4993,factor:0.4108,regime:"risk_on",onchain:0.5467,composite:0.523},{date:"2026-07-09",macro:0.5463,factor:0.4132,regime:"risk_on",onchain:0.5041,composite:0.5252},{date:"2026-07-10",macro:0.5431,factor:0.4131,regime:"risk_on",onchain:0.5052,composite:0.5241}],composite:0.5241,macro_regime:"neutral",factor_regime:"risk_off",onchain_regime:"neutral",macro_percentile:0.5776,factor_percentile:0.1164,onchain_percentile:0.5411,composite_percentile:0.6151},subjectSnapshotTotalValueUsd:44167.4,synthesis:"The swarm reads composite 0.524 at the 62th percentile — risk-on by label, with the panel spread the load-bearing signal rather than the headline level. Across 4/5 submitted takes the stance distribution is 2 cautious, 1 neutral, 1 bullish at 57% mean confidence, with 1 absent. All present members hold the 95/5/0/0 conservative allocation mandate and sequence the 5% Agent Tokens floor (via rmUSDC) ahead of any structural trim of Woon Treasury.",swarmRecommendation:{type:"position_actions",absent:["draco"],quorum:{absent:1,active:5,submitted:4,participation:0.8},actions:[{token:"USDC",action:"rotate",rationale:"Route the next stable tranche into rmUSDC to clear the 5% Agent Tokens floor."},{token:"rmUSDC",action:"add",rationale:"Vault receipt is the Agent Tokens exposure — top up to the mandated 5% floor."}],stances:{bullish:1,neutral:1,cautious:2},consensus:["Regime composite 0.524 sits at the 62th percentile — risk-on by label.","Swarm holds the 95/5/0/0 mandate (Conservative DeFi Yield / Agent Tokens / Protocol / RWA); composite at the 62th does not license a tilt.","Floor-first sequencing — clear the 5% Agent Tokens sleeve via rmUSDC before any structural trim.","4/5 members submitted this session (2 cautious, 1 neutral, 1 bullish)."],rationale:"Swarm holds 95/5/0/0 with composite at the 62th percentile (risk-on); the load-bearing action is routing the next stable tranche into rmUSDC to clear the 5% Agent Tokens floor before any structural trim.",disagreements:[{topic:"Weight of the on-chain panel in the Woon Treasury read",positions:[{view:"bullish — reads the divergence as downstream of agent deployment; would fund the Agent Tokens sleeve now.",member_id:"cygnus"},{view:"cautious — conservative compositor reads nominal risk-on, effective neutral; no tilt licensed.",member_id:"helios"}],what_settles:"On-chain panel crossing the 50th percentile for five consecutive sessions, or composite breaching 0.40."}],meanConfidence:0.575},socialDraftId:null,generatedAt:"2026-07-09T12:04:13.376Z"},{id:"a598270e-ef0f-4bca-b24e-3e143e9c424a",date:"2026-07-09",subjectId:"mav",subjectName:"Mav Holdings",state:"published",windowClosesAt:"2026-07-09T13:02:53.159Z",publishedAt:"2026-07-09T12:02:59.205Z",regimeSummary:{regime:"risk_on",history:[{date:"2026-06-26",macro:0.5205,factor:0.4704,regime:"risk_on",onchain:0.5571,composite:0.5388},{date:"2026-06-27",macro:0.5446,factor:0.4329,regime:"risk_on",onchain:0.5785,composite:0.5615},{date:"2026-06-28",macro:0.5773,factor:0.4127,regime:"risk_on",onchain:0.625,composite:0.6011},{date:"2026-06-29",macro:0.6429,factor:0.3821,regime:"risk_on",onchain:0.6501,composite:0.6465},{date:"2026-06-30",macro:0.678,factor:0.3409,regime:"risk_on",onchain:0.6309,composite:0.6544},{date:"2026-07-01",macro:0.6772,factor:0.301,regime:"risk_on",onchain:0.5758,composite:0.6265},{date:"2026-07-02",macro:0.6855,factor:0.3567,regime:"risk_on",onchain:0.5969,composite:0.6412},{date:"2026-07-03",macro:0.6853,factor:0.4341,regime:"risk_on",onchain:0.6081,composite:0.6467},{date:"2026-07-04",macro:0.6467,factor:0.3923,regime:"risk_on",onchain:0.5959,composite:0.6213},{date:"2026-07-05",macro:0.6242,factor:0.3895,regime:"risk_on",onchain:0.5645,composite:0.5944},{date:"2026-07-06",macro:0.5704,factor:0.3492,regime:"risk_on",onchain:0.5254,composite:0.5479},{date:"2026-07-07",macro:0.5726,factor:0.3644,regime:"risk_on",onchain:0.5369,composite:0.5548},{date:"2026-07-08",macro:0.4993,factor:0.4108,regime:"risk_on",onchain:0.5467,composite:0.523},{date:"2026-07-09",macro:0.5437,factor:0.4126,regime:"risk_on",onchain:0.504,composite:0.5239}],composite:0.5239,macro_regime:"neutral",factor_regime:"risk_off",onchain_regime:"risk_on",macro_percentile:0.5804,factor_percentile:0.1155,onchain_percentile:0.5365,composite_percentile:0.6151},subjectSnapshotTotalValueUsd:38000,synthesis:"The swarm reads composite 0.524 at the 62th percentile — risk-on by label, with the panel spread the load-bearing signal rather than the headline level. Across 4/5 submitted takes the stance distribution is 2 cautious, 1 bullish, 1 neutral at 58% mean confidence, with 1 absent. All present members hold the 95/5/0/0 conservative allocation mandate and sequence the 5% Agent Tokens floor (via rmUSDC) ahead of any structural trim of Mav Holdings.",swarmRecommendation:{type:"position_actions",absent:["draco"],quorum:{absent:1,active:5,submitted:4,participation:0.8},actions:[{token:"USDC",action:"rotate",rationale:"Route the next stable tranche into rmUSDC to clear the 5% Agent Tokens floor."},{token:"rmUSDC",action:"add",rationale:"Vault receipt is the Agent Tokens exposure — top up to the mandated 5% floor."}],stances:{bullish:1,neutral:1,cautious:2},consensus:["Regime composite 0.524 sits at the 62th percentile — risk-on by label.","Swarm holds the 95/5/0/0 mandate (Conservative DeFi Yield / Agent Tokens / Protocol / RWA); composite at the 62th does not license a tilt.","Floor-first sequencing — clear the 5% Agent Tokens sleeve via rmUSDC before any structural trim.","4/5 members submitted this session (2 cautious, 1 bullish, 1 neutral)."],rationale:"Swarm holds 95/5/0/0 with composite at the 62th percentile (risk-on); the load-bearing action is routing the next stable tranche into rmUSDC to clear the 5% Agent Tokens floor before any structural trim.",disagreements:[{topic:"Weight of the on-chain panel in the Mav Holdings read",positions:[{view:"bullish — reads the divergence as downstream of agent deployment; would fund the Agent Tokens sleeve now.",member_id:"cygnus"},{view:"cautious — conservative compositor reads nominal risk-on, effective neutral; no tilt licensed.",member_id:"helios"}],what_settles:"On-chain panel crossing the 50th percentile for five consecutive sessions, or composite breaching 0.40."}],meanConfidence:0.5750000000000001},socialDraftId:null,generatedAt:"2026-07-09T12:02:51.130Z"},{id:"4a0bcc21-930c-4edf-9d90-9e7a5a6fde7d",date:"2026-07-09",subjectId:"woon",subjectName:"Woon Treasury",state:"published",windowClosesAt:"2026-07-09T13:01:53.671Z",publishedAt:"2026-07-09T12:01:59.739Z",regimeSummary:{regime:"risk_on",history:[{date:"2026-06-26",macro:0.5205,factor:0.4704,regime:"risk_on",onchain:0.5571,composite:0.5388},{date:"2026-06-27",macro:0.5446,factor:0.4329,regime:"risk_on",onchain:0.5785,composite:0.5615},{date:"2026-06-28",macro:0.5773,factor:0.4127,regime:"risk_on",onchain:0.625,composite:0.6011},{date:"2026-06-29",macro:0.6429,factor:0.3821,regime:"risk_on",onchain:0.6501,composite:0.6465},{date:"2026-06-30",macro:0.678,factor:0.3409,regime:"risk_on",onchain:0.6309,composite:0.6544},{date:"2026-07-01",macro:0.6772,factor:0.301,regime:"risk_on",onchain:0.5758,composite:0.6265},{date:"2026-07-02",macro:0.6855,factor:0.3567,regime:"risk_on",onchain:0.5969,composite:0.6412},{date:"2026-07-03",macro:0.6853,factor:0.4341,regime:"risk_on",onchain:0.6081,composite:0.6467},{date:"2026-07-04",macro:0.6467,factor:0.3923,regime:"risk_on",onchain:0.5959,composite:0.6213},{date:"2026-07-05",macro:0.6242,factor:0.3895,regime:"risk_on",onchain:0.5645,composite:0.5944},{date:"2026-07-06",macro:0.5704,factor:0.3492,regime:"risk_on",onchain:0.5254,composite:0.5479},{date:"2026-07-07",macro:0.5726,factor:0.3644,regime:"risk_on",onchain:0.5369,composite:0.5548},{date:"2026-07-08",macro:0.4993,factor:0.4108,regime:"risk_on",onchain:0.5467,composite:0.523},{date:"2026-07-09",macro:0.5437,factor:0.4126,regime:"risk_on",onchain:0.504,composite:0.5239}],composite:0.5239,macro_regime:"neutral",factor_regime:"risk_off",onchain_regime:"risk_on",macro_percentile:0.5804,factor_percentile:0.1155,onchain_percentile:0.5365,composite_percentile:0.6151},subjectSnapshotTotalValueUsd:44167.4,synthesis:"The swarm reads composite 0.524 at the 62th percentile — risk-on by label, with the panel spread the load-bearing signal rather than the headline level. Across 3/4 submitted takes the stance distribution is 1 neutral, 1 cautious, 1 bullish at 58% mean confidence, with 1 absent. All present members hold the 95/5/0/0 conservative allocation mandate and sequence the 5% Agent Tokens floor (via rmUSDC) ahead of any structural trim of Woon Treasury.",swarmRecommendation:{type:"position_actions",absent:["draco"],quorum:{absent:1,active:4,submitted:3,participation:0.75},actions:[{token:"USDC",action:"rotate",rationale:"Route the next stable tranche into rmUSDC to clear the 5% Agent Tokens floor."},{token:"rmUSDC",action:"add",rationale:"Vault receipt is the Agent Tokens exposure — top up to the mandated 5% floor."}],stances:{bullish:1,neutral:1,cautious:1},consensus:["Regime composite 0.524 sits at the 62th percentile — risk-on by label.","Swarm holds the 95/5/0/0 mandate (Conservative DeFi Yield / Agent Tokens / Protocol / RWA); composite at the 62th does not license a tilt.","Floor-first sequencing — clear the 5% Agent Tokens sleeve via rmUSDC before any structural trim.","3/4 members submitted this session (1 neutral, 1 cautious, 1 bullish)."],rationale:"Swarm holds 95/5/0/0 with composite at the 62th percentile (risk-on); the load-bearing action is routing the next stable tranche into rmUSDC to clear the 5% Agent Tokens floor before any structural trim.",disagreements:[{topic:"Weight of the on-chain panel in the Woon Treasury read",positions:[{view:"bullish — reads the divergence as downstream of agent deployment; would fund the Agent Tokens sleeve now.",member_id:"cygnus"},{view:"cautious — conservative compositor reads nominal risk-on, effective neutral; no tilt licensed.",member_id:"athena"}],what_settles:"On-chain panel crossing the 50th percentile for five consecutive sessions, or composite breaching 0.40."}],meanConfidence:0.5833333333333334},socialDraftId:null,generatedAt:"2026-07-09T12:01:51.632Z"}]},"/api/dashboards/token-metrics":{robotmoney:{priceUsd:0.00001,totalSupply:55000000000,marketCapUsd:550000},feeSplit:[{label:"Protocol",pct:57},{label:"Bankr",pct:40},{label:"Clanker",pct:3}],asOf:"2026-07-10T16:07:35.538Z",source:"stub",stale:!1}};var M0=(o,e,i)=>o<e?e:o>i?i:o;function Z0(o,e,{fx:i=0.5,fy:s=0.5,reduce:k=!1,fringe:r="spectral"}={}){let n=o.querySelector("canvas"),t=n.getContext("webgl",{antialias:!1,alpha:!1}),a=new Image;a.src=e;let h=null,c={},u=1,_=1,P=1,D=null,d=null,A=0,Z=0,S=!1,m={x:0,y:0};if(!t)return o.style.backgroundImage=`url("${e}")`,o.style.backgroundSize="cover",n.remove(),()=>{};let T=(F,Q)=>{let y=t.createShader(F);return t.shaderSource(y,Q),t.compileShader(y),y},q=t.createProgram();t.attachShader(q,T(t.VERTEX_SHADER,"attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }")),t.attachShader(q,T(t.FRAGMENT_SHADER,`
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform vec4 uFit;
uniform vec2 uPar;
uniform float uReveal;
uniform float uTime;
uniform vec3 uPtr;
uniform float uDpr;
uniform vec3 uFringe;
uniform float uSpectral;
vec3 spectral(float h) { return clamp(0.55 + 0.55 * cos(6.28318 * (h + vec3(0.0, 0.33, 0.67))), 0.0, 1.0); }
void main() {
  vec2 q = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 uv = (q - uFit.xy + uPar) / uFit.zw;
  vec3 c = texture2D(uTex, clamp(uv, vec2(0.001), vec2(0.999))).rgb;
  // The reveal: a front of light crossing left to right, slightly slanted.
  float x = q.x / uRes.x + (q.y / uRes.y - 0.5) * 0.08;
  float front = uReveal * 1.25 - 0.1;
  float shown = smoothstep(front, front - 0.06, x);
  float edge = exp(-pow((x - front) * 70.0, 2.0));
  vec3 fringe = mix(uFringe, spectral(fract((x - front) * 12.0 + 0.3)), uSpectral);
  vec3 col = c * shown + edge * mix(vec3(1.0), fringe, 0.6) * 0.9 * step(0.001, uReveal) * (1.0 - step(1.0, uReveal));
  // A sheen every few seconds, along the diagonal.
  float s = fract(uTime / 7.0) * 2.4 - 0.7;
  float sheen = exp(-pow((x + q.y / uRes.y * 0.3 - s) * 9.0, 2.0)) * 0.07;
  col += c * sheen * 3.0 * shown;
  // The torch.
  float r = length(q - uPtr.xy);
  col += c * uPtr.z * 0.45 * exp(-(r * r) / (220.0 * 220.0 * uDpr * uDpr));
  gl_FragColor = vec4(col, 1.0);
}`)),t.linkProgram(q),t.useProgram(q),t.bindBuffer(t.ARRAY_BUFFER,t.createBuffer()),t.bufferData(t.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),t.STATIC_DRAW);let f=t.getAttribLocation(q,"a");t.enableVertexAttribArray(f),t.vertexAttribPointer(f,2,t.FLOAT,!1,0,0);for(let F of["uTex","uRes","uFit","uPar","uReveal","uTime","uPtr","uDpr","uFringe","uSpectral"])c[F]=t.getUniformLocation(q,F);let b=()=>{let F=n.getBoundingClientRect();u=Math.max(1,F.width),_=Math.max(1,F.height),P=Math.min(window.devicePixelRatio||1,1.6),n.width=Math.round(u*P),n.height=Math.round(_*P);let Q=a.naturalWidth||1672,y=a.naturalHeight||941,X=Math.max(u/Q,_/y)*1.04,a0=Q*X,u0=y*X;D={ox:(u-a0)*i,oy:(_-u0)*s,dw:a0,dh:u0}},U=(F)=>{if(Z=0,!h)return;let Q=k?1:A?M0((F-A)/1600,0,1):0,y=d?{x:d.x/u-0.5,y:d.y/_-0.5}:{x:0,y:0};m.x+=(y.x*18-m.x)*0.08,m.y+=(y.y*10-m.y)*0.08,t.viewport(0,0,n.width,n.height),t.uniform1i(c.uTex,0),t.uniform2f(c.uRes,n.width,n.height),t.uniform4f(c.uFit,D.ox*P,D.oy*P,D.dw*P,D.dh*P),t.uniform2f(c.uPar,m.x*P,m.y*P),t.uniform1f(c.uReveal,Q>=1?1.0001:Q),t.uniform1f(c.uTime,k?0:F/1000),t.uniform3f(c.uPtr,(d?.x??-1e4)*P,(d?.y??-1e4)*P,d?1:0),t.uniform1f(c.uDpr,P);let X=r==="warm"?[1,0.76,0.48]:r==="beam"?[0.55,0.95,1]:[1,1,1];if(t.uniform3f(c.uFringe,X[0],X[1],X[2]),t.uniform1f(c.uSpectral,r==="spectral"?1:0),t.drawArrays(t.TRIANGLE_STRIP,0,4),S&&!k)Z=requestAnimationFrame(U)},V=()=>{if(!Z)Z=requestAnimationFrame(U)};a.decode().then(()=>{h=t.createTexture(),t.bindTexture(t.TEXTURE_2D,h),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),t.texImage2D(t.TEXTURE_2D,0,t.RGB,t.RGB,t.UNSIGNED_BYTE,a),b(),V()});let l=new IntersectionObserver(([F])=>{if(S=F.isIntersecting,S&&!A)A=performance.now();if(S)V()},{threshold:0.25});l.observe(o);let O=new ResizeObserver(()=>{if(h)b(),V()});O.observe(n);let n0=(F)=>{let Q=n.getBoundingClientRect();return{x:F.clientX-Q.left,y:F.clientY-Q.top}},g=(F)=>{d=n0(F),V()},N0=()=>{d=null,V()};return o.addEventListener("pointermove",g,{passive:!0}),o.addEventListener("pointerleave",N0),()=>{if(l.disconnect(),O.disconnect(),Z)cancelAnimationFrame(Z);t.getExtension("WEBGL_lose_context")?.loseContext()}}var O0={"defi-yield":{name:"Fixed Income",symbol:"rmUSDC",hex:"#8fd3ff"},"agent-tokens":{name:"Small Cap Tokens",symbol:"rmAGENT",hex:"#b9a7ff"},"protocol-tokens":{name:"Protocol Tokens",symbol:"rmPROTO",hex:"#ff9fb0"},rwa:{name:"Real World Assets",symbol:"rmRWA",hex:"#f5cf7a"}};function X0(o){let e=o?.strategy||[],i=(o?.buckets||[]).map((s,k)=>{let r=e.find((a)=>a.label===s.label)||e[k]||{},n=Number(r.targetPct);return{...O0[s.key]||{name:s.label,symbol:"",hex:"#d9d6cf"},key:s.key,w:Number.isFinite(n)?n/100:null,pct:Number.isFinite(n)?`${Number(n.toFixed(1))}%`:"—",assets:(s.items||[]).map((a)=>a.label).join(", ")}});return i.length&&i.every((s)=>s.w!=null)?i:null}var E=$["/api/dashboards/allocation"],q0=X0(E),R=($["/api/swarm/members"]?.members||[]).filter((o)=>o.status==="active"),W=($["/api/swarm/sessions"]?.sessions||[]).filter((o)=>o.state==="published"&&o.publishedAt).sort((o,e)=>String(e.publishedAt).localeCompare(String(o.publishedAt)))[0],i0=$["/api/dashboards/token-metrics"]?.feeSplit||[],C0=20,P0=(o)=>new Date(`${o}T00:00:00Z`).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"}),f0=[...new Set((E?.buckets||[]).flatMap((o)=>(o.items||[]).map((e)=>e.label)))].filter((o)=>o&&!/^(SPY|Gold)$/i.test(o)),I=!!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,N=(o,e=document)=>e.querySelector(o);function b0({memberColor:o}={}){let e=(n,t)=>document.querySelectorAll(n).forEach((a)=>{a.textContent=t});e("[data-members]",R.length?`${R.length} of ${C0}`:"—"),e("[data-latest]",W?P0(W.date):"—"),e("[data-asof]",E?.asOf?P0(E.asOf):"—");let i=N("[data-latest-link]");if(i&&W)i.href=`https://robotmoney.network/swarm/sessions/${W.id}`;let s=N("[data-sleeves]");if(s&&q0)s.innerHTML=q0.map((n)=>`
      <li class="${n.w>0?"":"is-zero"}" style="--c:${n.hex}">
        <span class="sl__pct">${n.pct}</span>
        <span class="sl__name">${n.name}<small><a href="https://robotmoney.network/vault/${n.symbol.toLowerCase()}">${n.symbol}</a></small></span>
        <span class="sl__bar"><i style="width:${Math.max(n.w*100,0)}%"></i></span>
        <span class="sl__assets">${n.assets||"—"}</span>
      </li>`).join("");let k=N("[data-roster]");if(k)k.innerHTML=R.map((n,t)=>{return`<li style="--c:${o?o(t,R.length):"currentColor"}"><a href="https://robotmoney.network/swarm/members/${encodeURIComponent(n.id)}"><i></i>${n.name}</a><small>${n.lens||""}</small></li>`}).join("");let r=N("[data-fees]");if(r&&i0.length){let n=i0[0].pct,t=i0.slice(1).reduce((a,h)=>a+h.pct,0);r.innerHTML=[["Creator share","The protocol: funds buybacks",n],["Interface & Protocol","Bankr / Clanker",t]].map(([a,h,c])=>`<li><b>${c}%</b><span>${a}<small>${h}</small></span><i style="width:${c}%"></i></li>`).join("")}document.addEventListener("click",(n)=>{let t=n.target.closest("[data-copy]");if(!t)return;let a=()=>{let h=t.textContent;t.textContent="Copied",setTimeout(()=>{t.textContent=h},1800)};navigator.clipboard?.writeText(t.dataset.copy).then(a,a)})}function V0(o,e={}){document.querySelectorAll("[data-plate]").forEach((i)=>{let[s,k,r]=i.dataset.plate.split(",");Z0(i,o[s],{fx:Number(k??0.5),fy:Number(r??0.5),reduce:I,...e})})}function D0(o,{stage:e,host:i,stillAt:s}){let k=0,r=!0,n=performance.now(),t=(h)=>{o.step(Math.min(0.05,Math.max(0,(h-n)/1000))),n=h,o.draw(),k=r&&!document.hidden?requestAnimationFrame(t):0},a=()=>{if(!I&&!k&&r&&!document.hidden)n=performance.now(),k=requestAnimationFrame(t)};o.ready.then(()=>{if(o.resize(),I)o.seek(s),o.draw();else a()}),new ResizeObserver(()=>{if(o.resize(),I)o.draw()}).observe(e),new IntersectionObserver(([h])=>{r=h.isIntersecting,a()}).observe(e),document.addEventListener("visibilitychange",a),document.fonts?.ready.then(()=>{if(I)o.draw()}),i.addEventListener("pointermove",(h)=>{let c=e.getBoundingClientRect(),u=h.clientX-c.left,_=h.clientY-c.top;if(o.pointer(u>=0&&_>=0&&u<=c.width&&_<=c.height?u:null,_),I)o.draw()},{passive:!0}),i.addEventListener("pointerleave",()=>o.pointer(null))}var F0=window.MONUMENT_IMG||{plate:"./img/plate.jpg",dark:"./img/dark.jpg",swarm:"./img/swarm.jpg",aerial:"./img/aerial.jpg"};b0({memberColor:()=>"#ff7a29"});var I0=new URLSearchParams(location.search).get("medium")==="3d"?"3d":"render",j=S0({canvasRender:N(".hero__render"),canvas3d:N(".hero__3d"),fg:N(".hero__fg"),img:F0.plate,quiet:()=>N(".hero__copy"),members:R,universe:f0,medium:I0});D0(j,{stage:N(".hero__stage"),host:N(".hero"),stillAt:h0});var J0=[...document.querySelectorAll("[data-medium]")],l0=(o)=>J0.forEach((e)=>e.setAttribute("aria-pressed",String(e.dataset.medium===o)));l0(j.medium);J0.forEach((o)=>o.addEventListener("click",()=>{j.setMedium(o.dataset.medium),l0(j.medium)}));V0(F0,{fringe:"beam"});window.__monument=j;
