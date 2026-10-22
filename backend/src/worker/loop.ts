// Claim one job, run its handler under its lease, settle it (issue #107; the
// queue moved behind the api in issue 1034, decision D75).
//
// Every queue statement runs in the api (pipeline/queue-store.ts), reached
// through /api/pipeline/** (worker/pipeline-client.ts). This module keeps the
// worker's half: which lane it claims for, the lease renewal while a handler
// runs, how a handler's result maps to an outcome, and the log lines.
import { config } from "../config.ts";
import { getHandler } from "./handlers/index.ts";
import { LANES, type Lane } from "./lanes.ts";
import { claimJob, renewLease, releaseOwnedJobs as releaseJobs, runWithLease, settleJob } from "./pipeline-client.ts";
import type { PipelineLease, SettleOutcome } from "../lib/pipeline-wire.ts";

// Lease-renewal cadence (issue #107): while a handler is live its owner renews
// `locked_at` on this interval so the reaper's visibility timeout only ever
// fires for genuinely crashed/abandoned owners — a long research fetch is never
// reaped and executed concurrently. Defaults to a third of the visibility
// timeout; JOB_LEASE_RENEW_MS overrides (tests shorten it). Read per claim so
// tests can adjust without re-importing the module.
function leaseRenewMs(): number {
  const explicit = Number(process.env.JOB_LEASE_RENEW_MS ?? NaN);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const visibilitySeconds = Number(process.env.JOB_VISIBILITY_TIMEOUT ?? 300);
  return Math.max(1000, Math.floor((visibilitySeconds * 1000) / 3));
}

// A handler signals a degraded (non-fatal) run by returning `{ ok:false }`
// instead of throwing — it kept the last-persisted rows and wrote nothing.
function isDegradedResult(output: unknown): output is { ok: false; error?: unknown } {
  return output != null && typeof output === "object" && (output as { ok?: unknown }).ok === false;
}

// A degrade a RETRY CANNOT CHANGE THE ANSWER TO (T21). The handler says so
// explicitly with `terminal: true`; everything else keeps the
// exponential-backoff retry, because most degrades ARE transient.
function isTerminalDegrade(output: unknown): boolean {
  return output != null && typeof output === "object" && (output as { terminal?: unknown }).terminal === true;
}

function degradedError(output: { error?: unknown }): string {
  const e = output.error;
  return e == null ? "degraded (kept last-persisted rows)" : e instanceof Error ? e.message : String(e);
}

export interface ClaimOptions {
  /** Execution lane whose kind allowlist bounds the claim. Default: generic. */
  lane?: Lane;
  /** Owner id recorded in locked_by. Default: config.workerId. */
  workerId?: string;
  /**
   * Invoked once a job is claimed, BEFORE its handler runs. The drain loop uses
   * this to widen its liveness deadline for the duration of the job: from the
   * outside, "claimed a job" and "sat idle" are indistinguishable, and only this
   * moment tells the loop which budget it is now working against
   * (src/ops/heartbeat.ts). Must not throw and must not block.
   */
  onClaim?: (job: { id: number; kind: string }) => void;
}

/**
 * Claim exactly one due job WITHIN THE LANE'S KIND ALLOWLIST, run its handler,
 * and record the outcome. Returns true if a job was processed (the caller polls
 * faster when busy).
 *
 * The api claims with FOR UPDATE SKIP LOCKED, priority first and `id` as the
 * load-bearing tiebreak (issue #806). The handler runs under the claim's lease
 * (jobId, workerId, attempt): every write it sends is fenced by it, so a handler
 * whose lease the reaper took writes nothing, and its settle is discarded.
 *
 * Outcomes (settled by the api, pipeline/queue-store.ts settleJob):
 *   - `{ ok:false }` DEGRADED: the handler kept the last-persisted rows. A
 *     'degraded' run, retried with exponential backoff; once attempts are
 *     exhausted it settles 'failed' (R16: 'failed' is the honest terminal for
 *     "asked N times, never answered"; 'dead' is never used here). A degrade
 *     with `terminal: true` skips the retries and is recorded red.
 *   - any other return: 'succeeded'.
 *   - a throw: 'failed' and retried with backoff, or 'dead' on the last attempt.
 */
export async function processOneJob(opts: ClaimOptions = {}): Promise<boolean> {
  const lane = opts.lane ?? LANES.generic;
  const workerId = opts.workerId ?? config.workerId;
  const job = await claimJob(lane, workerId);
  if (!job) return false;
  opts.onClaim?.({ id: job.id, kind: job.kind });

  const lease: PipelineLease = { jobId: job.id, workerId, attempt: job.attempts };
  const startedAt = new Date();
  const handler = getHandler(job.kind);

  // Lease renewal: keep `locked_at` fresh while the handler is live so the
  // reaper only reaps abandoned owners. A renewal that finds the lease gone
  // (we were reaped / an operator requeued the job) CANCELS the run in effect:
  // we cannot abort an in-flight await, but every write and the settle below
  // are fenced by the lease, so the zombie's result is discarded. A renewal the
  // api answered 503 is retried inside renewLease, so a saturated api never
  // costs a live job its lease.
  const renewTimer = setInterval(() => {
    void (async () => {
      try {
        if (!(await renewLease(lease))) {
          clearInterval(renewTimer);
          console.warn(`job ${job.id} (${job.kind}) lease lost during execution — run canceled (terminal write will be discarded)`);
        }
      } catch { /* transient renewal failure — next tick retries; reaper is the backstop */ }
    })();
  }, leaseRenewMs());

  let outcome: SettleOutcome;
  try {
    if (!handler) throw new Error(`no handler registered for kind "${job.kind}"`);
    // Pass the claimed job's id so handlers that persist their own telemetry
    // can link output rows back to the originating job (issue #179).
    const output = await runWithLease(lease, () => handler(job.payload, job.id));
    outcome = isDegradedResult(output)
      ? { kind: "degraded", error: degradedError(output), terminal: isTerminalDegrade(output), output: output ?? null }
      : { kind: "succeeded", output: output ?? null };
  } catch (err) {
    outcome = { kind: "failed", error: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err) };
  } finally {
    clearInterval(renewTimer);
  }

  const result = await settleJob(lease, outcome, startedAt);
  if (!result.settled) {
    console.warn(`job ${job.id} (${job.kind}) lost its lock before completion (reaped) — ${outcome.kind} result discarded`);
    return true;
  }
  const retry = result.status === "pending" ? `, retry in ${result.backoffSeconds}s` : "";
  if (outcome.kind === "degraded") {
    const first = outcome.error.split("\n")[0];
    if (outcome.terminal) console.error(`job ${job.id} (${job.kind}) REFUSED TERMINALLY — no retry can change the answer, settled FAILED: ${first}`);
    else console.warn(`job ${job.id} (${job.kind}) DEGRADED — kept last-persisted${retry || " (attempts exhausted; settled FAILED, next cron re-enqueues)"}: ${first}`);
  } else if (outcome.kind === "failed") {
    console.error(`job ${job.id} (${job.kind}) failed${retry || " — DEAD"}: ${outcome.error.split("\n")[0]}`);
  }
  return true;
}

// Release every job still owned by `workerId` back to 'pending' (lock cleared).
// Used by bounded shutdown (runtime.ts): when a hung handler outlives the
// shutdown deadline its job must not survive as an orphaned 'running' row owned
// by a stopped worker. The lease fence then discards the abandoned handler's
// eventual writes and settle, so no duplicate job_runs row is possible.
export async function releaseOwnedJobs(workerId: string): Promise<number> {
  return releaseJobs(workerId);
}
