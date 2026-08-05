// RESEARCH SIGNALS SEMANTICS: closes #493's open acceptance criterion and
// test-plan item for #465's R5/R7 fix (research-signals.ts). Nothing else in
// the suite pinned:
//   (a) the CHANNEL composite's new all-rollingPercentileRank definition (R7)
//   (b) computeLateCycle's {date, value} 6dp summary shape, incl. the
//       all-NaN {date:null, value:null} sentinel (R5b)
//   (c) positionalLast vs lastFinite divergence on a trailing-NaN axis (R5a)
//   (d) #505: gauge readings are finite-coerced — a non-finite reading is an
//       EXPLICIT null (+ a "no reading" read), never a raw NaN that only looks
//       like null once JSON.stringify has been applied
// research-fidelity.test.ts replays real vendored data but only exercises
// `indicators.*`, which R5/R7 left untouched — it can't see any of the above.
//
// R5a is dormant in production (v1's forward-filled dense axes never end in
// NaN today, per #465 finding 11.2), so only a synthetic trailing-NaN series
// like case (c) below can exercise it at all.
//
// Fixed/synthetic inputs only — small, hand-constructed daily series, not the
// vendored fixtures used by research-fidelity.test.ts. Expected values are
// derived by calling the SAME exported building blocks
// (rollingPercentileRank, rollingBetaSeries, alignDailyForwardFill,
// pctChangeLag, buildDateAxis) that research-signals.ts itself calls, so a
// regression in how research-signals.ts *wires* those blocks together (not a
// bug in math.ts) is what this file is designed to catch.
import { test, expect } from "bun:test";
import {
  computeChannelDivergence,
  computeLateCycle,
  rollingBetaSeries,
  type ChannelInputs,
  type LateCycleInputs,
} from "../src/analytics/analyze/research-signals.ts";
import {
  buildDateAxis,
  alignDailyForwardFill,
  rollingPercentileRank,
  pctChangeLag,
} from "../src/analytics/transform/math.ts";
import type { Point } from "../src/analytics/types.ts";

// Mirrors research-signals.ts's private (unexported) module constants.
// Duplicated deliberately: if they ever drift from the source of truth, the
// sanity assertions below (which require these exact window sizes to clear
// rollingPercentileRank's 30-obs gate) will fail loudly instead of silently
// testing the wrong thing.
const CHANNEL_START = "2018-01-01";
const LATECYCLE_START = "2010-01-01";
const PCT_RANK_WINDOW = 252 * 3; // 756
const BETA_WINDOW = 90;
const FLOW_WINDOW = 90;

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dailySeries(start: string, n: number, fn: (t: number) => number): Point[] {
  return Array.from({ length: n }, (_, t) => ({ date: addDaysIso(start, t), value: fn(t) }));
}

const positionalLastOf = (arr: number[]): number => (arr.length ? arr[arr.length - 1] : NaN);

