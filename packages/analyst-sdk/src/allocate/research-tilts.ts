// R2 inputs: Lex's two research previews, computed once over the full history with
// the SDK's own functions. Every series inside them is a backward-looking window
// (90-day beta, 90-day flow, 756-day percentile rank), so a value on day t uses
// only data up to t. One run therefore equals an as-of run for every day, unlike
// the regime composite (see labels.ts).
import type { Point } from "../types.ts";
import { computeChannelDivergence, computeLateCycle, TOP7 } from "../analyze/research-signals.ts";
import { rollingPercentileRank } from "../transform/math.ts";

export interface ResearchSeries {
  // channel divergence (daily)
  btcBeta: Map<string, number>;
  btcBetaMedian: number; // full-history median from the SDK summary: reported only, not used by the rule (look-ahead)
  btcQqqPct: Map<string, number>;
  flowDiff: Map<string, number>;
  // late cycle (daily, forward-filled from the SDK's weekly sampling)
  concentrationPct: Map<string, number>;
  mnaPct: Map<string, number>;
  marginYoyPct: Map<string, number>;
  confPct: Map<string, number>; // UMCSENT, 3-year percentile (our addition: the preview shows the level)
}

const toMap = (pts: { date: string; value: number | null }[] | undefined): Map<string, number> => {
  const m = new Map<string, number>();
  for (const p of pts ?? []) if (p.value !== null && Number.isFinite(p.value)) m.set(p.date, p.value);
  return m;
};

export interface ResearchInputs {
  btc: Point[]; qqq: Point[]; spy: Point[]; rsp: Point[];
  top7: Record<string, Point[]>; // keyed by ticker, TOP7 order resolved here
  stables: Point[]; mna: Point[]; margin: Point[]; conf: Point[];
}

export function computeResearchSeries(inp: ResearchInputs, asof: string): ResearchSeries {
  const ch = computeChannelDivergence({ btc: inp.btc, qqq: inp.qqq, spy: inp.spy, stables: inp.stables }, asof);
  const lc = computeLateCycle(
    { spy: inp.spy, rsp: inp.rsp, top7: TOP7.map((t) => inp.top7[t] ?? []), mna: inp.mna, margin: inp.margin, conf: inp.conf },
    asof,
  );
  const ci = ch.indicators ?? {};
  const li = lc.indicators ?? {};
  const median = (ch.summary as { beta?: { median_full_history?: number } } | undefined)?.beta?.median_full_history;
  // Consumer confidence: the preview reads the level ("elevated and rolling over");
  // for a rule we need a rank, so take the same 756-day percentile the other gauges use.
  const confSorted = [...inp.conf].sort((a, b) => (a.date < b.date ? -1 : 1));
  const confPctArr = rollingPercentileRank(confSorted.map((p) => p.value), 36); // 36 monthly points = 3 years
  const confPct = new Map<string, number>();
  confSorted.forEach((p, i) => { if (Number.isFinite(confPctArr[i])) confPct.set(p.date, confPctArr[i]); });
  return {
    btcBeta: toMap(ci.btc_beta_vs_risk_appetite),
    btcBetaMedian: Number.isFinite(median) ? (median as number) : NaN,
    btcQqqPct: toMap(ci.btc_qqq_ratio_percentile),
    flowDiff: toMap(ci.stables_vs_qqq_flow),
    concentrationPct: toMap(li.concentration_cap_vs_equal_pct),
    mnaPct: toMap(li.mna_pct),
    marginYoyPct: toMap(li.margin_debt_yoy_pct),
    confPct,
  };
}

// Last known value on or before a date (series are sampled daily, weekly or monthly).
// releaseLagDays: a point dated D is not known until D + lag (monthly and quarterly
// series are published weeks after their observation date).
export function valueAsOf(m: Map<string, number>, date: string, maxAgeDays = 120, releaseLagDays = 0): number {
  const cutoff = new Date(Date.parse(date) - releaseLagDays * 864e5).toISOString().slice(0, 10);
  let best: string | null = null;
  for (const k of m.keys()) if (k <= cutoff && (best === null || k > best)) best = k;
  if (best === null) return NaN;
  const age = (Date.parse(date) - Date.parse(best)) / 864e5;
  return age <= maxAgeDays + releaseLagDays ? (m.get(best) as number) : NaN;
}

// Trailing median of a daily series over the `windowDays` ending on `date` (no look-ahead).
export function trailingMedian(m: Map<string, number>, date: string, windowDays = 756): number {
  const from = new Date(Date.parse(date) - windowDays * 864e5).toISOString().slice(0, 10);
  const xs: number[] = [];
  for (const [k, v] of m) if (k > from && k <= date && Number.isFinite(v)) xs.push(v);
  if (xs.length < windowDays * 0.5) return NaN;
  xs.sort((a, b) => a - b);
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
}

// Channel divergence, thresholds as written on the preview page: macro panel loud
// (> 0.70) while the channel is weak: BTC beta < 0.5 x its trailing 3-year median,
// or BTC/QQQ 3-year percentile < 0.30, or the 90-day stablecoin-float change minus
// the 90-day QQQ change below zero for 90 consecutive days. The preview draws the
// full-history median; the rule uses a trailing one so no future value leaks in.
export function channelDivergenceFires(rs: ResearchSeries, date: string, macroPercentile: number | null, p: Record<string, number>): boolean {
  if (macroPercentile === null || macroPercentile <= (p.macroLoud ?? 0.70)) return false;
  const beta = valueAsOf(rs.btcBeta, date);
  const ratio = valueAsOf(rs.btcQqqPct, date);
  const med = trailingMedian(rs.btcBeta, date, p.medianDays ?? 756);
  const weakBeta = Number.isFinite(beta) && Number.isFinite(med) && beta < (p.betaFrac ?? 0.5) * med;
  const weakRatio = Number.isFinite(ratio) && ratio < (p.ratioPct ?? 0.30);
  // "sustained negative": every daily flow reading in the last N days below zero.
  const n = p.flowDays ?? 90;
  let seen = 0, neg = 0;
  for (const [k, v] of rs.flowDiff) {
    if (k <= date && (Date.parse(date) - Date.parse(k)) / 864e5 < n) { seen++; if (v < 0) neg++; }
  }
  const weakFlow = seen >= n * 0.8 && neg === seen;
  return weakBeta || weakRatio || weakFlow;
}

// Late cycle: at least `minGauges` of the 4 gauges above `saturated` (0.80, the
// preview's number for concentration; applied to the other 3 as our choice).
// Release lags: S-4 counts are month-end stamped and complete about 2 weeks later;
// Z.1 margin debt is published about 10 weeks after quarter end; UMich final
// sentiment about 4 weeks after its month start.
export function lateCycleFires(rs: ResearchSeries, date: string, p: Record<string, number>): boolean {
  const thr = p.saturated ?? 0.80;
  const gauges = [
    valueAsOf(rs.concentrationPct, date, 400),
    valueAsOf(rs.mnaPct, date, 400, p.mnaLagDays ?? 14),
    valueAsOf(rs.marginYoyPct, date, 400, p.marginLagDays ?? 70),
    valueAsOf(rs.confPct, date, 400, p.confLagDays ?? 28),
  ];
  const hot = gauges.filter((g) => Number.isFinite(g) && g > thr).length;
  return hot >= (p.minGauges ?? 3);
}
