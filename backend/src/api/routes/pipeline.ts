// /api/pipeline/** — the pipeline worker's only way to the database (issue
// 1034, decision D75).
//
// Only the api holds a database credential. The pipeline worker presents its
// pipeline-worker token (the automation-token store, smoke spec §3) and:
//   - claims, renews, settles and releases jobs, ticks the schedules, reaps
//     expired leases and sweeps a stale backlog through the queue routes
//     (right `pipeline_queue`);
//   - reads the state its handlers need and writes their rows through the read
//     and ingestion routes (right `pipeline_ingest`).
// No other token reaches these routes, and the pipeline-worker token reaches no
// other route: each route elsewhere asks for a right this holder never carries.
//
// BOUNDED. Every request runs on the batch pool, so pipeline work can exhaust
// only that pool and the request pool keeps serving public and member routes.
// A token may hold PIPELINE_TOKEN_CONCURRENCY requests at once (default 2); one
// more waits PG_ADMISSION_WAIT_MS and then answers 503 db_saturated with
// Retry-After, which the worker honours. A body over 1 MiB, or an ingestion
// request over 1,000 rows, answers 413.
//
// IDEMPOTENT AND FENCED. Every write carries an Idempotency-Key and the lease
// it runs under, (jobId, workerId, attempt). The api runs it in one transaction
// that first locks the job row and proves the lease still holds, and records a
// receipt (pipeline/receipts.ts) with the response. A replay of the same key
// and body is answered from the receipt and writes nothing; the same key with a
// different body answers 409; a write whose lease the reaper took, or whose
// attempt is stale, answers 409 lease_lost and writes nothing.
import { classifyDbFailure, sql } from "../../db/client.ts";
import { createPoolGate, type PoolGate } from "../../db/pool-gate.ts";
import { DEFAULT_ADMISSION_WAIT_MS } from "../../db/client.ts";
import type { RegistryDb } from "../../db/registry.ts";
import { requestWaits } from "../../lib/request-waits.ts";
import { automationTokenGrant, type AutomationGrant } from "../auth.ts";
import {
  IDEMPOTENCY_KEY_HEADER,
  PIPELINE_MAX_BODY_BYTES,
  PIPELINE_MAX_ROWS,
  PIPELINE_PREFIX,
  PIPELINE_ROUTES,
  decodePipeline,
  encodePipeline,
  type PipelineLease,
  type SettleOutcome,
} from "../../lib/pipeline-wire.ts";
import {
  claimJob,
  enqueueJob,
  fenceLease,
  releaseOwnedJobs,
  reapStuckJobs,
  renewLease,
  settleJob,
  sweepStaleBacklog,
  tickScheduler,
  type EnqueueRequest,
  type LaneFilter,
} from "../../pipeline/queue-store.ts";
import { bodySha256, findReceipt, recordReceipt } from "../../pipeline/receipts.ts";
import { PIPELINE_OPS } from "../../pipeline/ops.ts";

/** What a pipeline route answers: a status and a body in the pipeline encoding. */
export interface PipelineReply {
  readonly status: number;
  readonly body: unknown;
}

/** Requests one pipeline-worker token may hold at once (PIPELINE_TOKEN_CONCURRENCY, default 2). */
export function pipelineTokenConcurrency(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.PIPELINE_TOKEN_CONCURRENCY ?? 2);
  return Number.isInteger(n) && n >= 1 ? n : 2;
}

function admissionWaitMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.PG_ADMISSION_WAIT_MS ?? DEFAULT_ADMISSION_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_ADMISSION_WAIT_MS;
}

// One gate per presented token (instance and holder), built on first use.
const tokenGates = new Map<string, PoolGate>();
function gateFor(grant: AutomationGrant): PoolGate {
  const key = `${grant.instance}/${grant.holder}`;
  let gate = tokenGates.get(key);
  if (!gate) {
    gate = createPoolGate(`pipeline:${key}`, pipelineTokenConcurrency(), admissionWaitMs());
    tokenGates.set(key, gate);
  }
  return gate;
}

/** Per-token admission counts, for /health's db_pool telemetry. */
export function pipelineGateTelemetry(): Record<string, ReturnType<PoolGate["stats"]>> {
  return Object.fromEntries([...tokenGates].map(([key, gate]) => [key, gate.stats()]));
}

