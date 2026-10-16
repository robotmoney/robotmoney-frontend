import { sql } from "../db/worker-client.ts";
import { on, registerQuery } from "../db/registry.ts";

// A registered query (smoke-production-spec.md §7.1), on the worker's own
// pool, driven by the worker process's reaper loop.
const reapJobs = registerQuery({
  role: "rm_worker",
  object: "jobs",
  // SELECT because the WHERE and RETURNING read the rows.
  privileges: ["UPDATE", "SELECT"],
  site: "src/worker/reaper:reapStuckJobs",
  purpose: "Requeue (or kill, once attempts are spent) running jobs whose lease expired with their worker.",
  callers: ["src/worker/index"],
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

// Read per call (not at module load) so tests can shorten the window; a live
// owner renews `locked_at` on a fraction of this interval (loop.ts lease
// renewal), so only genuinely crashed/abandoned owners ever trip it.
const visibilityTimeoutSeconds = () => Number(process.env.JOB_VISIBILITY_TIMEOUT ?? 300);

// Requeue jobs that have been 'running' longer than the visibility timeout —
// their worker presumably crashed. Bounded by max_attempts: exhausted jobs go
// to 'dead' instead of looping forever.
export async function reapStuckJobs(): Promise<number> {
  // Requeued jobs get the same exponential backoff as caught failures (so a
  // handler that hard-crashes the process doesn't immediately re-run with no
  // spacing): run_after = now() + 2^attempts seconds (capped at 1h).
  const reaped = await on(sql, reapJobs)`
    UPDATE jobs
       SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
           run_after = now() + (LEAST(3600, POWER(2, attempts))::int || ' seconds')::interval,
           locked_at = NULL,
           locked_by = NULL,
           last_error = COALESCE(last_error, '') || ' [reaped: lock expired]',
           updated_at = now()
     WHERE status = 'running'
       AND locked_at < now() - (${visibilityTimeoutSeconds()} || ' seconds')::interval
     RETURNING id
  `;
  if (reaped.length > 0) console.warn(`reaper requeued/killed ${reaped.length} stuck job(s)`);
  return reaped.length;
}
