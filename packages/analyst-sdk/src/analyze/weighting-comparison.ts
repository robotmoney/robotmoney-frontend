// Weighting-methodology comparison (research generator) — ported VERBATIM
// from agentjuno/robotmoney scripts/regime/weighting-comparison.js.
//
// Runs the regime pipeline three ways, holding everything else identical
// (same raw data, same percentile/sign-align/bucket/smoothing, same constant
// 2.6%/yr cash, same 10 bps rebalance cost). Only the panel-weighting step
// differs:
//
//   1. static_invcorr  — one inverse-correlation weight vector from the most
//                         recent 3y window, applied to all history. This is
//                         the current production method; it has look-ahead.
//   2. equal_1n        — fixed 1/N weight per indicator (no correlation input).
//   3. walk_forward    — point-in-time inverse-correlation: each day's weights
//                         use only the trailing 3y ending that day. No
//                         look-ahead. (Recomputed monthly; daily is identical
//                         to 3 decimals and ~20x slower.)
//
// R1 port rules (docs/v0-v1-quant-platform-parity-report.md §8 Phase R): the
// constant 2.6%/yr cash model, COST_PER_REBALANCE, WALK_FORWARD_REFRESH_DAYS
// and the hardcoded PHASES (including the 2026-05-12 'Recent' anchor — this
// script's PHASES differ from regime-eq-comparison.ts's, and both are
// preserved exactly as their respective originals, not unified) are kept
// bit-for-bit. Do NOT "clean up" to v1's real-DTB3 backtest model.
//
// Pure and deterministic: same inputs, same outputs. No I/O, no Date.now().
import { INDICATORS as DEFAULT_INDICATORS, PANELS, ROLLING_WINDOW_DAYS, type Indicator, type Panel } from "./indicators.ts";
import { applyTransform } from "../transform/transforms.ts";
import {
  rollingPercentileRank,
  inverseCorrelationWeights,
  alignDailyForwardFill,
  buildDateAxis,
} from "../transform/math.ts";
import { smoothRegimes, bucketFn } from "./compute.ts";
import type { Point } from "../types.ts";

export const CONSTANT_CASH_YR = 0.026;
export const COST_PER_REBALANCE = 0.001;
export const WALK_FORWARD_REFRESH_DAYS = 21;

export const PHASES: { name: string; start: string; end: string }[] = [
  { name: "Pre-2020 + COVID", start: "2018-02-28", end: "2020-12-31" },
  { name: "2021 mania", start: "2020-12-31", end: "2021-11-30" },
  { name: "2022 drawdown", start: "2021-11-30", end: "2022-12-31" },
  { name: "Recovery", start: "2022-12-31", end: "2024-01-31" },
  { name: "Recent", start: "2024-01-31", end: "2026-05-12" },
];

export interface WeightingComparisonInput {
  // Raw (pre-transform) daily history per indicator id, as read from
  // data/regime/raw-indicator-history.csv in v0.
  raw: Record<string, Point[]>;
  // snap.asof and snap.extras.{eth,spx} from public/data/regime-snapshot.json
  // in v0.
  snapAsof: string;
  extras: { eth: Point[]; spx: Point[] };
  // Indicator registry. Defaults to the shared, current INDICATORS (the
  // registry every other analyze/* module uses — kept in sync with v0's
  // HEAD lib/indicators.js). v0's own registry is not static over time
  // (indicators have been reclassified between panels, e.g. SPX_TREND/
  // IWM_SPY macro→factor), so a golden-replay test reproducing an OLDER
  // v0-published artifact must pass the registry as it existed at that
  // vintage — this parameter exists for that case, not for go-forward use
  // (regenerate scripts always take the default).
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
  equity_curve: Point[];
  phases: { name: string; cagr: number | null; max_drawdown: number | null }[];
}

interface MethodBlock {
  label: string;
  panel_weights: { macro: Record<string, number>; onchain: Record<string, number> };
  eth: { composite: BacktestResult; conservative: BacktestResult; aggressive: BacktestResult; hodl: BacktestResult };
  mixed: { composite: BacktestResult; conservative: BacktestResult; aggressive: BacktestResult; hodl: BacktestResult };
}

export interface WeightingComparisonResult {
  asof: string;
  assumptions: {
    cash_yield_annual: number;
    rebalance_cost_bps: number;
    rolling_window_days: number;
    note: string;
  };
  methods: Record<string, MethodBlock>;
}

