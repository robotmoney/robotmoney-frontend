// In-process concurrency primitives for the host swarm driver.
//
// WHY THEY EXIST. The driver used to run one session at a time, so nothing in
// it ever had to share. Concurrent sessions (scripts/lib/smoke-schedule.ts
// SmokeCadence.maxConcurrentSessions) meet two resources that are NOT safe to
// use twice at once, and both are fixed here in shared code — the same code
// runs with a cap of one in production, where it simply never contends:
//
//   - a member's persistent HOME volume. Every container a member runs
//     (enroll or participate) mounts it read-write, and the member client
//     writes its token and identity files there non-atomically. Two sessions
//     running the same member at once would race those writes. KeyedMutex
//     serializes a member's containers (swarm/agent.ts), which also bounds the
//     driver's member containers to the roster size.
//   - the analytics-producer's regime run for one as-of date. regime-store
//     upserts without a transaction, so two same-date runs race. InFlightMemo
//     lets concurrent sessions share the run already in flight
//     (swarm/session.ts classifyRegimeShared).
//
// Both are PURE of I/O and dependency-free so the required per-PR `unit` job
// executes them directly (scripts/tests/unit/swarm-concurrency.test.ts).

/**
 * A FIFO mutex per key. `run(key, fn)` waits for every earlier holder of
 * `key` to finish, runs `fn`, then hands the key to the next waiter. Keys are
 * independent: different keys never wait on each other. A holder that throws
 * still releases the key.
 */
export class KeyedMutex {
  // The tail of each key's queue: resolves when the LAST queued holder is done.
  // Tails only ever resolve (they are release signals, never results), so a
  // failing holder cannot poison the waiters behind it.
  private readonly tails = new Map<string, Promise<void>>();

  /** True while `key` is held or has waiters — i.e. `run(key, …)` would wait. */
  isHeld(key: string): boolean {
    return this.tails.has(key);
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => released);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      // Only the LAST holder clears the entry; an earlier one leaving would
      // make isHeld() lie to the waiters still queued behind it.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/**
 * Coalesce concurrent calls per key onto ONE in-flight promise. It is not a
 * cache: once the run settles the key is forgotten, so the next call runs
 * again. That keeps a one-session-at-a-time driver exactly as it was (every
 * session still triggers its own run) while concurrent sessions for the same
 * key share one. Every joined caller sees the same result or the same error.
 */
export class InFlightMemo<T> {
  private readonly inflight = new Map<string, Promise<T>>();

  isInFlight(key: string): boolean {
    return this.inflight.has(key);
  }

  run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    // Async wrapper so a synchronous throw inside `fn` still lands in the
    // promise (and still clears the key) instead of escaping past it.
    const running: Promise<T> = (async () => fn())().finally(() => {
      if (this.inflight.get(key) === running) this.inflight.delete(key);
    });
    this.inflight.set(key, running);
    return running;
  }
}
