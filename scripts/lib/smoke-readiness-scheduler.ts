// SMOKE'S READINESS GATE ON THE SCHEDULER — issue #1026 W4, part 3.
//
// AUTHORITY: docs/technical/smoke-production-spec.md §6.3.
//
//   "Scheduler readiness requires all of: the scheduler authenticated to the
//    API; its stream established and synchronized (scheduler spec §3.1); its
//    initial rebuild complete, meaning timers reconstructed and recoverable
//    work resumed, not that any settlement has finished; and every active
//    subject holding a `collecting` session. A scheduler reporting exhausted
//    work (scheduler spec §4.6) is not ready. `collecting` rows alone establish
//    nothing, since an exhausted turnover leaves such a row in place. Smoke
//    reads this from the scheduler's health endpoint and records the result in
//    the receipt."
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY SMOKE DOES NOT RESTART THE CONTAINER
// ─────────────────────────────────────────────────────────────────────────────
//
// §6.3 again, and it is the reason this module runs no command at all:
// "Recovery from exhausted work is a restart of that instance's scheduler
// container (`docker restart` of the instance's `system-scheduler`) after the
// failing dependency is back; smoke never restarts it on its own."
//
// That is not caution, it is correctness. §4.6's degradation means a dependency
// has been failing for an entire retry budget. A restart before it recovers
// burns the budget again and hides the failure behind a loop, and the operator
// — who is the only party that can tell whether the dependency is back — never
// sees it. So this module REPORTS and refuses; the recovery action belongs to a
// human, and the omission is asserted by a test that greps this file.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY `collecting` ROWS ARE CHECKED SEPARATELY FROM THE HEALTH ENDPOINT
// ─────────────────────────────────────────────────────────────────────────────
//
// The scheduler is not the authority on what is in the database; the API is.
// A scheduler asked "does every subject have an open epoch" could only answer
// from its own copy, and §3.1 admits that copy can be stale. So the two halves
// come from the two authorities — health from the scheduler, epochs from the
// API — and readiness is the conjunction. Neither alone is the gate, which is
// exactly what §6.3's "`collecting` rows alone establish nothing" means.
import type { FetchLike, SchedulerHealth } from "./system-scheduler/types.ts";

/** Re-exported so a consumer needs one import. The producing side owns the shape. */
export type SchedulerHealthReport = SchedulerHealth;

/**
 * Every check this gate produces, by name.
 *
 * Exported and asserted to be exhaustive, so a check cannot be dropped in a
 * refactor and leave readiness quietly weaker than §6.3.
 */
export const SCHEDULER_READINESS_CHECKS = [
  "scheduler-authenticated",
  "scheduler-stream-synchronized",
  "scheduler-initial-rebuild",
  "scheduler-no-exhausted-work",
  "epoch-per-active-subject",
] as const;

export type SchedulerReadinessCheckName = (typeof SCHEDULER_READINESS_CHECKS)[number];

export interface ReadinessCheck {
  check: SchedulerReadinessCheckName;
  pass: boolean;
  detail: string;
}

export interface SchedulerReadinessInput {
  /** The parsed health body, or null when the endpoint could not be read. */
  health: SchedulerHealthReport | null;
  /** Subject ids the API reports active. */
  activeSubjectIds: readonly string[];
  /** Subject ids the API reports holding a `collecting` session. */
  collectingSubjectIds: readonly string[];
}

/**
 * Read the scheduler's health endpoint.
 *
 * A NON-2xx BODY IS STILL PARSED. An unhealthy scheduler answers 503 and its
 * body is the only place the reason exists; treating 503 as "no answer" would
 * turn every degradation into an indistinguishable timeout in the receipt.
 *
 * A body that is not the expected object is null, never a partially-read object:
 * a proxy's HTML error page has no `authenticated` field, and `undefined` read
 * as falsy would be luck rather than a decision.
 */
export async function fetchSchedulerHealth(
  url: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 5_000,
): Promise<SchedulerHealthReport | null> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (
    typeof b.authenticated !== "boolean" ||
    typeof b.streamSynchronized !== "boolean" ||
    typeof b.initialRebuildComplete !== "boolean" ||
    !Array.isArray(b.exhausted)
  ) {
    return null;
  }
  return body as SchedulerHealthReport;
}

