// Real research-signal composition — ported from agentjuno/robotmoney
// scripts/regime/channel-divergence.js and late-cycle-signals.js. These are the
// PRODUCTION signals: pure functions over REAL fetched inputs (no seeded
// provider). The orchestrator (analytics/index.ts) composes the inputs, calls
// these, and persists the resulting ResearchPayload via the research store.
//
// The payload keeps our ResearchPayload gauge/series shape (so existing API
// consumers keep working) but is enriched with the original's full indicator
// series map + summary, surfaced through the extended contract DTO.
import type { Point } from "../types.ts";
import type { ResearchPayload, Gauge } from "./research.ts";
import {
  buildDateAxis,
  alignDailyForwardFill,
  rollingPercentileRank,
  pctChangeLag,
  percentileInWindow,
} from "../transform/math.ts";

const CHANNEL_START = "2018-01-01";
const LATECYCLE_START = "2010-01-01";
const PCT_RANK_WINDOW = 252 * 3; // 756
const BETA_WINDOW = 90;
const FLOW_WINDOW = 90;

// Today's top-7 S&P names by index weight (survivorship caveat documented on the
// research page). Ported verbatim from late-cycle-signals.js.
export const TOP7 = ["NVDA", "MSFT", "AAPL", "GOOGL", "AMZN", "META", "AVGO"];

// ─── shared local helpers (ported verbatim) ─────────────────────────────────

// OLS beta of y on x over a trailing window of n obs → a SERIES (one beta per
// day). beta = cov(x,y)/var(x); NaN-tolerant, needs ≥ n/2 paired finite obs.
// (math.ts::rollingBeta returns only the final scalar; the research signal needs
// the whole history for percentile ranking, so the series form lives here.)
export function rollingBetaSeries(y: number[], x: number[], n: number): number[] {
  const out = new Array(y.length).fill(NaN);
  for (let i = n - 1; i < y.length; i++) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0, c = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const xv = x[j], yv = y[j];
      if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
      sx += xv; sy += yv; sxx += xv * xv; sxy += xv * yv; c++;
    }
    if (c < Math.floor(n / 2)) continue;
    const mx = sx / c, my = sy / c;
    const varX = sxx / c - mx * mx;
    if (varX <= 0) continue;
    const covXY = sxy / c - mx * my;
    out[i] = covXY / varX;
  }
  return out;
}

// Daily-rebalanced equal-weight index of the input aligned series. Starts at 1.0
// on the first day EVERY member has a finite value (so early-history gaps for
// younger listings don't fabricate returns). Ported verbatim.
export function buildEqualWeightIndex(alignedSeries: number[][], n: number): number[] {
  const out = new Array(n).fill(NaN);
  let started = false;
  let level = 1;
  for (let i = 1; i < n; i++) {
    const rets: number[] = [];
    let allFinite = true;
    for (const s of alignedSeries) {
      if (!Number.isFinite(s[i]) || !Number.isFinite(s[i - 1]) || s[i - 1] === 0) {
        allFinite = false;
        break;
      }
      rets.push(s[i] / s[i - 1] - 1);
    }
    if (!allFinite) {
      if (started) out[i] = level;
      continue;
    }
    if (!started) {
      started = true;
      out[i - 1] = level;
    }
    level *= 1 + rets.reduce((a, b) => a + b, 0) / rets.length;
    out[i] = level;
  }
  return out;
}

function firstFinite(arr: number[]): number {
  for (let i = 0; i < arr.length; i++) if (Number.isFinite(arr[i])) return i;
  return 0;
}

function lastFinite(arr: number[]): number {
  for (let i = arr.length - 1; i >= 0; i--) if (Number.isFinite(arr[i])) return arr[i];
  return NaN;
}

