// Lane-scoped worker runtime (issue #107). Owns the three loops a worker runs
// (lane-filtered claim drain, scheduler tick, reaper tick) behind a start/stop
// handle so the process entry (index.ts) stays thin and tests can run several
// concurrent lane workers in-process with independent worker ids.
//
// Shutdown contract: stop() halts claiming immediately, waits for the in-flight
// job up to `shutdownTimeoutMs` (BOUNDED exit), then releases any job still
// owned by this worker back to 'pending' — a stopped worker never leaves an
// orphaned 'running' row, and the ownership-guarded terminal writes in loop.ts
// discard a hung handler's eventual result (no duplicate job_runs).
import { config } from "../config.ts";
import { processOneJob, releaseOwnedJobs } from "./loop.ts";
import { tickScheduler } from "./scheduler.ts";
import { reapStuckJobs } from "./reaper.ts";
import { describeLane, type Lane } from "./lanes.ts";

export interface WorkerOptions {
  lane: Lane;
  /** Owner id for locked_by/logs. Default: WORKER_ID env, else `<lane>-<pid>`. */
  workerId?: string;
  idlePollMs?: number;
  schedulerTickMs?: number;
  reaperTickMs?: number;
  /** Max time stop() waits for an in-flight job before releasing it. */
  shutdownTimeoutMs?: number;
}

export interface WorkerHandle {
  readonly workerId: string;
  readonly lane: Lane;
  /** Idempotent bounded shutdown (safe to call from several signal handlers). */
  stop(): Promise<void>;
}

export function startWorker(opts: WorkerOptions): WorkerHandle {
  const lane = opts.lane;
  // Lane-aware worker id: an explicit WORKER_ID wins, otherwise the id carries
  // the lane name so locked_by, logs, and the admin jobs dashboard all show
  // WHICH lane owns a job.
  const workerId = opts.workerId ?? process.env.WORKER_ID ?? `${lane.name}-${process.pid}`;
  const idlePollMs = opts.idlePollMs ?? Number(process.env.WORKER_IDLE_POLL_MS ?? 2000);
  const schedulerTickMs = opts.schedulerTickMs ?? Number(process.env.SCHEDULER_TICK_MS ?? 30_000);
  const reaperTickMs = opts.reaperTickMs ?? Number(process.env.REAPER_TICK_MS ?? 60_000);
  const shutdownTimeoutMs = opts.shutdownTimeoutMs ?? Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS ?? 30_000);

  let running = true;
  const stopped = new AbortController();

  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (stopped.signal.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      stopped.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  async function drainLoop(): Promise<void> {
    while (running) {
      try {
        const did = await processOneJob({ lane, workerId });
        if (!did) await sleep(idlePollMs); // nothing to do — back off
      } catch (err) {
        console.error(`[${workerId}] loop error:`, err);
        await sleep(idlePollMs);
      }
    }
  }

  async function periodic(label: string, fn: () => Promise<unknown>, everyMs: number): Promise<void> {
    while (running) {
      try {
        await fn();
      } catch (err) {
        console.error(`[${workerId}] ${label} error:`, err);
      }
      await sleep(everyMs);
    }
  }

  // Lane-aware health/status line: names the lane and its claim allowlist so an
  // operator reading logs (or `docker compose logs worker-<lane>`) can see
  // exactly which kinds this worker may claim.
  console.log(`worker ${workerId} starting (lane=${lane.name}, claims: ${describeLane(lane)}, env=${config.env})`);

  // Every lane runs the scheduler + reaper too — both are concurrency-safe
  // (SKIP LOCKED / idempotent UPDATE), so N workers ticking them is harmless
  // and no lane depends on another lane's process being alive.
  const loops = [
    drainLoop(),
    periodic("scheduler", tickScheduler, schedulerTickMs),
    periodic("reaper", reapStuckJobs, reaperTickMs),
  ];

  async function doStop(): Promise<void> {
    running = false;
    stopped.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      Promise.allSettled(loops).then(() => false as const),
      new Promise<true>((resolve) => { timer = setTimeout(() => resolve(true), shutdownTimeoutMs); }),
    ]);
    clearTimeout(timer);
    // Belt-and-braces even on a clean exit: guarantees no 'running' row can
    // remain owned by a stopped worker.
    const released = await releaseOwnedJobs(workerId);
    if (timedOut) {
      console.warn(`worker ${workerId} (lane=${lane.name}) shutdown timed out after ${shutdownTimeoutMs}ms — released ${released} in-flight job(s) back to pending`);
    } else if (released > 0) {
      console.warn(`worker ${workerId} (lane=${lane.name}) released ${released} job(s) on shutdown`);
    }
    console.log(`worker ${workerId} (lane=${lane.name}) stopped`);
  }

  let stopPromise: Promise<void> | null = null;
  return {
    workerId,
    lane,
    stop: () => (stopPromise ??= doStop()),
  };
}
