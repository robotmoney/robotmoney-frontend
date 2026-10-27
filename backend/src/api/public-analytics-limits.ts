// Server load protection for /api/public/analytics/ (issue 1422). Public
// traffic must never starve the site, so every public analytics route, archive
// routes included, passes three budgets:
//
//   1. A CONCURRENCY GATE. At most PUBLIC_ANALYTICS_MAX_CONCURRENT_QUERIES (2)
//      public queries hold a database connection at once, process-wide. A
//      request that finds no free slot is refused at once with 503 and
//      Retry-After: it never queues behind the pool, so public traffic holds at
//      most 2 of the request pool's connections and every other route keeps the
//      rest. Work already admitted (the pages of an archive body, a backup's
//      background build) waits for a slot instead, bounded by `waitMs`.
//   2. A WEIGHTED TOKEN BUDGET per client ip: 100 tokens in any sliding
//      minute. A list request costs 1, a heavy one (an archive body, a report's
//      bytes) costs 10. Out of tokens: 429 with Retry-After.
//   3. A BYTE BUDGET per client ip: 50 MB in any sliding minute. A request is
//      admitted while the client has any budget left. Bytes are charged
//      after the fact as actually transmitted (the encoded body), except an
//      archive, which is charged in full on admission: its size is known from
//      its record, and an archive is never re-chunked to fit the budget. So the
//      budget may go negative, and later requests answer 429 with Retry-After
//      until it recovers.
//
// All of it lives in this process's memory and resets on restart: it is abuse
// mitigation, not accounting. One api replica runs today (docker-compose.yml);
// a second would double every client's allowance (D58 says the same of the
// limiter this replaces).
import {
  PUBLIC_ANALYTICS_BYTES_PER_MINUTE,
  PUBLIC_ANALYTICS_MAX_CONCURRENT_QUERIES,
  PUBLIC_ANALYTICS_TOKENS_PER_MINUTE,
} from "@robotmoney/contract";
import type { TransactionSql } from "postgres";
import { sql } from "../db/client.ts";
import { onStatement, registerStatement } from "../db/registry.ts";
import { DEFAULT_MAX_KEYS } from "./rate-limit.ts";

const MINUTE_MS = 60_000;

/** The gate is full: answer 503 with Retry-After. */
export class PublicBusyError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("public analytics is at its concurrent query limit");
  }
}

export interface QueryGate {
  /** Take a slot now or throw PublicBusyError. With `waitMs`, wait that long for one first. */
  acquire(waitMs?: number): Promise<() => void>;
  /** Slots held right now. */
  inUse(): number;
}

export function createQueryGate(slots: number = PUBLIC_ANALYTICS_MAX_CONCURRENT_QUERIES): QueryGate {
  let held = 0;
  const waiters: (() => void)[] = [];
  const release = (): void => {
    held -= 1;
    const next = waiters.shift();
    if (next) next();
  };
  const once = (): (() => void) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      release();
    };
  };
  return {
    async acquire(waitMs = 0) {
      if (held < slots) {
        held += 1;
        return once();
      }
      if (waitMs <= 0) throw new PublicBusyError(1);
      return new Promise<() => void>((resolve, reject) => {
        const grant = (): void => {
          clearTimeout(timer);
          held += 1;
          resolve(once());
        };
        const timer = setTimeout(() => {
          const i = waiters.indexOf(grant);
          if (i >= 0) waiters.splice(i, 1);
          reject(new PublicBusyError(1));
        }, waitMs);
        waiters.push(grant);
      });
    },
    inUse: () => held,
  };
}

export interface BudgetVerdict {
  admitted: boolean;
  /** Whole seconds until the request would be admitted; 0 when admitted. */
  retryAfterSeconds: number;
  /** Which budget refused it. */
  reason: "tokens" | "bytes" | null;
}

export interface ClientBudgets {
  /** Admit a request of `cost` tokens, or refuse it with a Retry-After. Takes the tokens when admitted. */
  admit(key: string, cost: number, now?: number): BudgetVerdict;
  /** Charge bytes actually served (or, for an archive, its full size). May drive the budget negative. */
  chargeBytes(key: string, bytes: number, now?: number): void;
  /** Tokens and bytes left for a client, for tests and diagnostics. */
  peek(key: string, now?: number): { tokens: number; bytes: number };
  reset(): void;
}

interface Window {
  /** (time, cost) of each admitted request in the last minute, oldest first. */
  tokens: [number, number][];
  /** (time, bytes) of each charge in the last minute, oldest first. */
  bytes: [number, number][];
}

