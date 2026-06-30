// Regime classifier as a composable AnalyticTool. Macro + on-chain indicators →
// per-indicator sign-adjusted percentile → panel composites → overall composite +
// regime label. Persists the full history to regime_snapshots.
import { sql } from "../../db/client.ts";
import type { AnalyticTool, ToolContext } from "../tool.ts";
import { percentileInWindow, applySign } from "../transforms.ts";

const WINDOW = 90;
const RISK_OFF = 0.33;
const RISK_ON = 0.67;

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

const label = (s: number) => (s < RISK_OFF ? "risk_off" : s >= RISK_ON ? "risk_on" : "neutral");

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

  async persist(result) {
    for (const s of result.snapshots) {
      await sql`
        INSERT INTO regime_snapshots
          (date, composite, composite_percentile, regime, macro_regime, onchain_regime, factor_regime, percentiles, indicators)
        VALUES (${s.date}, ${s.composite}, ${s.compositePercentile}, ${s.regime}, ${s.macroRegime}, ${s.onchainRegime}, ${s.factorRegime}, ${sql.json(s.percentiles)}, ${sql.json(s.indicators)})
        ON CONFLICT (date) DO UPDATE SET
          composite = EXCLUDED.composite, composite_percentile = EXCLUDED.composite_percentile,
          regime = EXCLUDED.regime, macro_regime = EXCLUDED.macro_regime, onchain_regime = EXCLUDED.onchain_regime,
          factor_regime = EXCLUDED.factor_regime, percentiles = EXCLUDED.percentiles, indicators = EXCLUDED.indicators`;
    }
  },
};
