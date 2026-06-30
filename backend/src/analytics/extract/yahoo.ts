// Extract stage: Yahoo Finance (keyless) source client. Pure parser — chart JSON
// in → date-keyed Point[] out, throw on garbage — plus the endpoint URL.
import type { Point } from "../types.ts";
import { isoDay } from "../transform/math.ts";

// Yahoo Finance chart: result.chart.result[0].{timestamp[], indicators.quote[0].close[]}.
export function parseYahoo(j: unknown): Point[] {
  const res = (j as any)?.chart?.result?.[0];
  const ts: number[] = res?.timestamp;
  const close: number[] = res?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(close)) throw new Error("yahoo: missing timestamp/close");
  const out: Point[] = [];
  for (let i = 0; i < ts.length; i++) if (close[i] != null) out.push({ date: isoDay(ts[i] * 1000), value: Number(close[i]) });
  return out;
}

export const yfUrl = (symbol: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`;
