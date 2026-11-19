// Issue 1667: the fast rank and weight kernels return bit-identical results to
// the code they replaced (support/reference-kernels.ts), Object.is on every
// element and weight, on the full SDK fixture and on seeded random inputs.
import { describe, expect, test } from "bun:test";
import { INDICATORS, PANELS, ROLLING_WINDOW_DAYS } from "../src/analyze/indicators.ts";
import { prepareRegimeInputs } from "../src/prepare.ts";
import { BACKFILL_START, buildReport, runRegime as runRegimeOutcome, requireComplete } from "../src/run.ts";
// Each run here scores a complete day (issue 1655): an IncompleteDay fails the test.
const runRegime = (...a: Parameters<typeof runRegimeOutcome>) => requireComplete(runRegimeOutcome(...a));
import { correlation, correlationFromMoments, correlationMoments } from "../src/transform/exact.ts";
import { inverseCorrelationWeights, lcg, MAX_FORWARD_FILL_DAYS, rollingPercentileRank } from "../src/transform/math.ts";
import { resolveInputHistory } from "../src/series-ids.ts";
import { ratiosFromLegs } from "../src/transform/ratios.ts";
import * as ref from "./support/reference-kernels.ts";
import { fixture, legInputs } from "./support/ratio-legs.ts";

// First index where the two arrays differ under Object.is, or -1.
function firstDiff(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return i;
  return -1;
}
function weightDiff(a: Record<string, number>, b: Record<string, number>): string | null {
  const ka = Object.keys(a);
  if (ka.join() !== Object.keys(b).join()) return "keys";
  for (const k of ka) if (!Object.is(a[k], b[k])) return k;
  return null;
}

// The fixture as the regime core sees it: each indicator's transformed series
// with stale forward-fills masked (computeRegime), and every panel's signed
// rank series and panel index.
const run = runRegime(fixture, { factor: true });
const raw = ratiosFromLegs(fixture, resolveInputHistory(fixture));
const prepared = prepareRegimeInputs(raw, { start: BACKFILL_START, asof: run.dateAxis[run.dateAxis.length - 1]! });
const indicatorSeries: Record<string, number[]> = {};
for (const ind of INDICATORS) {
  const age = prepared.ages[ind.id];
  const xs = prepared.transformed[ind.id]!;
  indicatorSeries[ind.id] = age ? xs.map((v, i) => (Number.isFinite(age[i]) && age[i]! > MAX_FORWARD_FILL_DAYS ? NaN : v)) : xs;
}
const panelIndexSeries: Record<string, number[]> = {};
for (const p of PANELS) panelIndexSeries[p] = run.result.panelIndices[p]!;
panelIndexSeries.factor = run.factor!.panelIndices.factor!;

// Seeded random series: NaN gaps, ties, +/-Infinity, -0 and wide magnitudes.
function randomSeries(rnd: () => number, n: number): number[] {
  const kind = Math.floor(rnd() * 4);
  const prefix = Math.floor(rnd() * Math.min(n, 400));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = rnd();
    if (i < prefix || u < 0.05) out.push(NaN);
    else if (u < 0.07) out.push(rnd() < 0.5 ? Infinity : -Infinity);
    else if (u < 0.08) out.push(rnd() < 0.5 ? 0 : -0);
    else if (kind === 0) out.push(Math.floor(rnd() * 20)); // heavy ties
    else if (kind === 1) out.push((rnd() - 0.5) * 10 ** Math.floor(rnd() * 20 - 10));
    else if (kind === 2) out.push(Math.round((rnd() - 0.5) * 1000) / 8);
    else out.push(rnd());
  }
  return out;
}

describe("rollingPercentileRank equals the reference", () => {
  test("on every indicator series and panel index of the full SDK fixture, at window 1095 and window = length", () => {
    const all = { ...indicatorSeries, ...panelIndexSeries };
    expect(Object.keys(all).length).toBe(INDICATORS.length + 3);
    for (const [id, xs] of Object.entries(all)) {
      expect(xs.filter(Number.isFinite).length, id).toBeGreaterThan(30);
      for (const w of [ROLLING_WINDOW_DAYS, xs.length]) {
        expect(firstDiff(rollingPercentileRank(xs, w), ref.rollingPercentileRank(xs, w)), `${id} window ${w}`).toBe(-1);
      }
    }
  }, 120_000);

  test("on 200 seeded random series (lengths 0 to 5,000) at windows 1, 30, 1095 and length", () => {
    const rnd = lcg(1667);
    for (let k = 0; k < 200; k++) {
      const n = k === 0 ? 0 : Math.floor(rnd() * 5001);
      const xs = randomSeries(rnd, n);
      for (const w of [1, 30, 1095, n]) {
        expect(firstDiff(rollingPercentileRank(xs, w), ref.rollingPercentileRank(xs, w)), `series ${k} n ${n} window ${w}`).toBe(-1);
      }
    }
  }, 120_000);

  test("on odd windows: 0, negative, fractional, NaN and Infinity", () => {
    const xs = randomSeries(lcg(7), 400);
    for (const w of [0, -3, 0.5, 30.5, 45.25, NaN, Infinity, 10_000]) {
      expect(firstDiff(rollingPercentileRank(xs, w), ref.rollingPercentileRank(xs, w)), `window ${w}`).toBe(-1);
    }
  });
});

