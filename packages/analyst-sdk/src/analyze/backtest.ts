// Regime backtest — ported VERBATIM from agentjuno/robotmoney scripts/regime/
// update.js (computeBacktest ~L695-770, simulate ~L827-925, combineConservativeN/
// combineAggressiveN/firstIndexWithAllAssets/forwardFillDaily/sameWeights/
// turnoverBetween, PORTFOLIO_SPECS + constants, stripDailyFromSnapshot). Pure and
// deterministic. Byte-fidelity to the original JS is proven in
// backend/tests/backtest-correlations-fidelity.test.ts.
//
// Three portfolios share the same 3-state regime-bucket rule but allocate to
// different risky baskets (eth / sp500 / mixed), all earning the DTB3 3-month
// T-bill yield on the cash leg. Rebalance only on bucket transitions; transaction
// cost = one-sided turnover × 10 bps. Strategies tested per portfolio: composite,
// each panel regime, macro_inverted, conservative, aggressive. Baselines: HODL +
// 100% stables. Month-end downsampled equity_curve; the per-day `_daily` series is
// stripped from the snapshot payload (stripDailyFromSnapshot).
import type { RegimeComputeResult } from "./compute.ts";
import type { Point } from "../types.ts";
import { toDateMap } from "./correlations.ts";
import { PANELS } from "./indicators.ts";

export const BACKTEST_COST_PER_REBALANCE = 0.001;
export const BACKTEST_IN_SAMPLE_END = "2024-01-31";

type Weights = Record<string, number>;

interface PortfolioSpec {
  risky: string[];
  weights: Record<string, Weights>;
  hodl: { key: string; weights: Weights };
}

export const PORTFOLIO_SPECS: Record<string, PortfolioSpec> = {
  eth: {
    risky: ["eth"],
    weights: {
      risk_off: { cash: 1, eth: 0 },
      neutral: { cash: 0.5, eth: 0.5 },
      risk_on: { cash: 0, eth: 1 },
    },
    hodl: { key: "eth_hodl", weights: { cash: 0, eth: 1 } },
  },
  sp500: {
    risky: ["sp500"],
    weights: {
      risk_off: { cash: 1, sp500: 0 },
      neutral: { cash: 0.5, sp500: 0.5 },
      risk_on: { cash: 0, sp500: 1 },
    },
    hodl: { key: "sp500_hodl", weights: { cash: 0, sp500: 1 } },
  },
  mixed: {
    risky: ["eth", "sp500"],
    weights: {
      risk_off: { cash: 1, eth: 0, sp500: 0 },
      neutral: { cash: 0.5, eth: 0.25, sp500: 0.25 },
      risk_on: { cash: 0, eth: 0.5, sp500: 0.5 },
    },
    hodl: { key: "blend_hodl", weights: { cash: 0, eth: 0.5, sp500: 0.5 } },
  },
};

export interface BacktestMetrics {
  final_value: number | null;
  cagr: number | null;
  cagr_in_sample: number | null;
  cagr_out_sample: number | null;
  sharpe: number | null;
  max_drawdown: number | null;
  transitions: number;
  n_days: number;
  start_date: string;
  end_date: string;
  equity_curve: Point[];
  _daily?: Point[];
}

// portfolio → strategy → metrics.
export type BacktestPayload = Record<string, Record<string, BacktestMetrics>>;

// Daily SPX (^GSPC), ETH (ETH-USD) price levels + DTB3 (tbill3m) annualized yields
// (%). NOT registry indicators — sourced via fetchBacktestExtras.
export interface BacktestExtras {
  spx: Point[];
  eth: Point[];
  tbill3m: Point[];
}

const nullIfNaN = (v: number): number | null => (Number.isFinite(v) ? v : null);