/** Forget every per-token gate. Tests that change PIPELINE_TOKEN_CONCURRENCY call it. */
export function _resetPipelineGatesForTests(): void {
  tokenGates.clear();
}

function reply(r: PipelineReply): Response {
  return new Response(encodePipeline(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
}

const tooLarge: PipelineReply = { status: 413, body: { error: "payload_too_large", maxBytes: PIPELINE_MAX_BODY_BYTES, maxRows: PIPELINE_MAX_ROWS } };

/** The right a pipeline path needs, or null when the path is not a pipeline route. */
function rightFor(path: string): "pipeline_queue" | "pipeline_ingest" | null {
  if (path.startsWith("/api/pipeline/queue/") || path === PIPELINE_ROUTES.tick || path === PIPELINE_ROUTES.whoami) {
    return "pipeline_queue";
  }
  if (path.startsWith("/api/pipeline/read/") || path.startsWith("/api/pipeline/ingest/")) return "pipeline_ingest";
  return null;
}

/**
 * Serve one /api/pipeline/** request: authenticate, bound, then dispatch on the
 * batch pool. The api's router calls this inside runOnBatchPool.
 */
export async function handlePipeline(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  if (req.method !== "POST") return reply({ status: 405, body: { error: "method not allowed" } });
  const right = rightFor(path);
  if (!right) return reply({ status: 404, body: { error: "not found" } });

  const declared = Number(req.headers.get("Content-Length") ?? 0);
  if (declared > PIPELINE_MAX_BODY_BYTES) return reply(tooLarge);

  // Another holder's token is answered exactly as a forged one is, so no
  // token tells a caller anything about the routes it may not use.
  // This lookup runs on the batch pool before the token's gate below, so no
  // cap bounds it: the batch share keeps a connection for it (issue 1514,
  // BATCH_UNCAPPED_RESERVE in db/connection-budget.ts).
  const grant = await automationTokenGrant(req);
  if (!grant || grant.holder !== "pipeline-worker" || !grant.rights.includes(right)) {
    return reply({ status: 401, body: { error: "unauthorized" } });
  }

  const text = await req.text();
  if (Buffer.byteLength(text) > PIPELINE_MAX_BODY_BYTES) return reply(tooLarge);

  // The token's gate is a concurrency limiter, so its wait is the slow-request
  // line's limiter wait (issue 1514); a refusal here names the gate
  // (`pipeline:<instance>/<holder>`) in its db_saturated log.
  const waits = requestWaits();
  const queued = performance.now();
  let release: () => void;
  try {
    release = await gateFor(grant).acquire();
  } finally {
    if (waits) waits.limiterMs += performance.now() - queued;
  }
  try {
    if (path === PIPELINE_ROUTES.whoami) return reply({ status: 200, body: { holder: grant.holder, rights: grant.rights } });
    return reply(await dispatchPipeline(path, text, req.headers.get(IDEMPOTENCY_KEY_HEADER), { fenced: true }));
  } catch (err) {
    // A database failure is the router's 503 (db_saturated, db_timeout,
    // database unavailable), which the worker retries.
    if (classifyDbFailure(err) !== null) throw err;
    // Anything else fails the job. The caller is the authenticated pipeline
    // worker, so the message goes back to it and lands in job_runs, as it did
    // when the worker ran the statement itself.
    console.error(`api error (500 ${path}):`, err);
    return reply(pipelineError(err));
  } finally {
    release();
  }
}

/** The 500 a failed pipeline operation answers: the error's message, for the job's record. */
export function pipelineError(err: unknown): PipelineReply {
  return { status: 500, body: { error: "internal error", detail: err instanceof Error ? err.message : String(err) } };
}

export interface DispatchOptions {
  /**
   * Whether writes are fenced by a lease and keyed by an Idempotency-Key. Always
   * true over HTTP. The in-process test transport (backend/tests/support/
   * pipeline-in-process.ts) passes false for a handler a test calls outside any
   * claimed job; it is reachable only from the test harness.
   */
  readonly fenced: boolean;
}

function bad(message: string): PipelineReply {
  return { status: 400, body: { error: message } };
}

function asLease(value: unknown): PipelineLease | null {
  const v = value as Partial<PipelineLease> | null;
  if (!v || typeof v !== "object") return null;
  if (!Number.isInteger(v.jobId) || !Number.isInteger(v.attempt) || typeof v.workerId !== "string" || !v.workerId) return null;
  return { jobId: v.jobId!, workerId: v.workerId, attempt: v.attempt! };
}

function asLane(value: unknown): LaneFilter | null {
  const v = value as Partial<LaneFilter> | null;
  const strings = (a: unknown): a is string[] => Array.isArray(a) && a.every((s) => typeof s === "string");
  if (!v || !strings(v.include) || !strings(v.exclude)) return null;
  return { include: v.include, exclude: v.exclude };
}

function asOutcome(value: unknown): SettleOutcome | null {
  const v = value as { kind?: unknown; error?: unknown; terminal?: unknown; output?: unknown } | null;
  if (!v || typeof v !== "object") return null;
  if (v.kind === "succeeded") return { kind: "succeeded", output: v.output ?? null };
  if (v.kind === "degraded" && typeof v.error === "string") {
    return { kind: "degraded", error: v.error, terminal: v.terminal === true, output: v.output ?? null };
  }
  if (v.kind === "failed" && typeof v.error === "string") return { kind: "failed", error: v.error };
  return null;
}

function positiveSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

const leaseLost: PipelineReply = { status: 409, body: { error: "lease_lost" } };

/**
 * One fenced, idempotent write: the receipt check, the lease fence, the write
 * and the receipt, in one transaction.
 */
async function fencedWrite(
  operation: string,
  text: string,
  key: string | null,
  lease: PipelineLease | null,
  options: DispatchOptions,
  write: (tx: RegistryDb) => Promise<PipelineReply>,
): Promise<PipelineReply> {
  if (options.fenced) {
    if (!lease) return bad("a write needs its lease: { jobId, workerId, attempt }");
    if (!key) return bad(`a write needs an ${IDEMPOTENCY_KEY_HEADER} header`);
  }
  const hash = bodySha256(text);
  const replayOf = async (db: RegistryDb): Promise<PipelineReply | null> => {
    if (!key) return null;
    const receipt = await findReceipt(db, key);
    if (!receipt) return null;
    if (receipt.bodySha256 !== hash) {
      return { status: 409, body: { error: "idempotency_key_reused", detail: "this key was recorded with a different body" } };
    }
    return { status: receipt.response.status, body: decodePipeline(JSON.stringify(receipt.response.body)) };
  };

  const early = await replayOf(sql);
  if (early) return early;
  try {
    return await sql.begin(async (tx) => {
      if (options.fenced && lease) {
        if (!(await fenceLease(tx, lease))) return leaseLost;
        // A duplicate that waited on the fence above sees the first one's receipt.
        const replay = await replayOf(tx);
        if (replay) return replay;
      }
      const out = await write(tx);
      if (key && out.status < 300) {
        await recordReceipt(tx, {
          key,
          operation,
          bodySha256: hash,
          response: { status: out.status, body: JSON.parse(encodePipeline(out.body)) },
          jobId: lease?.jobId ?? null,
        });
      }
      return out;
    });
  } catch (err) {
    // Two copies of one request raced past the receipt check; the loser's
    // receipt insert hit the primary key and rolled its write back. Answer it
    // from the winner's receipt.
    if ((err as { code?: unknown } | null)?.code === "23505") {
      const replay = await replayOf(sql);
      if (replay) return replay;
    }
    throw err;
  }
}

/**
 * Dispatch one pipeline request body to its route. Shared by the HTTP handler
 * above and the test harness's in-process transport.
 */
export async function dispatchPipeline(
  path: string,
  text: string,
  idempotencyKey: string | null,
  options: DispatchOptions,
): Promise<PipelineReply> {
  if (!path.startsWith(PIPELINE_PREFIX)) return { status: 404, body: { error: "not found" } };
  let body: Record<string, unknown>;
  try {
    const decoded = text ? decodePipeline(text) : {};
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return bad("the body must be a JSON object");
    body = decoded as Record<string, unknown>;
  } catch {
    return bad("the body is not valid JSON");
  }
  const lease = body.lease === undefined ? null : asLease(body.lease);
  if (body.lease !== undefined && !lease) return bad("lease must be { jobId, workerId, attempt }");

  switch (path) {
    case PIPELINE_ROUTES.claim: {
      const lane = asLane(body.lane);
      if (!lane || typeof body.workerId !== "string" || !body.workerId) return bad("claim needs { lane: { include, exclude }, workerId }");
      return { status: 200, body: { job: await claimJob(sql, lane, body.workerId) } };
    }
    case PIPELINE_ROUTES.renew: {
      if (!lease) return bad("renew needs its lease");
      return (await renewLease(sql, lease)) ? { status: 200, body: { renewed: true } } : leaseLost;
    }
    case PIPELINE_ROUTES.settle: {
      const outcome = asOutcome(body.outcome);
      const startedAt = body.startedAt instanceof Date ? body.startedAt : null;
      if (!lease || !outcome || !startedAt) return bad("settle needs { lease, outcome, startedAt }");
      if (options.fenced && !idempotencyKey) return bad(`a settle needs an ${IDEMPOTENCY_KEY_HEADER} header`);
      // settleJob fences the lease itself (it reads the attempt count it
      // settles against), so the shared fence is not run twice.
      return fencedWrite("queue.settle", text, idempotencyKey, lease, { fenced: false }, async (tx) => {
        const result = await settleJob(tx, lease, outcome, startedAt);
        return result.settled ? { status: 200, body: result } : leaseLost;
      });
    }
    case PIPELINE_ROUTES.release: {
      if (typeof body.workerId !== "string" || !body.workerId) return bad("release needs { workerId }");
      return { status: 200, body: { released: await releaseOwnedJobs(sql, body.workerId) } };
    }
    case PIPELINE_ROUTES.reap:
      return { status: 200, body: { reaped: await reapStuckJobs(sql, positiveSeconds(body.visibilitySeconds, 300)) } };
    case PIPELINE_ROUTES.sweep:
      return { status: 200, body: { cancelled: await sweepStaleBacklog(sql, positiveSeconds(body.leaseSeconds, 300)) } };
    case PIPELINE_ROUTES.tick:
      return { status: 200, body: { enqueued: await sql.begin((tx) => tickScheduler(tx)) } };
    case PIPELINE_ROUTES.enqueue: {
      const r = body.request as Partial<EnqueueRequest> | null;
      if (!r || typeof r.kind !== "string" || !r.kind || !r.payload || typeof r.payload !== "object") {
        return bad("enqueue needs { request: { kind, payload, dedupeKey, unlessLive } }");
      }
      const request: EnqueueRequest = {
        kind: r.kind,
        payload: r.payload as Record<string, unknown>,
        dedupeKey: typeof r.dedupeKey === "string" ? r.dedupeKey : null,
        unlessLive: r.unlessLive === true,
      };
      return fencedWrite("queue.enqueue", text, idempotencyKey, lease, options, async (tx) => ({
        status: 200,
        body: { id: await enqueueJob(tx, request) },
      }));
    }
  }

  const readName = path.startsWith("/api/pipeline/read/") ? path.slice("/api/pipeline/read/".length) : null;
  const ingestName = path.startsWith("/api/pipeline/ingest/") ? path.slice("/api/pipeline/ingest/".length) : null;
  const name = readName ?? ingestName;
  if (!name) return { status: 404, body: { error: "not found" } };
  const op = Object.hasOwn(PIPELINE_OPS, name) ? PIPELINE_OPS[name] : undefined;
  if (!op || (readName !== null) !== (op.kind === "read")) return { status: 404, body: { error: `no ${readName !== null ? "read" : "ingestion"} operation ${name}` } };
  const args = body.args === undefined ? [] : body.args;
  if (!Array.isArray(args)) return bad("args must be an array");

  if (op.kind === "read") return { status: 200, body: { result: await op.run(sql, args) } };
  if (op.rows(args) > PIPELINE_MAX_ROWS) return tooLarge;
  return fencedWrite(name, text, idempotencyKey, lease, options, async (tx) => ({
    status: 200,
    body: { result: await op.run(tx, args) },
  }));
}
