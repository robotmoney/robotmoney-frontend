// Alpine.data factory for the hero's generative "substrate" canvas. p5 sketch
// ported verbatim from the original SubstrateEffect in src/app/page.tsx. No Web
// Components: Alpine's init()/destroy() lifecycle starts and tears down p5 (so
// the canvas is cleaned up on SPA view changes). p5 is the global from the CDN
// <script>; we render into the element this x-data is attached to.
export function registerSubstrate(Alpine) {
  Alpine.data("substrate", () => ({
    _p5: null,
    _p5Timer: null,
    _destroyed: false,
    _observer: null,
    init() {
      this._destroyed = false;
      const host = this.$el;
      host.innerHTML =
        '<div class="substrate__canvas" style="position:absolute;inset:0"></div>' +
        '<div class="substrate__overlay" style="position:absolute;inset:0;pointer-events:none;background-color:rgb(10,10,15);opacity:0"></div>';
      const container = host.querySelector(".substrate__canvas");
      const overlay = host.querySelector(".substrate__overlay");
      const startWhenReady = () => {
        if (this._destroyed) return;
        if (window.p5) this._start(container, overlay);
        else this._p5Timer = setTimeout(startWhenReady, 50);
      };
      startWhenReady();
    },
    destroy() {
      this._destroyed = true;
      clearTimeout(this._p5Timer);
      this._p5Timer = null;
      if (this._p5) { this._p5.remove(); this._p5 = null; }
      if (this._observer) this._observer.disconnect();
    },
    _start(container, overlay) {
      const p5Constructor = window.p5;
      const intensity = 81, speed = 6.0, fadeSec = 4, lineW = 1.1, dotSize = 36;
      const ACCENT = [0, 229, 255], BG = [10, 10, 15];

      const sketch = (p) => {
        let W, H, cgrid, cracks = [], numCracks = 0, maxCracks;
        let phase = 0, fadeTimer = 0, generation = 0, stasisFrames = 0, crackLayer;

        function Crack() {
          this.x = 0; this.y = 0; this.t = 0; this.alive = true;
          this.findStart = function () {
            for (let attempt = 0; attempt < 5000; attempt++) {
              let px = Math.floor(p.random(W));
              let py = Math.floor(p.random(H));
              if (cgrid[py * W + px] < 10000) {
                let a = cgrid[py * W + px];
                if (p.random(100) < 50) a -= 90 + Math.floor(p.random(-2, 3));
                else a += 90 + Math.floor(p.random(-2, 3));
                this.x = px + 0.61 * Math.cos((a * Math.PI) / 180);
                this.y = py + 0.61 * Math.sin((a * Math.PI) / 180);
                this.t = a;
                return;
              }
            }
            this.alive = false;
          };
          this.move = function () {
            this.x += 0.42 * Math.cos((this.t * Math.PI) / 180);
            this.y += 0.42 * Math.sin((this.t * Math.PI) / 180);
            let z = 0.33;
            let cx = Math.floor(this.x + p.random(-z, z));
            let cy = Math.floor(this.y + p.random(-z, z));
            crackLayer.stroke(120, 120, 120, 160);
            crackLayer.strokeWeight(lineW);
            crackLayer.point(this.x + p.random(-z, z), this.y + p.random(-z, z));
            if (cx >= 0 && cx < W && cy >= 0 && cy < H) {
              if (cgrid[cy * W + cx] > 10000 || Math.abs(cgrid[cy * W + cx] - this.t) < 5) {
                cgrid[cy * W + cx] = Math.floor(this.t);
              } else if (Math.abs(cgrid[cy * W + cx] - this.t) > 2) {
                this.alive = false; spawnCrack(); spawnCrack();
              }
            } else { this.alive = false; spawnCrack(); }
          };
          this.findStart();
        }
        function spawnCrack() {
          if (phase !== 0) return;
          if (numCracks >= maxCracks) return;
          cracks[numCracks] = new Crack();
          numCracks++;
        }
        function initGeneration() {
          cgrid = new Int32Array(W * H).fill(10001);
          cracks = []; numCracks = 0; stasisFrames = 0;
          maxCracks = Math.max(5, Math.round(W * (intensity / 100)));
          let seeds = Math.max(3, Math.round(maxCracks * 0.1));
          for (let k = 0; k < seeds; k++) {
            let px = Math.floor(p.random(W));
            let py = Math.floor(p.random(H));
            cgrid[py * W + px] = Math.floor(p.random(360));
          }
          for (let k = 0; k < Math.min(8, maxCracks); k++) spawnCrack();
          generation++;
        }
        p.setup = function () {
          W = container.offsetWidth; H = container.offsetHeight;
          p.pixelDensity(1);
          p.createCanvas(W, H).style("display", "block");
          crackLayer = p.createGraphics(W, H);
          crackLayer.pixelDensity(1);
          crackLayer.background(BG[0], BG[1], BG[2]);
          phase = 0; fadeTimer = 0; generation = 0;
          overlay.style.opacity = "0"; overlay.style.transition = "none";
          initGeneration();
        };
        p.windowResized = function () {
          if (!container) return;
          W = container.offsetWidth; H = container.offsetHeight;
          p.resizeCanvas(W, H);
          crackLayer = p.createGraphics(W, H);
          crackLayer.pixelDensity(1);
          crackLayer.background(BG[0], BG[1], BG[2]);
          overlay.style.opacity = "0"; overlay.style.transition = "none";
          initGeneration();
        };
        p.draw = function () {
          p.background(BG[0], BG[1], BG[2]);
          p.image(crackLayer, 0, 0);
          if (phase === 0) {
            let steps = Math.max(1, Math.round(speed));
            for (let s = 0; s < steps; s++) {
              let moved = 0;
              for (let n = 0; n < numCracks; n++) {
                if (cracks[n].alive) { cracks[n].move(); moved++; }
              }
              if (moved === 0) stasisFrames++;
            }
            p.noStroke();
            for (let n = 0; n < numCracks; n++) {
              if (!cracks[n].alive) continue;
              p.fill(ACCENT[0], ACCENT[1], ACCENT[2], 40);
              p.ellipse(cracks[n].x, cracks[n].y, dotSize);
              p.fill(ACCENT[0], ACCENT[1], ACCENT[2], 200);
              p.ellipse(cracks[n].x, cracks[n].y, dotSize * 0.35);
            }
            if (stasisFrames > 30) {
              phase = 1; fadeTimer = 0;
              overlay.style.transition = `opacity ${fadeSec}s ease`;
              overlay.style.opacity = "1";
            }
          } else {
            fadeTimer++;
            let fadeProgress = fadeTimer / (fadeSec * 60);
            if (fadeProgress >= 1) {
              crackLayer.background(BG[0], BG[1], BG[2]);
              p.background(BG[0], BG[1], BG[2]);
              phase = 0; fadeTimer = 0; initGeneration();
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  overlay.style.transition = "none";
                  overlay.style.opacity = "0";
                });
              });
            }
          }
        };
      };

      this._p5 = new p5Constructor(sketch, container);
      this._observer = new IntersectionObserver(
        (entries) => entries.forEach((e) => {
          if (!this._p5) return;
          if (e.isIntersecting) this._p5.loop(); else this._p5.noLoop();
        }),
        { threshold: 0.1 },
      );
      this._observer.observe(this.$el);
    },
  }));
}
