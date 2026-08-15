// RESEARCH FIDELITY: the SHIPPED production functions (computeChannelDivergence
// / computeLateCycle from analyze/research-signals.ts — the ones the real
// orchestrator calls, NOT the seeded-random-walk shadow tools deleted in R3)
// are fed inputs reconstructed from the original's committed JSON (plus
// STABLES from the raw fixture) and must reproduce the committed indicator
// series. This asserts the code CI actually ships, not a parallel
// reimplementation of it (R2; A3 F6; the #444 pattern of a truthful-sounding
// test over a parallel implementation).
//
// What is deterministically reproducible from vendored data:
//   channel-divergence:
//     - btc_qqq_ratio_percentile  (needs btc_price + qqq_price, both embedded)
//     - stables_vs_qqq_flow       (needs STABLES from raw fixture + qqq_price)
//     btc_beta_vs_risk_appetite needs SPY daily (NOT embedded) → covered by the
//     rollingBeta unit test in transform.test.ts instead; fed an empty spy
//     input here so the shipped function still runs its real code path (the
//     beta gauge just comes out NaN/unchecked).
//   late-cycle-signals:
//     - mna_pct                   (mna_s4_monthly embedded in full)
//     - margin_debt_yoy / _pct    (margin_debt_level embedded in full)
//     - consumer_conf_pct         (consumer_conf_level embedded in full)
//     concentration_* need RSP+top7 daily (NOT embedded) → buildEqualWeightIndex
//     is unit-tested in transform.test.ts instead; fed empty rsp/top7 inputs
//     here so the shipped function still runs its real code path.
import { test, expect } from "bun:test";
import { loadJsonGz, loadRawIndicatorHistory } from "./fixtures/regime/load.ts";
import { mergeSeries } from "../src/analytics/transform/math.ts";
import {
  computeChannelDivergence,
  computeLateCycle,
  TOP7,
  type ChannelInputs,
  type LateCycleInputs,
} from "../src/analytics/analyze/research-signals.ts";
import type { ResearchPoint } from "../src/analytics/analyze/research.ts";
import { refreshEdgarIncremental } from "../src/analytics/edgar-incremental-refresh.ts";

type Pt = { date: string; value: number | null };

// Fixture Pt[] (value nullable) → shipped-function Point[] input (value
// required), dropping the pre-history / gap NaNs the same way a real fetcher's
// sparse observation list would never contain them in the first place.
function toPoints(pts: Pt[]): { date: string; value: number }[] {
  return pts.filter((p): p is { date: string; value: number } => p.value != null);
}

// Compare two {date,value|null}[] series by date key (rather than by shared
// array index / a reconstructed date axis) — robust to either side being
// weekly-subsampled or windowed differently, which is exactly how both the
// shipped function's output and the genuine v0 fixture actually look.
function maxDiffByDate(embedded: Pt[], computed: ResearchPoint[] | undefined): { max: number; n: number } {
  const map = new Map((computed ?? []).filter((p) => p.value != null).map((p) => [p.date, p.value as number]));
  let max = 0;
  let n = 0;
  for (const p of embedded) {
    if (p.value == null) continue;
    const c = map.get(p.date);
    if (c == null || !Number.isFinite(c)) continue;
    max = Math.max(max, Math.abs(c - p.value));
    n++;
  }
  return { max, n };
}

test("channel-divergence fidelity: computeChannelDivergence (shipped) reproduces btc_qqq_ratio_percentile + stables_vs_qqq_flow from the JSON", async () => {
  const cd = await loadJsonGz("channel-divergence.json.gz");
  // Sanity: the fixture's declared spec still matches the shipped constants
  // it's implicitly asserting fidelity against.
  expect(cd.spec.percentile_window_days).toBe(756);
  expect(cd.spec.flow_window_days).toBe(90);

  const raw = await loadRawIndicatorHistory();
  const inputs: ChannelInputs = {
    btc: toPoints(cd.btc_price),
    qqq: toPoints(cd.qqq_price),
    spy: [], // not embedded in this fixture — beta gauge not asserted below
    stables: raw.STABLES,
  };
  const result = computeChannelDivergence(inputs, cd.asof);

  const r = maxDiffByDate(cd.indicators.btc_qqq_ratio_percentile, result.indicators?.btc_qqq_ratio_percentile);
  console.log(`[research-fidelity] btc_qqq_ratio_percentile: compared=${r.n} maxDiff=${r.max}`);
  expect(r.n).toBeGreaterThan(2900);
  expect(r.max).toBeLessThan(5e-3); // 6-dec rounded inputs can nudge a rank

  const f = maxDiffByDate(cd.indicators.stables_vs_qqq_flow, result.indicators?.stables_vs_qqq_flow);
  console.log(`[research-fidelity] stables_vs_qqq_flow: compared=${f.n} maxDiff=${f.max}`);
  expect(f.n).toBeGreaterThan(2900);
  // Issue #616's full-universe purge regeneration fully replaced STABLES with
  // a fresh DefiLlama live re-fetch (it is not on the unrecoverable-preserve
  // list), which no longer bit-matches the frozen v0-era STABLES vintage this
  // fixture's `raw.STABLES` input previously carried — DefiLlama's current
  // stablecoin-aggregate endpoint does not reproduce historical totals
  // byte-identically to an old snapshot (ordinary source-side revision, not a
  // defect). 3e-3 keeps headroom over the observed ~2.5e-3 90d-pct-change
  // drift while still catching a real regression.
  expect(f.max).toBeLessThan(3e-3);
});

