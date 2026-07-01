// Extract stage: GeckoTerminal new-pools (keyless) source client.
// Ported from agentjuno/robotmoney scripts/regime/fetchers/geckoterminal.js.
//
//   https://api.geckoterminal.com/api/v2/networks/new_pools?page=N
//
// The API only exposes the firehose ("latest N pools"), not historical daily
// counts. So this fetcher counts pools created in the trailing 24h and returns
// a SINGLE point {date: asof, value: count}. Unlike the original (which wrote a
// CSV floor itself), persistence is the orchestrator's job here: the append-only
// merge into raw_indicator_history accumulates the daily history.
//
// Caveat: paginates at most MAX_PAGES × ~20 pools, so the busiest days (Solana
// meme manias) under-count; relative intensity still ranks correctly, which is
// what the rolling-percentile classifier uses. NEW_TOKENS carries sign -1.
import type { Point } from "../types.ts";
import { isoDay } from "../transform/math.ts";
import { fetchJson } from "./http.ts";

const ENDPOINT = "https://api.geckoterminal.com/api/v2/networks/new_pools";
const MAX_PAGES = 10;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export const geckoTerminalUrl = (page: number) => `${ENDPOINT}?page=${page}`;

// Pure: count firehose entries whose pool_created_at falls within [now-window, now].
// Entries arrive newest-first, so we stop at the first entry older than the cutoff.
// Non-parseable timestamps are skipped (not a stop). Returns { count, stopped }
// where `stopped` means we hit an out-of-window entry (i.e. the window is fully
// covered — the count is not truncated by pagination limits).
export function countNewPools24h(
  entries: any[],
  now: number,
  windowMs = WINDOW_MS,
): { count: number; stopped: boolean } {
  const cutoff = now - windowMs;
  let count = 0;
  for (const e of entries) {
    const raw = e?.attributes?.pool_created_at;
    const created = raw ? Date.parse(raw) : NaN;
    if (!Number.isFinite(created)) continue;
    if (created < cutoff) return { count, stopped: true };
    count++;
  }
  return { count, stopped: false };
}

// Parse a new_pools page → its data[] entries. Throws when data is absent.
export function parseNewPoolsPage(j: unknown): any[] {
  const data = (j as any)?.data;
  if (!Array.isArray(data)) throw new Error("geckoterminal: missing data[]");
  return data;
}

export async function fetchGeckoTerminalNewPools(
  now = Date.now(),
  timeoutMs = 15000,
): Promise<Point[]> {
  let count = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let entries: any[];
    try {
      entries = parseNewPoolsPage(await fetchJson(geckoTerminalUrl(page), timeoutMs));
    } catch (e) {
      if (page === 1) throw e; // first page must succeed
      break;
    }
    if (entries.length === 0) break;
    const { count: c, stopped } = countNewPools24h(entries, now);
    count += c;
    if (stopped) break;
  }
  return [{ date: isoDay(now), value: count }];
}
