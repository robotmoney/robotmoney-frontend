// Shared, pure analytics math. Used by every tool (regime + research) so the
// normalization is identical across the suite. No I/O, no data-source knowledge.

export function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

// Fraction of `window` values <= value (0..1).
export function percentileInWindow(value: number, window: number[]): number {
  if (window.length <= 1) return 0.5;
  return window.filter((x) => x <= value).length / window.length;
}

// Sign-adjust a 0..1 percentile into a risk-on score (sign -1 inverts).
export const applySign = (pct: number, sign: 1 | -1) => (sign === 1 ? pct : 1 - pct);

export function pctChange(xs: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < xs.length; i++) out.push(xs[i - 1] ? xs[i] / xs[i - 1] - 1 : 0);
  return out;
}

export function ratio(a: number[], b: number[]): number[] {
  const n = Math.min(a.length, b.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(b[i] ? a[i] / b[i] : 0);
  return out;
}

// OLS slope of y on x over the last `window` paired points (rolling beta).
export function rollingBeta(y: number[], x: number[], window: number): number {
  const n = Math.min(y.length, x.length);
  const ys = y.slice(n - window), xs = x.slice(n - window);
  const mx = mean(xs), my = mean(ys);
  let cov = 0, varx = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    varx += (xs[i] - mx) ** 2;
  }
  return varx ? cov / varx : 0;
}

// Date string `daysAgo` before an ISO YYYY-MM-DD (no Date.now()).
export function dateBefore(asof: string, daysAgo: number): string {
  const [y, m, d] = asof.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - daysAgo * 86400_000).toISOString().slice(0, 10);
}
