// Alpine.data factory for the hero's generative "substrate" canvas. p5 sketch
// ported verbatim from the original SubstrateEffect in src/app/page.tsx. No Web
// Components: Alpine's init()/destroy() lifecycle starts and tears down p5 (so
// the canvas is cleaned up on SPA view changes). p5 is the global from the CDN
// <script>; we render into the element this x-data is attached to.
import { applyHeroPerf } from "./p5-hero-perf.js";

export function registerSubstrate(Alpine) {
  Alpine.data("substrate", () => ({
    _p5: null,
    _p5Timer: null,
    _destroyed: false,
    _perfCleanup: null,
    _pageHide: null,
    _beforeViewChange: null,
    init() {
      this._destroyed = false;
      this._pageHide = () => this.destroy();
      this._beforeViewChange = () => this.destroy();
      window.addEventListener("pagehide", this._pageHide, { once: true });
      window.addEventListener("rm:before-view-change", this._beforeViewChange);
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
      if (this._pageHide) window.removeEventListener("pagehide", this._pageHide);
      if (this._beforeViewChange) {
        window.removeEventListener("rm:before-view-change", this._beforeViewChange);
      }
      this._pageHide = null;
      this._beforeViewChange = null;
      clearTimeout(this._p5Timer);
      this._p5Timer = null;
      this._perfCleanup?.();
      this._perfCleanup = null;
      if (this._p5) { this._p5.noLoop(); this._p5.remove(); this._p5 = null; }
    },
    _start(container, overlay) {
      const p5Constructor = window.p5;
      // `speed` is crack-steps per frame and each step advances a crack 0.42px,
      // so at the old value of 3 a crack grew ~38px/second under the 30fps hero
      // cap. On a 1440px hero that meant the network was still half a dozen
      // lines after ten seconds, and a visitor who scrolled past never saw the
      // effect at all — the hero read as an empty black band. The seeding was
      // the other half: growth only compounds once cracks start colliding and
      // spawning, so 8 initial cracks spent the first seconds doing nothing
      // visible. More seeds and more steps reach a legible network in ~3s and
      // then settle into the same stasis-and-fade cycle as before.
      const intensity = 45, speed = 16.0, fadeSec = 4, lineW = 1.1, dotSize = 36;
      const seedCracks = 26;
      const ACCENT = [0, 229, 255], BG = [10, 10, 15];

      const sketch = (p) => {
        let W, H, cgrid, cracks = [], numCracks = 0, maxCracks;
        let phase = 0, fadeTimer = 0, generation = 0, stasisFrames = 0, crackLayer;

        function Crack() {
          this.x = 0; this.y = 0; this.t = 0; this.alive = true;
          this.findStart = function () {
            // Bounded random search for *a* valid grid cell, not a specific
            // one — a lower attempt cap is cheaper in the worst case (an
            // already-dense grid) with no visible difference in outcome.
            for (let attempt = 0; attempt < 1500; attempt++) {
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
          maxCracks = Math.min(700, Math.max(5, Math.round(W * (intensity / 100))));
          let seeds = Math.max(3, Math.round(maxCracks * 0.1));
          for (let k = 0; k < seeds; k++) {
            let px = Math.floor(p.random(W));
            let py = Math.floor(p.random(H));
            cgrid[py * W + px] = Math.floor(p.random(360));
          }
          for (let k = 0; k < Math.min(seedCracks, maxCracks); k++) spawnCrack();
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
      this._perfCleanup = applyHeroPerf(this._p5, this.$el, { fpsCap: 30 });
    },
  }));
}
