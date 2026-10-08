var qe=Math.PI*2,K=(e,a,m)=>e<a?a:e>m?m:e,E=(e)=>e<=0?0:e>=1?1:1-Math.pow(1-e,3),ve=(e,a,m)=>{let h=K((m-e)/(a-e),0,1);return h*h*(3-2*h)},he=(e,a)=>e+Math.random()*(a-e),Y={w:1672,h:941,entry:[0.62,0.45],exit:[0.686,0.45],crystal:[0.6,0.24,0.705,0.63],horizon:0.566},Ue=[["idle",1],["takes",6.5],["converge",1.5],["publish",1.6],["split",1.8],["flow",6.1],["fade",1.5]],b=Ue.reduce((e,[,a])=>e+a,0);function Be(e){let a=(e%b+b)%b,m=0;for(let[h,U]of Ue){if(a<U)return{name:h,p:a/U,at:a,start:m};a-=U,m+=U}return{name:"idle",p:0,at:0,start:0}}function ne(e){let a=0;for(let[m,h]of Ue){if(m===e)return a;a+=h}return 0}function De(e){return[0,0.33,0.67].map((a)=>K(0.55+0.55*Math.cos(qe*(e+a)),0,1))}function fe(e,a,m){let h=e.createShader(a);if(e.shaderSource(h,m),e.compileShader(h),!e.getShaderParameter(h,e.COMPILE_STATUS))throw Error(e.getShaderInfoLog(h)||"shader");return h}function Re({bg:e,fg:a,img:m,quiet:h,onHover:U=()=>{}}){let o=e.getContext("webgl",{antialias:!1,alpha:!1,premultipliedAlpha:!1}),i=a.getContext("2d"),t=new Image;t.src=m;let l,r={},S=null,v=1,f=1,s=1,y=null,A=!1,B=0,T=null,M={x:0,y:0},G=[],$=[],j=[];if(o){l=o.createProgram(),o.attachShader(l,fe(o,o.VERTEX_SHADER,"attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }")),o.attachShader(l,fe(o,o.FRAGMENT_SHADER,`
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uTex;
uniform vec2 uRes;
uniform vec4 uFit;
uniform vec2 uPar;
uniform float uDpr;
uniform float uTime;
uniform vec2 uEntry;
uniform vec2 uExit;
uniform vec2 uSplit;
uniform float uRayEnd;      // where the asset rays end: their nodes
uniform float uHorizon;
uniform vec2 uFade;          // incoming beams fade in between these x
uniform vec4 uIn[28];  // start y, hue, intensity, progress
uniform float uInW[28]; // core width in px
uniform float uCharge;
uniform vec2 uOut;           // progress, intensity
uniform vec4 uRay[9];     // end y, share, progress, present
uniform vec3 uRayCol[9];
uniform float uFlow;
uniform vec4 uCrystal;       // crystal box in image uv: u0, v0, u1, v1
uniform vec3 uPtr;
uniform float uHot;          // index of the beam under the pointer, -1 for none

vec3 spectral(float h) {
  return clamp(0.55 + 0.55 * cos(6.28318 * (h + vec3(0.0, 0.33, 0.67))), 0.0, 1.0);
}

// Distance from q to the drawn part of the segment a->b (0 to p of it), and
// how far along it the closest point sits.
float seg(vec2 q, vec2 a, vec2 b, float p, out float t) {
  vec2 ab = b - a;
  float h = clamp(dot(q - a, ab) / dot(ab, ab), 0.0, p);
  t = h;
  return length(q - (a + ab * h));
}
float beam(float d, float w) {
  return exp(-(d * d) / (w * w)) + 0.28 * exp(-d / (w * 7.0));
}

vec3 light(vec2 q) {
  vec3 L = vec3(0.0);
  float t;
  // Incoming takes.
  if (q.x < uEntry.x + 260.0 * uDpr) {
    float fade = smoothstep(uFade.x, uFade.y, q.x);
    for (int i = 0; i < 28; i++) {
      vec4 b = uIn[i];
      if (b.z <= 0.0 || b.w <= 0.0) continue;
      vec2 a = vec2(0.0, b.x);
      float d = seg(q, a, uEntry, b.w, t);
      float w = uInW[i];
      float hot = abs(float(i) - uHot) < 0.5 ? 2.2 : 1.0;
      float k = beam(d, w) * b.z * hot;
      // The head of a beam still travelling.
      if (b.w < 1.0) {
        vec2 head = a + (uEntry - a) * b.w;
        float r = length(q - head);
        k += 1.6 * exp(-(r * r) / (36.0 * uDpr * uDpr)) * b.z;
      }
      L += spectral(b.y) * k * fade;
    }
  }
  // The allocation: one white beam out of the crystal.
  if (uOut.x > 0.0 && q.x > uExit.x - 260.0 * uDpr) {
    float d = seg(q, uExit, uSplit, uOut.x, t);
    vec3 white = vec3(1.0, 0.985, 0.95);
    L += white * beam(d, 1.9 * uDpr) * 1.35 * uOut.y;
    if (uOut.x < 1.0) {
      vec2 head = uExit + (uSplit - uExit) * uOut.x;
      float r = length(q - head);
      L += white * 2.2 * exp(-(r * r) / (60.0 * uDpr * uDpr));
    }
    // Deposits ride the white beam as packets of light.
    if (uFlow > 0.0) {
      for (int k = 0; k < 4; k++) {
        float s = fract(uTime * 0.32 + float(k) * 0.25);
        vec2 pk = uExit + (uSplit - uExit) * s;
        float r = length(q - pk);
        L += white * 1.8 * uFlow * exp(-(r * r) / (18.0 * uDpr * uDpr));
      }
    }
  }
  // The split: one ray per asset in this loop's mix.
  if (q.x > uSplit.x - 260.0 * uDpr) {
    for (int i = 0; i < 9; i++) {
      vec4 r = uRay[i];
      if (r.w <= 0.0 || r.z <= 0.0) continue;
      vec2 end = vec2(uRayEnd, r.x);
      float d = seg(q, uSplit, end, r.z, t);
      float wgt = r.y;
      // The asset's node at the end of the ray, lit once the ray reaches it.
      float nr = length(q - end);
      float node = smoothstep(0.95, 1.0, r.z) * r.w;
      L += uRayCol[i] * node * (wgt > 0.0 ? 1.4 : 0.35) * exp(-(nr * nr) / (14.0 * uDpr * uDpr));
      float w = (0.6 + 5.0 * sqrt(wgt)) * uDpr;
      float strength = (wgt > 0.0 ? 0.55 + 1.1 * sqrt(wgt) : 0.16) * r.w;
      L += uRayCol[i] * beam(d, w) * strength;
      if (uFlow > 0.0 && wgt > 0.0) {
        for (int k = 0; k < 3; k++) {
          float s = fract(uTime * (0.22 + 0.25 * wgt) + float(k) / 3.0 + float(i) * 0.17);
          if (s > r.z) continue;
          vec2 pk = uSplit + (end - uSplit) * s;
          float rr = length(q - pk);
          L += uRayCol[i] * 1.5 * uFlow * r.w * exp(-(rr * rr) / (16.0 * uDpr * uDpr));
        }
      }
    }
  }
  return L;
}

void main() {
  vec2 q = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 uv = (q - uFit.xy + uPar) / uFit.zw;
  vec3 plate = texture2D(uTex, clamp(uv, vec2(0.001), vec2(0.999))).rgb;

  // The crystal charges: its own highlights brighten and flicker, tinted by
  // the light passing through it.
  float inC = smoothstep(uCrystal.x, uCrystal.x + 0.02, uv.x) * (1.0 - smoothstep(uCrystal.z - 0.02, uCrystal.z, uv.x))
            * smoothstep(uCrystal.y, uCrystal.y + 0.03, uv.y) * (1.0 - smoothstep(uCrystal.w - 0.04, uCrystal.w, uv.y));
  float lum = dot(plate, vec3(0.299, 0.587, 0.114));
  float glint = pow(lum, 2.4) * (0.8 + 0.2 * sin(uTime * 3.1 + uv.y * 9.0));
  vec3 tint = spectral(fract(uv.y * 2.3 + uTime * 0.05));
  vec3 col = plate + inC * uCharge * glint * mix(vec3(1.0), tint, 0.45) * 1.4;

  vec3 L = light(q);
  // The marble mirrors the light, fading with distance from the horizon.
  if (q.y > uHorizon) {
    vec2 m = vec2(q.x, 2.0 * uHorizon - q.y);
    float fall = exp(-(q.y - uHorizon) / (uRes.y * 0.22));
    L += light(m + vec2(sin(q.y * 0.08) * 1.5 * uDpr, 0.0)) * 0.3 * fall;
  }
  L = 1.0 - exp(-L);
  col = col + L * (1.0 - 0.35 * col);

  // The pointer is a faint torch on the scene.
  float pr = length(q - uPtr.xy);
  col += uPtr.z * 0.05 * exp(-(pr * pr) / (160.0 * 160.0 * uDpr * uDpr));
  gl_FragColor = vec4(col, 1.0);
}`)),o.linkProgram(l),o.useProgram(l);let n=o.createBuffer();o.bindBuffer(o.ARRAY_BUFFER,n),o.bufferData(o.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),o.STATIC_DRAW);let c=o.getAttribLocation(l,"a");o.enableVertexAttribArray(c),o.vertexAttribPointer(c,2,o.FLOAT,!1,0,0);for(let u of["uTex","uRes","uFit","uPar","uDpr","uTime","uEntry","uExit","uSplit","uRayEnd","uHorizon","uFade","uIn","uInW","uCharge","uOut","uRay","uRayCol","uFlow","uCrystal","uPtr","uHot"])r[u]=o.getUniformLocation(l,u)}let ce=t.decode().then(()=>{if(!o)return;S=o.createTexture(),o.bindTexture(o.TEXTURE_2D,S);for(let[n,c]of[[o.TEXTURE_MIN_FILTER,o.LINEAR],[o.TEXTURE_MAG_FILTER,o.LINEAR],[o.TEXTURE_WRAP_S,o.CLAMP_TO_EDGE],[o.TEXTURE_WRAP_T,o.CLAMP_TO_EDGE]])o.texParameteri(o.TEXTURE_2D,n,c);o.texImage2D(o.TEXTURE_2D,0,o.RGB,o.RGB,o.UNSIGNED_BYTE,t)});function ee(){let n=G.length?G.slice(0,20):[],c=n.length,u=A?12:22;j=[],n.forEach((D,R)=>{j.push({member:D,y:0.12+0.74*(R+0.5)/c+he(-0.02,0.02),hue:0.02+0.86*R/Math.max(1,c),I:1,w:1.15,order:R/Math.max(1,c)})});for(let D=0;D<u&&j.length<28;D++)j.push({member:null,y:he(0.04,0.96),hue:Math.random(),I:he(0.12,0.24),w:0.7,order:he(0,1)})}function re(){let n=a.getBoundingClientRect();v=Math.max(1,n.width),f=Math.max(1,n.height);let c=A;A=v<720,s=Math.min(window.devicePixelRatio||1,A?1.5:1.6);for(let I of[e,a])I.width=Math.round(v*s),I.height=Math.round(f*s);let u=Math.max(v/Y.w,f/Y.h),D=Y.w*u,R=Y.h*u,q=(Y.crystal[0]+Y.crystal[2])/2,N=A?v*0.62-q*D:v-430-Y.exit[0]*D;if(y={ox:D>v+1?K(N,v-D,0):(v-D)/2,oy:(f-R)*0.5,dw:D,dh:R},!j.length||c!==A)ee(),p.clear()}let W=(n,c)=>({x:y.ox+n*y.dw-M.x*14,y:y.oy+c*y.dh-M.y*8});function se(){let n=W(...Y.exit),c={x:n.x+(A?44:132),y:n.y},u=A?v+40:Math.max(c.x+90,v-150);return{ex:n,split:c,endX:u}}function ue(){let n=h();if(!n)return null;let c=a.getBoundingClientRect(),u=n.getBoundingClientRect();if(u.bottom<c.top||u.top>c.bottom)return null;return{x0:u.left-c.left,x1:u.right-c.left}}function ke(){let n=Be(B),c=ne("takes"),u=(B%b+b)%b,D=u-c,R=n.name==="fade"?1-E(n.p):n.name==="idle"?0:1,q=j.map((_)=>{let P=_.order*4.6+(_.member?0:0.6),O=n.name==="idle"?0:K((D-P)/(_.member?1.25:2.2),0,1);return{..._,p:E(O),k:R}}),N=ne("converge"),X=ne("publish"),I=ne("split"),k=ne("flow"),V=ve(N,N+1.2,u)*(n.name==="fade"?1-E(n.p):1)*(n.name==="idle"?0:1),oe=n.name==="idle"?0:K((u-X)/1.4,0,1),H=n.name==="idle"?0:K((u-I)/1.6,0,1),d=ve(k,k+0.8,u)*(n.name==="fade"?1-E(n.p):1)*(n.name==="idle"?0:1);return{ph:n,IN:q,charge:V,out:E(oe),outI:R,ray:E(H),rayK:R,flow:d}}function _e(n){B+=n;let c=T?T.x/v-0.5:0,u=T?T.y/f-0.5:0;M.x+=(c-M.x)*Math.min(1,n*2.5),M.y+=(u-M.y)*Math.min(1,n*2.5)}let C=-1;function Z(){if(!y||!t.complete)return;let n=ke(),c=W(...Y.entry),{ex:u,split:D,endX:R}=se(),q=J(Math.floor(B/b)),N=q.map((d,_)=>D.y+(q.length>1?_/(q.length-1)*2-1:0)*f*(A?0.2:0.19)),X=ue(),I=X&&!A?[X.x1-20,X.x1+90]:[-1,0];if(o&&S){o.viewport(0,0,e.width,e.height),o.uniform1i(r.uTex,0),o.uniform2f(r.uRes,e.width,e.height),o.uniform4f(r.uFit,y.ox*s,y.oy*s,y.dw*s,y.dh*s),o.uniform2f(r.uPar,M.x*14*s,M.y*8*s),o.uniform1f(r.uDpr,s),o.uniform1f(r.uTime,B),o.uniform2f(r.uEntry,c.x*s,c.y*s),o.uniform2f(r.uExit,u.x*s,u.y*s),o.uniform2f(r.uSplit,D.x*s,D.y*s),o.uniform1f(r.uRayEnd,R*s),o.uniform1f(r.uHorizon,W(0,Y.horizon).y*s),o.uniform2f(r.uFade,I[0]*s,I[1]*s);let d=new Float32Array(112),_=new Float32Array(28);n.IN.forEach((F,Q)=>{d.set([F.y*f*s,F.hue,F.I*F.k,F.p],Q*4),_[Q]=F.w*s}),o.uniform4fv(r.uIn,d),o.uniform1fv(r.uInW,_),o.uniform1f(r.uCharge,n.charge),o.uniform2f(r.uOut,n.out,n.outI);let P=new Float32Array(36),O=new Float32Array(27);q.forEach((F,Q)=>{P.set([N[Q]*s,F.w,n.ray*n.rayK>0?n.ray:0,n.rayK],Q*4),O.set(F.rgb,Q*3)}),o.uniform4fv(r.uRay,P),o.uniform3fv(r.uRayCol,O),o.uniform1f(r.uFlow,n.flow),o.uniform4f(r.uCrystal,...Y.crystal),o.uniform3f(r.uPtr,(T?.x??-1e4)*s,(T?.y??-1e4)*s,T?1:0),o.uniform1f(r.uHot,C),o.drawArrays(o.TRIANGLE_STRIP,0,4)}i.setTransform(s,0,0,s,0,0),i.clearRect(0,0,v,f);let k='500 10px "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',V=(d,_,P,O="left",F="rgba(243,241,236,0.92)",Q=k)=>{i.font=Q;try{i.letterSpacing="0.12em"}catch{}i.textAlign=O,i.fillStyle=F,i.fillText(d,_,P);try{i.letterSpacing="0px"}catch{}},oe=(d,_)=>d.y*f+(c.y-d.y*f)*K(_/c.x,0,1);C=-1;let H=14;if(n.IN.forEach((d,_)=>{if(!d.member)return;let P={x:0,y:d.y*f},O={x:P.x+(c.x-P.x)*d.p,y:P.y+(c.y-P.y)*d.p};if(T){let w=c.x-P.x,L=c.y-P.y,me=K(((T.x-P.x)*w+(T.y-P.y)*L)/(w*w+L*L),0,d.p),te=Math.hypot(T.x-(P.x+w*me),T.y-(P.y+L*me));if(te<H&&d.k>0.3&&T.x>I[1])H=te,C=_}let F=c.x-120;if(d.p>0&&d.p<1&&O.x>I[1]||C===_){let[w,L,me]=De(d.hue).map((Me)=>Math.round(Me*255)),te=C===_?1:1-ve(0.7,1,d.p),Te=C===_&&T?T.x+12:Math.min(O.x,F)-4,Ae=(C===_&&T?T.y:oe(d,Te))-12;if(V(d.member.name.toUpperCase(),Te,Ae,C===_?"left":"right",`rgba(${w},${L},${me},${te})`),d.member.lens)V(d.member.lens,Te,Ae+14,C===_?"left":"right",`rgba(243,241,236,${0.55*te})`,'400 10px "Geist", ui-sans-serif, system-ui')}}),U(C>=0?n.IN[C].member:null),a.style.cursor=C>=0?"pointer":"",n.out>0.6&&!A){let d=K((n.out-0.6)/0.4,0,1)*n.outI,_=u.x+(D.x-u.x)*0.5;V("ONE ALLOCATION",_,u.y+22,"center",`rgba(243,241,236,${0.62*d})`)}if(q.length&&n.ray>0.7&&!A){let d=K((n.ray-0.7)/0.3,0,1)*n.rayK;q.forEach((_,P)=>{let[O,F,Q]=_.rgb.map((w)=>Math.round(w*255));V(_.name.toUpperCase(),R+14,N[P]+4,"left",`rgba(${O},${F},${Q},${0.9*d})`)}),V("Any mix of liquid, permissionless assets on Base",v-28,N[N.length-1]+40,"right",`rgba(243,241,236,${0.5*d})`,'400 11px "Geist", ui-sans-serif, system-ui')}}let p=new Map;function J(n){if(!$.length)return[];if(p.has(n))return p.get(n);let c=n*2654435761+12345>>>0,u=()=>{c=c+1831565813>>>0;let k=c;return k=Math.imul(k^k>>>15,k|1),k^=k+Math.imul(k^k>>>7,k|61),((k^k>>>14)>>>0)/4294967296},D=Math.min($.length,A?5:7),R=$.slice();for(let k=R.length-1;k>0;k--){let V=Math.floor(u()*(k+1));[R[k],R[V]]=[R[V],R[k]]}let q=R.slice(0,D).map(()=>Math.pow(-Math.log(1-u()*0.999),1.7)),N=q.reduce((k,V)=>k+V,0),X=u(),I=R.slice(0,D).map((k,V)=>{let oe=(X+V/D*0.82)%1;return{name:k,w:q[V]/N,rgb:De(oe).map((H)=>0.35+0.65*H)}});if(p.set(n,I),p.size>8)p.delete(p.keys().next().value);return I}return{ready:ce,webgl:!!o,resize(){re()},step:_e,draw:Z,setMembers(n){G=n,ee()},setUniverse(n){$=n,p.clear()},pointer(n,c){T=n==null?null:{x:n,y:c}},seek(n){B=n},get time(){return B},hotMember(){return C>=0?j[C]?.member:null},destroy(){o?.getExtension("WEBGL_lose_context")?.loseContext()}}}var ae={"/api/dashboards/allocation":{strategy:[{label:"Conservative DeFi Yield",targetPct:95},{label:"Agent Tokens",targetPct:5},{label:"Protocol Tokens",targetPct:0},{label:"Real World Assets",targetPct:0}],buckets:[{key:"defi-yield",label:"Conservative DeFi Yield",items:[{label:"Aave",targetPct:25},{label:"Morpho",targetPct:25},{label:"Compound",targetPct:25},{label:"Sky",targetPct:25}]},{key:"agent-tokens",label:"Agent Tokens",items:[{label:"RobotMoney",targetPct:14.29},{label:"Juno",targetPct:14.29},{label:"Woon",targetPct:14.29},{label:"Peaq",targetPct:14.29},{label:"Zyfai",targetPct:14.29},{label:"Giza",targetPct:14.28},{label:"DEUS",targetPct:14.27}]},{key:"protocol-tokens",label:"Protocol Tokens",items:[{label:"BTC",targetPct:33.33},{label:"ETH",targetPct:33.33},{label:"HYPE",targetPct:33.34}]},{key:"rwa",label:"Real World Assets",items:[{label:"SPY",targetPct:50},{label:"Gold",targetPct:50}]}],asOf:"2026-06-02",source:"stub",managed:!0},"/api/swarm/members":{members:[{id:"athena",status:"active",name:"Athena",tagline:null,lens:"macro risk",mandate:null,biases:null,voiceMd:null,mode:null,operator:null,avatar:null,appliedAt:null,activatedAt:null},{id:"boreas",status:"active",name:"Boreas",tagline:null,lens:"on-chain flows",mandate:null,biases:null,voiceMd:null,mode:null,operator:null,avatar:null,appliedAt:null,activatedAt:null},{id:"cygnus",status:"active",name:"Cygnus",tagline:null,lens:"momentum",mandate:null,biases:null,voiceMd:null,mode:null,operator:null,avatar:null,appliedAt:null,activatedAt:null},{id:"draco",status:"active",name:"Draco",tagline:null,lens:"contrarian",mandate:null,biases:null,voiceMd:null,mode:null,operator:null,avatar:null,appliedAt:null,activatedAt:null},{id:"helios",status:"active",name:"Helios",tagline:null,lens:"liquidity",mandate:null,biases:null,voiceMd:null,mode:null,operator:null,avatar:null,appliedAt:"2026-07-09T12:02:38.687Z",activatedAt:"2026-07-09T12:02:49.927Z"}]},"/api/swarm/sessions":{sessions:[{id:"2344ca37-2c64-450f-9fe6-a31302ef476d",date:"2026-07-10",subjectId:"woon",subjectName:"Woon Treasury",state:"published",windowClosesAt:"2026-07-09T13:04:15.399Z",publishedAt:"2026-07-09T12:04:21.451Z",regimeSummary:{regime:"risk_on",history:[{date:"2026-06-27",macro:0.5446,factor:0.4329,regime:"risk_on",onchain:0.5785,composite:0.5615},{date:"2026-06-28",macro:0.5773,factor:0.4127,regime:"risk_on",onchain:0.625,composite:0.6011},{date:"2026-06-29",macro:0.6429,factor:0.3821,regime:"risk_on",onchain:0.6501,composite:0.6465},{date:"2026-06-30",macro:0.678,factor:0.3409,regime:"risk_on",onchain:0.6309,composite:0.6544},{date:"2026-07-01",macro:0.6772,factor:0.301,regime:"risk_on",onchain:0.5758,composite:0.6265},{date:"2026-07-02",macro:0.6855,factor:0.3567,regime:"risk_on",onchain:0.5969,composite:0.6412},{date:"2026-07-03",macro:0.6853,factor:0.4341,regime:"risk_on",onchain:0.6081,composite:0.6467},{date:"2026-07-04",macro:0.6467,factor:0.3923,regime:"risk_on",onchain:0.5959,composite:0.6213},{date:"2026-07-05",macro:0.6242,factor:0.3895,regime:"risk_on",onchain:0.5645,composite:0.5944},{date:"2026-07-06",macro:0.5704,factor:0.3492,regime:"risk_on",onchain:0.5254,composite:0.5479},{date:"2026-07-07",macro:0.5726,factor:0.3644,regime:"risk_on",onchain:0.5369,composite:0.5548},{date:"2026-07-08",macro:0.4993,factor:0.4108,regime:"risk_on",onchain:0.5467,composite:0.523},{date:"2026-07-09",macro:0.5463,factor:0.4132,regime:"risk_on",onchain:0.5041,composite:0.5252},{date:"2026-07-10",macro:0.5431,factor:0.4131,regime:"risk_on",onchain:0.5052,composite:0.5241}],composite:0.5241,macro_regime:"neutral",factor_regime:"risk_off",onchain_regime:"neutral",macro_percentile:0.5776,factor_percentile:0.1164,onchain_percentile:0.5411,composite_percentile:0.6151},subjectSnapshotTotalValueUsd:44167.4,synthesis:"The swarm reads composite 0.524 at the 62th percentile — risk-on by label, with the panel spread the load-bearing signal rather than the headline level. Across 4/5 submitted takes the stance distribution is 2 cautious, 1 neutral, 1 bullish at 57% mean confidence, with 1 absent. All present members hold the 95/5/0/0 conservative allocation mandate and sequence the 5% Agent Tokens floor (via rmUSDC) ahead of any structural trim of Woon Treasury.",swarmRecommendation:{type:"position_actions",absent:["draco"],quorum:{absent:1,active:5,submitted:4,participation:0.8},actions:[{token:"USDC",action:"rotate",rationale:"Route the next stable tranche into rmUSDC to clear the 5% Agent Tokens floor."},{token:"rmUSDC",action:"add",rationale:"Vault receipt is the Agent Tokens exposure — top up to the mandated 5% floor."}],stances:{bullish:1,neutral:1,cautious:2},consensus:["Regime composite 0.524 sits at the 62th percentile — risk-on by label.","Swarm holds the 95/5/0/0 mandate (Conservative DeFi Yield / Agent Tokens / Protocol / RWA); composite at the 62th does not license a tilt.","Floor-first sequencing — clear the 5% Agent Tokens sleeve via rmUSDC before any structural trim.","4/5 members submitted this session (2 cautious, 1 neutral, 1 bullish)."],rationale:"Swarm holds 95/5/0/0 with composite at the 62th percentile (risk-on); the load-bearing action is routing the next stable tranche into rmUSDC to clear the 5% Agent Tokens floor before any structural trim.",disagreements:[{topic:"Weight of the on-chain panel in the Woon Treasury read",positions:[{view:"bullish — reads the divergence as downstream of agent deployment; would fund the Agent Tokens sleeve now.",member_id:"cygnus"},{view:"cautious — conservative compositor reads nominal risk-on, effective neutral; no tilt licensed.",member_id:"helios"}],what_settles:"On-chain panel crossing the 50th percentile for five consecutive sessions, or composite breaching 0.40."}],meanConfidence:0.575},socialDraftId:null,generatedAt:"2026-07-09T12:04:13.376Z"},{id:"a598270e-ef0f-4bca-b24e-3e143e9c424a",date:"2026-07-09",subjectId:"mav",subjectName:"Mav Holdings",state:"published",windowClosesAt:"2026-07-09T13:02:53.159Z",publishedAt:"2026-07-09T12:02:59.205Z",regimeSummary:{regime:"risk_on",history:[{date:"2026-06-26",macro:0.5205,factor:0.4704,regime:"risk_on",onchain:0.5571,composite:0.5388},{date:"2026-06-27",macro:0.5446,factor:0.4329,regime:"risk_on",onchain:0.5785,composite:0.5615},{date:"2026-06-28",macro:0.5773,factor:0.4127,regime:"risk_on",onchain:0.625,composite:0.6011},{date:"2026-06-29",macro:0.6429,factor:0.3821,regime:"risk_on",onchain:0.6501,composite:0.6465},{date:"2026-06-30",macro:0.678,factor:0.3409,regime:"risk_on",onchain:0.6309,composite:0.6544},{date:"2026-07-01",macro:0.6772,factor:0.301,regime:"risk_on",onchain:0.5758,composite:0.6265},{date:"2026-07-02",macro:0.6855,factor:0.3567,regime:"risk_on",onchain:0.5969,composite:0.6412},{date:"2026-07-03",macro:0.6853,factor:0.4341,regime:"risk_on",onchain:0.6081,composite:0.6467},{date:"2026-07-04",macro:0.6467,factor:0.3923,regime:"risk_on",onchain:0.5959,composite:0.6213},{date:"2026-07-05",macro:0.6242,factor:0.3895,regime:"risk_on",onchain:0.5645,composite:0.5944},{date:"2026-07-06",macro:0.5704,factor:0.3492,regime:"risk_on",onchain:0.5254,composite:0.5479},{date:"2026-07-07",macro:0.5726,factor:0.3644,regime:"risk_on",onchain:0.5369,composite:0.5548},{date:"2026-07-08",macro:0.4993,factor:0.4108,regime:"risk_on",onchain:0.5467,composite:0.523},{date:"2026-07-09",macro:0.5437,factor:0.4126,regime:"risk_on",onchain:0.504,composite:0.5239}],composite:0.5239,macro_regime:"neutral",factor_regime:"risk_off",onchain_regime:"risk_on",macro_percentile:0.5804,factor_percentile:0.1155,onchain_percentile:0.5365,composite_percentile:0.6151},subjectSnapshotTotalValueUsd:38000,synthesis:"The swarm reads composite 0.524 at the 62th percentile — risk-on by label, with the panel spread the load-bearing signal rather than the headline level. Across 4/5 submitted takes the stance distribution is 2 cautious, 1 bullish, 1 neutral at 58% mean confidence, with 1 absent. All present members hold the 95/5/0/0 conservative allocation mandate and sequence the 5% Agent Tokens floor (via rmUSDC) ahead of any structural trim of Mav Holdings.",swarmRecommendation:{type:"position_actions",absent:["draco"],quorum:{absent:1,active:5,submitted:4,participation:0.8},actions:[{token:"USDC",action:"rotate",rationale:"Route the next stable tranche into rmUSDC to clear the 5% Agent Tokens floor."},{token:"rmUSDC",action:"add",rationale:"Vault receipt is the Agent Tokens exposure — top up to the mandated 5% floor."}],stances:{bullish:1,neutral:1,cautious:2},consensus:["Regime composite 0.524 sits at the 62th percentile — risk-on by label.","Swarm holds the 95/5/0/0 mandate (Conservative DeFi Yield / Agent Tokens / Protocol / RWA); composite at the 62th does not license a tilt.","Floor-first sequencing — clear the 5% Agent Tokens sleeve via rmUSDC before any structural trim.","4/5 members submitted this session (2 cautious, 1 bullish, 1 neutral)."],rationale:"Swarm holds 95/5/0/0 with composite at the 62th percentile (risk-on); the load-bearing action is routing the next stable tranche into rmUSDC to clear the 5% Agent Tokens floor before any structural trim.",disagreements:[{topic:"Weight of the on-chain panel in the Mav Holdings read",positions:[{view:"bullish — reads the divergence as downstream of agent deployment; would fund the Agent Tokens sleeve now.",member_id:"cygnus"},{view:"cautious — conservative compositor reads nominal risk-on, effective neutral; no tilt licensed.",member_id:"helios"}],what_settles:"On-chain panel crossing the 50th percentile for five consecutive sessions, or composite breaching 0.40."}],meanConfidence:0.5750000000000001},socialDraftId:null,generatedAt:"2026-07-09T12:02:51.130Z"},{id:"4a0bcc21-930c-4edf-9d90-9e7a5a6fde7d",date:"2026-07-09",subjectId:"woon",subjectName:"Woon Treasury",state:"published",windowClosesAt:"2026-07-09T13:01:53.671Z",publishedAt:"2026-07-09T12:01:59.739Z",regimeSummary:{regime:"risk_on",history:[{date:"2026-06-26",macro:0.5205,factor:0.4704,regime:"risk_on",onchain:0.5571,composite:0.5388},{date:"2026-06-27",macro:0.5446,factor:0.4329,regime:"risk_on",onchain:0.5785,composite:0.5615},{date:"2026-06-28",macro:0.5773,factor:0.4127,regime:"risk_on",onchain:0.625,composite:0.6011},{date:"2026-06-29",macro:0.6429,factor:0.3821,regime:"risk_on",onchain:0.6501,composite:0.6465},{date:"2026-06-30",macro:0.678,factor:0.3409,regime:"risk_on",onchain:0.6309,composite:0.6544},{date:"2026-07-01",macro:0.6772,factor:0.301,regime:"risk_on",onchain:0.5758,composite:0.6265},{date:"2026-07-02",macro:0.6855,factor:0.3567,regime:"risk_on",onchain:0.5969,composite:0.6412},{date:"2026-07-03",macro:0.6853,factor:0.4341,regime:"risk_on",onchain:0.6081,composite:0.6467},{date:"2026-07-04",macro:0.6467,factor:0.3923,regime:"risk_on",onchain:0.5959,composite:0.6213},{date:"2026-07-05",macro:0.6242,factor:0.3895,regime:"risk_on",onchain:0.5645,composite:0.5944},{date:"2026-07-06",macro:0.5704,factor:0.3492,regime:"risk_on",onchain:0.5254,composite:0.5479},{date:"2026-07-07",macro:0.5726,factor:0.3644,regime:"risk_on",onchain:0.5369,composite:0.5548},{date:"2026-07-08",macro:0.4993,factor:0.4108,regime:"risk_on",onchain:0.5467,composite:0.523},{date:"2026-07-09",macro:0.5437,factor:0.4126,regime:"risk_on",onchain:0.504,composite:0.5239}],composite:0.5239,macro_regime:"neutral",factor_regime:"risk_off",onchain_regime:"risk_on",macro_percentile:0.5804,factor_percentile:0.1155,onchain_percentile:0.5365,composite_percentile:0.6151},subjectSnapshotTotalValueUsd:44167.4,synthesis:"The swarm reads composite 0.524 at the 62th percentile — risk-on by label, with the panel spread the load-bearing signal rather than the headline level. Across 3/4 submitted takes the stance distribution is 1 neutral, 1 cautious, 1 bullish at 58% mean confidence, with 1 absent. All present members hold the 95/5/0/0 conservative allocation mandate and sequence the 5% Agent Tokens floor (via rmUSDC) ahead of any structural trim of Woon Treasury.",swarmRecommendation:{type:"position_actions",absent:["draco"],quorum:{absent:1,active:4,submitted:3,participation:0.75},actions:[{token:"USDC",action:"rotate",rationale:"Route the next stable tranche into rmUSDC to clear the 5% Agent Tokens floor."},{token:"rmUSDC",action:"add",rationale:"Vault receipt is the Agent Tokens exposure — top up to the mandated 5% floor."}],stances:{bullish:1,neutral:1,cautious:1},consensus:["Regime composite 0.524 sits at the 62th percentile — risk-on by label.","Swarm holds the 95/5/0/0 mandate (Conservative DeFi Yield / Agent Tokens / Protocol / RWA); composite at the 62th does not license a tilt.","Floor-first sequencing — clear the 5% Agent Tokens sleeve via rmUSDC before any structural trim.","3/4 members submitted this session (1 neutral, 1 cautious, 1 bullish)."],rationale:"Swarm holds 95/5/0/0 with composite at the 62th percentile (risk-on); the load-bearing action is routing the next stable tranche into rmUSDC to clear the 5% Agent Tokens floor before any structural trim.",disagreements:[{topic:"Weight of the on-chain panel in the Woon Treasury read",positions:[{view:"bullish — reads the divergence as downstream of agent deployment; would fund the Agent Tokens sleeve now.",member_id:"cygnus"},{view:"cautious — conservative compositor reads nominal risk-on, effective neutral; no tilt licensed.",member_id:"athena"}],what_settles:"On-chain panel crossing the 50th percentile for five consecutive sessions, or composite breaching 0.40."}],meanConfidence:0.5833333333333334},socialDraftId:null,generatedAt:"2026-07-09T12:01:51.632Z"}]},"/api/dashboards/token-metrics":{robotmoney:{priceUsd:0.00001,totalSupply:55000000000,marketCapUsd:550000},feeSplit:[{label:"Protocol",pct:57},{label:"Bankr",pct:40},{label:"Clanker",pct:3}],asOf:"2026-07-10T16:07:35.538Z",source:"stub",stale:!1}};var Je=(e,a,m)=>e<a?a:e>m?m:e;function Ze(e,a,{fx:m=0.5,fy:h=0.5,reduce:U=!1,fringe:o="spectral"}={}){let i=e.querySelector("canvas"),t=i.getContext("webgl",{antialias:!1,alpha:!1}),l=new Image;l.src=a;let r=null,S={},v=1,f=1,s=1,y=null,A=null,B=0,T=0,M=!1,G={x:0,y:0};if(!t)return e.style.backgroundImage=`url("${a}")`,e.style.backgroundSize="cover",i.remove(),()=>{};let $=(Z,p)=>{let J=t.createShader(Z);return t.shaderSource(J,p),t.compileShader(J),J},j=t.createProgram();t.attachShader(j,$(t.VERTEX_SHADER,"attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }")),t.attachShader(j,$(t.FRAGMENT_SHADER,`
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
}`)),t.linkProgram(j),t.useProgram(j),t.bindBuffer(t.ARRAY_BUFFER,t.createBuffer()),t.bufferData(t.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),t.STATIC_DRAW);let ce=t.getAttribLocation(j,"a");t.enableVertexAttribArray(ce),t.vertexAttribPointer(ce,2,t.FLOAT,!1,0,0);for(let Z of["uTex","uRes","uFit","uPar","uReveal","uTime","uPtr","uDpr","uFringe","uSpectral"])S[Z]=t.getUniformLocation(j,Z);let ee=()=>{let Z=i.getBoundingClientRect();v=Math.max(1,Z.width),f=Math.max(1,Z.height),s=Math.min(window.devicePixelRatio||1,1.6),i.width=Math.round(v*s),i.height=Math.round(f*s);let p=l.naturalWidth||1672,J=l.naturalHeight||941,n=Math.max(v/p,f/J)*1.04,c=p*n,u=J*n;y={ox:(v-c)*m,oy:(f-u)*h,dw:c,dh:u}},re=(Z)=>{if(T=0,!r)return;let p=U?1:B?Je((Z-B)/1600,0,1):0,J=A?{x:A.x/v-0.5,y:A.y/f-0.5}:{x:0,y:0};G.x+=(J.x*18-G.x)*0.08,G.y+=(J.y*10-G.y)*0.08,t.viewport(0,0,i.width,i.height),t.uniform1i(S.uTex,0),t.uniform2f(S.uRes,i.width,i.height),t.uniform4f(S.uFit,y.ox*s,y.oy*s,y.dw*s,y.dh*s),t.uniform2f(S.uPar,G.x*s,G.y*s),t.uniform1f(S.uReveal,p>=1?1.0001:p),t.uniform1f(S.uTime,U?0:Z/1000),t.uniform3f(S.uPtr,(A?.x??-1e4)*s,(A?.y??-1e4)*s,A?1:0),t.uniform1f(S.uDpr,s);let n=o==="warm"?[1,0.76,0.48]:o==="beam"?[0.55,0.95,1]:[1,1,1];if(t.uniform3f(S.uFringe,n[0],n[1],n[2]),t.uniform1f(S.uSpectral,o==="spectral"?1:0),t.drawArrays(t.TRIANGLE_STRIP,0,4),M&&!U)T=requestAnimationFrame(re)},W=()=>{if(!T)T=requestAnimationFrame(re)};l.decode().then(()=>{r=t.createTexture(),t.bindTexture(t.TEXTURE_2D,r),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),t.texImage2D(t.TEXTURE_2D,0,t.RGB,t.RGB,t.UNSIGNED_BYTE,l),ee(),W()});let se=new IntersectionObserver(([Z])=>{if(M=Z.isIntersecting,M&&!B)B=performance.now();if(M)W()},{threshold:0.25});se.observe(e);let ue=new ResizeObserver(()=>{if(r)ee(),W()});ue.observe(i);let ke=(Z)=>{let p=i.getBoundingClientRect();return{x:Z.clientX-p.left,y:Z.clientY-p.top}},_e=(Z)=>{A=ke(Z),W()},C=()=>{A=null,W()};return e.addEventListener("pointermove",_e,{passive:!0}),e.addEventListener("pointerleave",C),()=>{if(se.disconnect(),ue.disconnect(),T)cancelAnimationFrame(T);t.getExtension("WEBGL_lose_context")?.loseContext()}}var Ne={"defi-yield":{name:"Fixed Income",symbol:"rmUSDC",hex:"#8fd3ff"},"agent-tokens":{name:"Small Cap Tokens",symbol:"rmAGENT",hex:"#b9a7ff"},"protocol-tokens":{name:"Protocol Tokens",symbol:"rmPROTO",hex:"#ff9fb0"},rwa:{name:"Real World Assets",symbol:"rmRWA",hex:"#f5cf7a"}};function Oe(e){let a=e?.strategy||[],m=(e?.buckets||[]).map((h,U)=>{let o=a.find((l)=>l.label===h.label)||a[U]||{},i=Number(o.targetPct);return{...Ne[h.key]||{name:h.label,symbol:"",hex:"#d9d6cf"},key:h.key,w:Number.isFinite(i)?i/100:null,pct:Number.isFinite(i)?`${Number(i.toFixed(1))}%`:"—",assets:(h.items||[]).map((l)=>l.label).join(", ")}});return m.length&&m.every((h)=>h.w!=null)?m:null}var de=ae["/api/dashboards/allocation"],pe=Oe(de),x=(ae["/api/swarm/members"]?.members||[]).filter((e)=>e.status==="active"),le=(ae["/api/swarm/sessions"]?.sessions||[]).filter((e)=>e.state==="published"&&e.publishedAt).sort((e,a)=>String(a.publishedAt).localeCompare(String(e.publishedAt)))[0],Se=ae["/api/dashboards/token-metrics"]?.feeSplit||[],Qe=20,Pe=(e)=>new Date(`${e}T00:00:00Z`).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"}),ye=[...new Set((de?.buckets||[]).flatMap((e)=>(e.items||[]).map((a)=>a.label)))].filter((e)=>e&&!/^(SPY|Gold)$/i.test(e)),g=!!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,z=(e,a=document)=>a.querySelector(e);function Ce({memberColor:e}={}){let a=(i,t)=>document.querySelectorAll(i).forEach((l)=>{l.textContent=t});a("[data-members]",x.length?`${x.length} of ${Qe}`:"—"),a("[data-latest]",le?Pe(le.date):"—"),a("[data-asof]",de?.asOf?Pe(de.asOf):"—");let m=z("[data-latest-link]");if(m&&le)m.href=`https://robotmoney.network/swarm/sessions/${le.id}`;let h=z("[data-sleeves]");if(h&&pe)h.innerHTML=pe.map((i)=>`
      <li class="${i.w>0?"":"is-zero"}" style="--c:${i.hex}">
        <span class="sl__pct">${i.pct}</span>
        <span class="sl__name">${i.name}<small><a href="https://robotmoney.network/vault/${i.symbol.toLowerCase()}">${i.symbol}</a></small></span>
        <span class="sl__bar"><i style="width:${Math.max(i.w*100,0)}%"></i></span>
        <span class="sl__assets">${i.assets||"—"}</span>
      </li>`).join("");let U=z("[data-roster]");if(U)U.innerHTML=x.map((i,t)=>{return`<li style="--c:${e?e(t,x.length):"currentColor"}"><a href="https://robotmoney.network/swarm/members/${encodeURIComponent(i.id)}"><i></i>${i.name}</a><small>${i.lens||""}</small></li>`}).join("");let o=z("[data-fees]");if(o&&Se.length){let i=Se[0].pct,t=Se.slice(1).reduce((l,r)=>l+r.pct,0);o.innerHTML=[["Creator share","The protocol: funds buybacks",i],["Interface & Protocol","Bankr / Clanker",t]].map(([l,r,S])=>`<li><b>${S}%</b><span>${l}<small>${r}</small></span><i style="width:${S}%"></i></li>`).join("")}document.addEventListener("click",(i)=>{let t=i.target.closest("[data-copy]");if(!t)return;let l=()=>{let r=t.textContent;t.textContent="Copied",setTimeout(()=>{t.textContent=r},1800)};navigator.clipboard?.writeText(t.dataset.copy).then(l,l)})}function Ve(e,a={}){document.querySelectorAll("[data-plate]").forEach((m)=>{let[h,U,o]=m.dataset.plate.split(",");Ze(m,e[h],{fx:Number(U??0.5),fy:Number(o??0.5),reduce:g,...a})})}function Fe(e,{stage:a,host:m,stillAt:h}){let U=0,o=!0,i=performance.now(),t=(r)=>{e.step(Math.min(0.05,Math.max(0,(r-i)/1000))),i=r,e.draw(),U=o&&!document.hidden?requestAnimationFrame(t):0},l=()=>{if(!g&&!U&&o&&!document.hidden)i=performance.now(),U=requestAnimationFrame(t)};e.ready.then(()=>{if(e.resize(),g)e.seek(h),e.draw();else l()}),new ResizeObserver(()=>{if(e.resize(),g)e.draw()}).observe(a),new IntersectionObserver(([r])=>{o=r.isIntersecting,l()}).observe(a),document.addEventListener("visibilitychange",l),document.fonts?.ready.then(()=>{if(g)e.draw()}),m.addEventListener("pointermove",(r)=>{let S=a.getBoundingClientRect(),v=r.clientX-S.left,f=r.clientY-S.top;if(e.pointer(v>=0&&f>=0&&v<=S.width&&f<=S.height?v:null,f),g)e.draw()},{passive:!0}),m.addEventListener("pointerleave",()=>e.pointer(null))}var je=window.PRISM_IMG||{plate:"./img/plate.jpg",idle:"./img/idle.jpg",consensus:"./img/consensus.jpg",vaults:"./img/vaults.jpg"};Ce({memberColor:(e,a)=>{let m=0.02+0.86*e/Math.max(1,a);return`rgb(${[0,0.33,0.67].map((U)=>Math.round(Math.min(1,Math.max(0,0.55+0.55*Math.cos(6.28318*(m+U))))*255)).join(",")})`}});var ie=Re({bg:z(".hero__bg"),fg:z(".hero__fg"),img:je.plate,quiet:()=>z(".hero__copy")});ie.setMembers(x);ie.setUniverse(ye);Fe(ie,{stage:z(".hero__stage"),host:z(".hero"),stillAt:14.5});z(".hero__fg").addEventListener("click",()=>{let e=ie.hotMember();if(e)window.open(`https://robotmoney.network/swarm/members/${encodeURIComponent(e.id)}`,"_blank","noopener")});Ve(je,{fringe:"spectral"});window.__prism=ie;
