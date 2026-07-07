// Alpine.data factories for animated page-hero canvases.
import { p5Lifecycle } from "./p5-lifecycle.js";

export function registerHeroes(Alpine) {
  Alpine.data("slimeMoldHero", () => ({
    ...p5Lifecycle(),
    _start(container) {
      const p5Constructor = window.p5;
      const sketch = (p) => {
        let width = 0;
        let height = 0;
        const points = [];

        function reset() {
          width = container.offsetWidth;
          height = container.offsetHeight;
          points.length = 0;
          for (let i = 0; i < 80; i++) {
            points.push({ x: p.random(width), y: p.random(height), a: p.random(p.TWO_PI) });
          }
          p.background(5, 5, 8);
        }

        p.setup = function () {
          p.createCanvas(container.offsetWidth, container.offsetHeight).style("display", "block");
          p.pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
          reset();
        };
        p.windowResized = function () {
          p.resizeCanvas(container.offsetWidth, container.offsetHeight);
          reset();
        };
        p.draw = function () {
          p.noStroke();
          p.fill(5, 5, 8, 24);
          p.rect(0, 0, width, height);
          p.fill(0, 229, 255, 60);
          for (const point of points) {
            point.a += (p.noise(point.x * 0.006, point.y * 0.006, p.frameCount * 0.004) - 0.5) * 0.5;
            point.x = (point.x + Math.cos(point.a) * 1.2 + width) % width;
            point.y = (point.y + Math.sin(point.a) * 1.2 + height) % height;
            p.circle(point.x, point.y, 1.8);
          }
        };
      };
      this._p5 = new p5Constructor(sketch, container);
    },
  }));

  Alpine.data("blogHero", () => ({
    ...p5Lifecycle(),
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
    ...p5Lifecycle(),
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
    ...p5Lifecycle(),
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
    ...p5Lifecycle(),
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
    ...p5Lifecycle(),
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

  // Faithful port of components/OrbitsCanvas.tsx for the /regime hero:
  // count=8, layout="horizontal", fillHeight=0.7, speed=0.003. Lissajous curves
  // with fading trails; the frame is cleared with the dark BG at low alpha each
  // draw so trails decay (rather than a hard background()).
  Alpine.data("orbitsHero", () => ({
    ...p5Lifecycle(),
    _start(container) {
      const p5Constructor = window.p5;
      const COUNT = 8, FILL_HEIGHT = 0.7, SPEED = 0.003, TRAIL_LENGTH = 120;
      const PALETTE = [
        [0, 229, 255], [0, 210, 255], [0, 255, 240], [0, 200, 255],
        [0, 255, 220], [0, 190, 255], [0, 230, 250], [0, 220, 240],
      ];
      const BG = [5, 5, 8];

      class Lissajous {
        constructor(p, cx, cy, radius, a, b, delta, speed, color) {
          this.p = p; this.cx = cx; this.cy = cy; this.radius = radius;
          this.a = a; this.b = b; this.delta = delta; this.speed = speed;
          this.t = 0; this.trail = []; this.color = color;
        }
        update() {
          this.t += this.speed;
          const x = this.cx + this.p.sin(this.a * this.t + this.delta) * this.radius;
          const y = this.cy + this.p.sin(this.b * this.t) * this.radius;
          this.trail.push({ x, y });
          if (this.trail.length > TRAIL_LENGTH) this.trail.shift();
        }
        draw() {
          for (let i = 1; i < this.trail.length; i++) {
            const alpha = this.p.map(i, 0, this.trail.length, 0, 150);
            const weight = this.p.map(i, 0, this.trail.length, 0.2, 2);
            this.p.stroke(this.color[0], this.color[1], this.color[2], alpha);
            this.p.strokeWeight(weight);
            this.p.line(this.trail[i - 1].x, this.trail[i - 1].y, this.trail[i].x, this.trail[i].y);
          }
          if (this.trail.length > 0) {
            const cur = this.trail[this.trail.length - 1];
            this.p.noStroke();
            this.p.fill(this.color[0], this.color[1], this.color[2], 255);
            this.p.ellipse(cur.x, cur.y, 4);
            this.p.fill(this.color[0], this.color[1], this.color[2], 30);
            this.p.ellipse(cur.x, cur.y, 16);
          }
        }
      }

      const sketch = (p) => {
        let curves = [];
        function initCurves() {
          curves = [];
          const availH = p.height * FILL_HEIGHT;
          const availW = p.width;
          // horizontal layout (single centered row, incrementally faster L→R)
          const spacing = availW / (COUNT + 1);
          const cy = p.height / 2;
          const radius = Math.min(spacing, availH) * 0.4;
          for (let i = 0; i < COUNT; i++) {
            const cx = spacing * (i + 1);
            const a = 3 + i * 0.5, b = 2 + i * 0.3, delta = i * 0.4;
            const s = SPEED + i * 0.003;
            curves.push(new Lissajous(p, cx, cy, radius, a, b, delta, s, PALETTE[i % PALETTE.length]));
          }
        }
        p.setup = function () {
          W = container.offsetWidth; H = container.offsetHeight;
          p.createCanvas(W, H).style("display", "block");
          p.pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
          initCurves();
        };
        let W, H;
        p.windowResized = function () {
          W = container.offsetWidth; H = container.offsetHeight;
          p.resizeCanvas(W, H);
          // continue existing curves (OrbitsCanvas does not re-init on resize)
        };
        p.draw = function () {
          p.fill(BG[0], BG[1], BG[2], 25);
          p.noStroke();
          p.rect(0, 0, p.width, p.height);
          for (const c of curves) { c.update(); c.draw(); }
        };
      };
      this._p5 = new p5Constructor(sketch, container);
    },
  }));

  // Faithful port of the /allocation "liquid mesh dots" hero
  // (robotmoney-site/src/app/allocation/page.tsx lines 390-586): a cyan
  // Perlin-noise mesh of vertex dots that drift, with roaming scatter-objects
  // that push the mesh around. Oscillation slowly ramps the distortion param.
  Alpine.data("meshHero", () => ({
    ...p5Lifecycle(),
    _start(container) {
      const p5Constructor = window.p5;

      // Effect defaults
      const intensity = 80;
      const speed = 0.35;
      const slider3Value = 40;
      const oscillation = 300;
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
        let meshPoints = [];
        let scatterObjects = [];
        let frameNum = 0;

        function spawnScatterObject() {
          const side = Math.floor(p.random(4));
          let sx, sy, angle;
          const margin = 100;
          if (side === 0) { sx = -margin; sy = p.random(H); angle = p.random(-0.4, 0.4); }
          else if (side === 1) { sx = W + margin; sy = p.random(H); angle = p.PI + p.random(-0.4, 0.4); }
          else if (side === 2) { sx = p.random(W); sy = -margin; angle = p.HALF_PI + p.random(-0.4, 0.4); }
          else { sx = p.random(W); sy = H + margin; angle = -p.HALF_PI + p.random(-0.4, 0.4); }
          const spd = 1.5 + p.random(2.5);
          return {
            x: sx, y: sy,
            vx: Math.cos(angle) * spd,
            vy: Math.sin(angle) * spd,
            radius: 80 + p.random(120),
            alive: true,
          };
        }

        p.setup = function () {
          W = container.offsetWidth;
          H = container.offsetHeight;
          p.createCanvas(W, H).style("display", "block");
          setupMesh();
        };

        p.windowResized = function () {
          W = container.offsetWidth;
          H = container.offsetHeight;
          p.resizeCanvas(W, H);
          setupMesh();
        };

        function setupMesh() {
          meshPoints = [];
          const sp = Math.max(8, Math.round(I(60, 8)));
          for (let x = -sp; x <= W + sp; x += sp) {
            for (let y = -sp; y <= H + sp; y += sp) {
              meshPoints.push({
                baseX: x, baseY: y, x: x, y: y,
                nOff: Math.random() * 1000,
                dx: 0, dy: 0,
              });
            }
          }
          scatterObjects = [spawnScatterObject()];
        }

        p.draw = function () {
          tickOscillation();
          const spd = speed;
          frameNum += spd;
          const distortion = getParam3();

          p.background(BG[0], BG[1], BG[2]);
          const t = frameNum * I(0.003, 0.025);
          const baseDisp = I(6, 100);
          const shakeReduction = 0.5;
          const extraDisp = distortion * baseDisp * 1.5;
          const freqSpread = distortion * 0.006;

          // Update scatter objects
          for (const so of scatterObjects) {
            so.x += so.vx * spd;
            so.y += so.vy * spd;
            if (so.x < -300 || so.x > W + 300 || so.y < -300 || so.y > H + 300) so.alive = false;
          }
          scatterObjects = scatterObjects.filter((o) => o.alive);
          if (scatterObjects.length === 0) scatterObjects.push(spawnScatterObject());

          // Position mesh vertices
          for (const pt of meshPoints) {
            const freq = 0.004 + (distortion > 0.01 ? (p.noise(pt.nOff) - 0.5) * freqSpread : 0);
            const nx = p.noise(pt.baseX * freq, pt.baseY * freq, t);
            const ny = p.noise(pt.baseX * freq + 100, pt.baseY * freq + 100, t);
            pt.x = pt.baseX + (nx - 0.5) * baseDisp * shakeReduction;
            pt.y = pt.baseY + (ny - 0.5) * baseDisp * shakeReduction;
            if (distortion > 0.01) {
              const jx = p.noise(pt.nOff, t * 0.4) - 0.5;
              const jy = p.noise(pt.nOff + 500, t * 0.4) - 0.5;
              pt.x += jx * extraDisp;
              pt.y += jy * extraDisp;
            }

            pt.dx *= 0.85; pt.dy *= 0.85;
            for (const so of scatterObjects) {
              const ddx = pt.x - so.x;
              const ddy = pt.y - so.y;
              const dist = Math.sqrt(ddx * ddx + ddy * ddy);
              if (dist < so.radius) {
                let force = (1 - dist / so.radius);
                force = force * force * (40 + distortion * 80);
                const ang = Math.atan2(ddy, ddx);
                pt.dx += Math.cos(ang) * force * 0.3;
                pt.dy += Math.sin(ang) * force * 0.3;
              }
            }
            pt.x += pt.dx;
            pt.y += pt.dy;
          }

          // Vertex dots
          const baseDotSz = I(0.5, 7);
          const dotSz = baseDotSz + distortion * baseDotSz * 2;
          const daMax = I(5, 240);
          const dTh = I(0.8, 0.2) - distortion * 0.15;
          let skip = intensity < 25 ? 4 : (intensity < 50 ? 2 : 1);
          if (distortion > 0.5) skip = 1;
          p.noStroke();
          for (let i = 0; i < meshPoints.length; i += skip) {
            const pt = meshPoints[i];
            const br = p.noise(pt.baseX * 0.006, pt.baseY * 0.006, t * 0.7);
            if (br > dTh) {
              const al = p.map(br, dTh, 1, 0, daMax);
              const thisDot = dotSz * (0.5 + p.noise(pt.nOff + 100, t * 0.3));
              p.fill(ACCENT[0], ACCENT[1], ACCENT[2], al);
              p.ellipse(pt.x, pt.y, Math.max(0.5, thisDot));
              if (distortion > 0.3 && thisDot > dotSz * 0.6) {
                p.fill(ACCENT[0], ACCENT[1], ACCENT[2], al * 0.12 * distortion);
                p.ellipse(pt.x, pt.y, thisDot * (2 + distortion * 2));
              }
            }
          }

          // Draw scatter object glow
          p.noStroke();
          for (const so of scatterObjects) {
            if (so.x > -50 && so.x < W + 50 && so.y > -50 && so.y < H + 50) {
              p.fill(ACCENT[0], ACCENT[1], ACCENT[2], 6);
              p.ellipse(so.x, so.y, so.radius * 1.5);
              p.fill(ACCENT[0], ACCENT[1], ACCENT[2], 12);
              p.ellipse(so.x, so.y, so.radius * 0.5);
            }
          }
        };
      };

      this._p5 = new p5Constructor(sketch, container);
    },
  }));

  Alpine.data("constructivistHero", () => ({
    _cleanup: null,
    init() {
      const container = this.$el;
      if (!container) return;
      let cancelled = false;
      let raf = 0;
    const spd = 1.1, windSpd = 0.8, numCircles = 15, numWedges = 7, wedgeScl = 1.0;
    const BG = [10, 10, 15], AC = [0, 229, 255];
    let W = container.offsetWidth, H = container.offsetHeight;

    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    canvas.style.display = "block"; canvas.style.width = W + "px"; canvas.style.height = H + "px";
    container.appendChild(canvas);
    const ctx = canvas.getContext("2d");

    let circles = [], wedges = [], sparks = [];
    let windTime = 0, wedgeScaleOsc = 1.0;

    function generateCircles() {
      circles = [];
      const minR = Math.min(W, H) * 0.04, maxR = Math.min(W, H) * 0.18;
      let att = 0;
      while (circles.length < numCircles && att < 2000) {
        const r = minR + Math.random() * (maxR - minR);
        const x = r + Math.random() * (W - 2 * r), y = r + Math.random() * (H - 2 * r);
        let ok = true;
        for (const c of circles) { if (Math.sqrt((x - c.x) ** 2 + (y - c.y) ** 2) < r + c.r + 8) { ok = false; break; } }
        if (ok) circles.push({ x, y, r, vx: 0, vy: 0, homeX: x, homeY: y });
        att++;
      }
    }

    function initWedges() {
      wedges = [];
      for (let i = 0; i < numWedges; i++) {
        const bW = 30 + Math.random() * 40, len = bW * (3 + Math.random() * 2), ang = Math.random() * Math.PI * 2, v = 0.5 + Math.random() * 1.5;
        wedges.push({ x: Math.random() * W, y: Math.random() * H, angle: ang, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, baseW: bW, length: len, opacity: 0.85 + Math.random() * 0.15 });
      }
    }

    function wedgePath(w, s) {
      const len = w.length * s, half = w.baseW * s * 0.5;
      const tipX = w.x + Math.cos(w.angle) * len * 0.6, tipY = w.y + Math.sin(w.angle) * len * 0.6;
      const px = Math.cos(w.angle + Math.PI / 2), py = Math.sin(w.angle + Math.PI / 2);
      const bx = w.x - Math.cos(w.angle) * len * 0.4, by = w.y - Math.sin(w.angle) * len * 0.4;
      return { tipX, tipY, b1x: bx + px * half, b1y: by + py * half, b2x: bx - px * half, b2y: by - py * half };
    }

    function drawWedge(w, s, color) {
      const p = wedgePath(w, s);
      ctx.beginPath(); ctx.moveTo(p.tipX, p.tipY); ctx.lineTo(p.b1x, p.b1y); ctx.lineTo(p.b2x, p.b2y); ctx.closePath();
      ctx.fillStyle = color; ctx.fill();
    }

    function spawnSparks(x, y, cR) {
      if (sparks.length > 200) return;
      const cnt = 5 + Math.floor(Math.random() * 6), md = 5 + cR * 0.3;
      for (let i = 0; i < cnt; i++) {
        const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 3;
        sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, decay: 0.03 + Math.random() * 0.04, len: md * (0.3 + Math.random() * 0.7) });
      }
    }

    function drawSparks() {
      ctx.lineWidth = 1;
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i]; s.x += s.vx; s.y += s.vy; s.vx *= 0.92; s.vy *= 0.92; s.life -= s.decay;
        if (s.life <= 0) { sparks.splice(i, 1); continue; }
        ctx.strokeStyle = `rgba(${AC[0]},${AC[1]},${AC[2]},${s.life * 0.8})`;
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - s.vx * s.len * 0.3, s.y - s.vy * s.len * 0.3); ctx.stroke();
      }
    }

    function flowNoise(x, y, t) {
      return Math.sin(x * 0.008 + t * 0.3) * 0.5 + Math.sin(y * 0.01 + t * 0.2) * 0.3 + Math.sin((x + y) * 0.005 + t * 0.15) * 0.2 + Math.sin(x * 0.015 - y * 0.012 + t * 0.4) * 0.15;
    }

    function update() {
      windTime += 0.01 * windSpd;
      for (const w of wedges) {
        w.x += w.vx * spd; w.y += w.vy * spd;
        const m = 200 * wedgeScl;
        if (w.x > W + m) w.x = -m; if (w.x < -m) w.x = W + m;
        if (w.y > H + m) w.y = -m; if (w.y < -m) w.y = H + m;
      }
      const wf = windSpd * 0.15, gf = windSpd * 0.12;
      for (const c of circles) {
        c.vx += flowNoise(c.x, c.y, windTime) * wf; c.vy += flowNoise(c.x + 500, c.y + 500, windTime + 100) * wf;
        for (const o of circles) {
          if (o === c) continue; const dx = o.x - c.x, dy = o.y - c.y, dSq = dx * dx + dy * dy, d = Math.sqrt(dSq);
          if (d < 1) continue; const f = gf * (c.r * o.r) / (dSq + 500); c.vx += dx / d * f; c.vy += dy / d * f;
        }
        c.vx += (c.homeX - c.x) * 0.0005; c.vy += (c.homeY - c.y) * 0.0005;
        c.vx *= 0.98; c.vy *= 0.98; c.x += c.vx; c.y += c.vy;
        if (c.x - c.r < 0) { c.x = c.r; c.vx = Math.abs(c.vx) * 0.5; }
        if (c.x + c.r > W) { c.x = W - c.r; c.vx = -Math.abs(c.vx) * 0.5; }
        if (c.y - c.r < 0) { c.y = c.r; c.vy = Math.abs(c.vy) * 0.5; }
        if (c.y + c.r > H) { c.y = H - c.r; c.vy = -Math.abs(c.vy) * 0.5; }
      }
      for (let i = 0; i < circles.length; i++) {
        for (let j = i + 1; j < circles.length; j++) {
          const a = circles[i], b = circles[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy), minD = a.r + b.r + 4;
          if (d < minD && d > 0.01) {
            const ol = (minD - d) / 2, nx = dx / d, ny = dy / d;
            a.x -= nx * ol; a.y -= ny * ol; b.x += nx * ol; b.y += ny * ol;
            const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
            if (rv < 0) { const mA = a.r * a.r, mB = b.r * b.r, tM = mA + mB, imp = rv * 0.8; a.vx += nx * imp * mB / tM; a.vy += ny * imp * mB / tM; b.vx -= nx * imp * mA / tM; b.vy -= ny * imp * mA / tM; }
          }
        }
      }
      const oscT = Math.sin(windTime * 2 * Math.PI / 8) * 0.5 + 0.5;
      wedgeScaleOsc = 0.3 + (wedgeScl - 0.3) * oscT;
    }

    function render() {
      const acS = `rgb(${AC[0]},${AC[1]},${AC[2]})`, bgS = `rgb(${BG[0]},${BG[1]},${BG[2]})`;
      ctx.fillStyle = bgS; ctx.fillRect(0, 0, W, H);
      let maxR = 1; for (const c of circles) if (c.r > maxR) maxR = c.r;
      for (const c of circles) {
        const t = c.r / maxR;
        ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${Math.round(AC[0] * 0.2 + t * AC[0] * 0.8)},${Math.round(AC[1] * 0.15 + t * AC[1] * 0.7)},${Math.round(AC[2] * 0.05 + t * AC[2] * 0.3 + 10)},${0.35 + t * 0.55})`;
        ctx.fill();
      }
      for (const w of wedges) {
        const sc = wedgeScaleOsc, wp = wedgePath(w, sc);
        ctx.globalAlpha = w.opacity; drawWedge(w, sc, acS);
        for (const c of circles) {
          ctx.save(); ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2); ctx.clip(); drawWedge(w, sc, bgS); ctx.restore();
          const pts = [{ x: wp.tipX, y: wp.tipY }, { x: wp.b1x, y: wp.b1y }, { x: wp.b2x, y: wp.b2y }];
          for (let k = 0; k < 3; k++) {
            const p1 = pts[k], p2 = pts[(k + 1) % 3], d1 = (p1.x - c.x) ** 2 + (p1.y - c.y) ** 2, d2 = (p2.x - c.x) ** 2 + (p2.y - c.y) ** 2, r2 = c.r * c.r;
            if ((d1 < r2) !== (d2 < r2)) {
              let t = 0.5;
              for (let it = 0; it < 5; it++) { const mx = p1.x + t * (p2.x - p1.x), my = p1.y + t * (p2.y - p1.y), md = (mx - c.x) ** 2 + (my - c.y) ** 2; if (md < r2) { if (d1 < r2) t += 0.5 / (1 << (it + 1)); else t -= 0.5 / (1 << (it + 1)); } else { if (d1 < r2) t -= 0.5 / (1 << (it + 1)); else t += 0.5 / (1 << (it + 1)); } }
              spawnSparks(p1.x + t * (p2.x - p1.x), p1.y + t * (p2.y - p1.y), c.r);
            }
          }
        }
        ctx.globalAlpha = 1;
      }
      drawSparks();
    }

    function init() {
      if (!container) return;
      const nW = container.offsetWidth, nH = container.offsetHeight;
      if (nW < 1 || nH < 1) return;
      W = nW; H = nH; canvas.width = W; canvas.height = H; canvas.style.width = W + "px"; canvas.style.height = H + "px";
      generateCircles(); initWedges();
    }

    function loop() { if (cancelled) return; update(); render(); raf = requestAnimationFrame(loop); }
    init(); raf = requestAnimationFrame(loop);

    let prevW = W, prevH = H;
    const onResize = () => { if (!container) return; const nW = container.offsetWidth, nH = container.offsetHeight; if (nW === prevW && nH === prevH) return; prevW = nW; prevH = nH; init(); };
    window.addEventListener("resize", onResize);

      this._cleanup = () => {
        cancelled = true;
        cancelAnimationFrame(raf);
        window.removeEventListener("resize", onResize);
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      };
    },
    destroy() { if (this._cleanup) this._cleanup(); },
  }));
}
