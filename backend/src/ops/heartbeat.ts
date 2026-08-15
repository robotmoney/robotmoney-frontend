// Liveness heartbeat shared by the worker lanes and the analytics producer.
//
// WHY A HEARTBEAT AND NOT A PROCESS PROBE
// Docker already restarts a lane whose process exits (`restart: unless-stopped`
// in docker-compose.yml), so a healthcheck that only proves the process exists
// (`CMD true`, `pgrep bun`) adds nothing — and it actively lies, because it
// paints a WEDGED worker green. The failure mode worth reporting is "alive but
// not making progress": the drain loop blocked on a hung fetch or a stuck
// transaction, so the process is up and the container looks fine while no jobs
// get claimed. That is what this file detects.
//
// THE RULE THAT KEEPS IT HONEST
// The record is written from INSIDE the work loop, after a real unit of work
// completes — never from a detached `setInterval` that would keep ticking while
// the loop it claims to speak for is deadlocked.
//
// SELF-DESCRIBING STALENESS
// Each record carries its OWN `staleAfterMs`, so the writer — which is the only
// party that knows what it is currently doing — sets the deadline, and the
// healthcheck stays a dumb comparator. That matters because the budget is not
// one number: an idle lane must check in within seconds, a lane executing a job
// is allowed minutes. It also means the threshold can never drift out of sync
// with the env knobs (WORKER_IDLE_POLL_MS and friends) the way a duplicate
// literal in docker-compose.yml would.
import { rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** What the writer was doing when it last made progress. Free-form label used
 *  only for operator-facing diagnostics in `docker inspect`'s health log.
 *  `faulted`: a claim/execute cycle threw (lost DB, exhausted pool, ...) — the
 *  loop is not deadlocked (it beat), but it is not serving either, so it
 *  reports on the narrow IDLE-sized budget regardless of whether the error
 *  landed while idle or mid-job (worker/runtime.ts drainLoop). */
export type HeartbeatPhase = "boot" | "idle" | "busy" | "armed" | "faulted";

export interface HeartbeatRecord {
  /** Epoch ms at which the writer last completed a unit of work. */
  ts: number;
  /** How long this record stays valid. Past it, the writer is not progressing. */
  staleAfterMs: number;
  phase: HeartbeatPhase;
  /** Who wrote it (worker id / "analytics-producer") — for the health log. */
  writer?: string;
  /** Free-form context, e.g. `job 41 (swarm.session_open)`. */
  detail?: string;
}

export interface HeartbeatVerdict {
  healthy: boolean;
  /** One line, printed by the healthcheck so it lands in .State.Health.Log. */
  reason: string;
}

/** Default in-container location. Overridable so tests never touch a real one
 *  and so an operator can move it onto a tmpfs if they care about the writes. */
export const DEFAULT_HEARTBEAT_PATH = "/tmp/heartbeat";

export function heartbeatPath(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.HEARTBEAT_FILE?.trim();
  return explicit ? explicit : DEFAULT_HEARTBEAT_PATH;
}

// A SEPARATE file from the drain-loop heartbeat above (issue #614 AC1). Before
// this, tickScheduler ran inside worker/runtime.ts's generic `periodic()`
// helper, which swallows errors and never writes a heartbeat at all — so a
// frozen scheduler (the exact production incident this issue was filed from:
// next_run_at wedged in the past, RestartCount=0, container reporting
// healthy) was invisible to the ONE liveness file that existed, because that
// file was being kept fresh by the UNRELATED drain loop's own progress.
// Giving the scheduler its own path/record means its liveness can never be
// masked by a different loop in the same process still making progress.
export function schedulerHeartbeatPath(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.SCHEDULER_HEARTBEAT_FILE?.trim();
  return explicit ? explicit : `${heartbeatPath(env)}.scheduler`;
}

// Writes are coalesced: a busy lane runs processOneJob back-to-back with no
// sleep, which would otherwise mean hundreds of writes a second for no added
// signal. A PHASE CHANGE always writes through — going idle->busy must be
// visible immediately, because it is what widens the deadline. Keyed BY PATH:
// production gives every lane its own container, but the backend tests run
// several lane workers in one process, each with its own heartbeat file, and a
// single shared cursor would let one lane suppress another's writes.
const MIN_WRITE_INTERVAL_MS = 1000;
const lastWrite = new Map<string, { at: number; phase: HeartbeatPhase }>();

// Writes to one path are serialized through a promise chain. The drain loop
// records "busy" without awaiting (it must not delay the job it just claimed)
// and records "idle" when that job returns; for a fast job those two writes
// overlap, and concurrent write+rename pairs can land in either order. Losing
// that race would leave a finished lane advertising the 15-minute BUSY budget —
// masking a real stall for a quarter of an hour. Chaining makes last-call-wins
// mean last-write-wins.
const chains = new Map<string, Promise<void>>();

/** Test seam: forget the coalescing state between cases. */
export function resetHeartbeatWriter(): void {
  lastWrite.clear();
  chains.clear();
}

/**
 * Record progress. Never throws: a heartbeat that cannot be written must not
 * take down the loop it is only observing — the check will report the staleness
 * on its own, which is the correct outcome anyway.
 */
export async function writeHeartbeat(
  rec: Omit<HeartbeatRecord, "ts"> & { ts?: number },
  opts: { path?: string } = {},
): Promise<void> {
  const now = rec.ts ?? Date.now();
  const path = opts.path ?? heartbeatPath();
  const body: HeartbeatRecord = { ...rec, ts: now };

  const write = async (): Promise<void> => {
    const prev = lastWrite.get(path);
    if (prev && rec.phase === prev.phase && now - prev.at < MIN_WRITE_INTERVAL_MS) return;
    try {
      // Write-then-rename: the healthcheck polls this file concurrently and a
      // torn read would report a spurious `unhealthy`. rename(2) within one
      // directory is atomic, so a reader always sees the whole old or whole new
      // record.
      // Temp name carries the TARGET's basename as well as the pid: two lane
      // workers in one process (backend tests) can share a directory, and a
      // pid-only name would have them clobbering each other's staging file.
      const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
      await writeFile(tmp, `${JSON.stringify(body)}\n`);
      await rename(tmp, path);
      lastWrite.set(path, { at: now, phase: rec.phase });
    } catch { /* see doc comment: staleness is the correct signal, not a crash */ }
  };

  const next = (chains.get(path) ?? Promise.resolve()).then(write);
  chains.set(path, next);
  return next;
}

/**
 * Decide whether a heartbeat's contents mean "progressing". Pure, so the
 * semantics are unit-testable without a filesystem or a container.
 * `raw` is null when the file does not exist.
 */
export function evaluateHeartbeat(raw: string | null, now: number = Date.now()): HeartbeatVerdict {
  if (raw === null) {
    return { healthy: false, reason: "no heartbeat file — the work loop has never reported progress" };
  }
  let rec: Partial<HeartbeatRecord>;
  try {
    rec = JSON.parse(raw) as Partial<HeartbeatRecord>;
  } catch {
    return { healthy: false, reason: `heartbeat file is not JSON: ${raw.slice(0, 80)}` };
  }
  const { ts, staleAfterMs } = rec;
  if (typeof ts !== "number" || !Number.isFinite(ts)) {
    return { healthy: false, reason: `heartbeat has no usable timestamp: ${raw.slice(0, 80)}` };
  }
  if (typeof staleAfterMs !== "number" || !Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    return { healthy: false, reason: `heartbeat has no usable staleAfterMs: ${raw.slice(0, 80)}` };
  }
  const age = now - ts;
  const where = `${rec.writer ?? "?"} phase=${rec.phase ?? "?"}${rec.detail ? ` ${rec.detail}` : ""}`;
  // A timestamp from the future is a clock artifact, not a stall — age <= budget
  // covers it, and reporting healthy is the conservative reading.
  if (age > staleAfterMs) {
    return {
      healthy: false,
      reason: `no progress for ${Math.round(age / 1000)}s (budget ${Math.round(staleAfterMs / 1000)}s) — ${where}`,
    };
  }
  return { healthy: true, reason: `progress ${Math.round(age / 1000)}s ago (budget ${Math.round(staleAfterMs / 1000)}s) — ${where}` };
}

/** Read + evaluate. A missing file is `null` — every other read error is
 *  reported as unhealthy rather than swallowed. */
export async function checkHeartbeatFile(
  path: string = heartbeatPath(),
  now: number = Date.now(),
): Promise<HeartbeatVerdict> {
  const file = Bun.file(path);
  if (!(await file.exists())) return evaluateHeartbeat(null, now);
  try {
    return evaluateHeartbeat(await file.text(), now);
  } catch (err) {
    return { healthy: false, reason: `heartbeat file unreadable: ${err instanceof Error ? err.message : err}` };
  }
}
