import { jsonValue, sql } from "../db/worker-client.ts";
import { config } from "../config.ts";
import { getHandler } from "./handlers/index.ts";
import { LANES, type Lane } from "./lanes.ts";

const MAX_BACKOFF_SECONDS = 3600;

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

interface JobRow {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

// A handler signals a degraded (non-fatal) run by returning `{ ok:false }`
// instead of throwing — it kept the last-persisted rows and wrote nothing.
function isDegradedResult(output: unknown): output is { ok: false; error?: unknown } {
  return output != null && typeof output === "object" && (output as { ok?: unknown }).ok === false;
}

// A degrade a RETRY CANNOT CHANGE THE ANSWER TO (T21). The seam is the same
// question the session handlers already applied to benign skips, asked in
// the other direction: a consensus receipt refused because a FROZEN take set
// carries no weight vector will be refused identically on every attempt, so
// five identical red rows are five copies of one fact and a wasted backoff
// window. The handler says so explicitly with `terminal: true`; everything else
// keeps the exponential-backoff retry, because most degrades ARE transient.
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

// Claim exactly one due job WITHIN THE LANE'S KIND ALLOWLIST, lock it, run its
// handler, and record the outcome. Concurrency-safe across N workers via
// FOR UPDATE SKIP LOCKED (the lane predicate only narrows which kinds are
// visible to this worker; it never weakens ownership). Priority is preserved
// WITHIN the lane (ORDER BY priority DESC applies to the lane-filtered set).
//
// `, id` IS LOAD-BEARING (issue #806), not cosmetic. `run_after` is a
// millisecond instant and jobs routinely share one: the retired session-lifecycle
// rows were all priority 0, and `createSessionAdmin`'s clamp collapsed the
// aggregate and judge steps onto an IDENTICAL run_after for any window under ~2s.
// The rows are gone but the tie is not theirs alone, and without a
// tiebreak the claim order among equals is whatever the plan returns, and
// executed against a real Postgres the judge lost it: `aggregate` and `publish`
// both drained first and the judge burned all five attempts on
// `terminal_state:published` — final state `published`, zero judgement rows, in
// `shadow` mode. It does NOT self-heal, because the window that collapses the
// instants is the same window that puts the publish inside the judge's first
// backoff. `id` is insertion order, which is the order the enqueuer intended.
// Returns true if a job was processed (caller can poll faster when busy).
export async function processOneJob(opts: ClaimOptions = {}): Promise<boolean> {
  const lane = opts.lane ?? LANES.generic;
  const workerId = opts.workerId ?? config.workerId;
  const claimed = await sql<JobRow[]>`
    WITH claimed AS (
      SELECT id FROM jobs
      WHERE status = 'pending' AND run_after <= now()
        AND kind LIKE ANY(${[...lane.include]})
        AND kind NOT LIKE ALL(${[...lane.exclude]})
      -- The ", id" tiebreak is LOAD-BEARING (issue #806) and is explained in
      -- the comment above this function: run_after is a millisecond instant
      -- that same-priority jobs routinely share, and without a tiebreak the
      -- the judge step measurably lost the tie to its own publish.
      ORDER BY priority DESC, run_after, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE jobs j
       SET status = 'running',
           attempts = attempts + 1,
           locked_at = now(),
           locked_by = ${workerId},
           updated_at = now()
      FROM claimed
     WHERE j.id = claimed.id
     RETURNING j.id, j.kind, j.payload, j.attempts, j.max_attempts
  `;

  const job = claimed[0];
  if (!job) return false;
  opts.onClaim?.({ id: job.id, kind: job.kind });

  const startedAt = new Date();
  const handler = getHandler(job.kind);

  // Lease renewal: keep `locked_at` fresh while the handler is live so the
  // reaper only reaps abandoned owners. If a renewal finds the lock gone (we
  // were reaped anyway / an operator requeued the job), the run is CANCELED in
  // effect: we cannot abort an in-flight await, but every terminal write below
  // is ownership-guarded, so the zombie's result is discarded and no duplicate
  // job_runs row can be written.
  const renewTimer = setInterval(() => {
    void (async () => {
      try {
        const kept = await sql`
          UPDATE jobs SET locked_at = now(), updated_at = now()
           WHERE id = ${job.id} AND locked_by = ${workerId} AND status = 'running' RETURNING id`;
        if (kept.length === 0) {
          clearInterval(renewTimer);
          console.warn(`job ${job.id} (${job.kind}) lease lost during execution — run canceled (terminal write will be discarded)`);
        }
      } catch { /* transient renewal failure — next tick retries; reaper is the backstop */ }
    })();
  }, leaseRenewMs());

  // Terminal writes are guarded by continued ownership: if the reaper requeued
  // this job (we overran the visibility timeout) another worker now owns it, so
  // we must NOT stomp its row or write a duplicate job_runs. A 0-row UPDATE means
  // we lost the lock — bail without recording.
  try {
    if (!handler) throw new Error(`no handler registered for kind "${job.kind}"`);
    // Pass the claimed job's id so handlers that persist their own telemetry
    // (e.g. analytics regime/research runs → research_pipeline_runs.job_id,
    // issue #179) can link output rows back to the originating job.
    const output = await handler(job.payload, job.id);

    // A handler that returns { ok:false } DEGRADED (a live provider was
    // unreachable/slow, so it kept the last-persisted rows and wrote nothing).
    // Recording that as 'succeeded' is dishonest: it hides every silent no-op
    // from job_runs alerting and never re-tries the transient blip. Give it a
    // distinct durable job_runs.status ('degraded') and engage the same
    // exponential-backoff retry as a hard failure so a transient blip recovers
    // before the next (up to daily) cron tick. Never escalate to 'dead' —
    // last-persisted data is already intact and the schedule must keep firing.
    //
    // AN EXHAUSTED DEGRADE SETTLES 'failed', NOT 'succeeded' (R16). It used to
    // settle 'succeeded' on the reasoning that the next cron slot re-enqueues a
    // fresh attempt — which is true, and is unaffected by the status, because
    // the scheduler enqueues NEW rows. What the old status did do was make the
    // row lie: staging job 83 read `succeeded, attempts 5, last_error
    // judge_unavailable` for a judging that never happened, and the admin
    // overview's kind health, the operator's queue counts and
    // `swarm/receipt-gap.ts` all had to work around a green row for work that
    // was never done. 'failed' is the honest terminal for "asked N times, never
    // answered"; 'dead' is still never used here, so an operator requeue and
    // the next cron slot both stay available.
    //
    // A TERMINAL degrade skips the retries entirely — see isTerminalDegrade.
    if (isDegradedResult(output)) {
      const errText = degradedError(output);
      const terminal = isTerminalDegrade(output);
      const canRetry = !terminal && job.attempts < job.max_attempts;
      const backoff = Math.min(MAX_BACKOFF_SECONDS, Math.pow(2, job.attempts));
      const recorded = await sql.begin(async (tx) => {
        const upd = canRetry
          ? await tx`UPDATE jobs
                        SET status = 'pending',
                            run_after = now() + (${backoff} || ' seconds')::interval,
                            locked_at = NULL, locked_by = NULL,
                            last_error = ${errText}, updated_at = now()
                      WHERE id = ${job.id} AND locked_by = ${workerId} AND status = 'running' RETURNING id`
          : await tx`UPDATE jobs
                        SET status = 'failed', locked_at = NULL, locked_by = NULL,
                            last_error = ${errText}, updated_at = now()
                      WHERE id = ${job.id} AND locked_by = ${workerId} AND status = 'running' RETURNING id`;
        if (upd.length === 0) return false;
        // The RUN keeps the 'degraded' status that distinguishes "kept the
        // last-persisted rows" from a thrown failure — except for a terminal
        // refusal, which is not a degradation of anything and is recorded red.
        await tx`INSERT INTO job_runs (job_id, kind, started_at, finished_at, status, error, output)
                 VALUES (${job.id}, ${job.kind}, ${startedAt}, now(), ${terminal ? "failed" : "degraded"}, ${errText}, ${tx.json(jsonValue(output ?? null))})`;
        return true;
      });
      if (!recorded) console.warn(`job ${job.id} (${job.kind}) lost its lock before completion (reaped) — degraded result discarded`);
      else if (terminal) console.error(`job ${job.id} (${job.kind}) REFUSED TERMINALLY — no retry can change the answer, settled FAILED: ${errText.split("\n")[0]}`);
      else console.warn(`job ${job.id} (${job.kind}) DEGRADED — kept last-persisted${canRetry ? `, retry in ${backoff}s` : " (attempts exhausted; settled FAILED, next cron re-enqueues)"}: ${errText.split("\n")[0]}`);
      return true;
    }

    const ok = await sql.begin(async (tx) => {
      const upd = await tx`UPDATE jobs SET status = 'succeeded', locked_at = NULL, locked_by = NULL, last_error = NULL, updated_at = now()
                           WHERE id = ${job.id} AND locked_by = ${workerId} AND status = 'running' RETURNING id`;
      if (upd.length === 0) return false;
      await tx`INSERT INTO job_runs (job_id, kind, started_at, finished_at, status, output)
               VALUES (${job.id}, ${job.kind}, ${startedAt}, now(), 'succeeded', ${tx.json(jsonValue(output ?? null))})`;
      return true;
    });
    if (!ok) console.warn(`job ${job.id} (${job.kind}) lost its lock before completion (reaped) — result discarded`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    const canRetry = job.attempts < job.max_attempts;
    const backoff = Math.min(MAX_BACKOFF_SECONDS, Math.pow(2, job.attempts));
    await sql.begin(async (tx) => {
      const upd = canRetry
        ? await tx`UPDATE jobs
                      SET status = 'pending',
                          run_after = now() + (${backoff} || ' seconds')::interval,
                          locked_at = NULL, locked_by = NULL,
                          last_error = ${message}, updated_at = now()
                    WHERE id = ${job.id} AND locked_by = ${workerId} AND status = 'running' RETURNING id`
        : await tx`UPDATE jobs
                      SET status = 'dead', locked_at = NULL, locked_by = NULL,
                          last_error = ${message}, updated_at = now()
                    WHERE id = ${job.id} AND locked_by = ${workerId} AND status = 'running' RETURNING id`;
      if (upd.length === 0) return; // lost the lock — don't record a duplicate run
      await tx`INSERT INTO job_runs (job_id, kind, started_at, finished_at, status, error)
               VALUES (${job.id}, ${job.kind}, ${startedAt}, now(), ${canRetry ? "failed" : "dead"}, ${message})`;
    });
    console.error(`job ${job.id} (${job.kind}) failed${canRetry ? `, retry in ${backoff}s` : " — DEAD"}: ${message.split("\n")[0]}`);
    return true;
  } finally {
    clearInterval(renewTimer);
  }
}

// Release every job still owned by `workerId` back to 'pending' (lock cleared).
// Used by bounded shutdown (runtime.ts): when a hung handler outlives the
// shutdown deadline its job must not survive as an orphaned 'running' row owned
// by a stopped worker. The ownership guards above then discard the abandoned
// handler's eventual terminal write, so no duplicate job_runs row is possible.
export async function releaseOwnedJobs(workerId: string): Promise<number> {
  const released = await sql`
    UPDATE jobs
       SET status = 'pending',
           locked_at = NULL, locked_by = NULL,
           last_error = COALESCE(last_error, '') || ' [released: worker shutdown]',
           updated_at = now()
     WHERE status = 'running' AND locked_by = ${workerId}
     RETURNING id`;
  return released.length;
}
