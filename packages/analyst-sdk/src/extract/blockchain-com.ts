// Extract stage: blockchain.com charts API (keyless) source client.
// Ported from agentjuno/robotmoney scripts/regime/fetchers/blockchain_com.js.
//
//   https://api.blockchain.info/charts/<chart>?timespan=all&format=json&sampled=false
//
// We use `n-unique-addresses` (BTC daily active addresses → BTC_ACTIVE) only.
// The `mvrv` chart was removed upstream (HTTP 404) — BTC_MVRV now comes from
// Coinmetrics (btc/CapMVRVCur, see coinmetrics.ts / #127). timespan=all returns
// the full ~2009+ series; append-only merge preserves everything accumulated,
// so we always request the full window.
import type { Point } from "../types.ts";
import { isoDay } from "../transform/math.ts";
import { fetchJson } from "./http.ts";

export const blockchainComUrl = (chart: string, timespan = "all") =>
  `https://api.blockchain.info/charts/${chart}?timespan=${timespan}&format=json&sampled=false`;

// blockchain.com charts payload: { values: [{ x: unixSeconds, y: value }, ...] }.
export function parseBlockchainChart(j: unknown): Point[] {
  const values = (j as any)?.values;
  if (!Array.isArray(values)) throw new Error("blockchain.com: missing values[]");
  return values
    .map((p: any) => ({ date: isoDay(Number(p.x) * 1000), value: p.y }))
    .filter((p) => Number.isFinite(p.value));
}

export async function fetchBlockchainComChart(
  chart: string,
  timespan = "all",
  timeoutMs = 15000,
): Promise<Point[]> {
  return parseBlockchainChart(await fetchJson(blockchainComUrl(chart, timespan), timeoutMs));
}
