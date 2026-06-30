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

  Alpine.data("mediaHero", () => ({
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
      let intensity = 45;
      const speed = 0.20;
      const slider3Value = 200;
      const oscillation = 500;
      const slider3Max = 200;
      const pauseSec = 3;
      const cycleSec = 8;
      const oscMax = 500;

      const ACCENT = [0, 229, 255];
      const BG = [5, 5, 8];

      function I(lo, hi) {
        return lo + (hi - lo) * (intensity / 100);
      }

      // Oscillation state
      let oscPauseTimer = 0;
      let oscDirection = 1;
      let oscCurrentValue = 0;

      function tickOscillation() {
        if (oscillation === 0) { oscCurrentValue = slider3Value; return; }
        const target = slider3Value;
        if (target === 0) { oscCurrentValue = 0; return; }
        const pauseFrames = pauseSec * 60;
        const cycleFrames = (cycleSec * 60 * oscMax) / Math.max(oscillation, 1);
        const stepPerFrame = target / (cycleFrames / 2);
        if (oscPauseTimer > 0) { oscPauseTimer--; return; }
        oscCurrentValue += stepPerFrame * oscDirection;
        if (oscCurrentValue >= target) { oscCurrentValue = target; oscDirection = -1; oscPauseTimer = pauseFrames; }
        if (oscCurrentValue <= 0) { oscCurrentValue = 0; oscDirection = 1; oscPauseTimer = pauseFrames; }
      }

      function getParam3() {
        const raw = oscillation === 0 ? slider3Value : oscCurrentValue;
        return raw / slider3Max;
      }

      const sketch = (p) => {
        let W, H;
        let particles = [];
        let dataPixels = [];
        let frameNum = 0;

        p.setup = function () {
          W = container.offsetWidth;
          H = container.offsetHeight;
          p.createCanvas(W, H).style("display", "block");
          // Mobile: reduce intensity by 50%
          if (W < 768) intensity = Math.round(intensity * 0.5);
          setupSwarm();
        };

        p.windowResized = function () {
          W = container.offsetWidth;
          H = container.offsetHeight;
          p.resizeCanvas(W, H);
          setupSwarm();
        };

        function setupSwarm() {
          particles = [];
          const count = Math.round(I(15, 500));
          for (let i = 0; i < count; i++) {
            particles.push({
              x: p.random(W), y: p.random(H),
              vx: p.random(-0.4, 0.4), vy: p.random(-0.4, 0.4),
              sizeBase: p.random(0, 1),
              isAccent: p.random() > I(0.97, 0.45),
              nOff: p.random(1000),
            });
          }
          dataPixels = [];
        }

        function spawnDataPixels(connections) {
          const oscNorm = oscillation > 0 ? oscCurrentValue / Math.max(slider3Value, 1) : 0;
          if (oscNorm < 0.01) return;
          const spawnChance = oscNorm * 0.35;
          if (connections.length > 0 && p.random() < spawnChance) {
            const c = connections[Math.floor(p.random() * connections.length)];
            const cycleFrames = (cycleSec * 60 * oscMax) / Math.max(oscillation, 1);
            const travelFrames = Math.max(30, cycleFrames * 0.08);
            dataPixels.push({
              fromX: c.x1, fromY: c.y1, toX: c.x2, toY: c.y2,
              t: 0, duration: travelFrames,
              isAccent: c.isAccent,
            });
          }
          if (dataPixels.length > 200) dataPixels.splice(0, dataPixels.length - 200);
        }

        p.draw = function () {
          tickOscillation();
          const spd = speed;
          frameNum += spd;
          const nodeSize = getParam3();

          p.background(BG[0], BG[1], BG[2]);
          const cDist = I(60, 280);
          const drift = I(0.006, 0.08) * spd;

          for (const pt of particles) {
            const a = p.noise(pt.x * 0.003, pt.y * 0.003, frameNum * 0.004) * p.TWO_PI;
            pt.vx += Math.cos(a) * drift;
            pt.vy += Math.sin(a) * drift;
            pt.vx *= 0.97; pt.vy *= 0.97;
            pt.x += pt.vx; pt.y += pt.vy;
            if (pt.x > W + 40) pt.x = -40; if (pt.x < -40) pt.x = W + 40;
            if (pt.y > H + 40) pt.y = -40; if (pt.y < -40) pt.y = H + 40;
          }

          let minSz, maxSz;
          if (nodeSize < 0.01) {
            minSz = I(1.5, 3); maxSz = I(2, 4);
          } else {
            minSz = Math.max(0.5, I(1.5, 3) * (1 - nodeSize * 0.7));
            maxSz = I(2, 4) + nodeSize * I(15, 50);
          }

          const lw = I(0.15, 3.0);
          const laMax = I(12, 230);
          p.strokeWeight(lw);
          const maxCheck = Math.min(particles.length, 300);
          const cDist2 = cDist * cDist;
          const activeConnections = [];

          for (let i = 0; i < maxCheck; i++) {
            for (let j = i + 1; j < maxCheck; j++) {
              const dx = particles[i].x - particles[j].x;
              const dy = particles[i].y - particles[j].y;
              const d2 = dx * dx + dy * dy;
              if (d2 < cDist2) {
                const dist = Math.sqrt(d2);
                const al = p.map(dist, 0, cDist, laMax, 0);
                const isAcc = particles[i].isAccent || particles[j].isAccent;
                if (isAcc) {
                  p.stroke(ACCENT[0], ACCENT[1], ACCENT[2], al);
                } else {
                  const br = I(70, 210);
                  p.stroke(br, br + 5, br + 15, al * 0.8);
                }
                p.line(particles[i].x, particles[i].y, particles[j].x, particles[j].y);
                activeConnections.push({
                  x1: particles[i].x, y1: particles[i].y,
                  x2: particles[j].x, y2: particles[j].y,
                  isAccent: isAcc,
                });
              }
            }
          }

          // Spawn + draw data pixels
          spawnDataPixels(activeConnections);
          p.noStroke();
          for (let k = dataPixels.length - 1; k >= 0; k--) {
            const dp = dataPixels[k];
            dp.t += spd;
            const prog = dp.t / dp.duration;
            if (prog > 1) { dataPixels.splice(k, 1); continue; }
            const ep = prog < 0.5 ? 2 * prog * prog : 1 - Math.pow(-2 * prog + 2, 2) / 2;
            const px = p.lerp(dp.fromX, dp.toX, ep);
            const py = p.lerp(dp.fromY, dp.toY, ep);
            const al = 255 * (1 - Math.abs(prog - 0.5) * 2) * 0.9 + 40;
            if (dp.isAccent) {
              p.fill(ACCENT[0], ACCENT[1], ACCENT[2], al);
              p.ellipse(px, py, 4);
              p.fill(ACCENT[0], ACCENT[1], ACCENT[2], al * 0.3);
              p.ellipse(px, py, 10);
            } else {
              p.fill(220, 225, 240, al);
              p.ellipse(px, py, 3);
              p.fill(220, 225, 240, al * 0.2);
              p.ellipse(px, py, 8);
            }
          }

          // Nodes
          p.noStroke();
          const nAlpha = I(30, 255);
          for (const pt of particles) {
            const sz = p.lerp(minSz, maxSz, pt.sizeBase);
            const glowSz = sz * (1 + nodeSize * 1.5);
            if (pt.isAccent) {
              p.fill(ACCENT[0], ACCENT[1], ACCENT[2], I(4, 50) * (0.5 + nodeSize));
              p.ellipse(pt.x, pt.y, glowSz);
              p.fill(ACCENT[0], ACCENT[1], ACCENT[2], nAlpha);
            } else {
              if (nodeSize > 0.3 && sz > maxSz * 0.5) {
                p.fill(100, 130, 180, I(3, 25) * nodeSize);
                p.ellipse(pt.x, pt.y, glowSz * 0.8);
              }
              p.fill(I(100, 230), I(105, 235), I(120, 245), nAlpha * 0.65);
            }
            p.ellipse(pt.x, pt.y, sz);
          }
        };
      };

      this._p5 = new p5Constructor(sketch, container);
    },
  }));

  Alpine.data("changelogHero", () => ({
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
      let intensity = 55;
      const speed = 0.35;
      const slider3Value = 20;
      const oscillation = 500;
      const slider3Max = 100;
      const pauseSec = 3;
      const cycleSec = 10;
      const oscMax = 500;

      const ACCENT = [0, 229, 255];
      const BG = [5, 5, 8];

      function I(lo, hi) {
        return lo + (hi - lo) * (intensity / 100);
      }

      // Oscillation state
      let oscPauseTimer = 0;
      let oscDirection = 1;
      let oscCurrentValue = 0;

      function tickOscillation() {
        if (oscillation === 0) { oscCurrentValue = slider3Value; return; }
        const target = slider3Value;
        if (target === 0) { oscCurrentValue = 0; return; }
        const pauseFrames = pauseSec * 60;
        const cycleFrames = (cycleSec * 60 * oscMax) / Math.max(oscillation, 1);
        const stepPerFrame = target / (cycleFrames / 2);
        if (oscPauseTimer > 0) { oscPauseTimer--; return; }
        oscCurrentValue += stepPerFrame * oscDirection;
        if (oscCurrentValue >= target) { oscCurrentValue = target; oscDirection = -1; oscPauseTimer = pauseFrames; }
        if (oscCurrentValue <= 0) { oscCurrentValue = 0; oscDirection = 1; oscPauseTimer = pauseFrames; }
      }

      function getParam3() {
        const raw = oscillation === 0 ? slider3Value : oscCurrentValue;
        return raw / slider3Max;
      }

      const sketch = (p) => {
        let W, H;
        let particles = [];
        let cols, rows, scl;
        let flowField;
        let frameNum = 0;

        p.setup = function () {
          W = container.offsetWidth;
          H = container.offsetHeight;
          p.createCanvas(W, H).style("display", "block");
          // Mobile: reduce intensity by 50%
          if (W < 768) intensity = Math.round(intensity * 0.5);
          setupFlowField();
        };

        p.windowResized = function () {
          W = container.offsetWidth;
          H = container.offsetHeight;
          p.resizeCanvas(W, H);
          setupFlowField();
        };

        function setupFlowField() {
          scl = Math.max(6, Math.round(I(28, 6)));
          cols = Math.floor(W / scl);
          rows = Math.floor(H / scl);
          flowField = new Array(cols * rows);
          particles = [];
          const count = Math.round(I(20, 4000));
          for (let i = 0; i < count; i++) {
            const pp = p.createVector(p.random(W), p.random(H));
            particles.push({
              pos: pp.copy(),
              vel: p.createVector(0, 0),
              acc: p.createVector(0, 0),
              prevPos: pp.copy(),
              maxSpeed: p.random(0.4, I(1.2, 7)),
              hue: p.random(1),
              nOff: p.random(1000),
            });
          }
          p.background(BG[0], BG[1], BG[2]);
        }

        p.draw = function () {
          tickOscillation();
          const spd = speed;
          frameNum += spd;
          const variance = getParam3();

          p.noStroke();
          p.fill(BG[0], BG[1], BG[2], Math.round(I(2, 30)));
          p.rect(0, 0, W, H);

          const noiseSpd = I(0.0008, 0.01) * spd;
          const fMag = I(0.08, 1.0);
          const angleMult = 2 + variance * 6;
          const noiseGrain = 0.08 + variance * 0.2;

          for (let y = 0; y < rows; y++) {
            let xoff = 0;
            for (let x = 0; x < cols; x++) {
              const idx = x + y * cols;
              const a = p.noise(xoff, y * 0.06, frameNum * noiseSpd) * p.TWO_PI * angleMult;
              const v = p5Constructor.Vector.fromAngle(a);
              v.setMag(fMag + variance * fMag * 0.5);
              flowField[idx] = v;
              xoff += noiseGrain;
            }
          }

          const sw = I(0.2, 4.0);
          const baseA = I(8, 220);
          const accentCut = I(0.96, 0.4);
          for (const pt of particles) {
            const gx = p.constrain(Math.floor(pt.pos.x / scl), 0, cols - 1);
            const gy = p.constrain(Math.floor(pt.pos.y / scl), 0, rows - 1);
            const f = flowField[gx + gy * cols];
            if (f) {
              const force = f.copy();
              if (variance > 0.01) {
                const jA = p.noise(pt.nOff, frameNum * 0.02) * p.TWO_PI;
                force.x += Math.cos(jA) * variance * fMag * 1.5;
                force.y += Math.sin(jA) * variance * fMag * 1.5;
              }
              pt.acc.add(force);
            }
            pt.vel.add(pt.acc);
            pt.vel.limit(pt.maxSpeed * (0.5 + spd * 0.5));
            pt.pos.add(p5Constructor.Vector.mult(pt.vel, spd));
            pt.acc.mult(0);
            if (pt.pos.x > W) { pt.pos.x = 0; pt.prevPos.x = 0; }
            if (pt.pos.x < 0) { pt.pos.x = W; pt.prevPos.x = W; }
            if (pt.pos.y > H) { pt.pos.y = 0; pt.prevPos.y = 0; }
            if (pt.pos.y < 0) { pt.pos.y = H; pt.prevPos.y = H; }
            let al = baseA + pt.hue * I(5, 35);
            if (variance > 0.3) al *= (0.7 + p.noise(pt.nOff + frameNum * 0.01) * 0.6);
            if (pt.hue > accentCut) {
              p.stroke(ACCENT[0], ACCENT[1], ACCENT[2], al);
            } else {
              const br = I(80, 240);
              p.stroke(br, br + 5, br + 20, al * 0.7);
            }
            p.strokeWeight(sw);
            p.line(pt.prevPos.x, pt.prevPos.y, pt.pos.x, pt.pos.y);
            pt.prevPos.x = pt.pos.x;
            pt.prevPos.y = pt.pos.y;
          }
        };
      };

      this._p5 = new p5Constructor(sketch, container);
    },
  }));
}