test("R7: CHANNEL composite is the mean of three rollingPercentileRank-derived positional-last values", () => {
  const N = 150; // clears BETA_WINDOW(90) + the 30-obs rollingPercentileRank gate with room to spare
  const asof = addDaysIso(CHANNEL_START, N - 1);
  const btc = dailySeries(CHANNEL_START, N, (t) => 20000 + 30 * t + 500 * Math.sin(t / 9));
  const qqq = dailySeries(CHANNEL_START, N, (t) => 300 + 0.8 * t + 5 * Math.sin(t / 13));
  const spy = dailySeries(CHANNEL_START, N, (t) => 400 + 0.5 * t + 4 * Math.sin(t / 17));
  const stables = dailySeries(CHANNEL_START, N, (t) => 100000 + 200 * t + 1000 * Math.sin(t / 11));

  const inputs: ChannelInputs = { btc, qqq, spy, stables };
  const result = computeChannelDivergence(inputs, asof);

  // Reproduce the pipeline with the same exported building blocks
  // research-signals.ts itself uses, rather than hand-transcribing numbers.
  const axis = buildDateAxis(CHANNEL_START, asof);
  const btcA = alignDailyForwardFill(btc, axis);
  const qqqA = alignDailyForwardFill(qqq, axis);
  const spyA = alignDailyForwardFill(spy, axis);
  const stablesA = alignDailyForwardFill(stables, axis);

  const btcRet = pctChangeLag(btcA, 1);
  const qqqRet = pctChangeLag(qqqA, 1);
  const spyRet = pctChangeLag(spyA, 1);
  const risk = qqqRet.map((q, i) => (Number.isFinite(q) && Number.isFinite(spyRet[i]) ? q - spyRet[i] : NaN));
  const beta = rollingBetaSeries(btcRet, risk, BETA_WINDOW);
  const betaPctSeries = rollingPercentileRank(beta, PCT_RANK_WINDOW);

  const ratio = btcA.map((b, i) =>
    Number.isFinite(b) && Number.isFinite(qqqA[i]) && qqqA[i] !== 0 ? b / qqqA[i] : NaN,
  );
  const ratioPctSeries = rollingPercentileRank(ratio, PCT_RANK_WINDOW);

  const stables90 = pctChangeLag(stablesA, FLOW_WINDOW);
  const qqq90 = pctChangeLag(qqqA, FLOW_WINDOW);
  const flow = stables90.map((s, i) => (Number.isFinite(s) && Number.isFinite(qqq90[i]) ? s - qqq90[i] : NaN));
  const flowPctSeries = rollingPercentileRank(flow, PCT_RANK_WINDOW);

  const expectedBetaPct = positionalLastOf(betaPctSeries);
  const expectedRatioPctLast = positionalLastOf(ratioPctSeries);
  const expectedFlowPct = positionalLastOf(flowPctSeries);

  // Sanity: the fixture must actually clear the 30-obs percentile-rank gate
  // on all three inputs, or the "consistency" assertions below would pass
  // vacuously on NaN =~= NaN.
  expect(Number.isFinite(expectedBetaPct)).toBe(true);
  expect(Number.isFinite(expectedRatioPctLast)).toBe(true);
  expect(Number.isFinite(expectedFlowPct)).toBe(true);

  const parts = [expectedBetaPct, expectedRatioPctLast, expectedFlowPct].filter(Number.isFinite);
  const expectedComposite = +(parts.reduce((a, b) => a + b, 0) / parts.length).toFixed(3);

  const betaGauge = result.gauges.find((g) => g.id === "BTC_BETA")!;
  const ratioGauge = result.gauges.find((g) => g.id === "BTC_QQQ_RATIO")!;
  const flowGauge = result.gauges.find((g) => g.id === "STABLES_QQQ_FLOW")!;
  const channelGauge = result.gauges.find((g) => g.id === "CHANNEL")!;

  // Each input gauge's percentile must be exactly rollingPercentileRank's
  // output for that input — never percentileInWindow (the old, now-dropped
  // full-history/no-tie-splitting statistic R7 removed).
  expect(betaGauge.percentile).toBeCloseTo(+expectedBetaPct.toFixed(3), 9);
  expect(ratioGauge.percentile).toBeCloseTo(+expectedRatioPctLast.toFixed(3), 9);
  expect(flowGauge.percentile).toBeCloseTo(+expectedFlowPct.toFixed(3), 9);

  // R7: the CHANNEL composite is the plain mean of those three
  // rollingPercentileRank-derived values — one uniform percentile
  // definition, not the old betaPct/flowPct-via-percentileInWindow mix.
  expect(channelGauge.value).toBeCloseTo(expectedComposite, 9);
  expect(channelGauge.percentile).toBeCloseTo(expectedComposite, 9);
});

