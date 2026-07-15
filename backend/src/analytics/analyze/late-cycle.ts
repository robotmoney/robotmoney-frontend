// Research signal: "how late in the cycle is this rally?" Mirrors the original
// /research/late-cycle-signals. Slow gauges that historically saturate near
// equity peaks: index concentration (SPY/RSP), M&A activity, margin debt, and
// consumer confidence. Complements (does not feed) the regime composite.
import type { AnalyticTool, ToolContext } from "./tool.ts";
import { ratio, percentileInWindow } from "../transform/math.ts";
import type { ResearchPayload, Gauge } from "./research.ts";

const KEY = "late-cycle-signals";

export const lateCycleTool: AnalyticTool<ResearchPayload> = {
  id: KEY,
  title: "Late-cycle signals",
  kind: "research",
  inputs: ["SPY", "RSP", "MNA", "MARGIN", "CONF"],

  compute(ctx: ToolContext): ResearchPayload {
    const N = 260;
    const get = (id: string, base: number, vol: number, drift = 0) =>
      ctx.provider.getSeries({ id, base, vol, drift }, ctx.asof, N).map((p) => p.value);
    const spy = get("SPY", 540, 0.015, 0.0008);
    const rsp = get("RSP", 170, 0.013);
    const concentration = ratio(spy, rsp); // cap-weight vs equal-weight
    const mna = get("MNA", 120, 0.08);
    const margin = get("MARGIN", 700, 0.02, 0.0005);
    const conf = get("CONF", 65, 0.03);

    const latestPct = (xs: number[]) => percentileInWindow(xs.at(-1)!, xs);
    const read = (p: number) => (p >= 0.7 ? "saturated (late-cycle)" : p >= 0.5 ? "elevated" : "benign");
    const g = (id: string, name: string, xs: number[]): Gauge => {
      const p = latestPct(xs);
      return { id, name, value: Number((xs.at(-1) ?? 0).toFixed(2)), percentile: Number(p.toFixed(3)), read: read(p) };
    };

    const dates = ctx.provider.getSeries({ id: "SPY", base: 540, vol: 0.015, drift: 0.0008 }, ctx.asof, N).map((p) => p.date);
    return {
      asof: ctx.asof,
      title: "Late-cycle signals",
      question: "How late in the cycle is this rally?",
      spec: { percentile_window_days: N, gauges: ["concentration", "m&a", "margin debt", "confidence"] },
      gauges: [
        g("CONCENTRATION", "Index concentration (SPY/RSP)", concentration),
        g("MNA", "M&A activity", mna),
        g("MARGIN", "Margin debt", margin),
        g("CONF", "Consumer confidence", conf),
      ],
      series: { label: "Index concentration (SPY/RSP)", points: dates.map((date, i) => ({ date, value: Number((concentration[i] ?? 0).toFixed(3)) })).slice(-180) },
    };
  },
};
