// Extract stage: DefiLlama (keyless) source client. Pure parsers — JSON in →
// date-keyed Point[] out, throw on garbage — plus the canonical endpoint URLs.
import type { Point } from "../types.ts";
import { isoDay } from "../transform/math.ts";

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