test("R5b: computeLateCycle summary.* entries are {date, value} 6dp-rounded, and {date:null,value:null} when the series is all-NaN", () => {
  const N = 40; // clears the 30-obs rollingPercentileRank gate for concentration
  const asof = addDaysIso(LATECYCLE_START, N - 1);
  const spy = dailySeries(LATECYCLE_START, N, (t) => 400 + 2 * t);
  const rsp = dailySeries(LATECYCLE_START, N, (t) => 150 + 0.5 * t + 3 * Math.sin(t / 5));
  const top7: Point[][] = Array.from({ length: 7 }, (_, k) =>
    dailySeries(LATECYCLE_START, N, (t) => 100 + k * 10 + t),
  );
  const mna = dailySeries(LATECYCLE_START, N, (t) => 10 + (t % 5));
  const margin = dailySeries(LATECYCLE_START, N, (t) => 5000 + 10 * t);

  // conf deliberately empty: alignDailyForwardFill never resolves a value
  // before the first data point, so with NO data points the aligned series
  // is all-NaN for the whole axis — exercising latestOf's all-NaN branch.
  const inputs: LateCycleInputs = { spy, rsp, top7, mna, margin, conf: [] };
  const result = computeLateCycle(inputs, asof);
  const summary = result.summary as unknown as Record<
    string,
    { date: string | null; value: number | null }
  >;

  // All-NaN case (R5b's {date:null,value:null} sentinel, not the old
  // {latest: null} shape).
  expect(summary.consumer_conf).toEqual({ date: null, value: null });

  // Normal case: independently reproduce concentration_pct with the same
  // building blocks to get an expected {date, value} pair.
  const axis = buildDateAxis(LATECYCLE_START, asof);
  const spyA = alignDailyForwardFill(spy, axis);
  const rspA = alignDailyForwardFill(rsp, axis);
  const capVsEqual = spyA.map((s, i) =>
    Number.isFinite(s) && Number.isFinite(rspA[i]) && rspA[i] !== 0 ? s / rspA[i] : NaN,
  );
  const capVsEqualPct = rollingPercentileRank(capVsEqual, PCT_RANK_WINDOW);
  const lastIdx = capVsEqualPct.length - 1;

  // Sanity: this fixture actually reaches the non-null {date,value} path.
  expect(Number.isFinite(capVsEqualPct[lastIdx])).toBe(true);

  const expectedValue = +capVsEqualPct[lastIdx].toFixed(6);
  expect(summary.concentration).toEqual({ date: axis[lastIdx], value: expectedValue });
  // Explicitly pin the shape (not just deep-equality with the recomputed
  // value): {date, value}, value rounded to 6dp — not the old {latest}.
  expect(Object.keys(summary.concentration).sort()).toEqual(["date", "value"]);
  expect(typeof summary.concentration.date).toBe("string");
  expect(typeof summary.concentration.value).toBe("number");
});

test("R5a: a trailing-NaN axis distinguishes positionalLast from lastFinite in computeChannelDivergence's summary/gauge readings", () => {
  const N = 150;
  const asof = addDaysIso(CHANNEL_START, N - 1);
  const btc = dailySeries(CHANNEL_START, N, (t) => 20000 + 30 * t + 500 * Math.sin(t / 9));

  // qqq is finite on every axis day EXCEPT the very last one, where it's
  // deliberately 0. `ratio = btc/qqq` (and its rollingPercentileRank) is
  // therefore NaN exactly at the array's POSITIONAL-last index, while
  // earlier indices (e.g. the day before) stay finite — the axis' final day
  // "didn't resolve" the way #465 finding 11.2 describes. Real production
  // axes are forward-filled and dense, so this trailing-NaN shape can't
  // occur there today (R5a is dormant); only a synthetic series like this
  // one can exercise positionalLast vs lastFinite at all.
  const qqqValues = Array.from({ length: N }, (_, t) => 300 + 0.8 * t + 5 * Math.sin(t / 13));
  qqqValues[N - 1] = 0;
  const qqq: Point[] = qqqValues.map((value, t) => ({ date: addDaysIso(CHANNEL_START, t), value }));
  const spy = dailySeries(CHANNEL_START, N, (t) => 400 + 0.5 * t + 4 * Math.sin(t / 17));
  const stables = dailySeries(CHANNEL_START, N, (t) => 100000 + 200 * t + 1000 * Math.sin(t / 11));

  const inputs: ChannelInputs = { btc, qqq, spy, stables };
  const result = computeChannelDivergence(inputs, asof);

  // Independently derive both readings from the same ratio/percentile-rank
  // building blocks, to prove the fixture actually diverges before checking
  // which one production picked.
  const axis = buildDateAxis(CHANNEL_START, asof);
  const btcA = alignDailyForwardFill(btc, axis);
  const qqqA = alignDailyForwardFill(qqq, axis);
  const ratio = btcA.map((b, i) =>
    Number.isFinite(b) && Number.isFinite(qqqA[i]) && qqqA[i] !== 0 ? b / qqqA[i] : NaN,
  );
  const ratioPct = rollingPercentileRank(ratio, PCT_RANK_WINDOW);

  const positionalLastVal = positionalLastOf(ratioPct);
  let lastFiniteVal = NaN;
  for (let i = ratioPct.length - 1; i >= 0; i--) {
    if (Number.isFinite(ratioPct[i])) {
      lastFiniteVal = ratioPct[i];
      break;
    }
  }

  // Sanity: the fixture genuinely diverges — positionalLast is NaN (the
  // final day's ratio never resolved), lastFinite is a real, finite,
  // earlier value. If this pair of assertions ever fails, the test below is
  // no longer exercising R5a at all.
  expect(Number.isNaN(positionalLastVal)).toBe(true);
  expect(Number.isFinite(lastFiniteVal)).toBe(true);

  // R5a: production reads the POSITIONAL-last value — which has no finite
  // reading here, published as an explicit null since #505 (it was a raw NaN
  // before) — and must NOT reach back through the trailing NaN to
  // lastFiniteVal.
  const ratioGauge = result.gauges.find((g) => g.id === "BTC_QQQ_RATIO")!;
  expect(ratioGauge.percentile).toBeNull();
  expect(ratioGauge.percentile).not.toBe(+lastFiniteVal.toFixed(3));

  const summary = result.summary as unknown as Record<string, { latest: number | null }>;
  expect(summary.ratio_percentile.latest).toBeNull();
});

