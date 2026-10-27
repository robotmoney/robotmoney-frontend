// Extract stage: DefiLlama yields (keyless) source client, for lending supply
// rates (issue 1398). Pure parser plus the endpoint URL and an async fetcher.
//
//   https://yields.llama.fi/chart/<pool uuid>
//   -> {"status":"success","data":[{"timestamp":"2024-03-10T23:01:20.944Z","apy":..,"apyBase":..,"apyReward":..,..}]}
//
// The value is `apyBase`: the supply APY without reward emissions, in percent
// per year. A row whose apyBase is null or not finite is dropped, never filled
// from `apy` (that would serve rewards as supply rate, a silent proxy). The date
// is the UTC day of the timestamp; a repeated day keeps the last row.
import type { Point } from "../types.ts";
import { fetchJson } from "./http.ts";

export const llamaYieldChartUrl = (poolId: string) => `https://yields.llama.fi/chart/${encodeURIComponent(poolId)}`;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T/;

export function parseLlamaYieldChart(j: unknown, poolId: string): Point[] {
  const o = j as { status?: unknown; data?: unknown } | null;
  if (!o || typeof o !== "object" || o.status !== "success" || !Array.isArray(o.data)) {
    throw new Error(`defillama-yields ${poolId}: response is not a yield chart`);
  }
  const byDay = new Map<string, number>();
  for (const row of o.data as any[]) {
    const ts = row?.timestamp;
    if (typeof ts !== "string" || !ISO_INSTANT.test(ts) || Number.isNaN(Date.parse(ts))) {
      throw new Error(`defillama-yields ${poolId}: row timestamp ${JSON.stringify(ts)} is not an ISO instant`);
    }
    const v = row.apyBase;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    byDay.set(new Date(ts).toISOString().slice(0, 10), v);
  }
  return [...byDay].map(([date, value]) => ({ date, value })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export async function fetchLlamaYield(poolId: string, timeoutMs = 15000): Promise<Point[]> {
  return parseLlamaYieldChart(await fetchJson(llamaYieldChartUrl(poolId), timeoutMs), poolId);
}
