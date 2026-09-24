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
