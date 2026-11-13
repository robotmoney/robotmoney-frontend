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

// ── The answer store (issue 1629) ───────────────────────────────────────────
// The api keeps its own public analytics answers in process
// (docs/technical/web-serving-architecture.md §3.4); website-server stores no
// api response. The store is keyed by request URL and holds an answer for the
// max-age its route set, never longer. An answer whose Cache-Control has no
// max-age, or says no-store or private, is never stored: errors and refusals
// carry no-store. Identical cold requests that arrive together share one
// computation, so twenty of them run one database query and take one gate
// slot. The store is bounded by bytes and evicts the least recently used
// entry first. It lives in this process's memory, so it is empty after every
// api start and no answer outlives the code that computed it.

/** The store's cap: the bytes of every stored body, key and header together. */
export const PUBLIC_ANALYTICS_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/** An answer before it meets a request: status, headers and the identity body. */
export interface CachedAnswer {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface AnswerLookup {
  answer: CachedAnswer;
  /** True when the answer came from the store, with no computation. */
  hit: boolean;
  /** Whole seconds the answer has been stored; 0 on a miss. */
  age: number;
}

export interface AnswerCache {
  /** The stored answer for `key`, else the result of `compute` (shared with every identical request in flight). */
  get(key: string, compute: () => Promise<CachedAnswer>): Promise<AnswerLookup>;
  /** Bytes held now. */
  bytes(): number;
  /** Entries held now. */
  size(): number;
  /** Forget every entry and every request in flight. */
  clear(): void;
}

/** Seconds a 200 answer may be stored, or null when it may not be stored at all. */
export function storableSeconds(answer: CachedAnswer): number | null {
  if (answer.status !== 200) return null;
  const cc = (answer.headers["Cache-Control"] ?? "").toLowerCase();
  if (/(^|,)\s*(no-store|private|no-cache)\s*(,|$)/.test(cc)) return null;
  const m = /(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/.exec(cc);
  if (!m) return null;
  const seconds = Number(m[1]);
  return seconds > 0 ? seconds : null;
}

function costOfEntry(key: string, a: CachedAnswer): number {
  let n = key.length + a.body.byteLength;
  for (const [k, v] of Object.entries(a.headers)) n += k.length + v.length;
  return n;
}

interface StoredAnswer {
  answer: CachedAnswer;
  storedAt: number;
  expiresAt: number;
  cost: number;
}

export function createAnswerCache(opts: { maxBytes?: number; now?: () => number } = {}): AnswerCache {
  const maxBytes = opts.maxBytes ?? PUBLIC_ANALYTICS_CACHE_MAX_BYTES;
  const now = opts.now ?? Date.now;
  // Insertion order is recency order (a hit deletes and re-sets), so the first key is the least recently used.
  const entries = new Map<string, StoredAnswer>();
  const inFlight = new Map<string, Promise<CachedAnswer>>();
  let held = 0;
  // A clear() while a computation runs must not let that computation store its answer afterwards.
  let generation = 0;

  const drop = (key: string): void => {
    const e = entries.get(key);
    if (!e) return;
    entries.delete(key);
    held -= e.cost;
  };

  const store = (key: string, answer: CachedAnswer): void => {
    const seconds = storableSeconds(answer);
    if (seconds === null) return;
    const cost = costOfEntry(key, answer);
    if (cost > maxBytes) return;
    drop(key);
    while (held + cost > maxBytes) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      drop(oldest.value);
    }
    const at = now();
    entries.set(key, { answer, storedAt: at, expiresAt: at + seconds * 1000, cost });
    held += cost;
  };

  return {
    async get(key, compute) {
      const e = entries.get(key);
      if (e) {
        const at = now();
        if (at < e.expiresAt) {
          entries.delete(key);
          entries.set(key, e);
          return { answer: e.answer, hit: true, age: Math.floor((at - e.storedAt) / 1000) };
        }
        drop(key);
      }
      let pending = inFlight.get(key);
      if (!pending) {
        const gen = generation;
        pending = compute();
        inFlight.set(key, pending);
        const settle = (): void => {
          if (inFlight.get(key) === pending) inFlight.delete(key);
        };
        pending.then(
          (answer) => {
            settle();
            if (gen === generation) store(key, answer);
          },
          settle,
        );
      }
      return { answer: await pending, hit: false, age: 0 };
    },
    bytes: () => held,
    size: () => entries.size,
    clear() {
      entries.clear();
      inFlight.clear();
      held = 0;
      generation += 1;
    },
  };
}
