// Extract stage: Coinmetrics community API (keyless) source client.
// Ported from agentjuno/robotmoney scripts/regime/fetchers/coinmetrics.js.
//
//   https://community-api.coinmetrics.io/v4/timeseries/asset-metrics
//     ?assets=<asset>&metrics=<metric>&start_time=YYYY-MM-DD&page_size=10000
//
// Response is paginated; we follow next_page_token until exhausted. Used for
// ETH_ACTIVE (asset=eth, metric=AdrActCnt).
import type { Point } from "../types.ts";
import { fetchJson } from "./http.ts";

const BASE = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics";

export const coinmetricsUrl = (asset: string, metric: string, startDate: string) =>
  `${BASE}?assets=${encodeURIComponent(asset)}&metrics=${encodeURIComponent(
    metric,
  )}&start_time=${startDate}&page_size=10000&pretty=false`;

// Parse one Coinmetrics page for `metric`. { data: [{ time, <metric> }, ...] }.
// Rows with a non-finite metric value are dropped. Returns points + the (raw)
// next_page_token so the fetcher can page. Throws when `data` is absent.
export function parseCoinmetricsPage(
  j: unknown,
  metric: string,
): { points: Point[]; nextToken: string | null } {
  const data = (j as any)?.data;
  if (!Array.isArray(data)) throw new Error("coinmetrics: missing data[]");
  const points: Point[] = [];
  for (const row of data) {
    const v = parseFloat(row[metric]);
    if (!Number.isFinite(v)) continue;
    points.push({ date: String(row.time).slice(0, 10), value: v });
  }
  return { points, nextToken: (j as any)?.next_page_token ?? null };
}

export async function fetchCoinmetrics(
  asset: string,
  metric: string,
  startDate = "2018-01-01",
  timeoutMs = 15000,
): Promise<Point[]> {
  const out: Point[] = [];
  let url = coinmetricsUrl(asset, metric, startDate);
  for (let i = 0; i < 50; i++) {
    const j = await fetchJson(url, timeoutMs);
    const { points, nextToken } = parseCoinmetricsPage(j, metric);
    out.push(...points);
    if (!nextToken) break;
    // Per Coinmetrics docs: once next_page_token is present, use it standalone.
    url = `${BASE}?next_page_token=${encodeURIComponent(nextToken)}&pretty=false`;
  }
  return out;
}
