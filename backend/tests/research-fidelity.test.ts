// RESEARCH FIDELITY: deterministic replay of channel-divergence and
// late-cycle-signals from inputs embedded in the original's committed JSON
// (plus STABLES from the raw fixture) must reproduce the committed gauge series.
//
// What is deterministically reproducible from vendored data:
//   channel-divergence:
//     - btc_qqq_ratio_percentile  (needs btc_price + qqq_price, both embedded)
//     - stables_vs_qqq_flow       (needs STABLES from raw fixture + qqq_price)
//     btc_beta_vs_risk_appetite needs SPY daily (NOT embedded) → covered by the
//     rollingBeta unit test in transform.test.ts instead.
//   late-cycle-signals:
//     - mna_pct                   (mna_s4_monthly embedded in full)
//     - margin_debt_yoy / _pct    (margin_debt_level embedded in full)
//     - consumer_conf_pct         (consumer_conf_level embedded in full)
//     concentration_* need SPY+RSP+top7 daily (NOT embedded) → buildEqualWeightIndex
//     is unit-tested in transform.test.ts instead.
import { test, expect } from "bun:test";
import { loadJsonGz, loadRawIndicatorHistory } from "./fixtures/regime/load.ts";
import {
  buildDateAxis,
  alignDailyForwardFill,
  rollingPercentileRank,
  pctChangeLag,
} from "../src/analytics/transform/math.ts";

type Pt = { date: string; value: number | null };
const arr = (pts: Pt[]) => pts.map((p) => (p.value == null ? NaN : p.value));

function maxDiffAtEmbeddedDates(
  embedded: Pt[],
  axis: string[],
  computed: number[],
): { max: number; n: number } {
  const idx = new Map(axis.map((d, i) => [d, i]));
  let max = 0;
  let n = 0;
  for (const p of embedded) {
    if (p.value == null) continue;
    const i = idx.get(p.date);
    if (i == null) continue;
    const c = computed[i];
    if (!Number.isFinite(c)) continue;
    max = Math.max(max, Math.abs(c - p.value));
    n++;
  }
  return { max, n };
}

test("channel-divergence fidelity: btc_qqq_ratio_percentile + stables_vs_qqq_flow reproduce the JSON", async () => {
  const cd = await loadJsonGz("channel-divergence.json.gz");
  const PCT_WIN = cd.spec.percentile_window_days; // 756
  const FLOW_WIN = cd.spec.flow_window_days; // 90
  const axis: string[] = cd.btc_price.map((p: Pt) => p.date);
  const btc = arr(cd.btc_price);
  const qqq = arr(cd.qqq_price);

  // btc_qqq_ratio_percentile
  const ratio = btc.map((b, i) =>
    Number.isFinite(b) && Number.isFinite(qqq[i]) && qqq[i] !== 0 ? b / qqq[i] : NaN,
  );
  const ratioPct = rollingPercentileRank(ratio, PCT_WIN);
  const r = maxDiffAtEmbeddedDates(cd.indicators.btc_qqq_ratio_percentile, axis, ratioPct);
  console.log(`[research-fidelity] btc_qqq_ratio_percentile: compared=${r.n} maxDiff=${r.max}`);
  expect(r.n).toBeGreaterThan(2900);
  expect(r.max).toBeLessThan(5e-3); // 6-dec rounded inputs can nudge a rank

  // stables_vs_qqq_flow (STABLES from raw fixture, qqq from JSON)
  const raw = await loadRawIndicatorHistory();
  const stablesAligned = alignDailyForwardFill(raw.STABLES, axis);
  const stables90 = pctChangeLag(stablesAligned, FLOW_WIN);
  const qqq90 = pctChangeLag(qqq, FLOW_WIN);
  const flow = stables90.map((s, i) =>
    Number.isFinite(s) && Number.isFinite(qqq90[i]) ? s - qqq90[i] : NaN,
  );
  const f = maxDiffAtEmbeddedDates(cd.indicators.stables_vs_qqq_flow, axis, flow);
  console.log(`[research-fidelity] stables_vs_qqq_flow: compared=${f.n} maxDiff=${f.max}`);
  expect(f.n).toBeGreaterThan(2900);
  expect(f.max).toBeLessThan(1e-3);
});

test("late-cycle fidelity: mna_pct, margin_debt_yoy(+pct), consumer_conf_pct reproduce the JSON", async () => {
  const lc = await loadJsonGz("late-cycle-signals.json.gz");
  const START = lc.spec.start; // 2010-01-01
  const PCT_WIN = lc.spec.percentile_window_days; // 756
  const axis = buildDateAxis(START, lc.asof);

  // mna_pct
  const mnaAligned = alignDailyForwardFill(arrPts(lc.indicators.mna_s4_monthly), axis);
  const mnaPct = rollingPercentileRank(mnaAligned, PCT_WIN);
  const m = maxDiffAtEmbeddedDates(lc.indicators.mna_pct, axis, mnaPct);
  console.log(`[research-fidelity] mna_pct: compared=${m.n} maxDiff=${m.max}`);
  expect(m.n).toBeGreaterThan(700);
  expect(m.max).toBeLessThan(5e-3);

  // margin_debt_yoy and margin_debt_yoy_pct
  const marginAligned = alignDailyForwardFill(arrPts(lc.indicators.margin_debt_level), axis);
  const marginYoY = pctChangeLag(marginAligned, 365);
  const marginYoYPct = rollingPercentileRank(marginYoY, PCT_WIN);
  const my = maxDiffAtEmbeddedDates(lc.indicators.margin_debt_yoy, axis, marginYoY);
  const myp = maxDiffAtEmbeddedDates(lc.indicators.margin_debt_yoy_pct, axis, marginYoYPct);
  console.log(`[research-fidelity] margin_debt_yoy: compared=${my.n} maxDiff=${my.max}`);
  console.log(`[research-fidelity] margin_debt_yoy_pct: compared=${myp.n} maxDiff=${myp.max}`);
  expect(my.n).toBeGreaterThan(700);
  expect(my.max).toBeLessThan(1e-4);
  expect(myp.max).toBeLessThan(5e-3);

  // consumer_conf_pct
  const confAligned = alignDailyForwardFill(arrPts(lc.indicators.consumer_conf_level), axis);
  const confPct = rollingPercentileRank(confAligned, PCT_WIN);
  const c = maxDiffAtEmbeddedDates(lc.indicators.consumer_conf_pct, axis, confPct);
  console.log(`[research-fidelity] consumer_conf_pct: compared=${c.n} maxDiff=${c.max}`);
  expect(c.n).toBeGreaterThan(700);
  expect(c.max).toBeLessThan(5e-3);
});

function arrPts(pts: { date: string; value: number }[]): { date: string; value: number }[] {
  return pts.map((p) => ({ date: p.date, value: p.value }));
}
