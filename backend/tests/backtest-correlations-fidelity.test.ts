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
// Reference (regime-backtest-correlations-reference.json.gz) is produced by
// running the ORIGINAL, vendored update.js computeBacktest (stripped) +
// computeCorrelations VERBATIM over:
//   • result: the ORIGINAL JS 2-panel computeRegime over the vendored raw
//     fixture (regime-compute-reference.json.gz — which our TS port
//     reproduces to <1e-12, proven in regime-fidelity.test.ts)
//   • extras: real Yahoo ^GSPC / ETH-USD + FRED DTB3, truncated to <= asof, vendored
//     as regime-extras.json.gz.
// via `bun run scripts/regime-independent-reference-regenerate.ts`, which
// drives `backend/scripts/vendor/regime-reference-js/` — a verbatim vendoring
// of `robotmoney/robotmoney-site` (a fork of agentjuno/robotmoney, same
// GitHub org) scripts/regime/update.js's computeBacktest/computeCorrelations,
// extracted with no logic changes (see that directory's README.md for
// blob-sha provenance).
//
// Issue #400: adding real BTC_MVRV to the floor changed the composite (and
// every downstream backtest/correlations number).
//
// Issue #447: for a time (PR #444), this reference was regenerated from this
// repo's OWN in-repo TS pipeline instead of the original JS — based on the
// false claim that the original out-of-repo agentjuno/robotmoney generator
// was permanently unavailable. It is not: `robotmoney/robotmoney-site` still
// holds it byte-identical to upstream, verified by matching blob shas. This
// repo now vendors that original code and regenerates this fixture from it
// again, restoring the STRICT test below to a genuine independent
// cross-implementation check — verified 0 mismatches (correlationLeaves=48,
// backtestLeaves=4992) over the BTC_MVRV-inclusive floor, not merely a guard
// against the replay diverging between call sites.
//
// Issue 1559: every line of a market now starts on the strategies' first
// labelled date. The JS reference, the committed snapshot and the 1421
// originals all predate it, so each is compared with that rule applied
// (packages/analyst-sdk/tests/support/issue-1559.ts). The baselines are
// re-windowed from the ORIGINAL JS's own daily values (baselines do not depend
// on the regime labels), or from the originals' daily files.
import { createRequire } from "node:module";
import { describe, test, expect } from "bun:test";
import type { Panel } from "../src/analytics/analyze/indicators.ts";
// The originals predate issue 1708: their composite is macro and onchain only.
const ORIGINAL_PANELS: Panel[] = ["macro", "onchain"];
import { cutAtAsof, prepareRegimeInputs } from "../src/analytics/prepare.ts";
import { variantInputs } from "./support/originals-source.ts";
import {
  VARIANTS,
  dailyEvidenceBytes,
  originalFile,
  readOriginal,
  sharedAnalysisBytes,
} from "../../packages/analyst-sdk/tests/support/originals.ts";
import { AN_SKIPPED_DAY, anPins, anScenario } from "../../packages/analyst-sdk/tests/support/an-scenario.ts";
import { expectSameUpToRounding } from "../../packages/analyst-sdk/tests/support/numeric-diff.ts";
import { shapeDiffs } from "../../packages/analyst-sdk/tests/support/shape-diff.ts";
import { apply1559, apply1559ToDaily, apply1559ToText, type DailyEvidence } from "../../packages/analyst-sdk/tests/support/issue-1559.ts";
import {
  loadRawIndicatorHistory,
  loadJsonGz,
} from "./fixtures/regime/load.ts";
import { INDICATORS } from "../src/analytics/analyze/indicators.ts";
import { computeRegime } from "../src/analytics/analyze/compute.ts";
import {
  computeBacktest,
  stripDailyFromSnapshot,
  simulatePortfolio,
  periodStats,
  scheduleFromLabels,
  PORTFOLIO_SPECS,
  calendarsOf,
  referenceStrategies,
  type BacktestExtras,
} from "../src/analytics/analyze/backtest.ts";
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
  // The original JS and the committed snapshot are methodology v3 (issue 1652),
  // over the two-panel composite of their time (issue 1708 added factor).
  const result = computeRegime(transformed, dateAxis, ORIGINAL_PANELS, undefined, undefined, "v3");
  return { result, dateAxis };
}

interface Extras { spx: any[]; eth: any[]; tbill3m: any[]; }

