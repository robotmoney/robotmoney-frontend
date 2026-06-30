// Alpine.data factories for animated page-hero canvases. Same lifecycle pattern
// as substrate.js: init() injects a canvas host + waits for p5; destroy() tears
// the p5 instance down on SPA view changes. p5 is the CDN global.
export function registerHeroes(Alpine) {
  Alpine.data("blogHero", () => ({
    _p5: null,
    init() {
      const host = this.$el;
      host.innerHTML = '<div class="hero-art__canvas" style="position:absolute;inset:0"></div>';
      const container = host.querySelector(".hero-art__canvas");
      const startWhenReady = () => {
        if (window.p5) this._start(container);
        else setTimeout(startWhenReady, 50);
      };
      startWhenReady();
    },
    destroy() {
      if (this._p5) { this._p5.remove(); this._p5 = null; }
    },
    _start(container) {
      const p5Constructor = window.p5;
      const numTrees = 20, maxDepth = 6, windStrength = 80, branchAngle = 25, shrinkPct = 67, randomness = 40;
      const ACCENT = [0, 229, 255], BG = [5, 5, 8];
      const sketch = (p) => {
        let W, H, trees = [], windTime = 0;
        function generateTrees() {
          trees = [];
          for (let i = 0; i < numTrees; i++) {
            trees.push({
              x: W * 0.08 + p.random(W * 0.84),
              trunkH: (H * 0.12 + p.random(H * 0.25)) * 1.04,
              seed: p.random(10000),
              windPhase: p.random(p.TWO_PI),
              windSpeed: 0.6 + p.random(0.8),
              hueShift: p.random(-30, 30)
            });
          }
          trees.sort((a, b) => a.trunkH - b.trunkH);
        }
        let branchSeed = 0;
        function branchRand() {
          branchSeed++;
          let x = Math.sin(branchSeed * 127.1 + branchSeed * 311.7) * 43758.5453;
          return x - Math.floor(x);
        }
        function branchRandRange(lo, hi) { return lo + (hi - lo) * branchRand(); }
        function drawBranch(x, y, len, angle, depth, windOffset, hueShift) {
          if (depth <= 0 || len < 1.5) return;
          let depthFactor = depth / maxDepth;
          let sway = windOffset * (1 - depthFactor * 0.6);
          let endX = x + Math.cos(angle + sway) * len;
          let endY = y + Math.sin(angle + sway) * len;
          let thick = Math.max(0.24, depth * 0.64);
          let alpha = Math.min(255, 80 + depth * 20);
          let r, g, b;
          if (depth > maxDepth * 0.6) {
            let bright = 55 + depth * 6;
            r = bright - 10; g = bright; b = bright + 20;
          } else {
            let t = 1 - (depth / (maxDepth * 0.6));
            r = Math.round(p.lerp(50, ACCENT[0] * 0.9 + hueShift, t));
            g = Math.round(p.lerp(60, ACCENT[1] * 0.75 + hueShift, t));
            b = Math.round(p.lerp(75, ACCENT[2] * 0.6, t));
          }
          p.stroke(r, g, b, alpha);
          p.strokeWeight(thick);
          p.line(x, y, endX, endY);
          let rFactor = randomness / 100;
          let baseAngleRad = (branchAngle * Math.PI) / 180;
          let baseShrink = shrinkPct / 100;
          let aL = baseAngleRad * (1 + branchRandRange(-rFactor, rFactor));
          let aR = baseAngleRad * (1 + branchRandRange(-rFactor, rFactor));
          let aC = branchRandRange(-rFactor, rFactor) * baseAngleRad * 0.5;
          let sL = baseShrink * (1 + branchRandRange(-rFactor, rFactor));
          let sR = baseShrink * (1 + branchRandRange(-rFactor, rFactor));
          let sC = baseShrink * (1 + branchRandRange(-rFactor, rFactor)) * 0.85;
          drawBranch(endX, endY, len * sL, angle - aL, depth - 1, windOffset, hueShift);
          drawBranch(endX, endY, len * sR, angle + aR, depth - 1, windOffset, hueShift);
          if (depth > 2) {
            drawBranch(endX, endY, len * sC, angle + aC + windOffset * 0.3, depth - 1, windOffset, hueShift);
          }
        }
        p.setup = function () {
          W = container.offsetWidth; H = container.offsetHeight;
          p.createCanvas(W, H).style("display", "block");
          generateTrees();
        };
        p.windowResized = function () {
          W = container.offsetWidth; H = container.offsetHeight;
          p.resizeCanvas(W, H); generateTrees();
        };
        p.draw = function () {
          p.background(BG[0], BG[1], BG[2]);
          windTime += 0.008;
          let windBase = windStrength / 100;
          for (let tree of trees) {
            branchSeed = Math.floor(tree.seed * 1000);
            let w = p.noise(tree.seed + windTime * tree.windSpeed) * 2 - 1;
            w += Math.sin(windTime * 1.3 + tree.windPhase) * 0.3;
            let windOffset = w * windBase * 0.15;
            drawBranch(tree.x, H, tree.trunkH, -Math.PI / 2, maxDepth, windOffset, tree.hueShift);
          }
        };
      };
      this._p5 = new p5Constructor(sketch, container);
    },
  }));
}
