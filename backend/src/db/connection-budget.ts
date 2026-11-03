// How many connections the api may open, and how it splits them (issue 1034).
//
// The api is the database's main client, and it used to open a fixed pool of
// PG_POOL_MAX (10) whatever the instance allowed. Nothing compared that number
// with the server's max_connections, so an override or a smaller managed plan
// could ask for more connections than exist, and the refusals arrived as
// errors on live requests. The budget is read from the server at boot instead:
//
//   available = max_connections − superuser_reserved_connections
//               − reserved_connections − headroom
//
// `headroom` is what the api leaves for every other client: a migration, a
// backup, an operator's psql, and any service that still holds its own pool.
// The api's three shares must fit in what is left:
//
//   - guard:   one connection for the /health probe, so health never waits
//              on a saturated pool;
//   - request: public, member and admin routes, with timeouts below Bun's
//              10 s request deadline;
//   - batch:   analytics-provider and pipeline bulk work, with the long
//              timeouts a bulk write needs.
//
// A share the operator sets explicitly is honoured or the boot is refused: an
// override that does not fit names the budget and each share and exits
// non-zero, before a port is bound. A share left unset is derived from what is
// left, up to its default.
//
// THE BATCH POOL COVERS EVERY CAP THAT DRAWS ON IT (issue 1514). Two callers
// share it: the analytics routes, capped at ANALYTICS_CONCURRENCY, and the
// pipeline routes, capped at PIPELINE_TOKEN_CONCURRENCY per token. The batch
// share used to be 3 (2 on a small server) against caps that add up to 4, so
// while an analytics run held its two transactions a pipeline queue claim
// waited past the admission wait and answered 503 db_saturated, at every run.
// The batch share is now at least the two caps plus BATCH_UNCAPPED_RESERVE,
// derived or overridden, on every server: a budget that cannot hold it refuses
// the boot and names the shares.
//
// Pure: no database, no environment. client.ts and connection-check.ts feed it;
// the caps come from the caller (api/index.ts), so this module imports no route.

/** What the server allows, as `current_setting` reports it. */
export interface ServerConnectionLimits {
  readonly maxConnections: number;
  readonly superuserReserved: number;
  readonly reserved: number;
}

/** The operator's knobs. `undefined` means "derive it". */
export interface BudgetOverrides {
  readonly headroom?: number;
  readonly request?: number;
  readonly batch?: number;
}

export interface ConnectionBudget {
  readonly maxConnections: number;
  readonly superuserReserved: number;
  readonly reserved: number;
  readonly headroom: number;
  /** max_connections minus every reservation and the headroom. */
  readonly available: number;
  readonly guard: number;
  readonly request: number;
  readonly batch: number;
}

/** Connections left for every client that is not the api, unless PG_CONNECTION_HEADROOM says otherwise. */
export const DEFAULT_HEADROOM = 10;
/** The health probe's single connection. */
export const GUARD_SHARE = 1;
/** The request pool's size when the budget allows it (the pool's size before this budget existed). */
export const DEFAULT_REQUEST_SHARE = 10;
/**
 * Batch connections no cap bounds (issue 1514). The pipeline route looks its
 * token up on the batch pool BEFORE it takes the per-token gate (the gate is
 * keyed by the token it finds), and the analytics readiness probe is exempt
 * from the analytics limiter. Each is one short statement, but without a
 * connection of their own they take one of the capped callers' connections, and
 * a capped request then waits behind them. One reserved connection gives them a
 * place to run.
 */
export const BATCH_UNCAPPED_RESERVE = 1;

/** The callers that draw on the batch pool, each with its cap. */
export interface BatchCaps {
  /** ANALYTICS_CONCURRENCY: analytics-provider requests at once. */
  readonly analytics: number;
  /** PIPELINE_TOKEN_CONCURRENCY: requests one pipeline-worker token holds at once. */
  readonly pipeline: number;
}

/** The batch connections `caps` need: every cap, plus the reserve for the uncapped lookups. */
export function batchShareFor(caps: BatchCaps): number {
  return caps.analytics + caps.pipeline + BATCH_UNCAPPED_RESERVE;
}

export class ConnectionBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionBudgetError";
  }
}

function describe(b: Omit<ConnectionBudget, "request" | "batch"> & { request: number; batch: number }): string {
  return (
    `connection budget ${b.available} = max_connections ${b.maxConnections} − superuser_reserved_connections ` +
    `${b.superuserReserved} − reserved_connections ${b.reserved} − headroom ${b.headroom}; ` +
    `shares: request ${b.request} + batch ${b.batch} + guard ${b.guard} = ${b.request + b.batch + b.guard}`
  );
}

/** The api's shares of the server's connections, or ConnectionBudgetError when they cannot fit. */
export function deriveConnectionBudget(limits: ServerConnectionLimits, overrides: BudgetOverrides, caps: BatchCaps): ConnectionBudget {
  const headroom = overrides.headroom ?? DEFAULT_HEADROOM;
  const base = {
    maxConnections: limits.maxConnections,
    superuserReserved: limits.superuserReserved,
    reserved: limits.reserved,
    headroom,
    available: limits.maxConnections - limits.superuserReserved - limits.reserved - headroom,
    guard: GUARD_SHARE,
  };
  const free = base.available - base.guard;
  // The batch share is the caps' need on every server (issue 1514), never a
  // quarter of what is free: a smaller one refuses requests at every analytics run.
  const needed = batchShareFor(caps);

  let request: number;
  let batch: number;
  if (overrides.request !== undefined && overrides.batch !== undefined) {
    request = overrides.request;
    batch = overrides.batch;
  } else if (overrides.request !== undefined) {
    request = overrides.request;
    batch = needed;
  } else if (overrides.batch !== undefined) {
    batch = overrides.batch;
    request = Math.min(DEFAULT_REQUEST_SHARE, free - batch);
  } else {
    // A small instance gives up request connections, never batch ones.
    batch = needed;
    request = Math.min(DEFAULT_REQUEST_SHARE, free - batch);
  }

  const budget = { ...base, request, batch };
  if (batch < needed) {
    throw new ConnectionBudgetError(
      `api refused to start: the batch pool cannot hold every cap that draws on it — batch ${batch} < ` +
        `analytics ${caps.analytics} (ANALYTICS_CONCURRENCY) + pipeline ${caps.pipeline} (PIPELINE_TOKEN_CONCURRENCY) + ` +
        `reserve ${BATCH_UNCAPPED_RESERVE} = ${needed}; ${describe(budget)}. Raise PG_BATCH_POOL_MAX or unset it.`,
    );
  }
  if (request < 1 || request + batch + base.guard > base.available) {
    throw new ConnectionBudgetError(
      `api refused to start: the database connection shares do not fit the server's budget — ${describe(budget)}. ` +
        "Lower PG_REQUEST_POOL_MAX, PG_BATCH_POOL_MAX or PG_CONNECTION_HEADROOM, or raise max_connections.",
    );
  }
  return budget;
}

/** One line for the boot log. */
export function describeConnectionBudget(budget: ConnectionBudget): string {
  return describe(budget);
}
