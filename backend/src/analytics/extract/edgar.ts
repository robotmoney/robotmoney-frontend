// Extract stage: SEC EDGAR full-text-search (keyless) source client.
// Ported from agentjuno/robotmoney late-cycle-signals.js (fetchEdgarS4Monthly).
//
//   https://efts.sec.gov/LATEST/search-index?q=%22merger%22&forms=S-4&startdt=..&enddt=..
//
// Monthly count of S-4 filings (registration statement for mergers/exchange
// offers) → a free mechanical proxy for M&A deal flow (the late-cycle `mna`
// signal). FTS covers 2001+. SEC asks for a descriptive User-Agent and modest
// request rates; we send one request per month with retry/backoff. Each count is
// stamped on month-END so forward-fill aligns it to the month it describes
// without intra-month lookahead.
import type { Point } from "../types.ts";
import { fetchJson } from "./http.ts";

const UA = "robotmoney-research/1.0 (research@robotmoney.net)";

const PREFLIGHT_TIMEOUT_MS = 5000;
const PREFLIGHT_MAX_ATTEMPTS = 2;
const CIRCUIT_BREAKER_THRESHOLD = 3; // consecutive full-retry month misses → abort the sweep
const MAX_SWEEP_MS = 90_000; // aggregate wall-clock ceiling for the whole sweep

export const edgarUrl = (monthStart: string, monthEnd: string) =>
  `https://efts.sec.gov/LATEST/search-index?q=%22merger%22&forms=S-4&startdt=${monthStart}&enddt=${monthEnd}`;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Pure: enumerate [{monthStart, monthEnd}] (first/last calendar day) for every
// month overlapping [startIso, endIso].
export function enumerateMonths(startIso: string, endIso: string): { monthStart: string; monthEnd: string }[] {
  const out: { monthStart: string; monthEnd: string }[] = [];
  const start = new Date(startIso + "T00:00:00Z");
  const end = new Date(endIso + "T00:00:00Z");
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cur <= end) {
    const y = cur.getUTCFullYear();
    const m = cur.getUTCMonth();
    out.push({ monthStart: iso(new Date(Date.UTC(y, m, 1))), monthEnd: iso(new Date(Date.UTC(y, m + 1, 0))) });
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

// Pure: extract the hit count from an EDGAR FTS response ({ hits: { total: { value } } }).
// Returns null when absent/non-finite (a month the caller records as unrecovered).
export function parseEdgarCount(j: unknown): number | null {
  const v = (j as any)?.hits?.total?.value;
  return Number.isFinite(v) ? Number(v) : null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Injectable clock for deadline-aware retry loops — tests drive `now`/`sleep`
// deterministically (a fake-clock test never waits out a real backoff sleep);
// production omits this and gets the real wall clock.
export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
const REAL_CLOCK: Clock = { now: Date.now, sleep };

// One month's S-4 count with 4 attempts / exponential backoff. Retries 429/5xx;
// gives up (returns null) on other 4xx. Loud-logs the final failure.
//
// `deadlineAt` (issue #109) — an OPTIONAL absolute epoch-ms cutoff (same
// clock as `clock.now`) propagated by the incremental research refresh's
// hard deadline: checked before every attempt AND before/after every backoff
// sleep, and used to cap each request's own abort timeout to whatever
// budget remains. Once the deadline has passed, this returns null
// immediately — no further request, retry sleep, or parse is ever
// attempted. Omitted (the default), this behaves exactly as before
// (unbounded by any outer deadline) — every existing caller (the seed
// generator, the legacy full sweep) is unaffected. `clock` is likewise
// optional and defaults to the real wall clock; only fake-clock tests of
// this retry loop's OWN deadline handling supply one (the request's abort
// timer itself still uses a real setTimeout — there is no fake network I/O).
export async function fetchEdgarMonthCount(
  monthStart: string,
  monthEnd: string,
  timeoutMs = 15000,
  logger: { warn?: (m: string) => void } = console,
  maxAttempts = 4,
  deadlineAt?: number,
  clock: Clock = REAL_CLOCK,
): Promise<number | null> {
  const url = edgarUrl(monthStart, monthEnd);
  let lastErr = "unknown error";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (deadlineAt !== undefined && clock.now() >= deadlineAt) {
      lastErr = "hard deadline exceeded";
      break;
    }
    if (attempt > 0) {
      const backoff = 500 * 2 ** (attempt - 1);
      const budget = deadlineAt !== undefined ? deadlineAt - clock.now() : Infinity;
      if (budget <= 0) {
        lastErr = "hard deadline exceeded";
        break;
      }
      await clock.sleep(Math.min(backoff, budget));
      if (deadlineAt !== undefined && clock.now() >= deadlineAt) {
        lastErr = "hard deadline exceeded";
        break;
      }
    }
    const attemptTimeoutMs =
      deadlineAt !== undefined ? Math.max(0, Math.min(timeoutMs, deadlineAt - clock.now())) : timeoutMs;
    if (attemptTimeoutMs <= 0) {
      lastErr = "hard deadline exceeded";
      break;
    }
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), attemptTimeoutMs);
      let res: Response;
      try {
        res = await fetch(url, { signal: ac.signal, headers: { "user-agent": UA, accept: "application/json" } });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break; // non-retryable
        continue;
      }
      const count = parseEdgarCount(await res.json());
      if (count != null) return count;
      lastErr = "no count in response";
    } catch (e: any) {
      lastErr = String(e?.message ?? e);
    }
  }
  logger.warn?.(`[edgar] S-4 ${monthStart}: ${lastErr} (giving up after ${maxAttempts} tries)`);
  return null;
}

