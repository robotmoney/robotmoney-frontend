// The worker's reaper tick. The api requeues the expired leases
// (pipeline/queue-store.ts reapStuckJobs, issue 1034, decision D75).
import { reapStuckJobs as reap } from "./pipeline-client.ts";

// Read per call (not at module load) so tests can shorten the window; a live
// owner renews `locked_at` on a fraction of this interval (loop.ts lease
// renewal), so only genuinely crashed/abandoned owners ever trip it.
const visibilityTimeoutSeconds = () => Number(process.env.JOB_VISIBILITY_TIMEOUT ?? 300);

// Requeue jobs that have been 'running' longer than the visibility timeout —
// their worker presumably crashed. Bounded by max_attempts: exhausted jobs go
// to 'dead' instead of looping forever, and a requeued job gets the same
// exponential backoff as a caught failure.
export async function reapStuckJobs(): Promise<number> {
  const reaped = await reap(visibilityTimeoutSeconds());
  if (reaped > 0) console.warn(`reaper requeued/killed ${reaped} stuck job(s)`);
  return reaped;
}
