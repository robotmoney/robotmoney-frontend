// Where a request's time went: in a route's concurrency limiter, or waiting for
// a database pool permit (issue 1514).
//
// The slow-request line (api/request-timing.ts) used to say only how long a
// request took. At every production analytics run in October 2026 it listed
// source-acquisitions requests of 6 to 9 s, and nothing said whether that time
// was spent in the analytics limiter's line, waiting for a batch connection, or
// in the database. The waits are added here as they happen, per request, and
// the slow line reports them with the rest as handler time.
//
// One accumulator per request, carried by AsyncLocalStorage, so the gates that
// add to it (the analytics limiter, the per-token pipeline gate, the pool
// gates) need no handle on the request. Outside a request nothing is recorded.
// Waits that overlap inside one request (statements run in parallel) are summed.
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestWaits {
  /** Time spent in a route's concurrency limiter (analytics slots, the per-token pipeline gate). */
  limiterMs: number;
  /** Time spent waiting for a database pool permit (pool-gate.ts). */
  poolMs: number;
}

const current = new AsyncLocalStorage<RequestWaits>();

/** Run `fn` with a fresh accumulator; `waits` is the object the gates add to. */
export function withRequestWaits<T>(waits: RequestWaits, fn: () => T): T {
  return current.run(waits, fn);
}

/**
 * The accumulator of the request running now, or undefined outside a request.
 * A gate reads it when it starts to wait, because the grant may arrive on
 * another request's release.
 */
export function requestWaits(): RequestWaits | undefined {
  return current.getStore();
}
