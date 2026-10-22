// The /api/pipeline/** wire contract (issue 1034, decision D75), shared by the
// api, which serves it, and the pipeline worker, which calls it.
//
// The pipeline worker holds no database credential. It claims, renews and
// settles its jobs through the queue routes, reads the state its handlers need
// through the read routes, and writes its samples through the ingestion routes,
// all with its pipeline-worker token. This module is the part both sides must
// agree on: the paths, the limits and the JSON encoding. It imports nothing, so
// the worker can import it without reaching a database module.

/** The most rows one ingestion request may carry. A larger request answers 413. */
export const PIPELINE_MAX_ROWS = 1_000;

/** The largest request body the pipeline routes accept, in bytes. A larger one answers 413. */
export const PIPELINE_MAX_BODY_BYTES = 1024 * 1024;

/** The header an ingestion request names its idempotency key in. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/**
 * The lease a write is fenced by. The claim returns it, and every renew,
 * settle and ingestion request presents it. The api writes only while the job
 * row still says `running`, `locked_by = workerId` and `attempts = attempt`, so
 * a worker whose lease the reaper took, or that holds a stale attempt, writes
 * nothing (409 lease_lost).
 */
export interface PipelineLease {
  readonly jobId: number;
  readonly workerId: string;
  readonly attempt: number;
}

export const PIPELINE_PREFIX = "/api/pipeline/";

export const PIPELINE_ROUTES = {
  claim: "/api/pipeline/queue/claim",
  renew: "/api/pipeline/queue/renew",
  settle: "/api/pipeline/queue/settle",
  release: "/api/pipeline/queue/release",
  reap: "/api/pipeline/queue/reap",
  sweep: "/api/pipeline/queue/sweep",
  enqueue: "/api/pipeline/queue/enqueue",
  tick: "/api/pipeline/schedule/tick",
  /** The worker's startup check: the token is valid and holds both rights. */
  whoami: "/api/pipeline/whoami",
  read: (op: string) => `/api/pipeline/read/${op}`,
  ingest: (op: string) => `/api/pipeline/ingest/${op}`,
} as const;

/** How a claimed job ended, as the settle route records it. */
export type SettleOutcome =
  | { readonly kind: "succeeded"; readonly output: unknown }
  | { readonly kind: "degraded"; readonly error: string; readonly terminal: boolean; readonly output: unknown }
  | { readonly kind: "failed"; readonly error: string };

/** A claimed job, as the claim route returns it. */
export interface ClaimedJob {
  readonly id: number;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly max_attempts: number;
}

// JSON with two tagged shapes, so a Date and a bigint survive the trip. A
// handler's state is mostly strings and numbers, but the stores it calls take
// and return Date values (a sample's instant, a block's timestamp), and JSON
// would turn each into a string the other side then compares as one.
const DATE_TAG = "$date";
const BIGINT_TAG = "$bigint";

/** Encode a value for a pipeline request or response body. */
export function encodePipeline(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key, v) {
    const raw = this[key];
    if (raw instanceof Date) return { [DATE_TAG]: raw.toISOString() };
    if (typeof v === "bigint") return { [BIGINT_TAG]: v.toString() };
    return v;
  });
}

/** Decode a pipeline body produced by `encodePipeline`. */
export function decodePipeline(text: string): unknown {
  return JSON.parse(text, (_key, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === DATE_TAG && typeof v[DATE_TAG] === "string") return new Date(v[DATE_TAG]);
      if (keys.length === 1 && keys[0] === BIGINT_TAG && typeof v[BIGINT_TAG] === "string") return BigInt(v[BIGINT_TAG]);
    }
    return v;
  });
}

/** Split `rows` into chunks of at most PIPELINE_MAX_ROWS, for a writer whose rows can exceed one request. */
export function pipelineChunks<T>(rows: readonly T[], size: number = PIPELINE_MAX_ROWS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
