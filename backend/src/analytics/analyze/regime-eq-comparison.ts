// Research generator for /blog/regime-eq-vs-base — ported VERBATIM from
// agentjuno/robotmoney scripts/regime/regime-eq-comparison.js. Computes two
// parallel regime classifiers — same data, same point-in-time inverse-
// correlation weighting, same percentile/bucket/smoothing — and varies ONLY
// whether the equity factor panel is included in the composite:
//
//   base : panels = ['macro', 'onchain']            (what /regime publishes)
//   eq   : panels = ['macro', 'onchain', 'factor']   (what /regime_eq publishes)
//
// Both arms are walk-forward (no look-ahead), so the comparison is honest.
// Backtests both on ETH/cash, SP500/cash, and the mixed 50/50, with a
// single-panel-alone variant for each panel to surface attribution.
//
// R1 port rules (docs/v0-v1-quant-platform-parity-report.md §8 Phase R):
//   (a) the constant 2.6%/yr cash model (CASH_YR), COST, REFRESH and the
//       hardcoded PHASES are preserved bit-for-bit from the original script —
//       do NOT "clean up" to v1's real-DTB3 backtest model (analyze/backtest.ts).
//   (b) the exact input contract is reproduced: the raw indicator floor PLUS
//       snap.extras.eth / snap.extras.spx (regime-snapshot.json's chart-overlay
//       price series) are the only two inputs. Both are passed in explicitly —
//       this module does no I/O of its own, so callers (a regenerate script,
//       or a golden-replay test at a specific v0 sha) choose the source.
//
// Pure and deterministic: same inputs, same outputs. No I/O, no Date.now()
// (the caller stamps `generated_at` at write time).
import { INDICATORS as DEFAULT_INDICATORS, ROLLING_WINDOW_DAYS, type Indicator, type Panel } from "./indicators.ts";
import { applyTransform } from "../transform/transforms.ts";
import {
  rollingPercentileRank,
  inverseCorrelationWeights,
  alignDailyForwardFill,
  alignDailyZeroFill,
  buildDateAxis,
} from "../transform/math.ts";
import { smoothRegimes, bucketFn } from "./compute.ts";
import type { Point } from "../types.ts";

export const CASH_YR = 0.026;
export const COST = 0.001;
export const REFRESH = 21;

export const PHASES: { name: string; start: string; end: string }[] = [
  { name: "Pre-2020 + COVID", start: "2018-02-28", end: "2020-12-31" },
  { name: "2021 mania", start: "2020-12-31", end: "2021-11-30" },
  { name: "2022 drawdown", start: "2021-11-30", end: "2022-12-31" },
  { name: "Recovery", start: "2022-12-31", end: "2024-01-31" },
  { name: "Recent", start: "2024-01-31", end: "2099-12-31" },
];

export interface RegimeEqComparisonInput {
  // Raw (pre-transform) daily history per indicator id, as read from
  // data/regime/raw-indicator-history.csv in v0.
  raw: Record<string, Point[]>;
  // snap.extras.{eth,spx} from public/data/regime-snapshot.json in v0.
  extras: { eth: Point[]; spx: Point[] };
  // Indicator registry. Defaults to the shared, current INDICATORS (the
  // registry every other analyze/* module uses — kept in sync with v0's
  // HEAD lib/indicators.js, see analyze/indicators.ts's header). v0's own
  // registry is not static over time (indicators have been reclassified
  // between panels, e.g. SPX_TREND/IWM_SPY macro→factor), so a golden-replay
  // test reproducing an OLDER v0-published artifact must pass the registry
  // as it existed at that vintage — this parameter exists for that case, not
  // for go-forward use (regenerate scripts always take the default).
  indicators?: Indicator[];
}

interface PortfolioSpec {
  risky: string[];
  weights: Record<string, Record<string, number>>;
}

interface BacktestResult {
  final_value: number;
  cagr: number;
  sharpe: number;
  max_drawdown: number;
  transitions: number;
  equity_curve: Point[];
  phases: { name: string; cagr: number | null; max_drawdown: number | null }[];
}

interface PortfolioBlock {
  base: BacktestResult;
  eq: BacktestResult;
  macro_alone: BacktestResult;
  onchain_alone: BacktestResult;
  factor_alone: BacktestResult;
  hodl: BacktestResult;
}