/** One line per exhausted item, naming it, its subject or session, and the last error (§4.6). */
function describeExhausted(health: SchedulerHealthReport): string {
  return health.exhausted
    .map((e) => {
      const who = [e.subjectId ? `subject ${e.subjectId}` : null, e.sessionId ? `session ${e.sessionId}` : null]
        .filter(Boolean)
        .join(", ");
      return `${e.item}${who ? ` (${who})` : ""}: ${e.lastError}`;
    })
    .join("; ");
}

/**
 * §6.3's five requirements, each as its own named check.
 *
 * Separate checks rather than one boolean because the receipt and `smoke:status`
 * show them to an operator, and "readiness failed" is not an actionable
 * sentence. A missing health endpoint fails the FOUR scheduler checks rather
 * than being skipped: an unreadable surface is not a passing one.
 */
export function evaluateSchedulerReadiness(input: SchedulerReadinessInput): ReadinessCheck[] {
  const { health } = input;

  const unreadable = "scheduler health endpoint unreadable";
  const checks: ReadinessCheck[] = [
    {
      check: "scheduler-authenticated",
      pass: health?.authenticated === true,
      detail: health
        ? health.authenticated
          ? "authenticated to the API"
          : `not authenticated: ${health.lastError ?? "no reason reported"}`
        : unreadable,
    },
    {
      check: "scheduler-stream-synchronized",
      pass: health?.streamSynchronized === true,
      detail: health
        ? health.streamSynchronized
          ? "stream established and synchronized"
          : "stream not synchronized (scheduler spec §3.1)"
        : unreadable,
    },
    {
      check: "scheduler-initial-rebuild",
      pass: health?.initialRebuildComplete === true,
      detail: health
        ? health.initialRebuildComplete
          ? "initial rebuild complete: timers reconstructed, recoverable work resumed"
          : "initial rebuild not complete"
        : unreadable,
    },
    {
      check: "scheduler-no-exhausted-work",
      pass: health != null && health.exhausted.length === 0,
      detail: health
        ? health.exhausted.length === 0
          ? "no exhausted work"
          : `exhausted work (restart the instance's system-scheduler after the dependency recovers): ${describeExhausted(health)}`
        : unreadable,
    },
  ];

  const missing = input.activeSubjectIds.filter((id) => !input.collectingSubjectIds.includes(id));
  checks.push({
    check: "epoch-per-active-subject",
    pass: missing.length === 0,
    detail:
      missing.length === 0
        ? `${input.activeSubjectIds.length} active subject(s), each holding a collecting session`
        : `no collecting session for: ${missing.join(", ")}`,
  });

  return checks;
}

export function schedulerReadinessPassed(checks: readonly ReadinessCheck[]): boolean {
  return checks.length > 0 && checks.every((c) => c.pass);
}

/**
 * The line `smoke:status` and the TUI show for "now", beside the receipt's
 * "history" (§6.3).
 */
