import { sql } from "../db/client.ts";
import { config } from "../config.ts";
import { getHandler } from "./handlers/index.ts";

const MAX_BACKOFF_SECONDS = 3600;

interface JobRow {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

// Claim exactly one due job, lock it, run its handler, and record the outcome.
// Concurrency-safe across N workers via FOR UPDATE SKIP LOCKED.
// Returns true if a job was processed (caller can poll faster when busy).
export async function processOneJob(): Promise<boolean> {
  const claimed = await sql<JobRow[]>`
    WITH claimed AS (
      SELECT id FROM jobs
      WHERE status = 'pending' AND run_after <= now()
      ORDER BY priority DESC, run_after
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE jobs j
       SET status = 'running',
           attempts = attempts + 1,
           locked_at = now(),
           locked_by = ${config.workerId},
           updated_at = now()
      FROM claimed
     WHERE j.id = claimed.id
     RETURNING j.id, j.kind, j.payload, j.attempts, j.max_attempts
  `;

  const job = claimed[0];
  if (!job) return false;

  const startedAt = new Date();
  const handler = getHandler(job.kind);

  try {
    if (!handler) throw new Error(`no handler registered for kind "${job.kind}"`);
    const output = await handler(job.payload);
    await sql.begin(async (tx) => {
      await tx`UPDATE jobs SET status = 'succeeded', locked_at = NULL, locked_by = NULL, last_error = NULL, updated_at = now() WHERE id = ${job.id}`;
      await tx`INSERT INTO job_runs (job_id, kind, started_at, finished_at, status, output)
               VALUES (${job.id}, ${job.kind}, ${startedAt}, now(), 'succeeded', ${tx.json(output ?? null)})`;
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    const canRetry = job.attempts < job.max_attempts;
    const backoff = Math.min(MAX_BACKOFF_SECONDS, Math.pow(2, job.attempts));
    await sql.begin(async (tx) => {
      if (canRetry) {
        await tx`UPDATE jobs
                    SET status = 'pending',
                        run_after = now() + (${backoff} || ' seconds')::interval,
                        locked_at = NULL, locked_by = NULL,
                        last_error = ${message}, updated_at = now()
                  WHERE id = ${job.id}`;
      } else {
        await tx`UPDATE jobs
                    SET status = 'dead', locked_at = NULL, locked_by = NULL,
                        last_error = ${message}, updated_at = now()
                  WHERE id = ${job.id}`;
      }
      await tx`INSERT INTO job_runs (job_id, kind, started_at, finished_at, status, error)
               VALUES (${job.id}, ${job.kind}, ${startedAt}, now(), ${canRetry ? "failed" : "dead"}, ${message})`;
    });
    console.error(`job ${job.id} (${job.kind}) failed${canRetry ? `, retry in ${backoff}s` : " — DEAD"}: ${message.split("\n")[0]}`);
    return true;
  }
}
