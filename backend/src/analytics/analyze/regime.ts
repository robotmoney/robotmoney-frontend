// DEAD IN PRODUCTION — this is NOT the regime classifier, and must not be used
// for reconciliation. The production classifier is `bucketFn` in
// analyze/compute.ts, fed by `computeRegime`, invoked from
// analytics/index.ts::runAnalytics. See docs/technical/regime-engine.md §7 for
// the full comparison and docs/audits/v0-v1-parity/A1-regime-core-procedures.md
// finding F4 for the executed evidence. This file's only importer repo-wide is
// backend/tests/analytics.test.ts. It differs structurally from the production
// path in every dimension that matters: 11 hardcoded indicators (not the
// 26-entry registry in analyze/indicators.ts), static literal weights (not
// point-in-time inverse-correlation), a 90-day window (not the 1095-day
// rolling window), `percentileInWindow` (not `rollingPercentileRank` — see
// transform/math.ts's header for why that distinction matters), no 5-day/2σ
// smoothing, and 4-decimal rounding throughout its output. Reconciling a
// published regime label against THIS file's numbers will not match
// production and does not indicate a bug in production.
//
// Regime classifier as a composable AnalyticTool. Macro + on-chain indicators →
// per-indicator sign-adjusted percentile → panel composites → overall composite +
// regime label. Pure compute — persistence goes through the orchestrator's
// AnalyticsPersistence port (issue #106).
import type { AnalyticTool, ToolContext } from "./tool.ts";
import { classifyRegime } from "@robotmoney/contract";
import { percentileInWindow, applySign } from "../transform/math.ts";

// The regime thresholds/label rule live in @robotmoney/contract (contract/src/
// regime.js) — the same 0.33/0.67 rule the PRODUCTION classifier
// (analyze/compute.ts's `bucketFn`) also implements, not something this dead
// file defines. The swarm domain layer + swarm memo builder consume the same
// contract module so labels can never diverge across surfaces. Re-exported
// here only so this file's own (dead) callers/tests can keep importing the
// label rule from one place.
export { classifyRegime, REGIME_RISK_OFF, REGIME_RISK_ON } from "@robotmoney/contract";

const WINDOW = 90;

interface Indicator { id: string; name: string; panel: "macro" | "onchain"; sign: 1 | -1; base: number; vol: number; weight: number; }

export const REGIME_INDICATORS: Indicator[] = [
  { id: "T10Y2Y", name: "10y–2y yield curve", panel: "macro", sign: 1, base: 0.4, vol: 0.15, weight: 1 },
  { id: "HY_OAS", name: "High-yield credit spread", panel: "macro", sign: -1, base: 3.5, vol: 0.06, weight: 1.4 },
  { id: "VIX", name: "Equity volatility (VIX)", panel: "macro", sign: -1, base: 17, vol: 0.08, weight: 1.1 },
  { id: "DXY", name: "US dollar index", panel: "macro", sign: -1, base: 103, vol: 0.02, weight: 0.9 },
  { id: "COPPER_GOLD", name: "Copper/gold ratio", panel: "macro", sign: 1, base: 0.18, vol: 0.04, weight: 1 },
  { id: "ICSA", name: "Initial jobless claims", panel: "macro", sign: -1, base: 220000, vol: 0.05, weight: 1.2 },
  { id: "DEFI_TVL", name: "DeFi total value locked", panel: "onchain", sign: 1, base: 95e9, vol: 0.05, weight: 1.2 },
  { id: "STABLES", name: "Stablecoin supply growth", panel: "onchain", sign: 1, base: 1.0, vol: 0.03, weight: 1 },
  { id: "BTC_ACTIVE", name: "BTC active addresses", panel: "onchain", sign: 1, base: 950000, vol: 0.06, weight: 1 },
  { id: "ETH_TREND", name: "ETH price trend", panel: "onchain", sign: 1, base: 3200, vol: 0.07, weight: 1.1 },
  { id: "BTC_ETH", name: "BTC/ETH ratio", panel: "onchain", sign: 1, base: 18, vol: 0.04, weight: 0.9 },
];

const label = classifyRegime;

export interface RegimeSnapshot {
  date: string; composite: number; compositePercentile: number;
  regime: string; macroRegime: string; onchainRegime: string; factorRegime: null;
  percentiles: Record<string, number>;
  indicators: { id: string; name: string; panel: string; sign: number; value: number; score: number; weight: number }[];
}

export interface RegimeResult { snapshots: RegimeSnapshot[]; }

export const regimeTool: AnalyticTool<RegimeResult> = {
  id: "regime",
  title: "Market regime",
  kind: "regime",
  inputs: REGIME_INDICATORS.map((i) => i.id),

  compute(ctx: ToolContext): RegimeResult {
    const historyDays = 120;
    const lookback = WINDOW + historyDays;
    const series = REGIME_INDICATORS.map((ind) => ({
      ind,
      pts: ctx.provider.getSeries({ id: ind.id, base: ind.base, vol: ind.vol }, ctx.asof, lookback),
    }));
    const dates = series[0].pts.map((p) => p.date);
    const weightSum = REGIME_INDICATORS.reduce((a, i) => a + i.weight, 0);

    const compositeHistory: number[] = [];
    const snapshots: RegimeSnapshot[] = [];
    for (let t = WINDOW; t < lookback; t++) {
      const readings = series.map(({ ind, pts }) => {
        const window = pts.slice(t - WINDOW, t).map((p) => p.value);
        const value = pts[t].value;
        const score = applySign(percentileInWindow(value, window), ind.sign);
        return { id: ind.id, name: ind.name, panel: ind.panel, sign: ind.sign, value, score, weight: ind.weight };
      });
      const composite = readings.reduce((a, r) => a + r.score * r.weight, 0) / weightSum;
      compositeHistory.push(composite);
      const panel = (p: "macro" | "onchain") => {
        const rs = readings.filter((r) => r.panel === p);
        const w = rs.reduce((a, r) => a + r.weight, 0);
        return rs.reduce((a, r) => a + r.score * r.weight, 0) / w;
      };
      const percentiles: Record<string, number> = {};
      readings.forEach((r) => (percentiles[r.id] = Number(r.score.toFixed(4))));
      snapshots.push({
        date: dates[t],
        composite: Number(composite.toFixed(4)),
        compositePercentile: Number(percentileInWindow(composite, compositeHistory.slice(-WINDOW)).toFixed(4)),
        regime: label(composite), macroRegime: label(panel("macro")), onchainRegime: label(panel("onchain")), factorRegime: null,
        percentiles,
        indicators: readings.map((r) => ({ ...r, value: Number(r.value.toFixed(4)), score: Number(r.score.toFixed(4)) })),
      });
    }
    return { snapshots };
  },

};