export function renderSchedulerHealthLine(health: SchedulerHealthReport | null): string {
  if (!health) return "scheduler health: unreadable";
  if (health.healthy) {
    return `scheduler health: healthy (${health.timers.boundaries} boundary timer(s), ${health.timers.deadlines} judging deadline(s))`;
  }
  const why: string[] = [];
  if (!health.authenticated) why.push(`not authenticated${health.lastError ? `: ${health.lastError}` : ""}`);
  if (!health.streamSynchronized) why.push("stream not synchronized");
  if (!health.initialRebuildComplete) why.push("initial rebuild incomplete");
  if (health.exhausted.length > 0) why.push(`degraded — ${describeExhausted(health)}`);
  return `scheduler health: UNHEALTHY (${why.join("; ")})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE WHOLE READINESS GATE — §6.3 "Other services' readiness", D52
// ─────────────────────────────────────────────────────────────────────────────
//
//   "Readiness also requires `api`'s `/health` to answer ok, the pipeline
//    worker to have passed its startup checks (§7.2), and `analytics-producer`
//    to have authenticated with its token and completed its seed command.
//    Smoke records each result in the receipt."
//
// Every condition is its own named check, and the receipt carries all of them.
// This module still runs nothing: the OBSERVATION (HTTP reads, container health
// and log lines) is handed in by the boot (scripts/lib/smoke-readiness-probes.ts),
// and the verdict and the wait are decided here, so the gate can be driven
// with a fake typed exactly like the real reading. There is no path from here
// to a container restart; a failed gate reports and the operator recovers.

/** The non-scheduler checks, by name. Asserted exhaustive with the scheduler's. */
export const SERVICE_READINESS_CHECKS = [
  "api-health",
  "pipeline-worker-startup",
  "analytics-producer-authenticated",
  "analytics-producer-seed",
] as const;

/** Every check a boot's readiness records, in the receipt's order. */
export const READINESS_CHECKS = [...SERVICE_READINESS_CHECKS, ...SCHEDULER_READINESS_CHECKS] as const;
export type ReadinessCheckName = (typeof READINESS_CHECKS)[number];

export interface GateCheck {
  check: ReadinessCheckName;
  pass: boolean;
  detail: string;
}

/** A Docker health status, or `none` for a container with no healthcheck and `missing` for no container. */
export type ContainerHealth = "healthy" | "unhealthy" | "starting" | "none" | "missing";

/**
 * One pipeline-worker container, as the boot read it. The worker writes no
 * heartbeat until its startup checks 1-3 pass (§7.2), and logs exactly
 * `startup_preflight: passed`, or `startup_preflight: refused check <n>:
 * <reason>` and exits 1. `line` is the last such line in its log.
 */
export interface WorkerStartupReading {
  service: string;
  health: ContainerHealth;
  line: { kind: "passed" } | { kind: "refused"; detail: string } | null;
}

/** The exact line the pipeline worker logs, parsed; null for any other line. */
export function parseStartupPreflightLine(line: string): WorkerStartupReading["line"] {
  const passed = /startup_preflight: passed\b/.exec(line);
  const refused = /startup_preflight: refused (check \d+: .*)$/.exec(line.trim());
  if (refused) return { kind: "refused", detail: refused[1]! };
  if (passed) return { kind: "passed" };
  return null;
}

/** The last startup-preflight line in a log, or null when the worker has logged none yet. */
export function lastStartupPreflightLine(log: string): WorkerStartupReading["line"] {
  let last: WorkerStartupReading["line"] = null;
  for (const line of log.split("\n")) last = parseStartupPreflightLine(line) ?? last;
  return last;
}

/** Everything one readiness poll observed. */
export interface ReadinessObservation {
  apiHealth: { ok: boolean; detail: string };
  scheduler: SchedulerHealthReport | null;
  /** Active subjects and the subjects holding a `collecting` session, as the API reports them; null when unreadable. */
  subjects: { active: readonly string[]; collecting: readonly string[] } | null;
  workers: readonly WorkerStartupReading[];
  /**
   * The analytics-producer's authentication, read from the heartbeat phase its
   * last healthcheck printed (smoke-readiness-probes.ts readProducerAuth): a
   * healthy container is not enough, since the producer is healthy on its
   * pre-authentication `boot` record.
   */
  producer: { health: ContainerHealth; phase: string | null; authenticated: boolean; detail: string };
  /** The producer's seed command: whether it exited 0 on this boot. */
  seed: { completed: boolean; detail: string };
}

/** The pipeline worker's startup checks, over every worker container. */
export function evaluateWorkerStartup(workers: readonly WorkerStartupReading[]): GateCheck {
  if (workers.length === 0) {
    return { check: "pipeline-worker-startup", pass: false, detail: "no pipeline worker container is running" };
  }
  const describe = (w: WorkerStartupReading): string => {
    if (w.line?.kind === "refused") return `${w.service}: refused ${w.line.detail}`;
    if (w.line?.kind === "passed") return `${w.service}: startup checks passed (container ${w.health})`;
    return `${w.service}: no startup_preflight line yet (container ${w.health})`;
  };
  const pass = workers.every((w) => w.line?.kind === "passed" && w.health === "healthy");
  return { check: "pipeline-worker-startup", pass, detail: workers.map(describe).join("; ") };
}

/** Every check, in {@link READINESS_CHECKS} order. */
export function evaluateReadiness(o: ReadinessObservation): GateCheck[] {
  const scheduler = evaluateSchedulerReadiness({
    health: o.scheduler,
    activeSubjectIds: o.subjects?.active ?? [],
    collectingSubjectIds: o.subjects?.collecting ?? [],
  });
  if (o.subjects === null) {
    const epoch = scheduler.find((c) => c.check === "epoch-per-active-subject")!;
    epoch.pass = false;
    epoch.detail = "the API's subjects and collecting sessions could not be read";
  }
  return [
    { check: "api-health", pass: o.apiHealth.ok, detail: o.apiHealth.detail },
    evaluateWorkerStartup(o.workers),
    {
      check: "analytics-producer-authenticated",
      pass: o.producer.authenticated && o.producer.health === "healthy",
      detail: o.producer.detail,
    },
    { check: "analytics-producer-seed", pass: o.seed.completed, detail: o.seed.detail },
    ...scheduler,
  ];
}

/**
 * A failure that waiting cannot fix, or null. Readiness stops polling on one
 * and fails at once: exhausted work is the operator's to recover (restart the
 * instance's scheduler after the dependency is back), a rejected token needs a
 * re-provision, and a worker that refused its startup checks has exited.
 * Nothing here recovers any of them.
 */
export function terminalReadinessFailure(o: ReadinessObservation): string | null {
  if (o.scheduler && o.scheduler.exhausted.length > 0) {
    return `the scheduler reports exhausted work (${describeExhausted(o.scheduler)}); restart the instance's system-scheduler after the dependency recovers`;
  }
  if (o.scheduler && !o.scheduler.authenticated && /reject/i.test(o.scheduler.lastError ?? "")) {
    return `the API rejected the scheduler's token (${o.scheduler.lastError}); re-provision the tokens and restart the scheduler`;
  }
  const refused = o.workers.find((w) => w.line?.kind === "refused");
  if (refused && refused.line?.kind === "refused") return `${refused.service} refused its startup checks: ${refused.line.detail}`;
  if (!o.seed.completed) return `the analytics-producer seed command did not complete: ${o.seed.detail}`;
  return null;
}