test("late-cycle fidelity: computeLateCycle (shipped) reproduces mna_pct, margin_debt_yoy(+pct), consumer_conf_pct from the JSON", async () => {
  const lc = await loadJsonGz("late-cycle-signals.json.gz");
  expect(lc.spec.percentile_window_days).toBe(756);
  expect(lc.spec.start).toBe("2010-01-01");

  const inputs: LateCycleInputs = {
    spy: toPoints(lc.spy_price),
    rsp: [], // not embedded in this fixture — concentration gauges not asserted below
    top7: TOP7.map(() => []), // not embedded — top7_vs_spy gauge not asserted below
    mna: toPoints(lc.indicators.mna_s4_monthly),
    margin: toPoints(lc.indicators.margin_debt_level),
    conf: toPoints(lc.indicators.consumer_conf_level),
  };
  const result = computeLateCycle(inputs, lc.asof);

  const m = maxDiffByDate(lc.indicators.mna_pct, result.indicators?.mna_pct);
  console.log(`[research-fidelity] mna_pct: compared=${m.n} maxDiff=${m.max}`);
  expect(m.n).toBeGreaterThan(700);
  expect(m.max).toBeLessThan(5e-3);

  const my = maxDiffByDate(lc.indicators.margin_debt_yoy, result.indicators?.margin_debt_yoy);
  const myp = maxDiffByDate(lc.indicators.margin_debt_yoy_pct, result.indicators?.margin_debt_yoy_pct);
  console.log(`[research-fidelity] margin_debt_yoy: compared=${my.n} maxDiff=${my.max}`);
  console.log(`[research-fidelity] margin_debt_yoy_pct: compared=${myp.n} maxDiff=${myp.max}`);
  expect(my.n).toBeGreaterThan(700);
  expect(my.max).toBeLessThan(1e-4);
  expect(myp.n).toBeGreaterThan(700);
  expect(myp.max).toBeLessThan(5e-3);

  const c = maxDiffByDate(lc.indicators.consumer_conf_pct, result.indicators?.consumer_conf_pct);
  console.log(`[research-fidelity] consumer_conf_pct: compared=${c.n} maxDiff=${c.max}`);
  expect(c.n).toBeGreaterThan(700);
  expect(c.max).toBeLessThan(5e-3);
});

// R6 (docs/v0-v1-quant-platform-parity-report.md, finding 1.10): the
// fidelity guarantee above must ALSO hold when the MNA series is assembled
// via the refreshEdgarIncremental code path (refreshEdgarIncremental +
// mergeSeries(persistedFloor, newRows)) instead of a single embedded
// fixture array, and when the resulting merged series is then run through the
// SAME shipped computeLateCycle used above — specifically via Tier 2, the
// weekly FULL reconciliation sweep (tier: "full", forced explicitly here
// regardless of which weekday lc.asof happens to fall on; this test is about
// the full-range planner's correctness, not about which day
// selectEdgarRefreshTier would pick it on — that selection is covered
// separately in edgar-incremental-refresh.test.ts).
// Drive refreshEdgarIncremental with a deterministic fetchMonth double that
// reproduces the committed reference's OWN values for every month in
// [floorStart, asof] — the resulting newRows must reconstruct the reference
// byte-for-byte (starting from an EMPTY persisted floor, since a full
// re-crawl makes "what was already persisted" irrelevant to the fetched
// batch), and mna_pct recomputed by computeLateCycle from that batch must
// match the committed mna_pct within the SAME tolerance as the fixture-only
// test above.
test("late-cycle fidelity via the EDGAR refresh path: a full re-crawl, run through computeLateCycle (shipped), reproduces the committed reference exactly (R6, tier 'full')", async () => {
  const lc = await loadJsonGz("late-cycle-signals.json.gz");
  const START = lc.spec.start; // 2010-01-01

  const mnaFull = toPoints(lc.indicators.mna_s4_monthly); // ascending, 2010-01-31..2026-06-30
  const byMonthStart = new Map(mnaFull.map((p) => [`${p.date.slice(0, 7)}-01`, p.value]));

  const outcome = await refreshEdgarIncremental({
    asOf: lc.asof,
    floorStart: START,
    tier: "full", // force Tier 2 — this test is about the full-range planner, not the weekday gate
    persistedMonths: [], // irrelevant to the full-range plan — asserted below via newRows.length
    deadlineAt: Date.now() + 30_000,
    requestDelayMs: 0,
    logger: { log: () => {}, warn: () => {} },
    fetchMonth: async (monthStart: string) => {
      const v = byMonthStart.get(monthStart);
      if (v === undefined) throw new Error(`unexpected EDGAR request for ${monthStart} — plan should be exactly [floorStart, asof]`);
      return v;
    },
  });
  expect(outcome.status).toBe("updated");
  expect(outcome.newRows.length).toBe(mnaFull.length); // every month in the committed reference was (re)fetched

  const merged = mergeSeries([], outcome.newRows);
  expect(merged).toEqual(mnaFull); // byte-for-byte reproduction of the committed reference

  const inputs: LateCycleInputs = {
    spy: toPoints(lc.spy_price),
    rsp: [],
    top7: TOP7.map(() => []),
    mna: merged,
    margin: toPoints(lc.indicators.margin_debt_level),
    conf: toPoints(lc.indicators.consumer_conf_level),
  };
  const result = computeLateCycle(inputs, lc.asof);

  const m = maxDiffByDate(lc.indicators.mna_pct, result.indicators?.mna_pct);
  console.log(`[research-fidelity] mna_pct (via refreshEdgarIncremental full re-crawl + computeLateCycle): compared=${m.n} maxDiff=${m.max}`);
  expect(m.n).toBeGreaterThan(700);
  expect(m.max).toBeLessThan(5e-3); // same tolerance as the fixture-only fidelity test above
});
