// Extract stage: CoinGecko (keyless) source client. Pure parser — market_chart
// JSON in → date-keyed Point[] out, throw on garbage — plus the endpoint URL.
import type { Point } from "../types.ts";
import { isoDay } from "../transform/math.ts";

// CoinGecko market_chart series: {prices|total_volumes|market_caps: [[ms, v], ...]}.
export function parseCoinGecko(j: unknown, key: "prices" | "total_volumes" | "market_caps"): Point[] {
  const arr = (j as any)?.[key];
  if (!Array.isArray(arr)) throw new Error(`coingecko: missing ${key}`);
  return arr.map((row: any) => ({ date: isoDay(Number(row[0])), value: Number(row[1]) }));
}

export const cgUrl = (coin: string) =>
  `https://api.coingecko.com/api/v3/coins/${coin}/market_chart?vs_currency=usd&days=365&interval=daily`;
