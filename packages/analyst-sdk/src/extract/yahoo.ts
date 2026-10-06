// Extract stage: Yahoo Finance (keyless) source client. Pure parser — chart JSON
// in → date-keyed Point[] out, throw on garbage — plus the endpoint URL and an
// async fetcher. Ported from agentjuno/robotmoney scripts/regime/fetchers/yahoo.js.
//
// Uses the v8 chart JSON endpoint (more stable than the legacy v7 CSV download
// that 401s for unauthenticated callers):
//   https://query2.finance.yahoo.com/v8/finance/chart/<SYMBOL>?period1=..&period2=..&interval=1d
//
// Value is adjclose when finite, else the raw close; NaN rows are dropped.
import type { Point } from "../types.ts";
import { isoDay } from "../transform/math.ts";
import { fetchJson } from "./http.ts";

// Yahoo Finance chart: result.chart.result[0].{timestamp[], indicators.adjclose[0].adjclose[]
// | indicators.quote[0].close[]}. Prefer adjclose, fall back to close, drop NaN.
export function parseYahoo(j: unknown): Point[] {
  const res = (j as any)?.chart?.result?.[0];
  const ts: number[] = res?.timestamp;
  const adj: number[] = res?.indicators?.adjclose?.[0]?.adjclose ?? [];
  const close: number[] = res?.indicators?.quote?.[0]?.close ?? [];
  if (!Array.isArray(ts) || (!Array.isArray(adj) && !Array.isArray(close)))
    throw new Error("yahoo: missing timestamp/adjclose/close");
  if (adj.length === 0 && close.length === 0) throw new Error("yahoo: missing timestamp/adjclose/close");
  const out: Point[] = [];
  for (let i = 0; i < ts.length; i++) {
    const v = Number.isFinite(adj[i]) ? adj[i] : close[i];
    if (!Number.isFinite(v)) continue;
    out.push({ date: isoDay(ts[i] * 1000), value: Number(v) });
  }
  return out;
}

// Full-history v8 chart URL. period1=0 → earliest available; events=history for
// dividend/split-adjusted closes.
export const yfUrl = (
  symbol: string,
  startUnix = 0,
  endUnix = Math.floor(Date.now() / 1000),
) =>
  `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?period1=${startUnix}&period2=${endUnix}&interval=1d&events=history`;

export async function fetchYahoo(
  symbol: string,
  startUnix = 0,
  endUnix = Math.floor(Date.now() / 1000),
  timeoutMs = 15000,
): Promise<Point[]> {
  const j = await fetchJson(yfUrl(symbol, startUnix, endUnix), timeoutMs, {
    "user-agent": "Mozilla/5.0 (compatible; robotmoney-regime/1.0)",
  });
  return parseYahoo(j);
}