export function computeWeightingComparison(input: WeightingComparisonInput): WeightingComparisonResult {
  const { raw, snapAsof, extras } = input;
  const INDICATORS = input.indicators ?? DEFAULT_INDICATORS;

  // ── date axis: 2018-01-01 through the last date present in ANY raw series ──
  let maxDate = "2018-01-01";
  for (const id in raw) {
    for (const row of raw[id]) {
      if (row.date > maxDate) maxDate = row.date;
    }
  }
  const dateAxis = buildDateAxis("2018-01-01", maxDate);

  // ── load + prepare sign-aligned percentile ranks (shared by all 3 methods) ──
  const signed: Record<string, number[]> = {};
  for (const ind of INDICATORS) {
    const t = applyTransform(ind.transform, alignDailyForwardFill(raw[ind.id] || [], dateAxis));
    const r = rollingPercentileRank(t, ROLLING_WINDOW_DAYS);
    signed[ind.id] = r.map((v) => (Number.isFinite(v) ? (ind.sign >= 0 ? v : 1 - v) : NaN));
  }

  const indsOf = (panel: Panel) => INDICATORS.filter((x) => x.panel === panel);
  const wmean = (panel: Panel, w: Record<string, number>, i: number): number => {
    let num = 0;
    let den = 0;
    for (const ind of indsOf(panel)) {
      const v = signed[ind.id][i];
      const ww = w[ind.id];
      if (!Number.isFinite(v) || !Number.isFinite(ww)) continue;
      num += ww * v;
      den += ww;
    }
    return den > 0 ? num / den : NaN;
  };
  const validCount = (id: string, fromIdx: number, toIdx: number): number => {
    let n = 0;
    for (let k = fromIdx; k <= toIdx; k++) if (Number.isFinite(signed[id][k])) n++;
    return n;
  };

  function assemble(macroI: number[], onchI: number[]) {
    const comp = new Array(dateAxis.length).fill(NaN);
    for (let i = 0; i < dateAxis.length; i++) {
      if (Number.isFinite(macroI[i]) && Number.isFinite(onchI[i])) comp[i] = 0.5 * macroI[i] + 0.5 * onchI[i];
      else comp[i] = Number.isFinite(macroI[i]) ? macroI[i] : onchI[i];
    }
    return {
      macroR: smoothRegimes(rollingPercentileRank(macroI, ROLLING_WINDOW_DAYS), bucketFn),
      onchR: smoothRegimes(rollingPercentileRank(onchI, ROLLING_WINDOW_DAYS), bucketFn),
      compR: smoothRegimes(rollingPercentileRank(comp, ROLLING_WINDOW_DAYS), bucketFn),
    };
  }

  function staticMethod(equal: boolean) {
    const W: Record<string, Record<string, number>> = {};
    for (const panel of PANELS) {
      const inds = indsOf(panel);
      if (equal) {
        const valid = inds.filter(
          (ind) => validCount(ind.id, Math.max(0, signed[ind.id].length - ROLLING_WINDOW_DAYS), signed[ind.id].length - 1) >= 60,
        );
        W[panel] = {};
        for (const ind of inds) W[panel][ind.id] = valid.includes(ind) ? 1 / valid.length : 0;
      } else {
        const win: Record<string, number[]> = {};
        for (const ind of inds) win[ind.id] = signed[ind.id].slice(Math.max(0, signed[ind.id].length - ROLLING_WINDOW_DAYS));
        W[panel] = inverseCorrelationWeights(win);
      }
    }
    const mI = new Array(dateAxis.length).fill(NaN);
    const oI = new Array(dateAxis.length).fill(NaN);
    for (let i = 0; i < dateAxis.length; i++) {
      mI[i] = wmean("macro", W.macro, i);
      oI[i] = wmean("onchain", W.onchain, i);
    }
    return { ...assemble(mI, oI), weights: W };
  }

  function walkForwardMethod() {
    const mI = new Array(dateAxis.length).fill(NaN);
    const oI = new Array(dateAxis.length).fill(NaN);
    const cache: Record<string, Record<string, number>> = {};
    for (let i = 0; i < dateAxis.length; i++) {
      if (i % WALK_FORWARD_REFRESH_DAYS === 0 || !cache.macro) {
        for (const panel of PANELS) {
          const inds = indsOf(panel);
          const start = Math.max(0, i - ROLLING_WINDOW_DAYS + 1);
          const win: Record<string, number[]> = {};
          let ok = false;
          for (const ind of inds) {
            win[ind.id] = signed[ind.id].slice(start, i + 1);
            if (validCount(ind.id, start, i) >= 60) ok = true;
          }
          cache[panel] = ok
            ? inverseCorrelationWeights(win)
            : Object.fromEntries(inds.map((ind) => [ind.id, 1 / inds.length]));
        }
      }
      mI[i] = wmean("macro", cache.macro, i);
      oI[i] = wmean("onchain", cache.onchain, i);
    }
    return { ...assemble(mI, oI), weights: cache };
  }

  const combineConservative = (m: string | null, o: string | null): string | null =>
    !m || !o ? null : m === "risk_off" || o === "risk_off" ? "risk_off" : m === "risk_on" && o === "risk_on" ? "risk_on" : "neutral";
  const combineAggressive = (m: string | null, o: string | null): string | null => {
    if (!m || !o) return null;
    const s = (r: string | null) => (r === "risk_on" ? 1 : r === "risk_off" ? -1 : 0);
    const x = s(m) + s(o);
    return x >= 1 ? "risk_on" : x <= -1 ? "risk_off" : "neutral";
  };

  // ── prices + backtest ──
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
    const rets: number[] = [];
    const curve: Point[] = [];
    const cashDaily = Math.pow(1 + CONSTANT_CASH_YR, 1 / 365) - 1;
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
      if (lw && !sameW(lw, w)) eq *= 1 - turnover(lw, w) * COST_PER_REBALANCE;
      lw = w;
      if (eq > pk) pk = eq;
      const dd = eq / pk - 1;
      if (dd < mdd) mdd = dd;
      curve.push({ date: dateAxis[i], value: eq });
    }
    const yrs = (+new Date(curve[curve.length - 1].date) - +new Date(curve[0].date)) / (365.25 * 864e5);
    const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (rets.length - 1));
    const monthEnd = new Map<string, Point>();
    for (const p of curve) monthEnd.set(p.date.slice(0, 7), p);
    return {
      final_value: eq,
      cagr: Math.pow(eq, 1 / yrs) - 1,
      sharpe: sd > 0 ? (mean * 365) / (sd * Math.sqrt(365)) : 0,
      max_drawdown: mdd,
      equity_curve: [...monthEnd.values()],
      phases: PHASES.map((ph) => {
        const w = curve.filter((p) => p.date >= ph.start && p.date <= ph.end);
        if (w.length < 2) return { name: ph.name, cagr: null, max_drawdown: null };
        const y = (+new Date(ph.end) - +new Date(ph.start)) / (365.25 * 864e5);
        let p2 = w[0].value;
        let d2 = 0;
        for (const p of w) {
          if (p.value > p2) p2 = p.value;
          const dd = p.value / p2 - 1;
          if (dd < d2) d2 = dd;
        }
        return { name: ph.name, cagr: Math.pow(w[w.length - 1].value / w[0].value, 1 / y) - 1, max_drawdown: d2 };
      }),
    };
  }

  const ETH: PortfolioSpec = { risky: ["eth"], weights: { risk_off: { cash: 1 }, neutral: { cash: 0.5, eth: 0.5 }, risk_on: { eth: 1 } } };
  const MIX: PortfolioSpec = { risky: ["eth", "spx"], weights: { risk_off: { cash: 1 }, neutral: { cash: 0.5, eth: 0.25, spx: 0.25 }, risk_on: { eth: 0.5, spx: 0.5 } } };

  const METHODS: { id: string; label: string; gen: () => { macroR: (string | null)[]; onchR: (string | null)[]; compR: (string | null)[]; weights: Record<string, Record<string, number>> } }[] = [
    { id: "static_invcorr", label: "Static inverse-correlation (look-ahead)", gen: () => staticMethod(false) },
    { id: "equal_1n", label: "Equal weight (1/N)", gen: () => staticMethod(true) },
    { id: "walk_forward", label: "Walk-forward inverse-correlation (point-in-time)", gen: walkForwardMethod },
  ];

  const out: WeightingComparisonResult = {
    asof: snapAsof,
    assumptions: {
      cash_yield_annual: CONSTANT_CASH_YR,
      rebalance_cost_bps: COST_PER_REBALANCE * 10000,
      rolling_window_days: ROLLING_WINDOW_DAYS,
      note:
        "Constant cash yield used so the only difference between methods is the weighting. Absolute multiples differ slightly from /regime (which uses real daily T-bill); the cross-method comparison is the point.",
    },
    methods: {},
  };

  for (const m of METHODS) {
    const { macroR, onchR, compR, weights } = m.gen();
    const cons = compR.map((_, i) => combineConservative(macroR[i], onchR[i]));
    const aggr = compR.map((_, i) => combineAggressive(macroR[i], onchR[i]));
    out.methods[m.id] = {
      label: m.label,
      panel_weights: {
        macro: Object.fromEntries(Object.entries(weights.macro).map(([k, v]) => [k, +(+v).toFixed(4)])),
        onchain: Object.fromEntries(Object.entries(weights.onchain).map(([k, v]) => [k, +(+v).toFixed(4)])),
      },
      eth: {
        composite: backtest(compR, ETH),
        conservative: backtest(cons, ETH),
        aggressive: backtest(aggr, ETH),
        hodl: backtest(null, { ...ETH, fixed: { eth: 1 } }),
      },
      mixed: {
        composite: backtest(compR, MIX),
        conservative: backtest(cons, MIX),
        aggressive: backtest(aggr, MIX),
        hodl: backtest(null, { ...MIX, fixed: { eth: 0.5, spx: 0.5 } }),
      },
    };
  }

  return out;
}