// Monthly S-4 counts across [startIso, endIso], stamped on each month-end.
// Unrecovered months are logged loudly and omitted (never silently zero-filled).
export async function fetchEdgarS4Monthly(
  startIso: string,
  endIso: string,
  timeoutMs = 15000,
  logger: { warn?: (m: string) => void } = console,
): Promise<Point[]> {
  const months = enumerateMonths(startIso, endIso);
  if (months.length === 0) return [];

  const out: Point[] = [];
  const missing: string[] = [];

  // Preflight: probe the most recent month first, with a short timeout and a
  // small attempt budget. If EDGAR is unreachable this fails fast instead of
  // grinding through the full sweep (each attempt eating up to `timeoutMs`).
  const last = months[months.length - 1]!;
  const probe = await fetchEdgarMonthCount(
    last.monthStart,
    last.monthEnd,
    PREFLIGHT_TIMEOUT_MS,
    { warn: () => {} },
    PREFLIGHT_MAX_ATTEMPTS,
  );
  if (probe == null) {
    logger.warn?.(`[edgar] S-4: preflight probe failed — EDGAR unreachable, skipping ${months.length}-month sweep`);
    return [];
  }
  out.push({ date: last.monthEnd, value: probe });

  const deadline = Date.now() + MAX_SWEEP_MS;
  const remaining = months.slice(0, -1);
  let consecutiveMisses = 0;
  for (let i = 0; i < remaining.length; i++) {
    const { monthStart, monthEnd } = remaining[i]!;
    if (Date.now() > deadline) {
      logger.warn?.(`[edgar] S-4: aggregate wall-clock ceiling (${MAX_SWEEP_MS}ms) exceeded — skipping ${remaining.length - i} remaining month(s)`);
      break;
    }
    const count = await fetchEdgarMonthCount(monthStart, monthEnd, timeoutMs, logger);
    if (count != null) {
      out.push({ date: monthEnd, value: count });
      consecutiveMisses = 0;
    } else {
      missing.push(monthStart);
      consecutiveMisses++;
      if (consecutiveMisses >= CIRCUIT_BREAKER_THRESHOLD) {
        const skipped = remaining.length - i - 1;
        logger.warn?.(
          `[edgar] S-4: aborting after ${consecutiveMisses} consecutive unrecovered months — likely no network access, ${skipped} month(s) skipped`,
        );
        break;
      }
    }
    await sleep(250);
  }
  if (missing.length > 0) logger.warn?.(`[edgar] S-4: ${missing.length} months unrecovered: ${missing.join(", ")}`);
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}