function nn(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

// Full daily series → {date,value|null}[] (6-dec rounded, matching the original).
function seriesOf(dateAxis: string[], arr: number[]): { date: string; value: number | null }[] {
  return dateAxis.map((d, i) => ({ date: d, value: Number.isFinite(arr[i]) ? +arr[i].toFixed(6) : null }));
}

// Slow gauges: weekly-sample the JSON series to keep the payload small, keeping
// the final day. Ported from late-cycle-signals.js `weekly`.
function weekly<T>(pts: T[]): T[] {
  return pts.filter((_, i) => i % 7 === 0 || i === pts.length - 1);
}

// ─── CHANNEL DIVERGENCE ──────────────────────────────────────────────────────
// "Is the easy-money → crypto transmission channel breaking down?"
export interface ChannelInputs {
  btc: Point[]; // BTC-USD daily
  qqq: Point[]; // QQQ daily
  spy: Point[]; // SPY daily
  stables: Point[]; // STABLES from the persisted raw floor
}

const channelRead = (p: number) => (p >= 0.6 ? "channel intact" : p <= 0.35 ? "breaking down" : "softening");

export function computeChannelDivergence(inputs: ChannelInputs, asof: string): ResearchPayload {
  const dateAxis = buildDateAxis(CHANNEL_START, asof);
  const btcA = alignDailyForwardFill(inputs.btc, dateAxis);
  const qqqA = alignDailyForwardFill(inputs.qqq, dateAxis);
  const spyA = alignDailyForwardFill(inputs.spy, dateAxis);
  const stablesA = alignDailyForwardFill(inputs.stables, dateAxis);

  // 1. BTC beta to (QQQ − SPY) risk-appetite factor.
  const btcRet = pctChangeLag(btcA, 1);
  const qqqRet = pctChangeLag(qqqA, 1);
  const spyRet = pctChangeLag(spyA, 1);
  const risk = qqqRet.map((q, i) => (Number.isFinite(q) && Number.isFinite(spyRet[i]) ? q - spyRet[i] : NaN));
  const beta = rollingBetaSeries(btcRet, risk, BETA_WINDOW);

  // 2. BTC/QQQ relative-strength percentile.
  const ratio = btcA.map((b, i) =>
    Number.isFinite(b) && Number.isFinite(qqqA[i]) && qqqA[i] !== 0 ? b / qqqA[i] : NaN,
  );
  const ratioPct = rollingPercentileRank(ratio, PCT_RANK_WINDOW);

  // 3. 90d stablecoin growth minus 90d QQQ growth.
  const stables90 = pctChangeLag(stablesA, FLOW_WINDOW);
  const qqq90 = pctChangeLag(qqqA, FLOW_WINDOW);
  const flow = stables90.map((s, i) => (Number.isFinite(s) && Number.isFinite(qqq90[i]) ? s - qqq90[i] : NaN));

  const betaLast = lastFinite(beta);
  const betaFinite = beta.filter(Number.isFinite);
  const betaPct = betaFinite.length ? percentileInWindow(betaLast, betaFinite) : NaN;
  const ratioPctLast = lastFinite(ratioPct);
  const flowLast = lastFinite(flow);
  const flowFinite = flow.filter(Number.isFinite);
  const flowPct = flowFinite.length ? percentileInWindow(flowLast, flowFinite) : NaN;
  const channelPct = [betaPct, ratioPctLast, flowPct].filter(Number.isFinite);
  const composite = channelPct.length ? channelPct.reduce((a, b) => a + b, 0) / channelPct.length : NaN;

  const gauges: Gauge[] = [
    { id: "BTC_BETA", name: "BTC beta vs risk appetite", value: +betaLast.toFixed(3), percentile: +betaPct.toFixed(3), read: channelRead(betaPct) },
    { id: "BTC_QQQ_RATIO", name: "BTC/QQQ relative strength", value: +lastFinite(ratio).toFixed(2), percentile: +ratioPctLast.toFixed(3), read: channelRead(ratioPctLast) },
    { id: "STABLES_QQQ_FLOW", name: "Stablecoin vs QQQ flow (90d)", value: +flowLast.toFixed(4), percentile: +flowPct.toFixed(3), read: channelRead(flowPct) },
    { id: "CHANNEL", name: "Composite channel health", value: +composite.toFixed(3), percentile: +composite.toFixed(3), read: channelRead(composite) },
  ];

  const median = (arr: number[]) => {
    const v = arr.filter(Number.isFinite).slice().sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : NaN;
  };

  return {
    asof,
    title: "Channel divergence",
    question: "Is the easy-money → crypto transmission channel breaking down?",
    spec: {
      beta_window_days: BETA_WINDOW,
      flow_window_days: FLOW_WINDOW,
      percentile_window_days: PCT_RANK_WINDOW,
      risk_factor: "QQQ daily return − SPY daily return (high-beta tech vs broad market)",
    },
    gauges,
    series: {
      label: "BTC/QQQ ratio",
      points: dateAxis.map((date, i) => ({ date, value: nn(ratio[i]) })).filter((p) => p.value != null).slice(-180) as { date: string; value: number }[],
    },
    // richer original-shaped payload (surfaced via the extended DTO)
    btc_price: seriesOf(dateAxis, btcA),
    qqq_price: seriesOf(dateAxis, qqqA),
    indicators: {
      btc_beta_vs_risk_appetite: seriesOf(dateAxis, beta),
      btc_qqq_ratio_percentile: seriesOf(dateAxis, ratioPct),
      stables_vs_qqq_flow: seriesOf(dateAxis, flow),
    },
    summary: {
      beta: { latest: nn(betaLast), median_full_history: nn(median(beta)) },
      ratio_percentile: { latest: nn(ratioPctLast), median_full_history: nn(median(ratioPct)) },
      flow_diff: { latest: nn(flowLast), median_full_history: nn(median(flow)) },
    },
  };
}

// ─── LATE-CYCLE SIGNALS ──────────────────────────────────────────────────────
// "How late in the cycle is this rally?"
export interface LateCycleInputs {
  spy: Point[];
  rsp: Point[];
  top7: Point[][]; // aligned to TOP7 order
  mna: Point[]; // monthly S-4 counts (month-end stamped)
  margin: Point[]; // FRED BOGZ1FL663067003Q quarterly
  conf: Point[]; // FRED UMCSENT monthly
}

const lateRead = (p: number) => (p >= 0.7 ? "saturated (late-cycle)" : p >= 0.5 ? "elevated" : "benign");

export function computeLateCycle(inputs: LateCycleInputs, asof: string): ResearchPayload {
  const dateAxis = buildDateAxis(LATECYCLE_START, asof);
  const n = dateAxis.length;

  // 1. Concentration: SPY/RSP + top-7 basket vs SPY.
  const spyA = alignDailyForwardFill(inputs.spy, dateAxis);
  const rspA = alignDailyForwardFill(inputs.rsp, dateAxis);
  const capVsEqual = spyA.map((s, i) => (Number.isFinite(s) && Number.isFinite(rspA[i]) && rspA[i] !== 0 ? s / rspA[i] : NaN));
  const capVsEqualPct = rollingPercentileRank(capVsEqual, PCT_RANK_WINDOW);

  const top7Aligned = inputs.top7.map((s) => alignDailyForwardFill(s, dateAxis));
  const top7Index = buildEqualWeightIndex(top7Aligned, n);
  const spyBase = spyA[firstFinite(spyA)];
  const top7VsSpy = top7Index.map((t, i) =>
    Number.isFinite(t) && Number.isFinite(spyA[i]) && spyA[i] !== 0 ? t / (spyA[i] / spyBase) : NaN,
  );
  const top7VsSpyPct = rollingPercentileRank(top7VsSpy, PCT_RANK_WINDOW);

  // 2. M&A: monthly S-4 counts.
  const mnaAligned = alignDailyForwardFill(inputs.mna, dateAxis);
  const mnaPct = rollingPercentileRank(mnaAligned, PCT_RANK_WINDOW);

  // 3. Margin debt: quarterly level → YoY growth.
  const marginA = alignDailyForwardFill(inputs.margin, dateAxis);
  const marginYoY = pctChangeLag(marginA, 365);
  const marginYoYPct = rollingPercentileRank(marginYoY, PCT_RANK_WINDOW);

  // 4. Consumer confidence: UMich sentiment.
  const confA = alignDailyForwardFill(inputs.conf, dateAxis);
  const confPct = rollingPercentileRank(confA, PCT_RANK_WINDOW);

  const gauges: Gauge[] = [
    { id: "CONCENTRATION", name: "Index concentration (SPY/RSP)", value: +lastFinite(capVsEqual).toFixed(4), percentile: +lastFinite(capVsEqualPct).toFixed(3), read: lateRead(lastFinite(capVsEqualPct)) },
    { id: "TOP7_VS_SPY", name: "Top-7 basket vs SPY", value: +lastFinite(top7VsSpy).toFixed(4), percentile: +lastFinite(top7VsSpyPct).toFixed(3), read: lateRead(lastFinite(top7VsSpyPct)) },
    { id: "MNA", name: "M&A activity (S-4 filings)", value: +lastFinite(mnaAligned).toFixed(2), percentile: +lastFinite(mnaPct).toFixed(3), read: lateRead(lastFinite(mnaPct)) },
    { id: "MARGIN", name: "Margin debt YoY", value: +lastFinite(marginYoY).toFixed(4), percentile: +lastFinite(marginYoYPct).toFixed(3), read: lateRead(lastFinite(marginYoYPct)) },
    { id: "CONF", name: "Consumer confidence (UMich)", value: +lastFinite(confA).toFixed(2), percentile: +lastFinite(confPct).toFixed(3), read: lateRead(lastFinite(confPct)) },
  ];

  const wseries = (arr: number[]) => weekly(seriesOf(dateAxis, arr));

  return {
    asof,
    title: "Late-cycle signals",
    question: "How late in the cycle is this rally?",
    spec: {
      start: LATECYCLE_START,
      percentile_window_days: PCT_RANK_WINDOW,
      top7_membership: TOP7,
      mna_source: "SEC EDGAR full-text search, monthly count of S-4 filings",
      margin_source: "FRED BOGZ1FL663067003Q (Z.1 broker-dealer margin loans, quarterly)",
      conf_source: "FRED UMCSENT (University of Michigan consumer sentiment, monthly)",
    },
    gauges,
    series: {
      label: "Index concentration (SPY/RSP)",
      points: dateAxis.map((date, i) => ({ date, value: nn(capVsEqual[i]) })).filter((p) => p.value != null).slice(-180) as { date: string; value: number }[],
    },
    // richer original-shaped payload (surfaced via the extended DTO)
    spy_price: weekly(seriesOf(dateAxis, spyA)),
    indicators: {
      concentration_cap_vs_equal: wseries(capVsEqual),
      concentration_cap_vs_equal_pct: wseries(capVsEqualPct),
      concentration_top7_vs_spy: wseries(top7VsSpy),
      concentration_top7_vs_spy_pct: wseries(top7VsSpyPct),
      mna_s4_monthly: inputs.mna.map((p) => ({ date: p.date, value: p.value })),
      mna_pct: wseries(mnaPct),
      margin_debt_level: inputs.margin.map((p) => ({ date: p.date, value: p.value })),
      margin_debt_yoy: wseries(marginYoY),
      margin_debt_yoy_pct: wseries(marginYoYPct),
      consumer_conf_level: inputs.conf.map((p) => ({ date: p.date, value: p.value })),
      consumer_conf_pct: wseries(confPct),
    },
    summary: {
      concentration: { latest: nn(lastFinite(capVsEqualPct)) },
      top7_vs_spy: { latest: nn(lastFinite(top7VsSpyPct)) },
      mna: { latest: nn(lastFinite(mnaPct)) },
      margin_yoy: { latest: nn(lastFinite(marginYoY)) },
      consumer_conf: { latest: nn(lastFinite(confA)) },
    },
  };
}
