// BACKTEST + CORRELATIONS FIDELITY: our ported computeBacktest / computeCorrelations
// must reproduce the ORIGINAL agentjuno/robotmoney scripts/regime/update.js output
// BYTE-IDENTICALLY over the same inputs.
//
// ── Why a JS reference, not the committed regime-snapshot.json ────────────────
// The committed regime-snapshot.json.gz bakes backtest+correlations computed from
// the ORIGINAL's FROZEN regime history (each past day locked to the raw-data vintage
// available when it was first computed). A fresh recompute from the committed
// raw-indicator-history.csv.gz legitimately diverges from those frozen rows — the
// SAME data-vintage effect regime-fidelity.test.ts documents (9 regime-label rows
// differ, which flips backtest transitions 58↔56 and cascades ~8% into final_value).
// That drift is inherent to the frozen fixture, NOT a port defect. So — exactly as
// regime-compute-reference.json.gz does for computeRegime — the STRICT proof of
// ALGORITHM-PORT fidelity is exact reproduction of a reference produced by the
// ORIGINAL JS over the SAME raw fixture; the committed snapshot is asserted to
// TRACK within the documented vintage drift.
//
// Reference (regime-backtest-correlations-reference.json.gz) was produced by running
// update.js computeBacktest (stripped) + computeCorrelations VERBATIM over:
//   • result: reconstructed from regime-compute-reference.json.gz (original JS
//     2-panel computeRegime over the vendored raw fixture — which our TS port
//     reproduces to <1e-12, proven in regime-fidelity.test.ts)
//   • extras: real Yahoo ^GSPC / ETH-USD + FRED DTB3, truncated to <= asof, vendored
//     as regime-extras.json.gz.
// Regenerate both with the out-of-repo generator (scratchpad/gen-fixtures.js in the
// PR that added this test).
import { test, expect } from "bun:test";
import {
  loadRawIndicatorHistory,
  loadJsonGz,
} from "./fixtures/regime/load.ts";
import { INDICATORS } from "../src/analytics/analyze/indicators.ts";
import { computeRegime } from "../src/analytics/analyze/compute.ts";
import { computeBacktest, stripDailyFromSnapshot, type BacktestExtras } from "../src/analytics/analyze/backtest.ts";
import { computeCorrelations, type CorrelationExtras } from "../src/analytics/analyze/correlations.ts";
import {
  buildDateAxis,
  alignDailyForwardFill,
  alignDailyZeroFill,
} from "../src/analytics/transform/math.ts";
import { applyTransform } from "../src/analytics/transform/transforms.ts";

const BACKFILL_START = "2018-01-01";

async function replay() {
  const raw = await loadRawIndicatorHistory();
  let maxDate = BACKFILL_START;
  for (const id in raw) {
    const rows = raw[id];
    if (rows.length && rows[rows.length - 1].date > maxDate) maxDate = rows[rows.length - 1].date;
  }
  const dateAxis = buildDateAxis(BACKFILL_START, maxDate);
  const nanSeries = new Array(dateAxis.length).fill(NaN);
  const transformed: Record<string, number[]> = {};
  for (const ind of INDICATORS) {
    const series = raw[ind.id] ?? [];
    if (series.length === 0) {
      transformed[ind.id] = nanSeries.slice();
      continue;
    }
    const aligner = (ind as any).align === "zero_fill" ? alignDailyZeroFill : alignDailyForwardFill;
    transformed[ind.id] = applyTransform(ind.transform, aligner(series, dateAxis));
  }
  const result = computeRegime(transformed, dateAxis);
  return { result, dateAxis };
}

interface Extras { spx: any[]; eth: any[]; tbill3m: any[]; }
interface Reference {
  meta: { asof: string; extras: { spx: number; eth: number; tbill3m: number } };
  correlations: any;
  backtest: any;
}

// Deep numeric comparison: every leaf number within `tol`, structure identical.
function assertDeepClose(got: any, exp: any, path: string, tol: number, counter: { n: number }) {
  if (typeof exp === "number") {
    expect(typeof got, `${path} type`).toBe("number");
    const d = Math.abs(got - exp);
    expect(d, `${path}: got ${got} exp ${exp} (Δ${d.toExponential(3)})`).toBeLessThanOrEqual(tol);
    counter.n++;
    return;
  }
  if (exp === null || typeof exp !== "object") {
    expect(got, path).toBe(exp);
    counter.n++;
    return;
  }
  const keys = Object.keys(exp);
  const gotKeys = got == null ? [] : Object.keys(got);
  expect(new Set(gotKeys), `${path} keys`).toEqual(new Set(keys));
  for (const k of keys) assertDeepClose(got[k], exp[k], `${path}.${k}`, tol, counter);
}

