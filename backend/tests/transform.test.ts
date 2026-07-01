// Transform stage (pure): the dense-grid reshaping the live provider relies on.
import { test, expect } from "bun:test";
import { shapeDaily, ratioByDate } from "../src/analytics/transform/grid.ts";

test("shapeDaily: forward-fills onto a dense grid of length lookbackDays", () => {
  const raw = [
    { date: "2024-01-10", value: 10 },
    { date: "2024-01-12", value: 20 },
    { date: "2024-01-20", value: 99 }, // after asof → must be ignored
  ];
  const out = shapeDaily(raw, "2024-01-13", 5)!;
  expect(out).not.toBeNull();
  expect(out.length).toBe(5); // == lookbackDays
  expect(out.map((p) => p.date)).toEqual([
    "2024-01-09", "2024-01-10", "2024-01-11", "2024-01-12", "2024-01-13",
  ]);
  // back-fill before first obs (10), carry forward through the gap, step to 20.
  expect(out.map((p) => p.value)).toEqual([10, 10, 10, 20, 20]);
});

test("shapeDaily: null when there is no data at/-before asof", () => {
  const raw = [{ date: "2024-02-01", value: 5 }];
  expect(shapeDaily(raw, "2024-01-13", 5)).toBeNull();
  expect(shapeDaily([], "2024-01-13", 5)).toBeNull();
});

test("ratioByDate: aligns on shared dates only (a/b)", () => {
  const a = [
    { date: "2024-01-01", value: 100 },
    { date: "2024-01-02", value: 200 },
    { date: "2024-01-03", value: 300 },
  ];
  const b = [
    { date: "2024-01-01", value: 50 },
    { date: "2024-01-03", value: 150 },
  ];
  expect(ratioByDate(a, b)).toEqual([
    { date: "2024-01-01", value: 2 },
    { date: "2024-01-03", value: 2 },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Ported regime math (from agentjuno/robotmoney scripts/regime/lib/utils.js and
// compute.js). Hand-checked small cases.
// ─────────────────────────────────────────────────────────────────────────────
import {
  rollingPercentileRank,
  inverseCorrelationWeights,
  capWeights,
  pearson,
  sma as smaNaN,
} from "../src/analytics/transform/math.ts";
import { smoothRegimes, bucketFn } from "../src/analytics/analyze/compute.ts";

test("rollingPercentileRank: rank = (below + 0.5·equal)/n; NaN until 30 finite obs", () => {
  const xs = Array.from({ length: 50 }, (_, i) => i); // 0..49
  const r = rollingPercentileRank(xs, 1095);
  expect(Number.isNaN(r[28])).toBe(true); // only 29 obs < 30
  expect(r[29]).toBeCloseTo((29 + 0.5) / 30, 12); // value 29, all below + itself
  expect(r[49]).toBeCloseTo((49 + 0.5) / 50, 12); // max value
});

test("pearson: +1 / -1 / 0-variance / <3 pairs", () => {
  expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
  expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 12);
  expect(pearson([5, 5, 5], [1, 2, 3])).toBe(0); // zero variance
  expect(pearson([1, 2], [1, 2])).toBe(0); // <3 pairs
});

test("sma: NaN-tolerant, minValid = ceil-ish floor(n/2)", () => {
  const out = smaNaN([1, 2, NaN, 4, 5], 4);
  expect(Number.isNaN(out[0])).toBe(true);
  expect(Number.isNaN(out[2])).toBe(true);
  expect(out[3]).toBeCloseTo(7 / 3, 12); // mean of {1,2,4}
  expect(out[4]).toBeCloseTo(11 / 3, 12); // mean of {2,4,5}
});

test("capWeights: proportional redistribution of excess (feasible cap)", () => {
  const w = capWeights({ a: 0.5, b: 0.3, c: 0.2 }, 0.4);
  expect(w.a).toBeCloseTo(0.4, 12);
  expect(w.b).toBeCloseTo(0.36, 12);
  expect(w.c).toBeCloseTo(0.24, 12);
  expect(w.a + w.b + w.c).toBeCloseTo(1, 12);
});

test("inverseCorrelationWeights: 25% cap respected, weights normalize, low-obs excluded", () => {
  const n = 200;
  const mk = (f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
  // 4 correlated series + 1 orthogonal (would grab high inverse-corr weight) +
  // 1 too-short series (should be excluded → weight 0).
  const panel: Record<string, number[]> = {
    a: mk((i) => Math.sin(i / 5)),
    b: mk((i) => Math.sin(i / 5) + 0.01 * (i % 3)),
    c: mk((i) => Math.sin(i / 5) - 0.02 * (i % 4)),
    d: mk((i) => Math.sin(i / 5) + 0.5),
    e: mk((i) => Math.cos(i / 13)), // orthogonal-ish
    f: Array.from({ length: n }, (_, i) => (i < 40 ? i : NaN)), // <60 finite → excluded
  };
  const w = inverseCorrelationWeights(panel);
  const sum = Object.values(w).reduce((s, v) => s + v, 0);
  expect(sum).toBeCloseTo(1, 9);
  for (const id of Object.keys(w)) expect(w[id]).toBeLessThanOrEqual(0.25 + 1e-9);
  expect(w.f).toBe(0); // excluded for insufficient observations
});

test("smoothRegimes: 5-day confirmation delays a flip until confirmed", () => {
  // 9 risk_on days then neutral; flip only confirms on the 5th consecutive neutral.
  const seq = [0.8, 0.8, 0.8, 0.8, 0.8, 0.5, 0.5, 0.5, 0.5, 0.5];
  const out = smoothRegimes(seq, bucketFn);
  expect(out.slice(0, 9).every((r) => r === "risk_on")).toBe(true);
  expect(out[9]).toBe("neutral"); // 5th consecutive neutral (idx 5..9) confirms
});

test("smoothRegimes: 2σ fast-track flips immediately on a large move", () => {
  const seq: number[] = [];
  for (let i = 0; i < 35; i++) seq.push(0.8 + (i % 2) * 0.01); // tight risk_on, nonzero σ
  seq.push(0.1); // sudden multi-σ drop into risk_off
  const out = smoothRegimes(seq, bucketFn);
  expect(out[34]).toBe("risk_on");
  expect(out[35]).toBe("risk_off"); // fast-tracked, no 5-day wait
});