export interface RegimeEqComparisonResult {
  asof: string;
  assumptions: {
    cash_yield_annual: number;
    rebalance_cost_bps: number;
    rolling_window_days: number;
    weight_refresh_days: number;
    weighting: string;
  };
  indicator_counts: { macro: number; onchain: number; factor: number };
  history: {
    base_composite: { date: string; value: number | null }[];
    eq_composite: { date: string; value: number | null }[];
    macro_index: { date: string; value: number | null }[];
    onchain_index: { date: string; value: number | null }[];
    factor_index: { date: string; value: number | null }[];
    base_regime: { date: string; regime: string | null }[];
    eq_regime: { date: string; regime: string | null }[];
  };
  time_share: {
    base: Record<string, number>;
    eq: Record<string, number>;
    macro_alone: Record<string, number>;
    onchain_alone: Record<string, number>;
    factor_alone: Record<string, number>;
  };
  agreement: { same_pct: number; total: number; diff_by_year: Record<string, number> };
  backtest: { eth: PortfolioBlock; spx: PortfolioBlock; mixed: PortfolioBlock };
}

export function computeRegimeEqComparison(input: RegimeEqComparisonInput): RegimeEqComparisonResult {
  const { raw, extras } = input;
  const INDICATORS = input.indicators ?? DEFAULT_INDICATORS;

  // ── date axis: 2018-01-01 through the last date present in ANY raw series ──
  let maxDate = "2018-01-01";
  for (const id in raw) {
    for (const row of raw[id]) {
      if (row.date > maxDate) maxDate = row.date;
    }
  }
  const dateAxis = buildDateAxis("2018-01-01", maxDate);

  // ── transform + percentile + sign-align (shared across both arms) ──
  const signed: Record<string, number[]> = {};
  for (const ind of INDICATORS) {
    const aligner = ind.align === "zero_fill" ? alignDailyZeroFill : alignDailyForwardFill;
    const t = applyTransform(ind.transform, aligner(raw[ind.id] || [], dateAxis));
    const r = rollingPercentileRank(t, ROLLING_WINDOW_DAYS);
    signed[ind.id] = r.map((v) => (Number.isFinite(v) ? (ind.sign >= 0 ? v : 1 - v) : NaN));
  }

  const indsOf = (panel: Panel): Indicator[] => INDICATORS.filter((x) => x.panel === panel);

  const wmean = (inds: Indicator[], w: Record<string, number>, i: number): number => {
    let num = 0;
    let den = 0;
    for (const ind of inds) {
      const v = signed[ind.id][i];
      const ww = w[ind.id];
      if (!Number.isFinite(v) || !Number.isFinite(ww)) continue;
      num += ww * v;
      den += ww;
    }
    return den > 0 ? num / den : NaN;
  };

  function panelIndex(panel: Panel): number[] {
    const inds = indsOf(panel);
    const idx = new Array(dateAxis.length).fill(NaN);
    let cur: Record<string, number> = {};
    for (let i = 0; i < dateAxis.length; i++) {
      if (i % REFRESH === 0 || i === dateAxis.length - 1) {
        const start = Math.max(0, i - ROLLING_WINDOW_DAYS + 1);
        const win: Record<string, number[]> = {};
        for (const ind of inds) win[ind.id] = signed[ind.id].slice(start, i + 1);
        cur = inverseCorrelationWeights(win);
      }
      idx[i] = wmean(inds, cur, i);
    }
    return idx;
  }

  const panelIdx: Record<Panel, number[]> = {
    macro: panelIndex("macro"),
    onchain: panelIndex("onchain"),
    factor: panelIndex("factor"),
  };

  function composite(panels: Panel[]): number[] {
    const out = new Array(dateAxis.length).fill(NaN);
    for (let i = 0; i < dateAxis.length; i++) {
      let s = 0;
      let n = 0;
      for (const p of panels) {
        if (Number.isFinite(panelIdx[p][i])) {
          s += panelIdx[p][i];
          n++;
        }
      }
      out[i] = n > 0 ? s / n : NaN;
    }
    return out;
  }

  const baseComp = composite(["macro", "onchain"]);
  const eqComp = composite(["macro", "onchain", "factor"]);
  const baseRank = rollingPercentileRank(baseComp, ROLLING_WINDOW_DAYS);
  const eqRank = rollingPercentileRank(eqComp, ROLLING_WINDOW_DAYS);
  const baseRegime = smoothRegimes(baseRank, bucketFn);
  const eqRegime = smoothRegimes(eqRank, bucketFn);
  const panelRegimes: Record<Panel, (string | null)[]> = {
    macro: smoothRegimes(rollingPercentileRank(panelIdx.macro, ROLLING_WINDOW_DAYS), bucketFn),
    onchain: smoothRegimes(rollingPercentileRank(panelIdx.onchain, ROLLING_WINDOW_DAYS), bucketFn),
    factor: smoothRegimes(rollingPercentileRank(panelIdx.factor, ROLLING_WINDOW_DAYS), bucketFn),
  };

  // ── backtest ──
  const ffill = (series: Point[]): (number | null)[] => {
    const m = new Map(series.map((p) => [p.date, p.value]));
    const out: (number | null)[] = [];
    let last: number | null = null;
    for (const d of dateAxis) {
      if (m.has(d)) last = m.get(d)!;
      out.push(last);
    }
    return out;
  };
  const ethPx = ffill(extras.eth);
  const spxPx = ffill(extras.spx);

  const w0 = (w: Record<string, number>, k: string): number => w[k] || 0;
  const sameW = (a: Record<string, number>, b: Record<string, number>): boolean =>
    ["cash", "eth", "spx"].every((k) => Math.abs(w0(a, k) - w0(b, k)) < 1e-9);
  const turnover = (a: Record<string, number>, b: Record<string, number>): number =>
    ["cash", "eth", "spx"].reduce((s, k) => s + Math.abs(w0(a, k) - w0(b, k)), 0) / 2;

  function backtest(regimes: (string | null)[] | null, spec: PortfolioSpec & { fixed?: Record<string, number> }): BacktestResult {
    let i0 = 0;
    while (i0 < dateAxis.length && spec.risky.some((a) => (a === "eth" ? ethPx : spxPx)[i0] == null)) i0++;
    let eq = 1;
    let lw: Record<string, number> | null = null;
    let pk = 1;
    let mdd = 0;
    let trans = 0;
    const rets: number[] = [];
    const curve: Point[] = [];
    const cashDaily = Math.pow(1 + CASH_YR, 1 / 365) - 1;
    for (let i = i0; i < dateAxis.length; i++) {
      const w = spec.fixed || (regimes ? spec.weights[regimes[i] as string] : undefined);
      if (!w) continue;
      if (lw) {
        let pr = w0(lw, "cash") * cashDaily;
        for (const a of ["eth", "spx"]) {
          const ws = w0(lw, a);
          if (!ws) continue;
          const px = a === "eth" ? ethPx : spxPx;
          const p0 = px[i - 1];
          const p1 = px[i];
          if (Number.isFinite(p0) && Number.isFinite(p1) && (p0 as number) > 0) pr += ws * ((p1 as number) / (p0 as number) - 1);
        }
        eq *= 1 + pr;
        rets.push(pr);
      }
      if (lw && !sameW(lw, w)) {
        eq *= 1 - turnover(lw, w) * COST;
        trans++;
      }
      lw = w;
      if (eq > pk) pk = eq;
      const dd = eq / pk - 1;
      if (dd < mdd) mdd = dd;
      curve.push({ date: dateAxis[i], value: eq });
    }
    // monthly downsample for the curve
    const monthEnd = new Map<string, Point>();
    for (const p of curve) monthEnd.set(p.date.slice(0, 7), p);
    const monthly = [...monthEnd.values()];

    const yrs = (+new Date(curve[curve.length - 1].date) - +new Date(curve[0].date)) / (365.25 * 864e5);
    const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (rets.length - 1));

    const phases = PHASES.map((ph) => {
      const w = curve.filter((p) => p.date >= ph.start && p.date <= ph.end);
      if (w.length < 2) return { name: ph.name, cagr: null, max_drawdown: null };
      const y = (+new Date(w[w.length - 1].date) - +new Date(w[0].date)) / (365.25 * 864e5);
      let p2 = w[0].value;
      let d2 = 0;
      for (const p of w) {
        if (p.value > p2) p2 = p.value;
        const dd = p.value / p2 - 1;
        if (dd < d2) d2 = dd;
      }
      return { name: ph.name, cagr: Math.pow(w[w.length - 1].value / w[0].value, 1 / y) - 1, max_drawdown: d2 };
    });

    return {
      final_value: eq,
      cagr: Math.pow(eq, 1 / yrs) - 1,
      sharpe: sd > 0 ? (mean * 365) / (sd * Math.sqrt(365)) : 0,
      max_drawdown: mdd,
      transitions: trans,
      equity_curve: monthly,
      phases,
    };
  }

  const ETH: PortfolioSpec = { risky: ["eth"], weights: { risk_off: { cash: 1 }, neutral: { cash: 0.5, eth: 0.5 }, risk_on: { eth: 1 } } };
  const SPX: PortfolioSpec = { risky: ["spx"], weights: { risk_off: { cash: 1 }, neutral: { cash: 0.5, spx: 0.5 }, risk_on: { spx: 1 } } };
  const MIX: PortfolioSpec = { risky: ["eth", "spx"], weights: { risk_off: { cash: 1 }, neutral: { cash: 0.5, eth: 0.25, spx: 0.25 }, risk_on: { eth: 0.5, spx: 0.5 } } };

  function portfolioBlock(spec: PortfolioSpec, hodlSpec: Record<string, number>): PortfolioBlock {
    return {
      base: backtest(baseRegime, spec),
      eq: backtest(eqRegime, spec),
      macro_alone: backtest(panelRegimes.macro, spec),
      onchain_alone: backtest(panelRegimes.onchain, spec),
      factor_alone: backtest(panelRegimes.factor, spec),
      hodl: backtest(null, { ...spec, fixed: hodlSpec }),
    };
  }

  // ── regime-label agreement diagnostics ──
  function timeShare(regimes: (string | null)[]): Record<string, number> {
    const c: Record<string, number> = { risk_off: 0, neutral: 0, risk_on: 0, total: 0 };
    for (const r of regimes) {
      if (!r) continue;
      c[r]++;
      c.total++;
    }
    return c;
  }
  function agreement(a: (string | null)[], b: (string | null)[]) {
    let same = 0;
    let tot = 0;
    const byYear: Record<string, number> = {};
    for (let i = 0; i < a.length; i++) {
      if (!a[i] || !b[i]) continue;
      tot++;
      if (a[i] === b[i]) same++;
      else byYear[dateAxis[i].slice(0, 4)] = (byYear[dateAxis[i].slice(0, 4)] || 0) + 1;
    }
    return { same_pct: tot ? same / tot : 0, total: tot, diff_by_year: byYear };
  }

  // Monthly downsample for history series (keep payload small)
  function monthlyDownsample(series: number[]): { date: string; value: number | null }[] {
    const out: { date: string; value: number | null }[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < dateAxis.length; i++) {
      const ym = dateAxis[i].slice(0, 7);
      if (seen.has(ym)) continue;
      // Use the last day of each month
      let lastIdx = i;
      while (lastIdx + 1 < dateAxis.length && dateAxis[lastIdx + 1].slice(0, 7) === ym) lastIdx++;
      seen.add(ym);
      out.push({ date: dateAxis[lastIdx], value: Number.isFinite(series[lastIdx]) ? series[lastIdx] : null });
      i = lastIdx;
    }
    return out;
  }
  function dailyRegime(regimes: (string | null)[]): { date: string; regime: string | null }[] {
    const out: { date: string; regime: string | null }[] = [];
    for (let i = 0; i < dateAxis.length; i++) {
      out.push({ date: dateAxis[i], regime: regimes[i] || null });
    }
    return out;
  }

  return {
    asof: dateAxis[dateAxis.length - 1],
    assumptions: {
      cash_yield_annual: CASH_YR,
      rebalance_cost_bps: COST * 10000,
      rolling_window_days: ROLLING_WINDOW_DAYS,
      weight_refresh_days: REFRESH,
      weighting: "point-in-time inverse-correlation (walk-forward), 25% per-indicator cap",
    },
    indicator_counts: {
      macro: indsOf("macro").length,
      onchain: indsOf("onchain").length,
      factor: indsOf("factor").length,
    },
    history: {
      base_composite: monthlyDownsample(baseComp),
      eq_composite: monthlyDownsample(eqComp),
      macro_index: monthlyDownsample(panelIdx.macro),
      onchain_index: monthlyDownsample(panelIdx.onchain),
      factor_index: monthlyDownsample(panelIdx.factor),
      base_regime: dailyRegime(baseRegime),
      eq_regime: dailyRegime(eqRegime),
    },
    time_share: {
      base: timeShare(baseRegime),
      eq: timeShare(eqRegime),
      macro_alone: timeShare(panelRegimes.macro),
      onchain_alone: timeShare(panelRegimes.onchain),
      factor_alone: timeShare(panelRegimes.factor),
    },
    agreement: agreement(baseRegime, eqRegime),
    backtest: {
      eth: portfolioBlock(ETH, { eth: 1 }),
      spx: portfolioBlock(SPX, { spx: 1 }),
      mixed: portfolioBlock(MIX, { eth: 0.5, spx: 0.5 }),
    },
  };
}