describe("inverseCorrelationWeights equals the reference", () => {
  test("on each panel of the full SDK fixture, on every weight window the regime core uses, with default arguments", () => {
    const signed = { ...run.result.signed, ...run.factor!.signed };
    const n = run.dateAxis.length;
    let windows = 0;
    for (const p of ["macro", "onchain", "factor"]) {
      const ids = INDICATORS.filter((x) => x.panel === p).map((x) => x.id);
      for (let i = 0; i < n; i++) {
        if (i % 21 !== 0 && i !== n - 1) continue;
        const start = Math.max(0, i - ROLLING_WINDOW_DAYS + 1);
        const win: Record<string, number[]> = {};
        for (const id of ids) win[id] = signed[id]!.slice(start, i + 1);
        expect(weightDiff(inverseCorrelationWeights(win), ref.inverseCorrelationWeights(win)), `${p} day ${i}`).toBeNull();
        windows++;
      }
      // The whole history as one window.
      const full: Record<string, number[]> = {};
      for (const id of ids) full[id] = signed[id]!;
      expect(weightDiff(inverseCorrelationWeights(full), ref.inverseCorrelationWeights(full)), `${p} full`).toBeNull();
    }
    expect(windows).toBeGreaterThan(100);
  }, 120_000);

  test("on 200 seeded random panels (2 to 12 series, NaN prefixes, interior NaNs, constant series, 1e-300 to 1e300)", () => {
    const rnd = lcg(16670);
    for (let k = 0; k < 200; k++) {
      const m = 2 + Math.floor(rnd() * 11);
      const n = 40 + Math.floor(rnd() * 400);
      const sharedPrefix = Math.floor(rnd() * 30);
      const panel: Record<string, number[]> = {};
      for (let s = 0; s < m; s++) {
        const scale = 10 ** Math.floor(rnd() * 601 - 300);
        // Most series share one NaN pattern (the fast path); some differ.
        const prefix = rnd() < 0.6 ? sharedPrefix : Math.floor(rnd() * 60);
        const holes = rnd() < 0.3;
        const constant = rnd() < 0.1;
        const xs: number[] = [];
        for (let i = 0; i < n; i++) {
          if (i < prefix || (holes && rnd() < 0.1)) xs.push(NaN);
          else xs.push(constant ? scale : (rnd() - 0.3) * scale);
        }
        panel[`S${s}`] = xs;
      }
      const minValidObs = rnd() < 0.2 ? Math.floor(rnd() * 5) : 60;
      const cap = rnd() < 0.2 ? 0.5 : 0.25;
      expect(weightDiff(inverseCorrelationWeights(panel), ref.inverseCorrelationWeights(panel)), `panel ${k}`).toBeNull();
      expect(
        weightDiff(inverseCorrelationWeights(panel, minValidObs, cap), ref.inverseCorrelationWeights(panel, minValidObs, cap)),
        `panel ${k} minValidObs ${minValidObs} cap ${cap}`,
      ).toBeNull();
    }
  }, 120_000);
});

describe("correlationFromMoments equals correlation", () => {
  test("on seeded random pairs, with moments from the same series", () => {
    const rnd = lcg(166700);
    for (let k = 0; k < 500; k++) {
      const n = 1 + Math.floor(rnd() * 300);
      const sx = 10 ** Math.floor(rnd() * 601 - 300);
      const sy = 10 ** Math.floor(rnd() * 601 - 300);
      const constant = rnd() < 0.1;
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < n; i++) {
        const x = rnd() - 0.5;
        xs.push(constant ? sx : x * sx);
        ys.push((x * (rnd() - 0.2) + (rnd() - 0.5)) * sy);
      }
      const mx = correlationMoments(xs);
      const my = correlationMoments(ys);
      const r = correlationFromMoments(mx.a, my.a, mx.m, my.m, mx.sxx, my.sxx);
      expect(Object.is(r, correlation(xs, ys)), `pair ${k}`).toBe(true);
    }
  });
});

describe("one shared regime run gives the same reports as fresh runs", () => {
  test("buildReport(shared, { full: true }) and buildReport(shared) equal the reports from two fresh runRegime(stored) calls", () => {
    const { stored } = legInputs();
    const shared = runRegime(stored);
    const sharedFull = JSON.stringify(buildReport(shared, { full: true }));
    const sharedDefault = JSON.stringify(buildReport(shared));
    expect(sharedFull).toBe(JSON.stringify(buildReport(runRegime(stored), { full: true })));
    expect(sharedDefault).toBe(JSON.stringify(buildReport(runRegime(stored))));
  }, 120_000);
});
