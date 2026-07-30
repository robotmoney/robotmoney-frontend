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
//
// THROTTLE HONESTY (#135, evidence from #101): on the LIVE path GeckoTerminal
// 429s this keyless firehose under load, and an unbounded throttled leg
// stretches analytics.run past the swarm lifecycle deadlines. The sweep is
// therefore bounded the same way EDGAR (#103) and the Base RPC transport (#119)
// are: per-page retries honor `Retry-After` (else exponential backoff), every
// wait is clamped to the remaining aggregate wall-clock budget, and when the
// budget/attempts are exhausted the leg THROWS loudly — sources.ts fetchAll
// records the failure (logger.error + "x EMPTY" summary) and the orchestrator
// degrades to the last-persisted NEW_TOKENS floor. Never a silent skip, never a
// fabricated count.
import type { Point } from "../types.ts";
import { isoDay } from "../transform/math.ts";
import { UA } from "./http.ts";
import { withFetchCache } from "./fetch-cache.ts";

const ENDPOINT = "https://api.geckoterminal.com/api/v2/networks/new_pools";
const MAX_PAGES = 10;
const WINDOW_MS = 24 * 60 * 60 * 1000;

// Bounded-throttle knobs (mirroring edgar.ts + base-rpc-client.ts conventions).
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const MAX_SWEEP_MS = 45_000; // aggregate wall-clock budget for the whole paginated sweep
const MAX_ATTEMPTS_PER_PAGE = 5; // 1 try + up to 4 retries per page
const RETRY_BASE_MS = 1_000; // exponential fallback when no Retry-After is sent
const MAX_BACKOFF_MS = 15_000; // single-wait ceiling: a hostile/huge Retry-After can't stall the run

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

type WarnLogger = { warn?: (m: string) => void };

// Injectable knobs so the resilience tests are deterministic (no real waits,
// no live network); production callers (sources.ts) pass nothing.
export interface GeckoTerminalFetchOptions {
  budgetMs?: number; // aggregate sweep budget (default MAX_SWEEP_MS)
  logger?: WarnLogger;
  sleep?: Sleep;
}

export const geckoTerminalUrl = (page: number) => `${ENDPOINT}?page=${page}`;

// Pure: the wait before the Nth retry (1-based) of a throttled page. Honors
// `Retry-After` (RFC 7231 delta-seconds or HTTP-date) when present, else
// exponential backoff (base × 2^(n-1)); either way clamped to MAX_BACKOFF_MS.
// Returns null when the wait would overrun `remainingMs` (the sweep budget) —
// the caller must give up loudly instead of sleeping past its deadline.
export function throttleWaitMs(
  attempt: number,
  retryAfterHeader: string | null,
  remainingMs: number,
  now = Date.now(),
): number | null {
  let wait: number | null = null;
  if (retryAfterHeader) {
    const secs = Number(retryAfterHeader);
    if (Number.isFinite(secs)) wait = Math.max(0, secs * 1000);
    else {
      const when = Date.parse(retryAfterHeader);
      if (!Number.isNaN(when)) wait = Math.max(0, when - now);
    }
  }
  if (wait === null) wait = RETRY_BASE_MS * 2 ** (attempt - 1);
  wait = Math.min(wait, MAX_BACKOFF_MS);
  return wait <= remainingMs ? wait : null;
}

// One new_pools page with bounded 429/5xx retries inside the sweep deadline.
// Non-transient statuses throw immediately (no retry). Wrapped in the opt-in
// fetch-cache so warm demo boots reuse the cached body (http.ts conventions).
async function fetchNewPoolsPage(
  page: number,
  deadline: number,
  timeoutMs: number,
  logger: WarnLogger,
  sleep: Sleep,
): Promise<unknown> {
  const url = geckoTerminalUrl(page);
  return withFetchCache("json", url, async () => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_PAGE; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `geckoterminal: sweep budget exhausted before page ${page} attempt ${attempt} — degrading to last-persisted NEW_TOKENS`,
        );
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), Math.min(timeoutMs, remaining));
      let res: Response;
      try {
        res = await fetch(url, {
          signal: ac.signal,
          headers: { "user-agent": UA, accept: "application/json" },
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) return await res.json();
      if (!TRANSIENT_STATUSES.has(res.status)) throw new Error(`${res.status} ${res.statusText} for ${url}`);
      const wait =
        attempt < MAX_ATTEMPTS_PER_PAGE
          ? throttleWaitMs(attempt, res.headers.get("retry-after"), deadline - Date.now())
          : null;
      if (wait === null) {
        throw new Error(
          `geckoterminal: still throttled (HTTP ${res.status}) at page ${page} after ${attempt} attempt(s) — ` +
            `retry budget exhausted, degrading to last-persisted NEW_TOKENS`,
        );
      }
      logger.warn?.(
        `[geckoterminal] new_pools page ${page}: HTTP ${res.status} — retrying in ${wait}ms (attempt ${attempt}/${MAX_ATTEMPTS_PER_PAGE})`,
      );
      await sleep(wait);
    }
    throw new Error(`geckoterminal: page ${page} unrecovered after ${MAX_ATTEMPTS_PER_PAGE} attempts`);
  });
}

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
  opts: GeckoTerminalFetchOptions = {},
): Promise<Point[]> {
  const logger = opts.logger ?? console;
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = Date.now() + (opts.budgetMs ?? MAX_SWEEP_MS);
  let count = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let entries: any[];
    try {
      entries = parseNewPoolsPage(await fetchNewPoolsPage(page, deadline, timeoutMs, logger, sleep));
    } catch (e: any) {
      // First page must succeed: with no data at all the leg throws so the
      // caller (sources.ts fetchAll) records the failure and the orchestrator
      // falls back to the last-persisted NEW_TOKENS floor — never a zero count.
      if (page === 1) throw e;
      // Deeper pages only widen 24h-window coverage; a loss there is the same
      // documented truncation as the MAX_PAGES cap — logged, partial count kept.
      logger.warn?.(
        `[geckoterminal] new_pools page ${page} failed (${e?.message ?? e}) — partial 24h count from ${page - 1} page(s)`,
      );
      break;
    }
    if (entries.length === 0) break;
    const { count: c, stopped } = countNewPools24h(entries, now);
    count += c;
    if (stopped) break;
  }
  return [{ date: isoDay(now), value: count }];
}
