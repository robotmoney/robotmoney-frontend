// The job queue's statements, run by the api for the pipeline worker (issue
// 1034, decision D75).
//
// The worker used to issue these on its own rm_worker pool (worker/loop.ts,
// scheduler.ts, reaper.ts, boot.ts). It holds no database credential now: it
// calls the /api/pipeline/** queue routes (api/routes/pipeline.ts), and the api
// runs each statement here as rm_app on its batch pool. The statements and their
// semantics are the ones the worker ran, with one addition: every renew, settle
// and fenced write also matches the claim's attempt number, so a worker that
// holds a stale attempt of a job another worker re-claimed writes nothing.
import parser from "cron-parser";
import { jsonValue } from "../db/client.ts";
import { on, registerQuery, type RegistryDb } from "../db/registry.ts";
import type { ClaimedJob, PipelineLease, SettleOutcome } from "../lib/pipeline-wire.ts";

const PIPELINE_ROUTE = ["src/api/routes/pipeline"];

const claimJobSql = registerQuery({
  role: "rm_app",
  object: "jobs",
  // UPDATE for the claim itself and for FOR UPDATE SKIP LOCKED; SELECT for
  // the candidate scan, the WHERE and RETURNING.
  privileges: ["SELECT", "UPDATE"],
  site: "src/pipeline/queue-store:claimJob",
  purpose: "Claim the lane's highest-priority due pending job, skipping rows another worker holds.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `WITH claimed AS (
        SELECT id FROM jobs
        WHERE status = 'pending' AND run_after <= now()
          AND kind LIKE ANY($1::text[]) AND kind NOT LIKE ALL($2::text[])
        ORDER BY priority DESC, run_after, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE jobs j SET status = 'running', attempts = attempts + 1, locked_at = now(), locked_by = $3, updated_at = now()
      FROM claimed WHERE j.id = claimed.id
      RETURNING j.id, j.kind, j.payload, j.attempts, j.max_attempts`,
    params: ["{%}", "{}", "probe-worker"],
  },
});

const renewLeaseSql = registerQuery({
  role: "rm_app",
  object: "jobs",
  // SELECT because the WHERE and RETURNING read the row.
  privileges: ["UPDATE", "SELECT"],
  site: "src/pipeline/queue-store:renewLease",
  purpose: "Renew a claimed job's lease while its handler runs, noticing if the reaper took it.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `UPDATE jobs SET locked_at = now(), updated_at = now()
      WHERE id = $1 AND locked_by = $2 AND attempts = $3 AND status = 'running' RETURNING id`,
    params: [0, "probe-worker", 1],
  },
});

const fenceJob = registerQuery({
  role: "rm_app",
  object: "jobs",
  // UPDATE because FOR UPDATE locks the row.
  privileges: ["SELECT", "UPDATE"],
  site: "src/pipeline/queue-store:fenceLease",
  purpose: "Lock a claimed job's row for the length of a settle or a fenced write, proving the lease is still this worker's.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `SELECT kind, attempts, max_attempts FROM jobs
      WHERE id = $1 AND locked_by = $2 AND attempts = $3 AND status = 'running'
      FOR UPDATE`,
    params: [0, "probe-worker", 1],
  },
});

// SETTLING A CLAIMED JOB. Each outcome is its own statement, so each is its own
// site. The fence above already locked the row; each settle still repeats the
// guard, so a statement can never land on a row the fence did not prove.
const settleRetry = registerQuery({
  role: "rm_app",
  object: "jobs",
  privileges: ["UPDATE", "SELECT"],
  site: "src/pipeline/queue-store:settleJob.retry",
  purpose: "Put a failed or degraded job back to pending after its backoff, only while this lease still holds it.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `UPDATE jobs
      SET status = 'pending',
          run_after = now() + ($1 || ' seconds')::interval,
          locked_at = NULL, locked_by = NULL,
          last_error = $2, updated_at = now()
      WHERE id = $3 AND locked_by = $4 AND attempts = $5 AND status = 'running' RETURNING id`,
    params: [2, "probe", 0, "probe-worker", 1],
  },
});

const settleFailed = registerQuery({
  role: "rm_app",
  object: "jobs",
  privileges: ["UPDATE", "SELECT"],
  site: "src/pipeline/queue-store:settleJob.failed",
  purpose: "Settle an exhausted or terminal degrade as failed, only while this lease still holds it.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `UPDATE jobs SET status = 'failed', locked_at = NULL, locked_by = NULL,
      last_error = $1, updated_at = now()
      WHERE id = $2 AND locked_by = $3 AND attempts = $4 AND status = 'running' RETURNING id`,
    params: ["probe", 0, "probe-worker", 1],
  },
});

const settleSucceeded = registerQuery({
  role: "rm_app",
  object: "jobs",
  privileges: ["UPDATE", "SELECT"],
  site: "src/pipeline/queue-store:settleJob.succeeded",
  purpose: "Settle a job whose handler returned as succeeded, only while this lease still holds it.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `UPDATE jobs SET status = 'succeeded', locked_at = NULL, locked_by = NULL, last_error = NULL, updated_at = now()
      WHERE id = $1 AND locked_by = $2 AND attempts = $3 AND status = 'running' RETURNING id`,
    params: [0, "probe-worker", 1],
  },
});

const settleDead = registerQuery({
  role: "rm_app",
  object: "jobs",
  privileges: ["UPDATE", "SELECT"],
  site: "src/pipeline/queue-store:settleJob.dead",
  purpose: "Settle a job that threw on its last attempt as dead, only while this lease still holds it.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `UPDATE jobs SET status = 'dead', locked_at = NULL, locked_by = NULL,
      last_error = $1, updated_at = now()
      WHERE id = $2 AND locked_by = $3 AND attempts = $4 AND status = 'running' RETURNING id`,
    params: ["probe", 0, "probe-worker", 1],
  },
});

// RECORDING THE RUN, in the same transaction as the settle: one site per column
// set. Each probe inserts from a query yielding no row, because job_id is a
// foreign key to a real job and the database is blank.
const recordDegradedRun = registerQuery({
  role: "rm_app",
  object: "job_runs",
  privileges: ["INSERT"],
  site: "src/pipeline/queue-store:settleJob.recordDegradedRun",
  purpose: "Record a degraded (or terminally refused) run with its error and the handler's output.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `INSERT INTO job_runs (job_id, kind, started_at, finished_at, status, error, output)
      SELECT $1::bigint, $2, $3::timestamptz, now(), $4, $5, $6::jsonb WHERE false`,
    params: [0, "noop", "2026-01-01T00:00:00Z", "degraded", "probe", "{}"],
  },
});

const recordSucceededRun = registerQuery({
  role: "rm_app",
  object: "job_runs",
  privileges: ["INSERT"],
  site: "src/pipeline/queue-store:settleJob.recordSucceededRun",
  purpose: "Record a succeeded run with the handler's output.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `INSERT INTO job_runs (job_id, kind, started_at, finished_at, status, output)
      SELECT $1::bigint, $2, $3::timestamptz, now(), 'succeeded', $4::jsonb WHERE false`,
    params: [0, "noop", "2026-01-01T00:00:00Z", "{}"],
  },
});

const recordFailedRun = registerQuery({
  role: "rm_app",
  object: "job_runs",
  privileges: ["INSERT"],
  site: "src/pipeline/queue-store:settleJob.recordFailedRun",
  purpose: "Record a run whose handler threw, as failed (a retry follows) or dead.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `INSERT INTO job_runs (job_id, kind, started_at, finished_at, status, error)
      SELECT $1::bigint, $2, $3::timestamptz, now(), $4, $5 WHERE false`,
    params: [0, "noop", "2026-01-01T00:00:00Z", "failed", "probe"],
  },
});

const releaseJobs = registerQuery({
  role: "rm_app",
  object: "jobs",
  // SELECT because the WHERE and RETURNING read the rows.
  privileges: ["UPDATE", "SELECT"],
  site: "src/pipeline/queue-store:releaseOwnedJobs",
  purpose: "Hand a stopping worker's running jobs back to pending.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL,
          last_error = COALESCE(last_error, '') || ' [released: worker shutdown]', updated_at = now()
      WHERE status = 'running' AND locked_by = $1 RETURNING id`,
    params: ["probe-worker"],
  },
});

