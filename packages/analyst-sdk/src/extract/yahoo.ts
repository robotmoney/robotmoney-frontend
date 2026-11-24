// Extract stage: Yahoo Finance (keyless) source client. Pure parser — chart JSON
// in → date-keyed Point[] out, throw on garbage — plus the endpoint URL and an
// async fetcher. Ported from agentjuno/robotmoney scripts/regime/fetchers/yahoo.js.
//
// Uses the v8 chart JSON endpoint (more stable than the legacy v7 CSV download
// that 401s for unauthenticated callers):
//   https://query2.finance.yahoo.com/v8/finance/chart/<SYMBOL>?period1=..&period2=..&interval=1d
//
// parseYahoo's value is adjclose when finite, else the raw close; NaN rows are
// dropped. parseYahooClose's value is the raw close only (issue 1644: a ratio
// leg is source data, so never the dividend-adjusted close).
// Day boundary (issue 1733, finding E5): a row's timestamp is its session's
// open instant; the value belongs to that UTC day (isoDay), which ends at the
// next 00:00:00Z. Crypto pairs trade a UTC day; an exchange session closes
// before it ends.
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

// The raw close, `indicators.quote[0].close`, never adjclose. A row whose close
// is null or not finite is dropped.
export function parseYahooClose(j: unknown): Point[] {
  const res = (j as any)?.chart?.result?.[0];
  const ts: number[] = res?.timestamp;
  const close: number[] = res?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(close) || close.length === 0) throw new Error("yahoo: missing timestamp/close");
  const out: Point[] = [];
  for (let i = 0; i < ts.length; i++) {
    if (!Number.isFinite(close[i])) continue;
    out.push({ date: isoDay(ts[i] * 1000), value: Number(close[i]) });
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

/** The chart JSON for one symbol: both parsers read the one response. */
export function fetchYahooChart(
  symbol: string,
  startUnix = 0,
  endUnix = Math.floor(Date.now() / 1000),
  timeoutMs = 15000,
): Promise<unknown> {
  return fetchJson(yfUrl(symbol, startUnix, endUnix), timeoutMs, {
    "user-agent": "Mozilla/5.0 (compatible; robotmoney-regime/1.0)",
  });
}

/** The adjusted close (parseYahoo). */
export async function fetchYahoo(
  symbol: string,
  startUnix = 0,
  endUnix = Math.floor(Date.now() / 1000),
  timeoutMs = 15000,
): Promise<Point[]> {
  return parseYahoo(await fetchYahooChart(symbol, startUnix, endUnix, timeoutMs));
}

/** The raw close (parseYahooClose): a ratio leg (issue 1644). */
export async function fetchYahooClose(
  symbol: string,
  startUnix = 0,
  endUnix = Math.floor(Date.now() / 1000),
  timeoutMs = 15000,
): Promise<Point[]> {
  return parseYahooClose(await fetchYahooChart(symbol, startUnix, endUnix, timeoutMs));
}
