// Slow-request logging for the api (issue 1060).
//
// On 2026-09-30 a request stalled for more than Bun's default 10 s limit, was cut off, and reached the reader as a 502
// from nginx. The api logged one line from Bun ("request timed out after 10 seconds") with no path and no duration, so
// nothing said WHAT stalled. This wraps the router and records, for any request that runs past a threshold, the
// method, path, duration, status and caller. A request that runs past the configured limit is logged as an error:
// Bun has already cut the client off by then, and the handler finishing later is the only record of how long it took.
//
// The path only: a query string can carry a search term or a cursor and is not needed to find a slow route.
//
// WHERE THE TIME WENT (issue 1514). At every production analytics run in October 2026 this line listed
// source-acquisitions requests of 6 to 9 s, and nothing said whether the time was queueing or database work. The line
// now splits it: limiter_wait_ms (a route's concurrency limiter: the analytics slots, the per-token pipeline gate),
// pool_wait_ms (waiting for a database pool permit) and handler_ms (the rest). The gates add their waits to a
// per-request accumulator (lib/request-waits.ts). scripts/release/analytics-load-check.ts parses this line.
import { API_IDLE_TIMEOUT_SECONDS, API_SLOW_REQUEST_MS } from "../config.ts";
import { withRequestWaits, type RequestWaits } from "../lib/request-waits.ts";

export interface RequestTimingOptions {
  slowMs?: number;
  limitMs?: number;
  now?: () => number;
  log?: { warn: (message: string) => void; error: (message: string) => void };
}

export async function withRequestTiming(
  req: Request,
  pathname: string,
  run: () => Promise<Response>,
  opts: RequestTimingOptions = {},
): Promise<Response> {
  const slowMs = opts.slowMs ?? API_SLOW_REQUEST_MS;
  const limitMs = opts.limitMs ?? API_IDLE_TIMEOUT_SECONDS * 1000;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? console;
  const started = now();
  const waits: RequestWaits = { limiterMs: 0, poolMs: 0 };
  let status: number | string = "threw";
  try {
    const res = await withRequestWaits(waits, run);
    status = res.status;
    return res;
  } finally {
    const ms = now() - started;
    if (ms >= slowMs) {
      const caller = (req.headers.get("user-agent") ?? "unknown").slice(0, 80);
      const limiter = Math.round(waits.limiterMs);
      const pool = Math.round(waits.poolMs);
      const handler = Math.max(0, Math.round(ms) - limiter - pool);
      const split = `limiter_wait_ms=${limiter} pool_wait_ms=${pool} handler_ms=${handler}`;
      const what = `${req.method} ${pathname} took ${(ms / 1000).toFixed(1)}s status=${status} ${split} ua=${caller}`;
      if (ms >= limitMs) log.error(`[api] request ran past the ${limitMs / 1000}s limit, so the client was cut off: ${what}`);
      else log.warn(`[api] slow request: ${what}`);
    }
  }
}
