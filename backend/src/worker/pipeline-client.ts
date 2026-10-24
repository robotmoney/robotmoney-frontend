// The pipeline worker's client for /api/pipeline/** (issue 1034, decision D75).
//
// The worker holds no database credential. Every claim, renew, settle, tick,
// reap, read and write goes to the api over HTTP, presenting the
// pipeline-worker token read from PIPELINE_TOKEN_FILE (smoke spec §3: a service
// token is a file the boot places in the instance's state directory, never an
// env value). This module imports no database module, and
// backend/tests/pipeline-worker-boundary.test.ts holds the worker's whole
// import graph to that.
//
// RETRIES. A 503 (db_saturated, db_timeout, database unavailable) is the api
// saying "not now": the client waits the Retry-After it was given and sends the
// same request again, with the same Idempotency-Key, until
// PIPELINE_RETRY_DEADLINE_MS (default 60 s) runs out. A refused connection or
// a gateway 502/504 is retried the same way and, past the deadline, thrown as
// PipelineUnreachableError so a handler that can wait degrades instead of
// failing. A renew is retried like any other request, so a saturated api never
// costs a live job its lease.
//
// FENCING AND IDEMPOTENCY. A handler runs inside runWithLease (worker/loop.ts),
// so every write it sends carries the lease (jobId, workerId, attempt) and an
// Idempotency-Key unique to that write: `<jobId>.<attempt>.<n>.<operation>`,
// where n counts the job's writes in order. A retry of one write reuses its key
// and body, so the api answers it from its receipt and adds no row.
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { testSeamArmed, testSeamRefusal } from "../test-seam.ts";
import {
  IDEMPOTENCY_KEY_HEADER,
  PIPELINE_ROUTES,
  decodePipeline,
  encodePipeline,
  type ClaimedJob,
  type PipelineLease,
  type SettleOutcome,
} from "../lib/pipeline-wire.ts";

/** The api did not answer (connection refused, or a gateway 502/504) within the retry deadline. */
export class PipelineUnreachableError extends Error {
  override name = "PipelineUnreachableError";
}

/** The api answered 409 lease_lost: the job is no longer this worker's, and nothing was written. */
export class PipelineLeaseLostError extends Error {
  override name = "PipelineLeaseLostError";
}

/** The api refused the request (any other non-2xx). The message carries its status and error text, never the token. */
export class PipelineRequestError extends Error {
  override name = "PipelineRequestError";
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** One HTTP exchange: the path, the encoded body and the headers in; the status, body text and Retry-After out. */
export type PipelineTransport = (
  path: string,
  body: string,
  headers: Readonly<Record<string, string>>,
) => Promise<{ status: number; text: string; retryAfter: string | null }>;

/** The pipeline-worker token, from the file PIPELINE_TOKEN_FILE names. A named file that is missing or empty throws. */
export function readPipelineToken(env: Record<string, string | undefined> = process.env): string | null {
  const file = env.PIPELINE_TOKEN_FILE?.trim();
  if (!file) return null;
  const value = readFileSync(file, "utf8").trim();
  if (!value) throw new Error("PIPELINE_TOKEN_FILE points to an empty token file");
  return value;
}

/** The api base URL the worker calls: PIPELINE_API_URL, else the local api port. */
export function resolvePipelineApiUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.PIPELINE_API_URL?.trim() || `http://localhost:${Number(env.API_PORT ?? 8787)}`).replace(/\/+$/, "");
}