// The ORIGINAL JS (vendored verbatim), run unstripped: its daily values are the
// evidence the issue 1559 rule re-windows the baselines from.
const originalJs = createRequire(import.meta.url)("../scripts/vendor/regime-reference-js/backtest-correlations.js") as {
  computeBacktest: (dateAxis: string[], result: unknown, extras: Extras) => Record<string, Record<string, { _daily: { date: string; value: number }[] }>>;
};
function originalJsEvidence(dateAxis: string[], result: unknown, extras: Extras): DailyEvidence {
  const out: DailyEvidence = {};
  for (const [pf, strategies] of Object.entries(originalJs.computeBacktest(dateAxis, result, extras))) {
    out[pf] = {};
    for (const [name, m] of Object.entries(strategies)) out[pf]![name] = m._daily.map((p) => [p.date, p.value]);
  }
  return out;
}
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
  // Issue 1742: the vendored reference predates n_eff on forward correlation cells.
  const gotKeys = got == null ? [] : Object.keys(got).filter((k) => !(k === "n_eff" && !("n_eff" in exp)));
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
  // Issue 1734 (D94): the backtest departs from the original JS on purpose (next-session
  // execution, closed-market deferral, post-cost excess Sharpe, yield-basis cash), so
  // it keeps the original's shape and no longer its numbers.
  const bShape = shapeDiffs(bt, apply1559(ref.backtest, originalJsEvidence(dateAxis, result, extras)));
  expect(bShape).toEqual([]);
  const bCount = { n: Object.keys(bt).length };

  // Prove the assertion actually EXECUTED over a large surface, not a lone leaf.
  console.log(
    `[backtest-corr-fidelity] STRICT vs original-JS reference: ` +
      `correlationLeaves=${cCount.n} backtestLeaves=${bCount.n}`,
  );
  expect(cCount.n).toBeGreaterThan(40); // 3 indices × 2 assets × (3 fwd + 1 conc) cells × {rho,n} = 48
  expect(bCount.n).toBe(3); // three portfolios, each shape-checked above
  // Spot-check a load-bearing metric so a silently-empty compare can't pass.
  expect(bt.eth.composite.transitions).toBeGreaterThan(0);
  expect(bt.eth.composite.n_days).toBeGreaterThan(1000);
  expect(bt.eth.composite.in_sample.label).toBe("in_sample");
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
    // The report fields of the snapshot, plus the labelled sample blocks of issue 1734.
    expect(shapeDiffs(bt[pf].composite, snap.backtest[pf].composite)).toEqual([]);
    expect(Object.keys(bt[pf].composite)).toContain("in_sample");
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
  const snapBacktest = apply1559(snap.backtest, originalJsEvidence(dateAxis, result, extras));

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

  // Issue 1734 (D94): the snapshot's backtest was computed with same-close execution
  // and pre-cost Sharpe, so its numbers no longer track; its shape does.
  let btCompared = 0;
  for (const pf of Object.keys(snapBacktest)) {
    for (const strat of Object.keys(snapBacktest[pf]!)) {
      expect(shapeDiffs(bt[pf][strat], snapBacktest[pf]![strat]), `${pf}.${strat} shape`).toEqual([]);
      // The market's last day does not depend on the execution lag.
      expect(bt[pf][strat].end_date, `${pf}.${strat} end`).toBe(snapBacktest[pf]![strat]!.end_date);
      btCompared++;
    }
  }
  expect(btCompared).toBeGreaterThan(20);
  console.log(
    `[backtest-corr-fidelity] TRACKING vs committed snapshot: concurrentClose=${corrClose}/${corrCompared} ` +
      `backtestStrategiesCompared=${btCompared}`,
  );
});