const reapJobs = registerQuery({
  role: "rm_app",
  object: "jobs",
  // SELECT because the WHERE and RETURNING read the rows.
  privileges: ["UPDATE", "SELECT"],
  site: "src/pipeline/queue-store:reapStuckJobs",
  purpose: "Requeue (or kill, once attempts are spent) running jobs whose lease expired with their worker.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `UPDATE jobs
      SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
          run_after = now() + (LEAST(3600, POWER(2, attempts))::int || ' seconds')::interval,
          locked_at = NULL, locked_by = NULL,
          last_error = COALESCE(last_error, '') || ' [reaped: lock expired]', updated_at = now()
      WHERE status = 'running' AND locked_at < now() - ($1 || ' seconds')::interval
      RETURNING id`,
    params: [300],
  },
});

const dueSchedules = registerQuery({
  role: "rm_app",
  object: "job_schedules",
  // UPDATE for FOR UPDATE SKIP LOCKED, which locks the due rows.
  privileges: ["SELECT", "UPDATE"],
  site: "src/pipeline/queue-store:tickScheduler.due",
  purpose: "Lock the enabled schedules that are due, skipping any another scheduler holds.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `SELECT id, kind, cron, payload, timezone, next_run_at, catchup_policy FROM job_schedules
      WHERE enabled AND (next_run_at IS NULL OR next_run_at <= now())
      FOR UPDATE SKIP LOCKED`,
  },
});

const setNextRun = registerQuery({
  role: "rm_app",
  object: "job_schedules",
  // SELECT because the WHERE reads the row.
  privileges: ["UPDATE", "SELECT"],
  site: "src/pipeline/queue-store:tickScheduler.setNextRun",
  purpose: "Give a schedule with no next run its first one, from its cron.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: "UPDATE job_schedules SET next_run_at = $1::timestamptz WHERE id = $2",
    params: ["2026-01-01T00:00:00Z", 0],
  },
});

const enqueueSlot = registerQuery({
  role: "rm_app",
  object: "jobs",
  // SELECT for RETURNING and the ON CONFLICT arbiter.
  privileges: ["INSERT", "SELECT"],
  site: "src/pipeline/queue-store:tickScheduler.enqueue",
  purpose: "Enqueue one schedule slot's job, idempotent on its dedupe key.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `INSERT INTO jobs (kind, payload, dedupe_key) VALUES ($1, $2::jsonb, $3)
      ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
      RETURNING id`,
    params: ["noop", "{}", "noop:probe"],
  },
});

const advanceSchedule = registerQuery({
  role: "rm_app",
  object: "job_schedules",
  // SELECT because the WHERE reads the row.
  privileges: ["UPDATE", "SELECT"],
  site: "src/pipeline/queue-store:tickScheduler.advance",
  purpose: "Stamp a schedule's last enqueue and move its next run past now.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: "UPDATE job_schedules SET last_enqueued_at = now(), next_run_at = $1::timestamptz WHERE id = $2",
    params: ["2026-01-01T00:00:00Z", 0],
  },
});

// One statement, two declarations: it updates jobs and reads job_schedules for
// each kind's catch-up policy.
const SWEEP_PROBE = {
  statement: `WITH policy AS (
      SELECT kind, min(catchup_policy) AS catchup_policy FROM job_schedules
      WHERE enabled GROUP BY kind
      HAVING count(DISTINCT catchup_policy) = 1 AND min(catchup_policy) IN ('latest-only', 'collapse-per-bucket')
    ), live AS (
      SELECT j.id, j.kind, p.catchup_policy,
        coalesce(j.payload->>'slotAt', to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS slot
      FROM jobs j JOIN policy p ON p.kind = j.kind
      WHERE j.status = 'pending' OR (j.status = 'running' AND j.locked_at < now() - ($1 || ' seconds')::interval)
    ), ranked AS (
      SELECT id, row_number() OVER (
        PARTITION BY kind, CASE WHEN catchup_policy = 'collapse-per-bucket' THEN left(slot, 10) END
        ORDER BY slot DESC, id DESC) AS rn
      FROM live
    )
    UPDATE jobs j SET status = 'cancelled', locked_at = NULL, locked_by = NULL,
      last_error = 'superseded at worker start', updated_at = now()
    FROM ranked
    WHERE j.id = ranked.id AND ranked.rn > 1
      AND (j.status = 'pending' OR (j.status = 'running' AND j.locked_at < now() - ($2 || ' seconds')::interval))
    RETURNING j.id, j.kind`,
  params: [300, 300],
};

const sweepJobs = registerQuery({
  role: "rm_app",
  object: "jobs",
  // SELECT because the WHERE, the CTE and RETURNING read the rows.
  privileges: ["UPDATE", "SELECT"],
  site: "src/pipeline/queue-store:sweepStaleBacklog",
  purpose: "Cancel every queued slot of a latest-only or collapse-per-bucket kind that a newer slot supersedes, before a worker's first claim.",
  callers: PIPELINE_ROUTE,
  probe: SWEEP_PROBE,
});

const sweepSchedules = registerQuery({
  role: "rm_app",
  object: "job_schedules",
  privileges: ["SELECT"],
  site: "src/pipeline/queue-store:sweepStaleBacklog.policy",
  purpose: "Read each kind's catch-up policy for the worker-start backlog sweep.",
  callers: PIPELINE_ROUTE,
  probe: SWEEP_PROBE,
});

const enqueueJobSql = registerQuery({
  role: "rm_app",
  object: "jobs",
  // SELECT for RETURNING, the ON CONFLICT arbiter and the NOT EXISTS guard.
  privileges: ["INSERT", "SELECT"],
  site: "src/pipeline/queue-store:enqueueJob",
  purpose: "Enqueue one job a handler dispatches, idempotent on its dedupe key, and skipped while a live job of the same kind exists when asked.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `INSERT INTO jobs (kind, payload, dedupe_key)
      SELECT $1, $2::jsonb, $3
       WHERE NOT ($4::boolean AND EXISTS (
               SELECT 1 FROM jobs WHERE kind = $5 AND status IN ('pending', 'running')))
      ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
      RETURNING id`,
    params: ["noop", "{}", null, false, "noop"],
  },
});

const liveJobPayloads = registerQuery({
  role: "rm_app",
  object: "jobs",
  privileges: ["SELECT"],
  site: "src/pipeline/queue-store:livePayloadField",
  purpose: "List one payload field of every pending or running job of a kind, so a dispatcher skips work a live job already covers.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: "SELECT payload->>$1 AS value FROM jobs WHERE kind = $2 AND status IN ('pending', 'running')",
    params: ["asof", "wallet.backfill_day"],
  },
});

/** A lane's claim allowlist, as the worker's WORKER_LANE resolves it (worker/lanes.ts). */
export interface LaneFilter {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/**
 * Claim exactly one due job within the lane's kind allowlist, lock it, and
 * return it with the attempt number the claim gave it. Concurrency-safe across
 * N workers via FOR UPDATE SKIP LOCKED.
 *
 * `, id` IS LOAD-BEARING (issue #806): `run_after` is a millisecond instant that
 * same-priority jobs routinely share, and without a tiebreak the claim order
 * among equals is whatever the plan returns. `id` is insertion order, which is
 * the order the enqueuer intended.
 */
export async function claimJob(db: RegistryDb, lane: LaneFilter, workerId: string): Promise<ClaimedJob | null> {
  const claimed = await on(db, claimJobSql)<ClaimedJob>`
    WITH claimed AS (
      SELECT id FROM jobs
      WHERE status = 'pending' AND run_after <= now()
        AND kind LIKE ANY(${[...lane.include]})
        AND kind NOT LIKE ALL(${[...lane.exclude]})
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
  return job ? { id: Number(job.id), kind: job.kind, payload: job.payload, attempts: job.attempts, max_attempts: job.max_attempts } : null;
}

/** Renew `lease`. False when the reaper, an operator or a newer claim took the job. */
export async function renewLease(db: RegistryDb, lease: PipelineLease): Promise<boolean> {
  const kept = await on(db, renewLeaseSql)`
    UPDATE jobs SET locked_at = now(), updated_at = now()
     WHERE id = ${lease.jobId} AND locked_by = ${lease.workerId} AND attempts = ${lease.attempt} AND status = 'running' RETURNING id`;
  return kept.length > 0;
}

/** The fenced job row, locked until the caller's transaction ends, or null when the lease is lost. */
export async function fenceLease(
  db: RegistryDb,
  lease: PipelineLease,
): Promise<{ kind: string; attempts: number; max_attempts: number } | null> {
  const [row] = await on(db, fenceJob)<{ kind: string; attempts: number; max_attempts: number }>`
    SELECT kind, attempts, max_attempts FROM jobs
     WHERE id = ${lease.jobId} AND locked_by = ${lease.workerId} AND attempts = ${lease.attempt} AND status = 'running'
     FOR UPDATE`;
  return row ?? null;
}

const MAX_BACKOFF_SECONDS = 3600;

/** What a settle did: the job's new status, or that the lease was lost and nothing was written. */
export type SettleResult =
  | { readonly settled: true; readonly status: "succeeded" | "pending" | "failed" | "dead"; readonly backoffSeconds: number | null }
  | { readonly settled: false };

/**
 * Settle a claimed job and record its run, in `tx`, only while `lease` holds.
 *
 * The rules are the worker loop's (worker/loop.ts before issue 1034):
 *   - succeeded: status 'succeeded', a 'succeeded' run with the output.
 *   - degraded: retried with exponential backoff while attempts remain and the
 *     degrade is not terminal; otherwise settled 'failed' (never 'dead': the
 *     last-persisted rows are intact and the schedule keeps firing). The run is
 *     'degraded', or 'failed' for a terminal refusal.
 *   - failed (the handler threw): retried with backoff while attempts remain,
 *     else 'dead'. The run is 'failed' or 'dead'.
 * A lease that no longer holds writes nothing.
 */
export async function settleJob(
  tx: RegistryDb,
  lease: PipelineLease,
  outcome: SettleOutcome,
  startedAt: Date,
): Promise<SettleResult> {
  const job = await fenceLease(tx, lease);
  if (!job) return { settled: false };
  const { jobId: id, workerId, attempt } = lease;
  const backoff = Math.min(MAX_BACKOFF_SECONDS, Math.pow(2, job.attempts));

  if (outcome.kind === "succeeded") {
    await on(tx, settleSucceeded)`UPDATE jobs SET status = 'succeeded', locked_at = NULL, locked_by = NULL, last_error = NULL, updated_at = now()
                         WHERE id = ${id} AND locked_by = ${workerId} AND attempts = ${attempt} AND status = 'running' RETURNING id`;
    await on(tx, recordSucceededRun)`INSERT INTO job_runs (job_id, kind, started_at, finished_at, status, output)
             VALUES (${id}, ${job.kind}, ${startedAt}, now(), 'succeeded', ${tx.json(jsonValue(outcome.output ?? null))})`;
    return { settled: true, status: "succeeded", backoffSeconds: null };
  }

  if (outcome.kind === "degraded") {
    const canRetry = !outcome.terminal && job.attempts < job.max_attempts;
    if (canRetry) {
      await on(tx, settleRetry)`UPDATE jobs
                    SET status = 'pending',
                        run_after = now() + (${backoff} || ' seconds')::interval,
                        locked_at = NULL, locked_by = NULL,
                        last_error = ${outcome.error}, updated_at = now()
                  WHERE id = ${id} AND locked_by = ${workerId} AND attempts = ${attempt} AND status = 'running' RETURNING id`;
    } else {
      await on(tx, settleFailed)`UPDATE jobs
                    SET status = 'failed', locked_at = NULL, locked_by = NULL,
                        last_error = ${outcome.error}, updated_at = now()
                  WHERE id = ${id} AND locked_by = ${workerId} AND attempts = ${attempt} AND status = 'running' RETURNING id`;
    }
    await on(tx, recordDegradedRun)`INSERT INTO job_runs (job_id, kind, started_at, finished_at, status, error, output)
             VALUES (${id}, ${job.kind}, ${startedAt}, now(), ${outcome.terminal ? "failed" : "degraded"}, ${outcome.error}, ${tx.json(jsonValue(outcome.output ?? null))})`;
    return { settled: true, status: canRetry ? "pending" : "failed", backoffSeconds: canRetry ? backoff : null };
  }

  const canRetry = job.attempts < job.max_attempts;
  if (canRetry) {
    await on(tx, settleRetry)`UPDATE jobs
                  SET status = 'pending',
                      run_after = now() + (${backoff} || ' seconds')::interval,
                      locked_at = NULL, locked_by = NULL,
                      last_error = ${outcome.error}, updated_at = now()
                WHERE id = ${id} AND locked_by = ${workerId} AND attempts = ${attempt} AND status = 'running' RETURNING id`;
  } else {
    await on(tx, settleDead)`UPDATE jobs
                  SET status = 'dead', locked_at = NULL, locked_by = NULL,
                      last_error = ${outcome.error}, updated_at = now()
                WHERE id = ${id} AND locked_by = ${workerId} AND attempts = ${attempt} AND status = 'running' RETURNING id`;
  }
  await on(tx, recordFailedRun)`INSERT INTO job_runs (job_id, kind, started_at, finished_at, status, error)
           VALUES (${id}, ${job.kind}, ${startedAt}, now(), ${canRetry ? "failed" : "dead"}, ${outcome.error})`;
  return { settled: true, status: canRetry ? "pending" : "dead", backoffSeconds: canRetry ? backoff : null };
}

/** Release every job still owned by `workerId` back to 'pending' (a stopping worker's bounded shutdown). */
export async function releaseOwnedJobs(db: RegistryDb, workerId: string): Promise<number> {
  const released = await on(db, releaseJobs)`
    UPDATE jobs
       SET status = 'pending',
           locked_at = NULL, locked_by = NULL,
           last_error = COALESCE(last_error, '') || ' [released: worker shutdown]',
           updated_at = now()
     WHERE status = 'running' AND locked_by = ${workerId}
     RETURNING id`;
  return released.length;
}

/**
 * Requeue jobs that have been 'running' longer than `visibilitySeconds` (their
 * worker presumably crashed), with the same exponential backoff as a caught
 * failure; exhausted jobs go to 'dead'.
 */
export async function reapStuckJobs(db: RegistryDb, visibilitySeconds: number): Promise<number> {
  const reaped = await on(db, reapJobs)`
    UPDATE jobs
       SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
           run_after = now() + (LEAST(3600, POWER(2, attempts))::int || ' seconds')::interval,
           locked_at = NULL,
           locked_by = NULL,
           last_error = COALESCE(last_error, '') || ' [reaped: lock expired]',
           updated_at = now()
     WHERE status = 'running'
       AND locked_at < now() - (${visibilitySeconds} || ' seconds')::interval
     RETURNING id
  `;
  return reaped.length;
}

interface ScheduleRow {
  id: number;
  kind: string;
  cron: string;
  payload: Record<string, unknown>;
  timezone: string;
  next_run_at: Date | null;
  catchup_policy: "all" | "collapse-per-bucket" | "latest-only";
}

// Catch-up is bounded per tick so one wedged schedule can't hold the
// transaction (and therefore every other schedule's SKIP LOCKED row) open
// indefinitely. A schedule left behind by more than this many slots simply
// takes several ticks to fully drain.
const MAX_SLOTS_PER_TICK = 1000;

/**
 * Enqueue jobs for any schedule whose next_run_at is due, then advance
 * next_run_at to the following cron occurrence, in `tx`. Multiple schedulers
 * are safe: rows are claimed with SKIP LOCKED, and the dedupe_key (kind + slot
 * minute) guarantees a given slot enqueues at most once.
 *
 * Catch-up policies: 'all' enqueues every missed slot; 'collapse-per-bucket'
 * (issue #651) only the last slot of each UTC day in this tick's batch;
 * 'latest-only' (issue 1378) only the newest due slot. Each slot's own instant
 * rides in the payload as `slotAt` (issue #614 AC2).
 *
 * CLAMP (issue #614): the cursor advances to the slot just processed on every
 * iteration, so a schedule more than MAX_SLOTS_PER_TICK slots behind drains a
 * fresh batch each tick and is never left pinned on one stale next_run_at.
 */
export async function tickScheduler(tx: RegistryDb): Promise<number> {
  const due = await on(tx, dueSchedules)<ScheduleRow>`
    SELECT id, kind, cron, payload, timezone, next_run_at, catchup_policy
      FROM job_schedules
     WHERE enabled AND (next_run_at IS NULL OR next_run_at <= now())
     FOR UPDATE SKIP LOCKED
  `;

  let enqueued = 0;
  const now = new Date();
  for (const s of due) {
    if (s.next_run_at == null) {
      // Brand-new schedule: seed next_run_at to the next FUTURE occurrence
      // without firing a stale past slot.
      const it = parser.parseExpression(s.cron, { tz: s.timezone, currentDate: now });
      await on(tx, setNextRun)`UPDATE job_schedules SET next_run_at = ${it.next().toDate()} WHERE id = ${s.id}`;
      continue;
    }
    const it = parser.parseExpression(s.cron, { tz: s.timezone, currentDate: new Date(s.next_run_at.getTime() - 1000) });
    let nextRun = new Date(s.next_run_at);
    let pendingBucket: string | null = null;
    let pendingSlotDate: Date | null = null;
    const insertSlot = async (slotDate: Date) => {
      const slot = slotDate.toISOString().slice(0, 16).replace(/[-:T]/g, "");
      const payload = { ...s.payload, slotAt: slotDate.toISOString() };
      const inserted = await on(tx, enqueueSlot)`
        INSERT INTO jobs (kind, payload, dedupe_key)
        VALUES (${s.kind}, ${tx.json(jsonValue(payload))}, ${`${s.kind}:${slot}`})
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
        RETURNING id`;
      if (inserted.length > 0) enqueued++;
    };
    for (let guard = 0; guard < MAX_SLOTS_PER_TICK; guard++) {
      const slotDate = it.next().toDate();
      if (slotDate > now) { nextRun = slotDate; break; }
      if (s.catchup_policy === "collapse-per-bucket" || s.catchup_policy === "latest-only") {
        // UTC calendar day, or one bucket for the whole backlog.
        const bucket = s.catchup_policy === "latest-only" ? "latest" : slotDate.toISOString().slice(0, 10);
        if (pendingBucket !== null && bucket !== pendingBucket) await insertSlot(pendingSlotDate!);
        pendingBucket = bucket;
        pendingSlotDate = slotDate;
      } else {
        await insertSlot(slotDate);
      }
      nextRun = slotDate;
    }
    // Flush whichever slot is the last-seen occupant of its bucket.
    if (s.catchup_policy !== "all" && pendingSlotDate) await insertSlot(pendingSlotDate);
    await on(tx, advanceSchedule)`UPDATE job_schedules SET last_enqueued_at = now(), next_run_at = ${nextRun} WHERE id = ${s.id}`;
  }
  return enqueued;
}

/**
 * Cancel every superseded slot still queued, before a worker's first claim
 * (issue 1378). Scope: kinds whose enabled schedules all carry one policy, and
 * that policy is 'latest-only' or 'collapse-per-bucket'. A pending row, or a
 * running row whose lease expired, is cancelled unless it is the newest slot of
 * its kind ('latest-only') or of its kind and UTC day ('collapse-per-bucket'). A
 * running row whose lease is live is never touched, and no row is deleted.
 */
export async function sweepStaleBacklog(db: RegistryDb, leaseSeconds: number): Promise<{ id: number; kind: string }[]> {
  const cancelled = await on(db, sweepJobs, sweepSchedules)<{ id: number; kind: string }>`
    WITH policy AS (
      SELECT kind, min(catchup_policy) AS catchup_policy FROM job_schedules
      WHERE enabled GROUP BY kind
      HAVING count(DISTINCT catchup_policy) = 1 AND min(catchup_policy) IN ('latest-only', 'collapse-per-bucket')
    ), live AS (
      SELECT j.id, j.kind, p.catchup_policy,
        coalesce(j.payload->>'slotAt', to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS slot
      FROM jobs j JOIN policy p ON p.kind = j.kind
      WHERE j.status = 'pending' OR (j.status = 'running' AND j.locked_at < now() - (${leaseSeconds} || ' seconds')::interval)
    ), ranked AS (
      SELECT id, row_number() OVER (
        PARTITION BY kind, CASE WHEN catchup_policy = 'collapse-per-bucket' THEN left(slot, 10) END
        ORDER BY slot DESC, id DESC) AS rn
      FROM live
    )
    UPDATE jobs j SET status = 'cancelled', locked_at = NULL, locked_by = NULL,
      last_error = 'superseded at worker start', updated_at = now()
    FROM ranked
    WHERE j.id = ranked.id AND ranked.rn > 1
      AND (j.status = 'pending' OR (j.status = 'running' AND j.locked_at < now() - (${leaseSeconds} || ' seconds')::interval))
    RETURNING j.id, j.kind
  `;
  return cancelled.map((r) => ({ id: Number(r.id), kind: r.kind }));
}

/** One job a handler dispatches. */
export interface EnqueueRequest {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  /** Idempotent on this key across the whole jobs table, terminal rows included. */
  readonly dedupeKey: string | null;
  /** Enqueue nothing while a pending or running job of `kind` exists. */
  readonly unlessLive: boolean;
}

/** Enqueue `req`. Returns the new job id, or null when the dedupe key or a live job of the kind suppressed it. */
export async function enqueueJob(db: RegistryDb, req: EnqueueRequest): Promise<number | null> {
  const [row] = await on(db, enqueueJobSql)<{ id: number }>`
    INSERT INTO jobs (kind, payload, dedupe_key)
    SELECT ${req.kind}, ${db.json(jsonValue(req.payload))}, ${req.dedupeKey}
     WHERE NOT (${req.unlessLive}::boolean AND EXISTS (
             SELECT 1 FROM jobs WHERE kind = ${req.kind} AND status IN ('pending', 'running')))
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING id`;
  return row ? Number(row.id) : null;
}

/** The value of payload field `field` on every pending or running job of `kind`. */
export async function livePayloadField(db: RegistryDb, kind: string, field: string): Promise<(string | null)[]> {
  const rows = await on(db, liveJobPayloads)<{ value: string | null }>`
    SELECT payload->>${field} AS value FROM jobs WHERE kind = ${kind} AND status IN ('pending', 'running')`;
  return rows.map((r) => r.value);
}