const sum = (xs: [number, number][]): number => xs.reduce((n, [, v]) => n + v, 0);

/**
 * Sliding one-minute windows per client ip: a request is admitted when the
 * tokens spent in the last minute plus its cost fit in the budget, and while
 * the bytes charged in the last minute are below the byte budget. A sliding
 * window, not a refilling bucket, so "100 a minute" means exactly that: the
 * 101st list request inside any minute is refused.
 */
export function createClientBudgets(opts: { tokensPerMinute?: number; bytesPerMinute?: number; maxKeys?: number } = {}): ClientBudgets {
  const tokenCap = opts.tokensPerMinute ?? PUBLIC_ANALYTICS_TOKENS_PER_MINUTE;
  const byteCap = opts.bytesPerMinute ?? PUBLIC_ANALYTICS_BYTES_PER_MINUTE;
  const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  // Insertion order is recency order (every touch deletes and re-sets), so the
  // first key is the least recently seen; evicting it hands that ip a fresh
  // window, the safe direction: the cap bounds memory, not the limit.
  const windows = new Map<string, Window>();

  function load(key: string, now: number): Window {
    const w = windows.get(key) ?? { tokens: [], bytes: [] };
    const cutoff = now - MINUTE_MS;
    while (w.tokens.length && w.tokens[0]![0] <= cutoff) w.tokens.shift();
    while (w.bytes.length && w.bytes[0]![0] <= cutoff) w.bytes.shift();
    windows.delete(key);
    while (windows.size >= maxKeys) {
      const oldest = windows.keys().next();
      if (oldest.done) break;
      windows.delete(oldest.value);
    }
    windows.set(key, w);
    return w;
  }

  /** Seconds until enough of `entries` ages out that their sum drops to `target` or below. */
  function waitFor(entries: [number, number][], target: number, now: number): number {
    let left = sum(entries);
    for (const [at, v] of entries) {
      left -= v;
      if (left <= target) return Math.max(1, Math.ceil((at + MINUTE_MS - now) / 1000));
    }
    return 1;
  }

  return {
    admit(key, cost, now = Date.now()) {
      const w = load(key, now);
      if (sum(w.bytes) >= byteCap) {
        return { admitted: false, reason: "bytes", retryAfterSeconds: waitFor(w.bytes, byteCap - 1, now) };
      }
      if (sum(w.tokens) + cost > tokenCap) {
        return { admitted: false, reason: "tokens", retryAfterSeconds: waitFor(w.tokens, tokenCap - cost, now) };
      }
      w.tokens.push([now, cost]);
      return { admitted: true, reason: null, retryAfterSeconds: 0 };
    },
    chargeBytes(key, bytes, now = Date.now()) {
      if (!(bytes > 0)) return;
      load(key, now).bytes.push([now, bytes]);
    },
    peek(key, now = Date.now()) {
      const w = load(key, now);
      return { tokens: tokenCap - sum(w.tokens), bytes: byteCap - sum(w.bytes) };
    },
    reset() {
      windows.clear();
    },
  };
}

// ── One public read ─────────────────────────────────────────────────────────
// Every public analytics statement runs inside publicRead: a slot of the gate
// above, one READ ONLY transaction on one connection, and the session settings
// of §4.8 (a 5 s statement timeout, UTC timestamps). A statement that runs past
// the timeout is cancelled by Postgres (57014), its transaction ends and its
// connection returns to the pool; the route answers 503 with Retry-After.

const ROUTE = "src/api/routes/public-analytics";

const publicReadSession = registerStatement({
  role: "rm_app",
  shape: "publicReadSession",
  site: "src/api/public-analytics-limits:publicRead",
  purpose: "Set the public analytics read's 5 s statement timeout and UTC time zone for its transaction (issue 1422).",
  callers: [ROUTE],
});

/** The process-wide gate every public analytics read passes. */
export const publicQueryGate: QueryGate = createQueryGate();

/**
 * Run `fn` as one public read. `waitMs` 0 (a new request) refuses at once with
 * PublicBusyError when the gate is full; work already admitted passes a wait.
 */
export async function publicRead<T>(fn: (tx: TransactionSql<{}>) => Promise<T>, waitMs = 0): Promise<T> {
  const release = await publicQueryGate.acquire(waitMs);
  try {
    return (await sql.begin("read only", async (tx) => {
      await onStatement(tx, publicReadSession)`SELECT set_config('statement_timeout', '5000', true), set_config('TimeZone', 'UTC', true)`;
      return fn(tx);
    })) as T;
  } finally {
    release();
  }
}
