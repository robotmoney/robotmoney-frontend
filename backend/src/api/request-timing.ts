// Slow-request logging for the api (issue 1060).
//
// On 2026-09-30 a request stalled for more than Bun's default 10 s limit, was cut off, and reached the reader as a 502
// from nginx. The api logged one line from Bun ("request timed out after 10 seconds") with no path and no duration, so
// nothing said WHAT stalled. This wraps the router and records, for any request that runs past a threshold, the
// method, path, duration, status and caller. A request that runs past the configured limit is logged as an error:
// Bun has already cut the client off by then, and the handler finishing later is the only record of how long it took.
//
// The path only: a query string can carry a search term or a cursor and is not needed to find a slow route.
import { API_IDLE_TIMEOUT_SECONDS, API_SLOW_REQUEST_MS } from "../config.ts";

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
  let status: number | string = "threw";
  try {
    const res = await run();
    status = res.status;
    return res;
  } finally {
    const ms = now() - started;
    if (ms >= slowMs) {
      const caller = (req.headers.get("user-agent") ?? "unknown").slice(0, 80);
      const what = `${req.method} ${pathname} took ${(ms / 1000).toFixed(1)}s status=${status} ua=${caller}`;
      if (ms >= limitMs) log.error(`[api] request ran past the ${limitMs / 1000}s limit, so the client was cut off: ${what}`);
      else log.warn(`[api] slow request: ${what}`);
    }
  }
}