test("backtest+correlations fidelity (STRICT): TS port reproduces the ORIGINAL JS reference byte-for-byte (<1e-9)", async () => {
  const { result, dateAxis } = await replay();
  const extras = await loadJsonGz<Extras>("regime-extras.json.gz");
  const ref = await loadJsonGz<Reference>("regime-backtest-correlations-reference.json.gz");

  // Inputs sanity: real vendored daily series, non-trivial.
  expect(extras.spx.length).toBe(ref.meta.extras.spx);
  expect(extras.eth.length).toBe(ref.meta.extras.eth);
  expect(extras.tbill3m.length).toBe(ref.meta.extras.tbill3m);
  expect(extras.tbill3m.length).toBeGreaterThan(3000);
  expect(dateAxis[dateAxis.length - 1]).toBe(ref.meta.asof);

  const corr = computeCorrelations(dateAxis, result, extras as CorrelationExtras);
  const bt = stripDailyFromSnapshot(computeBacktest(dateAxis, result, extras as BacktestExtras));

  const cCount = { n: 0 };
  assertDeepClose(corr, ref.correlations, "corr", 1e-9, cCount);
  const bCount = { n: 0 };
  assertDeepClose(bt, ref.backtest, "backtest", 1e-9, bCount);

  // Prove the assertion actually EXECUTED over a large surface, not a lone leaf.
  console.log(
    `[backtest-corr-fidelity] STRICT vs original-JS reference: ` +
      `correlationLeaves=${cCount.n} backtestLeaves=${bCount.n}`,
  );
  expect(cCount.n).toBeGreaterThan(40); // 3 indices × 2 assets × (3 fwd + 1 conc) cells × {rho,n} = 48
  expect(bCount.n).toBeGreaterThan(1000); // 3 portfolios × 8 strategies × (metrics + equity_curve)
  // Spot-check a load-bearing metric so a silently-empty compare can't pass.
  expect(bt.eth.composite.transitions).toBe(ref.backtest.eth.composite.transitions);
  expect(bt.eth.composite.n_days).toBe(ref.backtest.eth.composite.n_days);
});

test("backtest+correlations shape matches the committed regime-snapshot.json (portfolios/strategies/corr keys)", async () => {
  const { result, dateAxis } = await replay();
  const extras = await loadJsonGz<Extras>("regime-extras.json.gz");
  const snap: any = await loadJsonGz("regime-snapshot.json.gz");

  const corr = computeCorrelations(dateAxis, result, extras as CorrelationExtras);
  const bt = stripDailyFromSnapshot(computeBacktest(dateAxis, result, extras as BacktestExtras));

  // Exact structural parity with the committed ground truth.
  expect(Object.keys(bt).sort()).toEqual(Object.keys(snap.backtest).sort());
  for (const pf of Object.keys(snap.backtest)) {
    expect(Object.keys(bt[pf]).sort(), `backtest.${pf} strategies`).toEqual(
      Object.keys(snap.backtest[pf]).sort(),
    );
    expect(Object.keys(bt[pf].composite).sort()).toEqual(
      Object.keys(snap.backtest[pf].composite).sort(),
    );
  }
  expect(Object.keys(corr.forward).sort()).toEqual(Object.keys(snap.correlations.forward).sort());
  expect(Object.keys(corr.concurrent.composite).sort()).toEqual(
    Object.keys(snap.correlations.concurrent.composite).sort(),
  );
  expect(Object.keys(corr.forward.composite).sort()).toEqual(
    Object.keys(snap.correlations.forward.composite).sort(),
  );
});

test("backtest+correlations TRACKING: metrics track the committed snapshot within the documented data-vintage drift", async () => {
  const { result, dateAxis } = await replay();
  const extras = await loadJsonGz<Extras>("regime-extras.json.gz");
  const snap: any = await loadJsonGz("regime-snapshot.json.gz");

  const corr = computeCorrelations(dateAxis, result, extras as CorrelationExtras);
  const bt = stripDailyFromSnapshot(computeBacktest(dateAxis, result, extras as BacktestExtras));

  // Concurrent correlations depend only on the (index level, log-price) pairs, so
  // the regime-label vintage drift does NOT touch them — they track tightly.
  let corrCompared = 0;
  let corrClose = 0;
  for (const idx of Object.keys(snap.correlations.concurrent)) {
    for (const asset of Object.keys(snap.correlations.concurrent[idx])) {
      const g = corr.concurrent[idx][asset].rho;
      const e = snap.correlations.concurrent[idx][asset].rho;
      if (g == null || e == null) continue;
      corrCompared++;
      if (Math.abs(g - e) < 5e-3) corrClose++;
    }
  }
  expect(corrCompared).toBeGreaterThan(4);
  expect(corrClose / corrCompared).toBeGreaterThan(0.8);

  // Backtest metrics carry the regime-label vintage drift (≤9 label rows differ,
  // flipping a couple transitions). Bound the drift generously but finitely — a
  // methodology regression would blow far past it.
  let btCompared = 0;
  for (const pf of Object.keys(snap.backtest)) {
    for (const strat of Object.keys(snap.backtest[pf])) {
      const g = bt[pf][strat];
      const e = snap.backtest[pf][strat];
      // start/end dates are vintage-invariant (asset coverage, not regime).
      expect(g.start_date, `${pf}.${strat} start`).toBe(e.start_date);
      expect(g.end_date, `${pf}.${strat} end`).toBe(e.end_date);
      // transitions differ by at most a few flips.
      expect(Math.abs(g.transitions - e.transitions), `${pf}.${strat} transitions`).toBeLessThanOrEqual(6);
      // final_value tracks within the compounded vintage drift band.
      if (e.final_value && g.final_value) {
        const rel = Math.abs(g.final_value - e.final_value) / Math.abs(e.final_value);
        expect(rel, `${pf}.${strat} final_value rel drift`).toBeLessThan(0.2);
      }
      btCompared++;
    }
  }
  expect(btCompared).toBeGreaterThan(20);
  console.log(
    `[backtest-corr-fidelity] TRACKING vs committed snapshot: concurrentClose=${corrClose}/${corrCompared} ` +
      `backtestStrategiesCompared=${btCompared}`,
  );
});