// Asserts a gauge field is either a finite number or an EXPLICIT null — and in
// particular never a raw NaN, which is the #505 defect: `+NaN.toFixed(3)` is
// NaN, and JSON.stringify renders NaN as `null`, so the null a consumer saw was
// a serialization artifact rather than a deliberate "no reading".
// The label rides along in the compared object so a failure names the offending
// gauge field instead of just reporting `false !== true`.
function expectFiniteOrExplicitNull(v: number | null, label: string): void {
  expect({ field: label, finiteOrExplicitNull: v === null || Number.isFinite(v) }).toEqual({
    field: label,
    finiteOrExplicitNull: true,
  });
}

test("#505: a trailing-NaN axis publishes an EXPLICIT null gauge reading, never a raw NaN", () => {
  const N = 150;
  const asof = addDaysIso(CHANNEL_START, N - 1);
  const btc = dailySeries(CHANNEL_START, N, (t) => 20000 + 30 * t + 500 * Math.sin(t / 9));

  // LOAD-BEARING fixture construction: the final qqq value is forced to 0 so
  // the `qqqA[i] !== 0` division guard in computeChannelDivergence yields NaN
  // exactly at the axis' terminal index. OMITTING the final point does NOT
  // work — alignDailyForwardFill backfills it from the previous day, leaving a
  // dense, entirely-finite axis and a vacuous test.
  const qqqValues = Array.from({ length: N }, (_, t) => 300 + 0.8 * t + 5 * Math.sin(t / 13));
  qqqValues[N - 1] = 0;
  const qqq: Point[] = qqqValues.map((value, t) => ({ date: addDaysIso(CHANNEL_START, t), value }));
  const spy = dailySeries(CHANNEL_START, N, (t) => 400 + 0.5 * t + 4 * Math.sin(t / 17));
  const stables = dailySeries(CHANNEL_START, N, (t) => 100000 + 200 * t + 1000 * Math.sin(t / 11));

  // ── ANTI-VACUITY GUARD ────────────────────────────────────────────────────
  // Prove, from the same building blocks production uses, that this fixture
  // really does produce a NON-FINITE TERMINAL value — before asserting
  // anything about the payload. Without this the assertions below would pass
  // on a fixture where the condition never arises and prove nothing.
  const axis = buildDateAxis(CHANNEL_START, asof);
  const btcA = alignDailyForwardFill(btc, axis);
  const qqqA = alignDailyForwardFill(qqq, axis);
  expect(qqqA[qqqA.length - 1]).toBe(0); // forward-fill did NOT overwrite the terminal 0
  const ratio = btcA.map((b, i) =>
    Number.isFinite(b) && Number.isFinite(qqqA[i]) && qqqA[i] !== 0 ? b / qqqA[i] : NaN,
  );
  const ratioPct = rollingPercentileRank(ratio, PCT_RANK_WINDOW);
  expect(Number.isNaN(positionalLastOf(ratio))).toBe(true);
  expect(Number.isNaN(positionalLastOf(ratioPct))).toBe(true);
  // ...and that the terminal NaN is local to the ratio axis, so a blanket
  // "everything is null" payload would NOT satisfy the assertions below.
  expect(ratio.filter(Number.isFinite).length).toBeGreaterThan(0);

  const inputs: ChannelInputs = { btc, qqq, spy, stables };
  const result = computeChannelDivergence(inputs, asof);

  const ratioGauge = result.gauges.find((g) => g.id === "BTC_QQQ_RATIO")!;
  // The non-finite positional-last percentile is published as a deliberate,
  // documented null (see the Gauge type in research.ts) with an explicit read —
  // not a raw NaN, and not a confident-sounding middle-bucket label.
  expect(ratioGauge.percentile).toBeNull();
  expect(ratioGauge.read).toBe("no reading");
  // BTC_QQQ_RATIO is the deliberately MIXED gauge (#493 Behaviour): its raw
  // `value` remains last-FINITE, so it stays a real number on this same
  // trailing-NaN axis. Pinned here so a future "uniformize the gauge" change
  // has to argue with a test.
  expect(typeof ratioGauge.value).toBe("number");
  expect(Number.isFinite(ratioGauge.value as number)).toBe(true);

  // Every remaining gauge still carries a finite reading — the null above is
  // specific to the axis that genuinely has no terminal reading.
  for (const id of ["BTC_BETA", "STABLES_QQQ_FLOW", "CHANNEL"]) {
    const g = result.gauges.find((x) => x.id === id)!;
    expect(Number.isFinite(g.value as number)).toBe(true);
    expect(Number.isFinite(g.percentile as number)).toBe(true);
    expect(g.read).not.toBe("no reading");
  }

  // No gauge field anywhere in the payload is a raw NaN.
  for (const g of result.gauges) {
    expectFiniteOrExplicitNull(g.value, `${g.id}.value`);
    expectFiniteOrExplicitNull(g.percentile, `${g.id}.percentile`);
    expect(Number.isNaN(g.value as number)).toBe(false);
    expect(Number.isNaN(g.percentile as number)).toBe(false);
    expect(typeof g.read).toBe("string");
    expect(g.read.length).toBeGreaterThan(0);
  }

  // The payload a consumer actually receives must be identical to the in-process
  // payload. This is the crux of #505: with a raw NaN on the gauge, the wire
  // form (null) and the in-process form (NaN) DISAGREE, so every null a frontend
  // sees is ambiguous. Round-tripping makes that ambiguity a test failure.
  const wire = JSON.parse(JSON.stringify(result.gauges)) as typeof result.gauges;
  expect(wire).toEqual(result.gauges);
  expect(wire.find((g) => g.id === "BTC_QQQ_RATIO")!.percentile).toBeNull();
});

