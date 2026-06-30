// Research signal: "is the easy-money → crypto channel breaking down?" Mirrors the
// original /research/channel-divergence. Complements (does not feed) the regime
// composite. Indicators: BTC beta vs the risk-appetite factor (QQQ−SPY returns),
// and the BTC/QQQ relative-strength ratio.
import type { AnalyticTool, ToolContext } from "./tool.ts";
import { pctChange, rollingBeta, ratio, percentileInWindow, clamp01 } from "../transform/math.ts";
import type { ResearchPayload } from "./research.ts";
import { persistResearchSignal } from "../store/research-store.ts";

const KEY = "channel-divergence";

export const channelDivergenceTool: AnalyticTool<ResearchPayload> = {
  id: KEY,
  title: "Channel divergence",
  kind: "research",
  inputs: ["BTC", "QQQ", "SPY"],

  compute(ctx: ToolContext): ResearchPayload {
    const N = 210, BETA_W = 90;
    const btc = ctx.provider.getSeries({ id: "BTC", base: 65000, vol: 0.04 }, ctx.asof, N);
    const qqq = ctx.provider.getSeries({ id: "QQQ", base: 480, vol: 0.02 }, ctx.asof, N);
    const spy = ctx.provider.getSeries({ id: "SPY", base: 540, vol: 0.015 }, ctx.asof, N);
    const btcR = pctChange(btc.map((p) => p.value));
    const qqqR = pctChange(qqq.map((p) => p.value));
    const spyR = pctChange(spy.map((p) => p.value));
    const risk = qqqR.map((q, i) => q - (spyR[i] ?? 0));

    // rolling beta history → latest + percentile
    const betas: number[] = [];
    for (let t = BETA_W; t < btcR.length; t++) betas.push(rollingBeta(btcR.slice(0, t), risk.slice(0, t), BETA_W));
    const beta = betas.at(-1) ?? 0;
    const betaPct = percentileInWindow(beta, betas);

    const ratioSeries = ratio(btc.map((p) => p.value), qqq.map((p) => p.value));
    const ratioPct = percentileInWindow(ratioSeries.at(-1)!, ratioSeries);

    const read = (p: number) => (p >= 0.6 ? "channel intact" : p <= 0.35 ? "breaking down" : "softening");
    const dates = btc.slice(1).map((p) => p.date);

    return {
      asof: ctx.asof,
      title: "Channel divergence",
      question: "Is the easy-money → crypto transmission channel breaking down?",
      spec: { beta_window_days: BETA_W, risk_factor: "QQQ return − SPY return", percentile_window_days: N },
      gauges: [
        { id: "BTC_BETA", name: "BTC beta vs risk appetite", value: Number(beta.toFixed(3)), percentile: Number(betaPct.toFixed(3)), read: read(betaPct) },
        { id: "BTC_QQQ_RATIO", name: "BTC/QQQ relative strength", value: Number((ratioSeries.at(-1) ?? 0).toFixed(2)), percentile: Number(ratioPct.toFixed(3)), read: read(ratioPct) },
        { id: "CHANNEL", name: "Composite channel health", value: Number(clamp01((betaPct + ratioPct) / 2).toFixed(3)), percentile: Number(((betaPct + ratioPct) / 2).toFixed(3)), read: read((betaPct + ratioPct) / 2) },
      ],
      series: { label: "BTC/QQQ ratio", points: dates.map((date, i) => ({ date, value: Number((ratioSeries[i + 1] ?? 0).toFixed(2)) })).slice(-180) },
    };
  },

  async persist(result, asof) { await persistResearchSignal(KEY, asof, result); },
};
