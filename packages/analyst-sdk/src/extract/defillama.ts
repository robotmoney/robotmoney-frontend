// Extract stage: DefiLlama (keyless) source client. Pure parsers — JSON in →
// date-keyed Point[] out, throw on garbage — plus the canonical endpoint URLs
// and async fetchers. Ported from agentjuno/robotmoney fetchers/defillama.js.
import type { Point } from "../types.ts";
import { isoDay } from "../transform/math.ts";
import { fetchJson } from "./http.ts";

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

// Total DeFi TVL across all chains (drops non-finite tvl rows).
export async function fetchDefillamaTvl(timeoutMs = 15000): Promise<Point[]> {
  return parseLlamaTvl(await fetchJson(llamaTvlUrl, timeoutMs)).filter((p) => Number.isFinite(p.value));
}

// Total stablecoin float (drops non-finite rows).
export async function fetchDefillamaStables(timeoutMs = 15000): Promise<Point[]> {
  return parseLlamaStables(await fetchJson(llamaStablesUrl, timeoutMs)).filter((p) => Number.isFinite(p.value));
}