test("#505: an axis with NO finite observation at all publishes null gauge value AND percentile", () => {
  // The trailing-NaN case above can only null out a percentile (BTC_QQQ_RATIO's
  // raw value is last-finite by design). This case covers the gauge `value`
  // coercion: an input series that never resolves anywhere on the axis.
  const N = 40; // clears the 30-obs rollingPercentileRank gate for concentration
  const asof = addDaysIso(LATECYCLE_START, N - 1);
  const spy = dailySeries(LATECYCLE_START, N, (t) => 400 + 2 * t);
  const rsp = dailySeries(LATECYCLE_START, N, (t) => 150 + 0.5 * t + 3 * Math.sin(t / 5));
  const top7: Point[][] = Array.from({ length: 7 }, (_, k) =>
    dailySeries(LATECYCLE_START, N, (t) => 100 + k * 10 + t),
  );
  const mna = dailySeries(LATECYCLE_START, N, (t) => 10 + (t % 5));
  const margin = dailySeries(LATECYCLE_START, N, (t) => 5000 + 10 * t);

  // ANTI-VACUITY GUARD: prove the conf axis really is all-NaN (empty input →
  // alignDailyForwardFill never resolves a value) before asserting on the
  // payload.
  const axis = buildDateAxis(LATECYCLE_START, asof);
  const confA = alignDailyForwardFill([], axis);
  expect(confA.length).toBeGreaterThan(0);
  expect(confA.some(Number.isFinite)).toBe(false);

  const inputs: LateCycleInputs = { spy, rsp, top7, mna, margin, conf: [] };
  const result = computeLateCycle(inputs, asof);

  const confGauge = result.gauges.find((g) => g.id === "CONF")!;
  expect(confGauge.value).toBeNull();
  expect(confGauge.percentile).toBeNull();
  expect(confGauge.read).toBe("no reading");

  // Not a blanket null payload: concentration still reads normally.
  const concentration = result.gauges.find((g) => g.id === "CONCENTRATION")!;
  expect(Number.isFinite(concentration.value as number)).toBe(true);
  expect(Number.isFinite(concentration.percentile as number)).toBe(true);

  for (const g of result.gauges) {
    expectFiniteOrExplicitNull(g.value, `${g.id}.value`);
    expectFiniteOrExplicitNull(g.percentile, `${g.id}.percentile`);
    expect(Number.isNaN(g.value as number)).toBe(false);
    expect(Number.isNaN(g.percentile as number)).toBe(false);
  }

  const wire = JSON.parse(JSON.stringify(result.gauges)) as typeof result.gauges;
  expect(wire).toEqual(result.gauges);
});