export function computeBacktest(
  dateAxis: string[],
  result: RegimeComputeResult,
  extras: BacktestExtras,
): BacktestPayload {
  const tbillMap = toDateMap(extras.tbill3m);
  let lastTbill = 0;
  const tbillDaily = new Array<number>(dateAxis.length).fill(0);
  for (let i = 0; i < dateAxis.length; i++) {
    const v = tbillMap.get(dateAxis[i]);
    if (v !== undefined) lastTbill = v;
    tbillDaily[i] = Number.isFinite(lastTbill) ? lastTbill : 0;
  }

  const assetSeries: Record<string, number[]> = {
    eth: forwardFillDaily(extras.eth, dateAxis),
    sp500: forwardFillDaily(extras.spx, dateAxis),
  };

  const panels = result.panels || PANELS;
  const strategies: Record<string, (string | null)[]> = { composite: result.regime };
  for (const p of panels) strategies[p] = result.panelRegimes[p];
  if (result.panelRegimes.macro) {
    strategies.macro_inverted = result.panelRegimes.macro.map((b) => {
      if (b === "risk_off") return "risk_on";
      if (b === "risk_on") return "risk_off";
      return b;
    });
  }
  // Conservative / aggressive generalized to N panels (reduces to the original
  // 2-panel truth tables exactly when N = 2).
  strategies.conservative = result.regime.map((_, i) =>
    combineConservativeN(panels.map((p) => result.panelRegimes[p][i])),
  );
  strategies.aggressive = result.regime.map((_, i) =>
    combineAggressiveN(panels.map((p) => result.panelRegimes[p][i])),
  );

  const out: BacktestPayload = {};
  for (const [pKey, spec] of Object.entries(PORTFOLIO_SPECS)) {
    const firstIdx = firstIndexWithAllAssets(spec.risky, assetSeries);
    if (firstIdx < 0) continue;

    const port: Record<string, BacktestMetrics> = {};
    for (const [name, regimeSeries] of Object.entries(strategies)) {
      port[name] = simulate(dateAxis, regimeSeries, spec.weights, assetSeries, tbillDaily, firstIdx, null);
    }
    port[spec.hodl.key] = simulate(dateAxis, null, null, assetSeries, tbillDaily, firstIdx, spec.hodl.weights);
    port.stables_only = simulate(dateAxis, null, null, assetSeries, tbillDaily, firstIdx, { cash: 1 });
    out[pKey] = port;
  }

  return out;
}

export function combineConservativeN(labels: (string | null)[]): string | null {
  if (labels.some((l) => !l)) return null;
  if (labels.some((l) => l === "risk_off")) return "risk_off";
  if (labels.every((l) => l === "risk_on")) return "risk_on";
  return "neutral";
}

export function combineAggressiveN(labels: (string | null)[]): string | null {
  if (labels.some((l) => !l)) return null;
  const score = (r: string | null) => (r === "risk_on" ? 1 : r === "risk_off" ? -1 : 0);
  const sum = labels.reduce((s, l) => s + score(l), 0);
  if (sum > 0) return "risk_on";
  if (sum < 0) return "risk_off";
  return "neutral";
}

function firstIndexWithAllAssets(assetKeys: string[], assetSeries: Record<string, number[]>): number {
  for (let i = 0; i < assetSeries[assetKeys[0]].length; i++) {
    if (assetKeys.every((k) => Number.isFinite(assetSeries[k][i]))) return i;
  }
  return -1;
}

export function forwardFillDaily(series: Point[] | undefined, dateAxis: string[]): number[] {
  const map = new Map<string, number>();
  if (Array.isArray(series)) for (const p of series) map.set(p.date, p.value);
  let last = NaN;
  const out = new Array<number>(dateAxis.length).fill(NaN);
  for (let i = 0; i < dateAxis.length; i++) {
    const v = map.get(dateAxis[i]);
    if (v !== undefined) last = v;
    out[i] = last;
  }
  return out;
}

function sameWeights(a: Weights, b: Weights): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (Math.abs((a[k] || 0) - (b[k] || 0)) > 1e-9) return false;
  }
  return true;
}

function turnoverBetween(a: Weights, b: Weights): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let s = 0;
  for (const k of keys) s += Math.abs((a[k] || 0) - (b[k] || 0));
  return s / 2; // one-sided turnover (∑|Δw|/2)
}

