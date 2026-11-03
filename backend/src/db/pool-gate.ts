// The admission gate in front of one postgres.js pool (issue 1034).
//
// WHY. postgres.js queues a query without limit when every connection is busy.
// On 2026-09-30 that queue is what turned a few slow statements into minutes of
// 502s: each request waited behind the busy connections until Bun's 10 s
// request deadline killed it, at ~1 % CPU. The gate makes the wait bounded and
// the refusal explicit: a query either gets a connection within `waitMs` or is
// refused with DbSaturatedError, which api/index.ts answers as
// `503 db_saturated` with Retry-After, at once.
//
// HOW. One permit per pool connection. A query holds a permit from the moment
// postgres.js would hand it to the pool until it settles; a transaction
// (`begin`) and a reserved connection (`reserve`) hold one for their whole
// life, and the statements inside them run on the connection they already
// hold, so they are not counted twice. postgres.js never queues internally,
// because the gate never lets more queries through than it has connections.
//
// A Query is lazy: it reaches the pool only when awaited, through its own
// `handler` property. The gated pool swaps that property on every Query it
// creates, so a fragment that is only ever interpolated into another statement
// is never gated, and an executed query waits for its permit first.
import type postgresTypes from "postgres";
import { requestWaits } from "../lib/request-waits.ts";

/** A query refused because its pool had no free connection within the admission wait. */
export class DbSaturatedError extends Error {
  readonly code = "DB_SATURATED";
  constructor(readonly pool: string, readonly waitMs: number) {
    super(`database pool "${pool}" is saturated: no connection became free within ${waitMs}ms`);
    this.name = "DbSaturatedError";
  }
}

/** SQLSTATEs a server-side timeout raises: 57014 statement or user cancel, 55P03 lock_not_available. */
export const DB_TIMEOUT_CODES: ReadonlySet<string> = new Set(["57014", "55P03"]);

export interface PoolGateStats {
  readonly max: number;
  readonly in_use: number;
  readonly waiting: number;
  readonly admitted_total: number;
  readonly refused_total: number;
  readonly timeout_total: number;
}

export interface PoolGate {
  readonly name: string;
  /** Resolves to a release function once a permit is free, or rejects with DbSaturatedError after the wait. */
  acquire(): Promise<() => void>;
  /** Count one server-side timeout seen on this pool. */
  noteError(err: unknown): void;
  stats(): PoolGateStats;
}

/** A FIFO counting semaphore of `permits`, whose waiters give up after `waitMs`. */
export function createPoolGate(name: string, permits: number, waitMs: number): PoolGate {
  let active = 0;
  let admitted = 0;
  let refused = 0;
  let timeouts = 0;
  const queue: { grant: () => void; timer: ReturnType<typeof setTimeout> }[] = [];

  const release = () => {
    const next = queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.grant();
    } else {
      active--;
    }
  };
  const permit = () => {
    admitted++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      release();
    };
  };

  return {
    name,
    acquire: () =>
      new Promise<() => void>((resolve, reject) => {
        if (active < permits) {
          active++;
          resolve(permit());
          return;
        }
        const entry = {
          grant: () => resolve(permit()),
          timer: setTimeout(() => {
            const at = queue.indexOf(entry);
            if (at >= 0) queue.splice(at, 1);
            refused++;
            reject(new DbSaturatedError(name, waitMs));
          }, waitMs),
        };
        queue.push(entry);
      }),
    noteError: (err) => {
      const code = (err as { code?: unknown } | null)?.code;
      if (typeof code === "string" && DB_TIMEOUT_CODES.has(code)) timeouts++;
    },
    stats: () => ({
      max: permits,
      in_use: active,
      waiting: queue.length,
      admitted_total: admitted,
      refused_total: refused,
      timeout_total: timeouts,
    }),
  };
}

type AnyQuery = Promise<unknown> & {
  handler: (q: AnyQuery) => void;
  reject: (err: unknown) => void;
  handle: () => unknown;
  cursorFn?: unknown;
};

function isQuery(value: unknown): value is AnyQuery {
  return value instanceof Promise && typeof (value as Partial<AnyQuery>).handle === "function" && "handler" in value;
}

/**
 * `gate.acquire()`, with the time spent waiting added to the running request's
 * pool wait (issue 1514), so the slow-request line can say how much of a
 * request was spent waiting for a connection.
 */
function acquireTimed(gate: PoolGate): Promise<() => void> {
  const waits = requestWaits();
  if (!waits) return gate.acquire();
  const started = performance.now();
  const done = () => { waits.poolMs += performance.now() - started; };
  return gate.acquire().then(
    (release) => { done(); return release; },
    (err: unknown) => { done(); throw err; },
  );
}

/** Make `query` wait for a permit before it reaches the pool, and give the permit back when it settles. */
function gateQuery(query: AnyQuery, gate: PoolGate): AnyQuery {
  // A cursor never settles its own promise, so it could not give a permit
  // back. Nothing in the api reads through a cursor; one that does is
  // admitted ungated rather than leaking a permit.
  if (query.cursorFn) return query;
  const run = query.handler;
  query.handler = (q) => {
    acquireTimed(gate).then(
      (release) => {
        // Promise.prototype.then, not q.then: Query#then would re-enter handle().
        Promise.prototype.then.call(q, release, (err: unknown) => {
          gate.noteError(err);
          release();
        });
        run(q);
      },
      (err) => q.reject(err),
    );
  };
  return query;
}

/**
 * `raw` behind `gate`: every statement, transaction and reserved connection
 * takes a permit first. Everything else (`json`, `array`, `options`, `end`, …)
 * is `raw`'s own.
 */
export function gatedPool(raw: postgresTypes.Sql<{}>, gate: PoolGate): postgresTypes.Sql<{}> {
  const wrap = <T>(value: T): T => (isQuery(value) ? (gateQuery(value, gate) as T) : value);
  const unsafe = (...args: unknown[]) => wrap((raw.unsafe as (...a: unknown[]) => unknown)(...args));
  const file = (...args: unknown[]) => wrap((raw.file as (...a: unknown[]) => unknown)(...args));
  const begin = async (...args: unknown[]) => {
    const release = await acquireTimed(gate);
    try {
      return await (raw.begin as (...a: unknown[]) => Promise<unknown>)(...args);
    } catch (err) {
      gate.noteError(err);
      throw err;
    } finally {
      release();
    }
  };
  const reserve = async () => {
    const release = await acquireTimed(gate);
    let reserved: postgresTypes.ReservedSql<{}>;
    try {
      reserved = await raw.reserve();
    } catch (err) {
      release();
      throw err;
    }
    const giveBack = reserved.release.bind(reserved);
    reserved.release = () => {
      giveBack();
      release();
    };
    return reserved;
  };
  const own: Record<PropertyKey, unknown> = { unsafe, file, begin, reserve };
  return new Proxy(raw, {
    apply: (target, thisArg, args) => wrap(Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args)),
    get: (target, prop, receiver) => (Object.hasOwn(own, prop) ? own[prop] : Reflect.get(target, prop, receiver)),
  });
}
