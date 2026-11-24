// Extract stage: DefiLlama (keyless) source client. Pure parsers — JSON in →
// date-keyed Point[] out, throw on garbage — plus the canonical endpoint URLs
// and async fetchers. Ported from agentjuno/robotmoney fetchers/defillama.js.
// Day boundary (issue 1733, finding E5): `date` is unix seconds at 00:00:00Z
// of the UTC day the value belongs to; that day ends at the next 00:00:00Z. The
// current day's row is provisional until then.
import type { Point } from "../types.ts";
import { isoDay } from "../transform/math.ts";
import { applyDayClose, fetchJson, type DayClose } from "./http.ts";

export const llamaTvlUrl = "https://api.llama.fi/v2/historicalChainTvl";
export const llamaStablesUrl = "https://stablecoins.llama.fi/stablecoincharts/all";

// DefiLlama total value locked across all chains: [{date: unixSeconds, tvl}].
export function parseLlamaTvl(j: unknown): Point[] {
  if (!Array.isArray(j)) throw new Error("llama tvl: not an array");
  return j.map((row: any) => ({ date: isoDay(Number(row.date) * 1000), value: Number(row.tvl) }));
}

// DefiLlama stablecoins aggregate circulating: [{date, totalCirculatingUSD:{peggedUSD}}].
export function parseLlamaStables(j: unknown): Point[] {
  if (!Array.isArray(j)) throw new Error("llama stables: not an array");
  return j.map((row: any) => ({
    date: isoDay(Number(row.date) * 1000),
    value: Number(row.totalCirculatingUSD?.peggedUSD ?? row.totalCirculating?.peggedUSD),
  }));
}

// The run time and the source's day-close rule (issue 1655) are parameters, so
// tests pin them. Under the declared "accept-partial" every served row is kept.
export interface DayCloseOptions {
  dayClose?: DayClose;
  now?: Date;
}

// Total DeFi TVL across all chains (drops non-finite tvl rows).
export async function fetchDefillamaTvl(timeoutMs = 15000, opts: DayCloseOptions = {}): Promise<Point[]> {
  const rows = parseLlamaTvl(await fetchJson(llamaTvlUrl, timeoutMs)).filter((p) => Number.isFinite(p.value));
  return applyDayClose(rows, opts.dayClose, opts.now);
}

// Total stablecoin float (drops non-finite rows).
export async function fetchDefillamaStables(timeoutMs = 15000, opts: DayCloseOptions = {}): Promise<Point[]> {
  const rows = parseLlamaStables(await fetchJson(llamaStablesUrl, timeoutMs)).filter((p) => Number.isFinite(p.value));
  return applyDayClose(rows, opts.dayClose, opts.now);
}
