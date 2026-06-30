import { sql } from "../db/client.ts";

const VISIBILITY_TIMEOUT_SECONDS = Number(process.env.JOB_VISIBILITY_TIMEOUT ?? 300);

// Requeue jobs that have been 'running' longer than the visibility timeout —
// their worker presumably crashed. Bounded by max_attempts: exhausted jobs go
// to 'dead' instead of looping forever.
export async function reapStuckJobs(): Promise<number> {
  // Requeued jobs get the same exponential backoff as caught failures (so a
  // handler that hard-crashes the process doesn't immediately re-run with no
  // spacing): run_after = now() + 2^attempts seconds (capped at 1h).
  const reaped = await sql`
    UPDATE jobs
       SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
           run_after = now() + (LEAST(3600, POWER(2, attempts))::int || ' seconds')::interval,
           locked_at = NULL,
           locked_by = NULL,
           last_error = COALESCE(last_error, '') || ' [reaped: lock expired]',
           updated_at = now()
     WHERE status = 'running'
       AND locked_at < now() - (${VISIBILITY_TIMEOUT_SECONDS} || ' seconds')::interval
     RETURNING id
  `;
  if (reaped.length > 0) console.warn(`reaper requeued/killed ${reaped.length} stuck job(s)`);
  return reaped.length;
}
