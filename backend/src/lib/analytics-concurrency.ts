// The analytics producer's concurrency cap and the semaphore that enforces it.
// A leaf (issue 1514): the api's analytics route and the producer's api client
// (analytics/api-client.ts) both import it, and the client must reach no
// database module.

/**
 * How many analytics-provider requests the api runs at once.
 *
 * WHY A CAP. Every /api/analytics route is the analytics producer's, and on 2026-09-25..28
 * a regime run sent many ledger writes at once. Each became a slow query on the
 * bloated ledger (issue 1035), together they held every connection of the api's
 * pool (PG_POOL_MAX, 10), and every public request waited past Bun's ~10 s idle
 * timeout: minutes of 502s on each run. With this cap the producer can hold at
 * most this many connections; the rest always serve the site. Excess producer
 * requests wait here, in line, instead of in the pool. The readiness probe is
 * exempt: it touches no data.
 *
 * THE CLIENT HOLDS THE SAME CAP (issue 1514). The producer fetches series
 * concurrently, so its acquisitions used to arrive at once and queue in the
 * api's limiter, on the request path, where the wait counted against the
 * request's 10 s deadline and the 5 s slow-request rule. analytics/api-client.ts
 * keeps at most this many requests in flight, so the line forms in the producer.
 */
export const ANALYTICS_CONCURRENCY = 2;

/** A counting semaphore: `acquire()` resolves to a release function, in FIFO order. */
export function createLimiter(limit: number): { acquire: () => Promise<() => void>; inFlight: () => number; waiting: () => number } {
  let active = 0;
  const queue: (() => void)[] = [];
  const release = () => {
    active--;
    const next = queue.shift();
    if (next) { active++; next(); }
  };
  return {
    acquire: () => new Promise<() => void>((resolve) => {
      const grant = () => { let done = false; resolve(() => { if (!done) { done = true; release(); } }); };
      if (active < limit) { active++; grant(); } else queue.push(grant);
    }),
    inFlight: () => active,
    waiting: () => queue.length,
  };
}