function httpTransport(): PipelineTransport {
  // Read once per process: rotation is a re-provision and a container restart (smoke spec §3).
  let token: string | null | undefined;
  return async (path, body, headers) => {
    if (token === undefined) token = readPipelineToken();
    const res = await fetch(`${resolvePipelineApiUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body,
      signal: AbortSignal.timeout(Number(process.env.PIPELINE_REQUEST_TIMEOUT_MS ?? 330_000)),
    });
    return { status: res.status, text: await res.text(), retryAfter: res.headers.get("Retry-After") };
  };
}

let transport: PipelineTransport | null = null;

/**
 * Replace the transport. TEST SEAM: refused unless the test seam is armed
 * (backend/src/test-seam.ts). backend/tests/preload.ts installs an in-process
 * transport that dispatches to the api's pipeline routes on the test database.
 */
export function setPipelineTransport(next: PipelineTransport | null): void {
  if (!testSeamArmed()) {
    throw testSeamRefusal("worker/pipeline-client.setPipelineTransport()", "The worker reaches the api at PIPELINE_API_URL.");
  }
  transport = next;
}

function currentTransport(): PipelineTransport {
  return (transport ??= httpTransport());
}

function retryDeadlineMs(): number {
  const n = Number(process.env.PIPELINE_RETRY_DEADLINE_MS ?? 60_000);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 30) * 1000 : 1000;
}

/** The error a refusal carries: a failed operation's own message when the api sent one, else the body. */
function errorText(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: unknown; detail?: unknown };
    if (typeof body.detail === "string") return body.detail;
    if (typeof body.error === "string") return body.error;
  } catch { /* not JSON */ }
  return text.slice(0, 500);
}

/** Send one request, retrying 503s and unreachability until the deadline. Returns the decoded body. */
async function send(path: string, body: unknown, idempotencyKey: string | null = null): Promise<Record<string, unknown>> {
  const text = encodePipeline(body);
  const headers: Record<string, string> = idempotencyKey ? { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } : {};
  const deadline = Date.now() + retryDeadlineMs();
  for (;;) {
    let res: { status: number; text: string; retryAfter: string | null };
    try {
      res = await currentTransport()(path, text, headers);
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new PipelineUnreachableError(`pipeline api POST ${path} unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
      await Bun.sleep(1000);
      continue;
    }
    if (res.status === 503 || res.status === 502 || res.status === 504) {
      if (Date.now() >= deadline) {
        const what = `pipeline api POST ${path} answered HTTP ${res.status}${res.text ? ` — ${res.text.slice(0, 300)}` : ""}`;
        if (res.status === 503) throw new PipelineRequestError(what, res.status);
        throw new PipelineUnreachableError(what);
      }
      await Bun.sleep(retryAfterMs(res.retryAfter));
      continue;
    }
    if (res.status === 409 && /"lease_lost"/.test(res.text)) {
      throw new PipelineLeaseLostError(`pipeline api POST ${path}: the lease was lost, nothing was written`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new PipelineRequestError(`pipeline api POST ${path} failed: HTTP ${res.status} — ${errorText(res.text)}`, res.status);
    }
    return (res.text ? decodePipeline(res.text) : {}) as Record<string, unknown>;
  }
}

// ── The lease a handler runs under ───────────────────────────────────────────

interface LeaseScope {
  readonly lease: PipelineLease;
  writes: number;
}
const leaseScope = new AsyncLocalStorage<LeaseScope>();

/** Run `fn` (a job's handler) under `lease`: its writes are fenced by it and keyed by it. */
export function runWithLease<T>(lease: PipelineLease, fn: () => Promise<T>): Promise<T> {
  return leaseScope.run({ lease, writes: 0 }, fn);
}

/** The lease the current handler runs under, or null outside a claimed job. */
export function currentLease(): PipelineLease | null {
  return leaseScope.getStore()?.lease ?? null;
}

function nextWriteKey(operation: string): { lease: PipelineLease; key: string } | null {
  const scope = leaseScope.getStore();
  if (!scope) return null;
  scope.writes += 1;
  const { jobId, attempt } = scope.lease;
  return { lease: scope.lease, key: `${jobId}.${attempt}.${scope.writes}.${operation}` };
}

// ── The routes ───────────────────────────────────────────────────────────────

export interface LaneFilter {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/** Claim one due job in `lane` for `workerId`, or null when none is due. */
export async function claimJob(lane: LaneFilter, workerId: string): Promise<ClaimedJob | null> {
  const out = await send(PIPELINE_ROUTES.claim, { lane: { include: [...lane.include], exclude: [...lane.exclude] }, workerId });
  return (out.job as ClaimedJob | null) ?? null;
}

/** Renew `lease`. False when the job is no longer this worker's. */
export async function renewLease(lease: PipelineLease): Promise<boolean> {
  try {
    await send(PIPELINE_ROUTES.renew, { lease });
    return true;
  } catch (err) {
    if (err instanceof PipelineLeaseLostError) return false;
    throw err;
  }
}

export type SettleReply =
  | { readonly settled: true; readonly status: "succeeded" | "pending" | "failed" | "dead"; readonly backoffSeconds: number | null }
  | { readonly settled: false };

/** Settle the job `lease` holds. `settled: false` when the lease was lost and nothing was recorded. */
export async function settleJob(lease: PipelineLease, outcome: SettleOutcome, startedAt: Date): Promise<SettleReply> {
  try {
    const out = await send(PIPELINE_ROUTES.settle, { lease, outcome, startedAt }, `${lease.jobId}.${lease.attempt}.settle`);
    return out as unknown as SettleReply;
  } catch (err) {
    if (err instanceof PipelineLeaseLostError) return { settled: false };
    throw err;
  }
}

/** Hand every job `workerId` still holds back to pending. */
export async function releaseOwnedJobs(workerId: string): Promise<number> {
  return Number((await send(PIPELINE_ROUTES.release, { workerId })).released ?? 0);
}

/** Requeue running jobs whose lease is older than `visibilitySeconds`. */
export async function reapStuckJobs(visibilitySeconds: number): Promise<number> {
  return Number((await send(PIPELINE_ROUTES.reap, { visibilitySeconds })).reaped ?? 0);
}

/** Cancel the superseded backlog before the first claim. */
export async function sweepStaleBacklog(leaseSeconds: number): Promise<{ id: number; kind: string }[]> {
  return ((await send(PIPELINE_ROUTES.sweep, { leaseSeconds })).cancelled as { id: number; kind: string }[]) ?? [];
}

/** Enqueue every due schedule slot. */
export async function tickScheduler(): Promise<number> {
  return Number((await send(PIPELINE_ROUTES.tick, {})).enqueued ?? 0);
}

/** Enqueue one job from inside a handler, fenced by its lease. Null when the dedupe key or a live job suppressed it. */
export async function enqueueJob(request: {
  kind: string;
  payload: Record<string, unknown>;
  dedupeKey?: string | null;
  unlessLive?: boolean;
}): Promise<number | null> {
  const write = nextWriteKey("queue.enqueue");
  const out = await send(
    PIPELINE_ROUTES.enqueue,
    { ...(write ? { lease: write.lease } : {}), request: { dedupeKey: null, unlessLive: false, ...request } },
    write?.key ?? null,
  );
  return (out.id as number | null) ?? null;
}

/** The worker's startup check: the api answers and the token is the pipeline worker's. */
export async function whoami(): Promise<{ holder: string; rights: string[] }> {
  return (await send(PIPELINE_ROUTES.whoami, {})) as unknown as { holder: string; rights: string[] };
}

/** Run read operation `op` with `args` (pipeline/ops.ts names them). */
export async function pipelineRead<T = unknown>(op: string, ...args: unknown[]): Promise<T> {
  return (await send(PIPELINE_ROUTES.read(op), { args })).result as T;
}

/** Run ingestion operation `op` with `args`, fenced by the current lease and keyed for idempotency. */
export async function pipelineIngest<T = unknown>(op: string, ...args: unknown[]): Promise<T> {
  const write = nextWriteKey(op);
  const out = await send(PIPELINE_ROUTES.ingest(op), { ...(write ? { lease: write.lease } : {}), args }, write?.key ?? null);
  return out.result as T;
}