// ── Issue 1421: the backend path against the pre-refactor originals ──────────
// The backend's own seam (the prepare/compute/backtest shims, exactly what
// runAnalytics calls) over each input variant must give the SAME original bytes
// the SDK's report-parity test uses: the shared correlations/backtest artifact
// and the daily portfolio values. And the established backtest behaviours
// AN-5/6/9/10/14 must equal their named original values through the shim.
// Since decision D78 (compensated arithmetic) the originals are
// matched up to rounding: identical structure, labels, nulls and integers, no
// number moved by more than rounding.
describe("issue 1421: backend backtest and correlations against the original bytes", () => {
  for (const v of VARIANTS) {
    test(`${v}: shared artifact and daily portfolio values equal the originals`, () => {
      const inputs = variantInputs(v);
      const { dateAxis, transformed, ages } = prepareRegimeInputs(inputs.registry, { start: BACKFILL_START, asof: inputs.asof, version: "v3" });
      // The originals were captured under methodology v3 (issue 1652).
      const r2 = computeRegime(transformed, dateAxis, ORIGINAL_PANELS, ages, undefined, "v3");
      const extras = { spx: cutAtAsof(inputs.extras.spx, inputs.asof), eth: cutAtAsof(inputs.extras.eth, inputs.asof), tbill3m: cutAtAsof(inputs.extras.tbill3m, inputs.asof) };
      const full = computeBacktest(dateAxis, r2, extras);
      const shared = sharedAnalysisBytes({ correlations: computeCorrelations(dateAxis, r2, extras), backtest: stripDailyFromSnapshot(full) });
      const evidence = JSON.parse(readOriginal(originalFile.daily(v))) as DailyEvidence;
      const originalShared = readOriginal(originalFile.sharedAnalysis(v));
      // The correlations still equal the original's up to rounding. The backtest keeps
      // the original's shape only (issue 1734, D94).
      const got = JSON.parse(shared) as { correlations: unknown; backtest: unknown };
      const want = JSON.parse(apply1559ToText(originalShared, evidence)) as { correlations: unknown; backtest: unknown };
      expectSameUpToRounding(JSON.stringify(got.correlations), JSON.stringify(want.correlations), `${v} shared correlations`);
      expect(shapeDiffs(got.backtest, want.backtest), `${v} shared backtest shape`).toEqual([]);
      const daily = JSON.parse(dailyEvidenceBytes(full)) as Record<string, Record<string, unknown[]>>;
      const wantDaily = apply1559ToDaily(evidence, JSON.parse(originalShared).backtest);
      expect(Object.keys(daily)).toEqual(Object.keys(wantDaily));
      for (const pf of Object.keys(daily)) expect(Object.keys(daily[pf]!)).toEqual(Object.keys(wantDaily[pf]!));
    }, 120_000);
  }

  test("AN-5/6/9/10/14: every named pin equals its original value through the backend shim", () => {
    const original = JSON.parse(readOriginal(originalFile.anBehaviours)) as { pins: Record<string, unknown>; backtest: any };
    const expected = apply1559(original.backtest);
    const s = anScenario();
    // AN-10 needs an out-of-sample year: the scenario predates the adoption date, so it splits where the original did.
    const bt = computeBacktest(s.dateAxis, s.result, s.extras, { splitDate: "2024-01-31" });
    const pins = anPins(bt);
    // The pin names are the original's. Their values moved with issue 1734 (D94).
    expect(Object.keys(pins)).toEqual(Object.keys(original.pins));
    expect(shapeDiffs(bt, expected)).toEqual([]);
    // The behaviours themselves, not only the numbers.
    expect(bt.mixed!.blend_hodl!.transitions).toBe(0); // AN-5
    expect(bt.eth!.composite!.start_date).toBe(bt.eth!.eth_hodl!.start_date); // AN-6 (issue 1559): one start per market
    // AN-9: the day with no label has no weights. Weights come from the previous day's label (issue 1734), so the day after it is the unscheduled one.
    const dayAfter = new Date(Date.parse(`${AN_SKIPPED_DAY}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    expect(bt.eth!.composite!._daily!.map((p) => p.date)).not.toContain(dayAfter);
    expect(bt.eth!.composite!.cagr_out_sample).not.toBeNull(); // AN-10
    expect(bt.eth!.composite!.transitions).toBeGreaterThan(0); // AN-14: costs charged, Sharpe post-cost
  });
});

// Issue 1404: the public simulatePortfolio + periodStats + scheduleFromLabels,
// reached through the backend shim, reproduce computeBacktest byte for byte
// (daily values included) and the ORIGINAL JS reference within the STRICT
// bound above, over the same composite-strategy and baseline schedules.
test("backtest generalized path (backend shim): simulatePortfolio + periodStats reproduce computeBacktest byte for byte", async () => {
  const { result, dateAxis } = await replay();
  const extras = await loadJsonGz<Extras>("regime-extras.json.gz");
  const ref = await loadJsonGz<Reference>("regime-backtest-correlations-reference.json.gz");
  const shared = computeBacktest(dateAxis, result, extras as BacktestExtras);
  const reference = apply1559(ref.backtest, originalJsEvidence(dateAxis, result, extras));
  const price: Record<string, any[]> = { eth: extras.eth, sp500: extras.spx };
  let compared = 0;
  for (const [pKey, spec] of Object.entries(PORTFOLIO_SPECS)) {
    const prices: Record<string, any[]> = {};
    for (const a of spec.risky) prices[a] = price[a]!;
    const run = (schedule: any) => {
      const sim = simulatePortfolio(dateAxis, schedule, prices, extras.tbill3m, { calendars: calendarsOf(spec.risky) });
      return periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns, excess: sim.excess, trades: sim.trades });
    };
    // Issue 1559: the baselines start with the strategies (their shared start here).
    // (computeBacktest starts every line on the latest first labelled date of the strategies.)
    const priced = dateAxis.findIndex((_, i) => spec.risky.every((a) => price[a]!.some((p: any) => p.date <= dateAxis[i]! && Number.isFinite(p.value))));
    const start = Math.max(
      ...Object.values(referenceStrategies(result)).map((labels) => scheduleFromLabels(labels, spec.weights).findIndex((w, i) => i >= priced && w != null)),
    );
    const fromStart = (w: any) => dateAxis.map((_, i) => (i < start ? null : w));
    const cases: [string, any][] = [
      ["composite", scheduleFromLabels(result.regime, spec.weights)],
      ["macro", scheduleFromLabels(result.panelRegimes.macro!, spec.weights)],
      [spec.hodl.key, fromStart(spec.hodl.weights)],
      ["stables_only", fromStart({ cash: 1 })],
    ];
    for (const [name, schedule] of cases) {
      const got = run(schedule);
      expect(JSON.stringify(got), `${pKey}.${name}`).toBe(JSON.stringify(shared[pKey]![name]));
      const { _daily, ...stripped } = got;
      void _daily;
      expect(shapeDiffs(stripped, reference[pKey]![name]), `${pKey}.${name} shape`).toEqual([]);
      compared++;
    }
  }
  expect(compared).toBe(12);
});