function simulate(
  dateAxis: string[],
  regimeSeries: (string | null)[] | null,
  weightsByBucket: Record<string, Weights> | null,
  assetSeries: Record<string, number[]>,
  tbillDaily: number[],
  firstIdx: number,
  fixedWeights: Weights | null,
): BacktestMetrics {
  let equity = 1;
  let lastWeights: Weights | null = null;
  const equityCurve: Point[] = [];
  const dailyEquity: Point[] = [];
  const dailyReturns: number[] = [];
  let transitions = 0;
  let peak = 1;
  let maxDd = 0;
  let firstActiveIdx = -1;

  for (let i = firstIdx; i < dateAxis.length; i++) {
    const w = fixedWeights ? fixedWeights : weightsByBucket && regimeSeries ? weightsByBucket[regimeSeries[i] as string] : undefined;
    if (!w) continue;
    if (firstActiveIdx < 0) firstActiveIdx = i;

    // Day i's portfolio return = lastWeights · (day i's asset returns).
    if (lastWeights != null) {
      const dailyTbill = Math.pow(1 + (tbillDaily[i - 1] || 0) / 100, 1 / 365) - 1;
      let portRet = (lastWeights.cash || 0) * dailyTbill;
      for (const [asset, ws] of Object.entries(lastWeights)) {
        if (asset === "cash" || ws === 0) continue;
        const p0 = assetSeries[asset]?.[i - 1];
        const p1 = assetSeries[asset]?.[i];
        if (Number.isFinite(p0) && Number.isFinite(p1) && p0 > 0) {
          portRet += ws * (p1 / p0 - 1);
        }
      }
      equity *= 1 + portRet;
      dailyReturns.push(portRet);
    }

    // Rebalance at close of today if weights changed (turnover-based cost).
    if (lastWeights != null && !sameWeights(lastWeights, w)) {
      const turnover = turnoverBetween(lastWeights, w);
      equity *= 1 - turnover * BACKTEST_COST_PER_REBALANCE;
      transitions++;
    }
    lastWeights = w;

    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak;
    if (dd < maxDd) maxDd = dd;

    equityCurve.push({ date: dateAxis[i], value: equity });
    dailyEquity.push({ date: dateAxis[i], value: equity });
  }

  const startDate = dateAxis[firstActiveIdx >= 0 ? firstActiveIdx : firstIdx];
  const endDate = dateAxis[dateAxis.length - 1];
  const years = (+new Date(endDate) - +new Date(startDate)) / (365.25 * 86400 * 1000);
  const cagr = years > 0 ? Math.pow(equity, 1 / years) - 1 : 0;
  const mean = dailyReturns.reduce((s, v) => s + v, 0) / Math.max(1, dailyReturns.length);
  const variance =
    dailyReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, dailyReturns.length - 1);
  const sd = Math.sqrt(variance);
  const sharpe = sd > 0 ? (mean * 365) / (sd * Math.sqrt(365)) : 0;

  const splitDate = BACKTEST_IN_SAMPLE_END;
  let isEquityStart: number | null = null;
  let isEquityEnd: number | null = null;
  let oosEquityStart: number | null = null;
  let oosEquityEnd: number | null = null;
  for (const pt of equityCurve) {
    if (isEquityStart == null) isEquityStart = pt.value;
    if (pt.date <= splitDate) isEquityEnd = pt.value;
    else {
      if (oosEquityStart == null) oosEquityStart = pt.value;
      oosEquityEnd = pt.value;
    }
  }
  const yearsIs = (+new Date(splitDate) - +new Date(startDate)) / (365.25 * 86400 * 1000);
  const yearsOos = (+new Date(endDate) - +new Date(splitDate)) / (365.25 * 86400 * 1000);
  const cagrIs =
    isEquityStart && isEquityEnd && yearsIs > 0 ? Math.pow(isEquityEnd / isEquityStart, 1 / yearsIs) - 1 : null;
  const cagrOos =
    oosEquityStart && oosEquityEnd && yearsOos > 0
      ? Math.pow(oosEquityEnd / oosEquityStart, 1 / yearsOos) - 1
      : null;

  const monthEnd = new Map<string, Point>();
  for (const pt of equityCurve) monthEnd.set(pt.date.slice(0, 7), pt);
  const downsampled = [...monthEnd.values()].sort((a, b) => a.date.localeCompare(b.date));

  return {
    final_value: nullIfNaN(equity),
    cagr: nullIfNaN(cagr),
    cagr_in_sample: cagrIs == null ? null : nullIfNaN(cagrIs),
    cagr_out_sample: cagrOos == null ? null : nullIfNaN(cagrOos),
    sharpe: nullIfNaN(sharpe),
    max_drawdown: nullIfNaN(maxDd),
    transitions,
    n_days: dailyReturns.length,
    start_date: startDate,
    end_date: endDate,
    equity_curve: downsampled,
    _daily: dailyEquity,
  };
}

// Strip the per-day `_daily` series from every strategy for the persisted snapshot
// payload (mirrors the original stripDailyFromSnapshot).
export function stripDailyFromSnapshot(backtest: BacktestPayload): BacktestPayload {
  const out: BacktestPayload = {};
  for (const [portfolioName, strategies] of Object.entries(backtest)) {
    out[portfolioName] = {};
    for (const [strategyName, v] of Object.entries(strategies)) {
      const { _daily, ...rest } = v;
      void _daily;
      out[portfolioName][strategyName] = rest as BacktestMetrics;
    }
  }
  return out;
}
