// A per-process sliding-window rate limiter keyed by client ip (issue #1095).
//
// Held in memory and reset on restart: it is abuse mitigation, not durable
// accounting. It is PER PROCESS on purpose and says so, because a second api
// replica would hold a second window and so double every client's allowance.
// One api replica runs today (docker-compose.yml); the day that changes, this
// moves behind a shared store, and routes/public-analytics.ts is its only caller.
//
// comments.ts and submissions.ts keep their own private copies of a
// 5-per-minute window. This one is the SHARED limiter for the public analytics
// routes: one instance, one budget per ip across all four of them, so a client
// cannot multiply its allowance by spreading requests over routes.

export interface RateLimitOutcome {
  limited: boolean;
  /** Whole seconds until the oldest request in the window ages out; 0 when not limited. */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string, now?: number): RateLimitOutcome;
  /** Forget every key. For tests. */
  reset(): void;
}

export function createRateLimiter(opts: { max: number; windowMs: number }): RateLimiter {
  const log = new Map<string, number[]>();
  let sweepCounter = 0;

  // Drop keys whose window has fully aged out, so the map cannot grow without
  // bound under many distinct ips. Cheap amortized sweep.
  function sweep(now: number): void {
    if (++sweepCounter < 500) return;
    sweepCounter = 0;
    const cutoff = now - opts.windowMs;
    for (const [k, ts] of log) {
      const recent = ts.filter((t) => t > cutoff);
      if (recent.length === 0) log.delete(k);
      else log.set(k, recent);
    }
  }

  return {
    check(key, now = Date.now()) {
      const cutoff = now - opts.windowMs;
      const recent = (log.get(key) ?? []).filter((t) => t > cutoff);
      if (recent.length >= opts.max) {
        log.set(key, recent);
        return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((recent[0]! + opts.windowMs - now) / 1000)) };
      }
      recent.push(now);
      log.set(key, recent);
      sweep(now);
      return { limited: false, retryAfterSeconds: 0 };
    },
    reset() {
      log.clear();
      sweepCounter = 0;
    },
  };
}
