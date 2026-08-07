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
import { heartbeatPath, writeHeartbeat } from "../ops/heartbeat.ts";

export interface WorkerOptions {
  lane: Lane;
  /** Owner id for locked_by/logs. Default: WORKER_ID env, else `<lane>-<pid>`. */
  workerId?: string;
  idlePollMs?: number;
  schedulerTickMs?: number;
  reaperTickMs?: number;
  /** Max time stop() waits for an in-flight job before releasing it. */
  shutdownTimeoutMs?: number;
  /** Liveness file this lane's drain loop reports progress into. Default:
   *  HEARTBEAT_FILE, else /tmp/heartbeat. Tests running several lanes in ONE
   *  process must give each its own path. */
  heartbeatFile?: string;
  /** How long a heartbeat written while IDLE stays valid. */
  idleProgressTimeoutMs?: number;
  /** How long a heartbeat written while EXECUTING A JOB stays valid. */
  jobProgressTimeoutMs?: number;
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

  // LIVENESS BUDGETS (src/ops/heartbeat.ts). Two of them, because "the loop is
  // progressing" means different things depending on what it is doing:
  //
  //  - IDLE: a lane with nothing queued still completes a claim query every
  //    `idlePollMs` (2s by default), so this budget only has to clear that plus
  //    the healthcheck's own interval. 60s is ~30 poll cycles — an idle lane can
  //    never flicker red (acceptance: idleness is not failure), while a claim
  //    query wedged on a stuck transaction is reported within a minute.
  //    A lane that has LOST ITS DATABASE also lands here: processOneJob throws,
  //    the catch logs and writes a `faulted` beat back on THIS (IDLE) budget —
  //    even if the failure happened mid-job, after onClaim had already widened
  //    the deadline to the 15-minute BUSY budget below — so a lost database is
  //    always caught within ~60s, never up to 15 minutes late. The beat proves
  //    the loop isn't deadlocked without claiming the database is up; repeated
  //    failures still age the record out and the lane goes unhealthy — the
  //    same "alive but not serving" distinction the api's /health check makes.
  //
  //  - BUSY: one claimed job blocks the drain loop for its whole duration, so
  //    this is a policy statement — no single job may occupy a lane longer than
  //    this without the lane counting as stalled. 15 minutes clears the slowest
  //    legitimate unit of work by a wide margin (a swarm lifecycle job's
  //    inference calls are individually bounded by OPENCODE_TIMEOUT_MS, 120s by
  //    default) while still catching the case this whole file exists for: a
  //    handler blocked forever on a hung fetch.
  //
  // Deliberately NOT driven off the job's lease renewal (loop.ts): renewal keeps
  // ticking for a wedged handler, so heartbeating from it would paint exactly
  // the failure we are trying to detect green. Overrunning the budget reports
  // `unhealthy` and nothing more — Docker acts on exit codes, not health status,
  // so a lane doing honest slow work is never killed for tripping this.
  const idleProgressTimeoutMs = opts.idleProgressTimeoutMs
    ?? Number(process.env.WORKER_IDLE_PROGRESS_TIMEOUT_MS ?? Math.max(60_000, idlePollMs * 6));
  const jobProgressTimeoutMs = opts.jobProgressTimeoutMs
    ?? Number(process.env.WORKER_JOB_PROGRESS_TIMEOUT_MS ?? 900_000);
  const heartbeatFile = opts.heartbeatFile ?? heartbeatPath();

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

  // Progress is recorded from INSIDE the drain loop, never from a timer: a
  // detached ticker would keep reporting health for a deadlocked loop, which is
  // the whole failure this signal exists to catch.
  function beat(phase: "boot" | "idle" | "busy" | "faulted", staleAfterMs: number, detail?: string): Promise<void> {
    return writeHeartbeat(
      { phase, staleAfterMs, writer: workerId, detail: detail ?? `lane=${lane.name}` },
      { path: heartbeatFile },
    );
  }

  async function drainLoop(): Promise<void> {
    // First record before any work: without it the very first claim query would
    // have to finish before the file exists at all. start_period in compose
    // covers the boot window either way.
    await beat("boot", idleProgressTimeoutMs);
    // Edge-triggered: true once we've already written a `faulted` beat for the
    // CURRENT run of consecutive failures, reset back to false the moment a
    // cycle succeeds again. See the catch branch below for why this can't be
    // unconditional.
    let faulted = false;
    while (running) {
      try {
        const did = await processOneJob({
          lane,
          workerId,
          // Widen the deadline for as long as this job holds the loop.
          onClaim: (job) => void beat("busy", jobProgressTimeoutMs, `job ${job.id} (${job.kind})`),
        });
        // Back to idle terms: a completed cycle — job finished, or a claim query
        // that found nothing — is the unit of progress this lane reports.
        await beat("idle", idleProgressTimeoutMs);
        faulted = false; // a real cycle succeeded — the next failure is a fresh edge
        if (!did) await sleep(idlePollMs); // nothing to do — back off
      } catch (err) {
        // A failing claim/execute cycle is NOT progress on a job — but it IS
        // proof the loop itself is not deadlocked, and critically it must
        // NARROW whatever budget is currently on disk. onClaim (loop.ts,
        // fired before processOneJob's own try/catch) may already have
        // widened the heartbeat to the 15-minute BUSY budget for the job that
        // just threw; skipping the beat here would leave that wide budget in
        // place, so a DB outage mid-job would take up to 15 minutes to report
        // unhealthy instead of the ~60s this loop otherwise guarantees.
        //
        // Write the `faulted` beat on the IDLE budget only on the EDGE from
        // succeeding to failing — not on every repeated failure. The first
        // failure after a success still narrows a stale wide BUSY budget down
        // to the IDLE-sized one immediately (that's the case above). But if we
        // kept writing on every subsequent failure too, each write would
        // refresh `ts` to `now` — and in production idlePollMs (2s default)
        // is LARGER than heartbeat.ts's MIN_WRITE_INTERVAL_MS (1s) write-
        // coalescing window, so consecutive faulted cycles land outside that
        // window and none of them would be suppressed. `ts` would then never
        // stop advancing for as long as the outage lasted, `age` would never
        // exceed the budget, and evaluateHeartbeat() would report the lane
        // healthy FOREVER during a permanent outage — exactly the failure
        // this heartbeat exists to catch. By writing once and then staying
        // silent while `faulted` stays true, the on-disk `ts` freezes at the
        // moment the outage started and ages out honestly past
        // idleProgressTimeoutMs, the same way it did before this file's
        // catch branch wrote anything at all — just narrowed to the right
        // budget first.
        console.error(`[${workerId}] loop error:`, err);
        if (!faulted) {
          await beat("faulted", idleProgressTimeoutMs, `error: ${err instanceof Error ? err.message : String(err)}`);
          faulted = true;
        }
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
  console.log(`worker ${workerId} starting (lane=${lane.name}, claims: ${describeLane(lane)}, env=${config.env}, heartbeat=${heartbeatFile} idle<=${idleProgressTimeoutMs}ms job<=${jobProgressTimeoutMs}ms)`);

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
