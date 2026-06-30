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

  Alpine.data("faqHero", () => ({
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
      const ACCENT = [0, 229, 255], BG = [5, 5, 8];
      const sketch = (p) => {
        let W, H, cols, rows, scl = 25, terrain = [], flying = 0, frameNum = 0;
        p.setup = function () {
          W = container.offsetWidth; H = container.offsetHeight;
          p.createCanvas(W, H, p.WEBGL).style("display", "block");
          p.pixelDensity(1);
          cols = Math.ceil(W / scl) + 2; rows = Math.ceil(H / scl) + 2;
          for (let x = 0; x < cols; x++) { terrain[x] = []; for (let y = 0; y < rows; y++) terrain[x][y] = 0; }
          p.background(BG[0], BG[1], BG[2]);
        };
        p.windowResized = function () {
          W = container.offsetWidth; H = container.offsetHeight;
          p.resizeCanvas(W, H);
          cols = Math.ceil(W / scl) + 2; rows = Math.ceil(H / scl) + 2;
          terrain = [];
          for (let x = 0; x < cols; x++) { terrain[x] = []; for (let y = 0; y < rows; y++) terrain[x][y] = 0; }
        };
        p.draw = function () {
          frameNum++; flying -= 0.01;
          let yoff = flying;
          for (let y = 0; y < rows; y++) {
            let xoff = 0;
            for (let x = 0; x < cols; x++) {
              let h = p.noise(xoff, yoff) * 180;
              h += p.noise(xoff * 2, yoff * 2) * 60;
              h += p.noise(xoff * 4, yoff * 4) * 20;
              terrain[x][y] = h; xoff += 0.08;
            }
            yoff += 0.08;
          }
          p.background(BG[0], BG[1], BG[2]);
          p.noStroke();
          const camDist = Math.max(W, H) * 0.7;
          p.camera(0, -Math.max(W, H) * 0.3, camDist * 0.8, 0, 0, 0, 0, 1, 0);
          p.rotateX(p.radians(55 + Math.sin(frameNum * 0.001) * 5));
          p.translate(-W * 0.5, -H * 0.3, 0);
          p.noFill();
          p.strokeWeight(0.5);
          for (let x = 0; x < cols; x++) {
            const alpha = 70 + (x % 5 === 0 ? 60 : 0);
            p.stroke(ACCENT[0], ACCENT[1], ACCENT[2], alpha);
            p.beginShape();
            for (let y = 0; y < rows; y++) { const h = terrain[x][y]; p.vertex(x * scl, y * scl, -h); }
            p.endShape();
          }
          for (let y = 0; y < rows; y++) {
            const alpha = 70 + (y % 5 === 0 ? 60 : 0);
            p.stroke(ACCENT[0], ACCENT[1], ACCENT[2], alpha);
            p.beginShape();
            for (let x = 0; x < cols; x++) { const h = terrain[x][y]; p.vertex(x * scl, y * scl, -h); }
            p.endShape();
          }
        };
      };
      this._p5 = new p5Constructor(sketch, container);
    },
  }));

  Alpine.data("tokHero", () => ({
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
      const ACCENT = [0, 229, 255], BG = [5, 5, 8];
      const sketch = (p) => {
        let W, H;
        let boids = [];
        let trailBuf;
        const NUM_BOIDS = 200;
        let frameNum = 0;

        let predator = { x: 0, y: 0, angle: 0, speed: 1.2 };

        const MAX_SPEED = 3.5;
        const MAX_FORCE = 0.08;
        const PERCEPTION = 60;
        const SEPARATION_DIST = 25;

        p.setup = function () {
          W = container.offsetWidth;
          H = container.offsetHeight;
          p.createCanvas(W, H).style("display", "block");
          p.pixelDensity(1);

          trailBuf = p.createGraphics(W, H);
          trailBuf.pixelDensity(1);
          trailBuf.background(BG[0], BG[1], BG[2]);

          for (let i = 0; i < NUM_BOIDS; i++) {
            boids.push(createBoid());
          }

          predator.x = W * 0.5;
          predator.y = H * 0.5;
          predator.angle = p.random(p.TWO_PI);

          p.background(BG[0], BG[1], BG[2]);
        };

        function createBoid() {
          return {
            x: p.random(W),
            y: p.random(H),
            vx: p.random(-2, 2),
            vy: p.random(-2, 2),
            ax: 0,
            ay: 0,
            r: 2 + p.random(2),
            hue: p.random(0.5, 1.0),
            maxSpeed: MAX_SPEED * (0.8 + p.random(0.4)),
            maxForce: MAX_FORCE,
          };
        }

        p.windowResized = function () {
          W = container.offsetWidth;
          H = container.offsetHeight;
          p.resizeCanvas(W, H);
          trailBuf.resizeCanvas(W, H);
          trailBuf.background(BG[0], BG[1], BG[2]);
        };

        function distSq(x1, y1, x2, y2) {
          const dx = x1 - x2;
          const dy = y1 - y2;
          return dx * dx + dy * dy;
        }

        function magSq(x, y) {
          return x * x + y * y;
        }

        function limit(x, y, max) {
          const mSq = magSq(x, y);
          if (mSq > max * max && mSq > 0) {
            const mag = Math.sqrt(mSq);
            return { x: (x / mag) * max, y: (y / mag) * max };
          }
          return { x, y };
        }

        function normalize(x, y) {
          const mag = Math.sqrt(x * x + y * y);
          if (mag === 0) return { x: 0, y: 0 };
          return { x: x / mag, y: y / mag };
        }

        function separation(b, neighbors) {
          let sx = 0, sy = 0, count = 0;
          for (let other of neighbors) {
            const d2 = distSq(b.x, b.y, other.x, other.y);
            if (d2 > 0 && d2 < SEPARATION_DIST * SEPARATION_DIST) {
              const d = Math.sqrt(d2);
              const diffX = b.x - other.x;
              const diffY = b.y - other.y;
              sx += (diffX / d);
              sy += (diffY / d);
              count++;
            }
          }
          if (count > 0) {
            sx /= count;
            sy /= count;
            const n = normalize(sx, sy);
            sx = n.x * b.maxSpeed;
            sy = n.y * b.maxSpeed;
            sx -= b.vx;
            sy -= b.vy;
            const l = limit(sx, sy, b.maxForce);
            return { x: l.x, y: l.y };
          }
          return { x: 0, y: 0 };
        }

        function alignment(b, neighbors) {
          let ax = 0, ay = 0, count = 0;
          for (let other of neighbors) {
            const d2 = distSq(b.x, b.y, other.x, other.y);
            if (d2 > 0 && d2 < PERCEPTION * PERCEPTION) {
              ax += other.vx;
              ay += other.vy;
              count++;
            }
          }
          if (count > 0) {
            ax /= count;
            ay /= count;
            const n = normalize(ax, ay);
            ax = n.x * b.maxSpeed;
            ay = n.y * b.maxSpeed;
            ax -= b.vx;
            ay -= b.vy;
            const l = limit(ax, ay, b.maxForce);
            return { x: l.x, y: l.y };
          }
          return { x: 0, y: 0 };
        }

        function cohesion(b, neighbors) {
          let cx = 0, cy = 0, count = 0;
          for (let other of neighbors) {
            const d2 = distSq(b.x, b.y, other.x, other.y);
            if (d2 > 0 && d2 < PERCEPTION * PERCEPTION) {
              cx += other.x;
              cy += other.y;
              count++;
            }
          }
          if (count > 0) {
            cx /= count;
            cy /= count;
            cx -= b.x;
            cy -= b.y;
            const n = normalize(cx, cy);
            cx = n.x * b.maxSpeed;
            cy = n.y * b.maxSpeed;
            cx -= b.vx;
            cy -= b.vy;
            const l = limit(cx, cy, b.maxForce);
            return { x: l.x, y: l.y };
          }
          return { x: 0, y: 0 };
        }

        function predatorAvoidance(b, px, py) {
          const d2 = distSq(b.x, b.y, px, py);
          const fearDist = 150;
          if (d2 < fearDist * fearDist && d2 > 0) {
            const d = Math.sqrt(d2);
            let dx = b.x - px;
            let dy = b.y - py;
            const n = normalize(dx, dy);
            dx = n.x * b.maxSpeed * 2.5;
            dy = n.y * b.maxSpeed * 2.5;
            dx -= b.vx;
            dy -= b.vy;
            const l = limit(dx, dy, b.maxForce * 3);
            return { x: l.x, y: l.y };
          }
          return { x: 0, y: 0 };
        }

        p.draw = function () {
          frameNum++;

          trailBuf.noStroke();
          trailBuf.fill(BG[0], BG[1], BG[2], 8);
          trailBuf.rect(0, 0, W, H);

          const noiseAngle = p.noise(frameNum * 0.008, 999) * p.TWO_PI * 2;
          predator.angle += (noiseAngle - predator.angle) * 0.03;
          predator.x += Math.cos(predator.angle) * predator.speed;
          predator.y += Math.sin(predator.angle) * predator.speed;
          if (predator.x < -30) predator.x = W + 30;
          if (predator.x > W + 30) predator.x = -30;
          if (predator.y < -30) predator.y = H + 30;
          if (predator.y > H + 30) predator.y = -30;

          const predatorX = predator.x;
          const predatorY = predator.y;

          for (let b of boids) {
            let neighbors = [];
            for (let other of boids) {
              if (other !== b && distSq(b.x, b.y, other.x, other.y) < PERCEPTION * PERCEPTION) {
                neighbors.push(other);
              }
            }

            const sep = separation(b, neighbors);
            const ali = alignment(b, neighbors);
            const coh = cohesion(b, neighbors);
            const pred = predatorAvoidance(b, predatorX, predatorY);

            b.ax = sep.x * 1.5 + ali.x * 1.0 + coh.x * 1.0 + pred.x * 2.0;
            b.ay = sep.y * 1.5 + ali.y * 1.0 + coh.y * 1.0 + pred.y * 2.0;

            b.vx += b.ax;
            b.vy += b.ay;
            const vLim = limit(b.vx, b.vy, b.maxSpeed);
            b.vx = vLim.x;
            b.vy = vLim.y;

            const prevX = b.x;
            const prevY = b.y;
            b.x += b.vx;
            b.y += b.vy;

            let wrapped = false;
            if (b.x < -10) { b.x = W + 10; wrapped = true; }
            if (b.x > W + 10) { b.x = -10; wrapped = true; }
            if (b.y < -10) { b.y = H + 10; wrapped = true; }
            if (b.y > H + 10) { b.y = -10; wrapped = true; }

            if (!wrapped) {
              const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
              const alpha = Math.min(120, 20 + speed * 15);
              const r = Math.floor(ACCENT[0] * b.hue);
              const g = Math.floor(ACCENT[1] * b.hue);
              const bcol = Math.floor(ACCENT[2] * (0.7 + b.hue * 0.3));
              trailBuf.stroke(r, g, bcol, alpha);
              trailBuf.strokeWeight(1);
              trailBuf.line(prevX, prevY, b.x, b.y);
            }
          }

          p.image(trailBuf, 0, 0);

          for (let b of boids) {
            const angle = Math.atan2(b.vy, b.vx);
            const r = Math.floor(ACCENT[0] * b.hue);
            const g = Math.floor(ACCENT[1] * b.hue);
            const bcol = Math.floor(ACCENT[2] * (0.7 + b.hue * 0.3));

            p.push();
            p.translate(b.x, b.y);
            p.rotate(angle);
            p.noStroke();
            p.fill(r, g, bcol, 200);
            p.beginShape();
            p.vertex(b.r * 2, 0);
            p.vertex(-b.r, -b.r * 0.8);
            p.vertex(-b.r, b.r * 0.8);
            p.endShape(p.CLOSE);
            p.pop();
          }

          const pulse = 1 + Math.sin(frameNum * 0.08) * 0.25;
          const breathe = Math.sin(frameNum * 0.12) * 8;

          p.noFill();
          p.stroke(255, 60, 60, 60 + Math.sin(frameNum * 0.1) * 20);
          p.strokeWeight(1.5);
          p.ellipse(predatorX, predatorY, (24 + breathe) * pulse);

          p.stroke(255, 80, 80, 40 + Math.sin(frameNum * 0.15) * 15);
          p.strokeWeight(1);
          p.ellipse(predatorX, predatorY, (40 + breathe * 1.5) * pulse);

          p.noStroke();
          p.fill(255, 60, 60, 160);
          p.ellipse(predatorX, predatorY, 6 * pulse);
          p.fill(255, 100, 100, 80);
          p.ellipse(predatorX, predatorY, 12 * pulse);
        };
      };

      this._p5 = new p5Constructor(sketch, container);
    },
  }));
}
