/**
 * Substrate — Crystal growth visualization (p5.js sketch)
 * Ported from robotmoney-site/src/app/substrate/page.tsx
 *
 * Pattern for all visualization modules:
 * export function createXxxSketch(container, options = {}) { ... }
 * Returns a p5 sketch function that receives (p) parameter
 */

export function createSubstrateSketch(container, options = {}) {
  const {
    intensity = 81,
    speed = 6.0,
    fadeSec = 4,
    lineW = 1.1,
    dotSize = 36
  } = options;

  const ACCENT = [0, 229, 255];    // cyan
  const BG = [10, 10, 15];         // dark void

  function I(lo, hi) {
    return lo + (hi - lo) * (intensity / 100);
  }

  return (p) => {
    let W, H;
    let cgrid;
    let cracks = [];
    let numCracks = 0;
    let maxCracks;
    let phase = 0;
    let fadeTimer = 0;
    let generation = 0;
    let stasisFrames = 0;
    let crackLayer;

    function Crack() {
      this.x = 0;
      this.y = 0;
      this.t = 0;
      this.alive = true;

      this.findStart = function() {
        for (let attempt = 0; attempt < 5000; attempt++) {
          let px = Math.floor(p.random(W));
          let py = Math.floor(p.random(H));
          if (cgrid[py * W + px] < 10000) {
            let a = cgrid[py * W + px];
            if (p.random(100) < 50) {
              a -= 90 + Math.floor(p.random(-2, 3));
            } else {
              a += 90 + Math.floor(p.random(-2, 3));
            }
            this.x = px + 0.61 * Math.cos((a * Math.PI) / 180);
            this.y = py + 0.61 * Math.sin((a * Math.PI) / 180);
            this.t = a;
            return;
          }
        }
      };

      this.step = function() {
        if (!this.alive) return;

        let nx = this.x + (speed / 60) * Math.cos((this.t * Math.PI) / 180);
        let ny = this.y + (speed / 60) * Math.sin((this.t * Math.PI) / 180);

        let pxn = Math.floor(nx);
        let pyn = Math.floor(ny);

        if (pxn < 0 || pxn >= W || pyn < 0 || pyn >= H) {
          this.alive = false;
          return;
        }

        if (cgrid[pyn * W + pxn] < 10000) {
          this.x = nx;
          this.y = ny;
        } else {
          this.alive = false;
          cgrid[pyn * W + pxn] = Math.min(cgrid[pyn * W + pxn], this.t);
        }
      };

      this.draw = function() {
        p.stroke(ACCENT[0], ACCENT[1], ACCENT[2]);
        p.strokeWeight(lineW);
        p.point(this.x, this.y);
      };
    }

    p.setup = function() {
      if (!container) return;

      W = container.offsetWidth;
      H = container.offsetHeight;

      if (W < 100 || H < 100) return;

      const canvas = p.createCanvas(W, H);
      canvas.parent(container);
      canvas.style('display', 'block');

      p.background(BG[0], BG[1], BG[2]);
      p.pixelDensity(1);

      cgrid = new Int32Array(W * H);
      for (let i = 0; i < cgrid.length; i++) {
        cgrid[i] = 10000;
      }

      maxCracks = Math.floor(I(5, 80));
      crackLayer = p.createGraphics(W, H);
      crackLayer.background(BG[0], BG[1], BG[2]);
    };

    p.draw = function() {
      if (!cgrid) return;

      fadeTimer += 1 / 60;
      if (fadeTimer > fadeSec && numCracks < maxCracks) {
        fadeTimer = 0;
        if (numCracks < cracks.length && !cracks[numCracks].alive) {
          cracks[numCracks].findStart();
          if (cracks[numCracks].alive) {
            numCracks++;
          }
        } else if (numCracks < cracks.length) {
          let c = new Crack();
          c.findStart();
          if (c.alive) {
            cracks[numCracks] = c;
            numCracks++;
          }
        }
      }

      for (let i = 0; i < numCracks; i++) {
        for (let s = 0; s < 3; s++) {
          cracks[i].step();
        }
      }

      p.background(BG[0], BG[1], BG[2]);
      for (let i = 0; i < numCracks; i++) {
        cracks[i].draw();
      }

      stasisFrames++;
      if (stasisFrames > 300 && numCracks >= maxCracks) {
        generation++;
        stasisFrames = 0;
        numCracks = 0;
        fadeTimer = 0;
        for (let i = 0; i < cgrid.length; i++) {
          cgrid[i] = 10000;
        }
        cracks = [];
      }
    };

    p.windowResized = function() {
      if (!cgrid) return;
      const newW = container?.offsetWidth || W;
      const newH = container?.offsetHeight || H;
      if (newW !== W || newH !== H) {
        W = newW;
        H = newH;
        p.resizeCanvas(W, H);
        cgrid = new Int32Array(W * H);
        for (let i = 0; i < cgrid.length; i++) {
          cgrid[i] = 10000;
        }
        numCracks = 0;
        fadeTimer = 0;
      }
    };
  };
}
