// What a worker does once, before its first claim (issue 1378).
//
// THE PROBLEM. Every boot of the stack released more work at once than the one
// first-in first-out worker-analytics lane can take. The v0.6.2 stage QA run of
// 2026-10-15 (boot 21:07:25-21:08:10Z on the 19:12Z production dump) showed it:
// the lane claimed analytics.parity_sweep at 21:07:29.62 and it failed
// 'Unable to connect' at 21:07:29.76, before the api listened (21:07:30.47);
// the reaper re-released the dump's 'running' projects.refresh_wallets row; and
// by 21:13 131 jobs were due, with live wallet samplers waiting behind slots of
// 18:36-18:40. On the rolling boot (C10 from 21:23:59.8Z) the worker's first
// claim was a parity sweep under a second after it started.
//
// THE CONTRACT, in the order runtime.ts's drain loop applies it:
//   1. waitForApiReady: no job is claimed until the api's /health answers 200.
//      A rolling boot starts services with `--no-deps`, so compose's
//      depends_on cannot gate it; this in-process wait does.
//   2. tickScheduler once, so this boot's own newest slot of each schedule is
//      already enqueued (scheduler.ts, 'latest-only' and 'collapse-per-bucket'
//      enqueue one slot for a backlog).
//   3. sweepStaleBacklog: every older slot still queued is cancelled.
import { sweepStaleBacklog as sweep } from "./pipeline-client.ts";

// The reason a superseded row carries in last_error. Tests and operators grep it.
export const SUPERSEDED_REASON = "superseded at worker start";

/**
 * Cancel every superseded slot still queued, before the first claim.
 *
 * Scope: kinds whose enabled schedules all carry one policy, and that policy is
 * 'latest-only' or 'collapse-per-bucket'. A kind with an 'all' schedule (or a
 * mix) is untouched: every one of its slots carries distinct work. In scope,
 * a pending row, or a running row whose lease expired (its worker died; the
 * reaper would otherwise requeue it), is cancelled unless it is the newest slot
 * of its kind ('latest-only') or of its kind and UTC day ('collapse-per-bucket').
 * A slot is the payload's slotAt, or for a row enqueued by hand its created_at.
 * A running row whose lease is live belongs to a working worker and is never
 * touched. No row is deleted: each one is settled 'cancelled' with
 * SUPERSEDED_REASON in last_error (pipeline/queue-store.ts spells it).
 */
export async function sweepStaleBacklog(): Promise<{ id: number; kind: string }[]> {
  // The api runs the one UPDATE (pipeline/queue-store.ts sweepStaleBacklog,
  // issue 1034); the lease window is this worker's own setting.
  return sweep(Number(process.env.JOB_VISIBILITY_TIMEOUT ?? 300));
}

export interface ApiReadyOptions {
  /** Aborted by stop(): the wait gives up and the worker claims nothing. */
  signal?: AbortSignal;
  /** First retry delay; doubles up to maxDelayMs. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Called on each failed probe, so the container log says why it waits. */
  onWait?: (detail: string) => void | Promise<void>;
}

/**
 * Resolve once `healthUrl` answers 200, retrying with capped backoff forever
 * (a lane without its api has nothing useful to do). No heartbeat is written
 * while it waits, so the one boot record ages out after the idle budget (about
 * 60 s) and the container shows unhealthy, never a false healthy. Returns false
 * only when `signal` aborts first.
 */
export async function waitForApiReady(healthUrl: string, opts: ApiReadyOptions = {}): Promise<boolean> {
  let delay = opts.initialDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 5_000;
  while (!opts.signal?.aborted) {
    let detail: string;
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return true;
      detail = `HTTP ${res.status}`;
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }
    await opts.onWait?.(`api not ready at ${healthUrl}: ${detail}`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      opts.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    delay = Math.min(maxDelay, delay * 2);
  }
  return false;
}

/**
 * The api's /health URL this worker waits for, or null when it waits for none.
 * WORKER_API_HEALTH_URL wins; else PIPELINE_API_URL (every queue call goes to
 * the api, issue 1034) or ANALYTICS_API_URL, + /health. A worker given none has
 * no api to wait for (tests that drive startWorker in-process).
 */
export function resolveApiHealthUrl(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = env.WORKER_API_HEALTH_URL?.trim();
  if (explicit) return explicit;
  const base = env.PIPELINE_API_URL?.trim() || env.ANALYTICS_API_URL?.trim();
  return base ? `${base.replace(/\/+$/, "")}/health` : null;
}