/**
 * How long a boot's readiness waits for every condition before it fails. It
 * covers the scheduler's startup check, first rebuild and first epoch per active
 * subject, the worker's startup checks, and the producer's first post-
 * authentication heartbeat (its deferred start waits only for a healthy
 * container, which its pre-authentication `boot` record already gives). A failure that waiting cannot fix ends the wait
 * at once ({@link terminalReadinessFailure}).
 */
export const READINESS_TIMEOUT_MS = 5 * 60_000;
/** How often readiness re-reads while it waits. */
export const READINESS_POLL_MS = 5_000;

export interface ReadinessWaitOptions {
  /** How long the gate waits for every check to pass before it fails. */
  timeoutMs: number;
  pollMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called with each poll's checks, for narration. */
  onPoll?: (checks: readonly GateCheck[]) => void;
}

export interface ReadinessVerdict {
  passed: boolean;
  checks: GateCheck[];
  /** Why it failed, when it did: the terminal failure, or the checks still failing at the deadline. */
  reason: string | null;
}

/**
 * Poll `observe` until every check passes, a terminal failure appears, or the
 * deadline passes. The first two return at once. There is no retry of any
 * action and no restart: the gate only reads.
 */
export async function awaitReadiness(
  observe: () => Promise<ReadinessObservation>,
  opts: ReadinessWaitOptions,
): Promise<ReadinessVerdict> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + opts.timeoutMs;
  for (;;) {
    const observation = await observe();
    const checks = evaluateReadiness(observation);
    opts.onPoll?.(checks);
    if (checks.every((c) => c.pass)) return { passed: true, checks, reason: null };
    const terminal = terminalReadinessFailure(observation);
    if (terminal) return { passed: false, checks, reason: terminal };
    if (now() >= deadline) {
      const failing = checks.filter((c) => !c.pass).map((c) => `${c.check} (${c.detail})`).join("; ");
      return { passed: false, checks, reason: `readiness did not pass within ${Math.round(opts.timeoutMs / 1000)}s: ${failing}` };
    }
    await sleep(opts.pollMs);
  }
}
