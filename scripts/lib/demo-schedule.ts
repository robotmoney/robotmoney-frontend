// Demo CADENCE PROFILE — the SINGLE source for how fast the standing demo
// publishes committee sessions, admits newcomers, and refreshes analytics.
//
// Two profiles, selected by ONE invocation argument (`bun run demo -- --stage`),
// never by an env var — the same hard rule `--pg-data` and `--stage`'s port pin
// already follow (docs/architecture.md §0). Cadence is a property of one
// deliberate invocation, not of a shell that happens to have something exported.
//
//   fast (default)      — `bun run demo` and CI. Today's values, unchanged: a
//                         committee session per subject every ~2 min, subjects
//                         staggered ~1 min. The required per-PR e2e demo
//                         readiness gate and the nightly LIVE smoke both depend
//                         on this staying fast and BOUNDED.
//   realistic (--stage) — the standing/public demo behind
//                         stage.robotmoney-labs.dev. A real investment committee
//                         does not sit every two minutes: each subject convenes
//                         every 6 h, the two subjects are phase-offset by 3 h so
//                         a session lands about every 3 h overall, and the
//                         analytics-producer refreshes research every 3 h with
//                         regime on the same beat offset by 30 min.
//
// Every consumer derives its timings from here: scripts/lib/demo-main.ts (the
// orchestrator that drives sessions and admissions) and scripts/demo-live-smoke.ts
// (whose poll deadline is derived from the FAST profile only — issue #128 — so
// the nightly smoke can never inherit a 6 h budget and outlive its job timeout).
// The analytics-producer's PRODUCER_REGIME_CRON / PRODUCER_RESEARCH_CRON for a
// `--stage` stack are injected from this module through resolveDemoEnv's
// composeEnv; the committed docker-compose.yml production defaults are never
// touched.
//
// This module is PURE and side-effect free: scripts/lib/demo-main.ts boots a
// stack at module load and cannot be imported by a test, so every cadence
// DECISION lives here where the required per-PR `unit` workflow executes it
// directly (scripts/tests/unit/demo-schedule.test.ts).

/** The standing demo convenes exactly these subjects (committee/session.ts SUBJECTS). */
export const DEMO_SUBJECT_COUNT = 2;

/**
 * Promptness bound: whichever profile is in force, EVERY subject's first
 * session must be scheduled within this window of boot, so the site is never
 * empty on first load. The slow profile only governs steady state.
 */
export const DEMO_FIRST_SESSION_MAX_MS = 120_000;

export type DemoCadenceProfile = "fast" | "realistic";

export interface DemoCadence {
  /** Which profile these values came from. */
  profile: DemoCadenceProfile;
  /** Steady-state interval between committee sessions for ONE subject. */
  committeeIntervalMs: number;
  /**
   * Steady-state phase offset between consecutive subjects, i.e. how long after
   * one subject's slot the next subject's slot lands. For the demo's
   * DEMO_SUBJECT_COUNT subjects this is committeeIntervalMs / DEMO_SUBJECT_COUNT.
   */
  committeeStaggerMs: number;
  /**
   * Gap between subjects' FIRST sessions at boot. Deliberately independent of
   * the steady-state stagger: under the realistic profile the phase offset is
   * hours, but bring-up must still land every subject's first session inside
   * DEMO_FIRST_SESSION_MAX_MS.
   */
  committeeBootstrapStaggerMs: number;
  /** Delay from boot to the FIRST newcomer admission. */
  onboardingFirstMs: number;
  /** Delay between subsequent newcomer admissions. */
  onboardingIntervalMs: number;
  /** analytics-producer regime timer (PRODUCER_REGIME_CRON). */
  regimeCron: string;
  /** analytics-producer research timer (PRODUCER_RESEARCH_CRON). */
  researchCron: string;
}

/**
 * The committed docker-compose.yml defaults for the analytics-producer, mirrored
 * here so the fast profile states the SAME schedule a non-stage stack resolves
 * from compose. scripts/tests/unit/demo-schedule.test.ts pins these against the
 * compose file itself, so drift in either direction is red.
 */
export const COMMITTED_REGIME_CRON = "30 22 * * *";
export const COMMITTED_RESEARCH_CRON = "0 23 * * *";

const HOUR_MS = 3_600_000;

/** Today's values — `bun run demo` and CI. Changing these changes CI. */
const FAST: DemoCadence = {
  profile: "fast",
  committeeIntervalMs: 120_000,
  committeeStaggerMs: 60_000,
  committeeBootstrapStaggerMs: 60_000,
  onboardingFirstMs: 60_000,
  onboardingIntervalMs: 300_000,
  regimeCron: COMMITTED_REGIME_CRON,
  researchCron: COMMITTED_RESEARCH_CRON,
};

/** The standing/public demo — `bun run demo -- --stage`. */
const REALISTIC: DemoCadence = {
  profile: "realistic",
  committeeIntervalMs: 6 * HOUR_MS,
  committeeStaggerMs: (6 * HOUR_MS) / DEMO_SUBJECT_COUNT,
  // Bring-up promptness: both subjects' first sessions land inside two minutes.
  committeeBootstrapStaggerMs: 30_000,
  // The first admission stays prompt (a visitor sees onboarding on the first
  // load); steady-state admissions then ride the committee beat.
  onboardingFirstMs: 60_000,
  onboardingIntervalMs: 6 * HOUR_MS,
  regimeCron: "30 */3 * * *",
  researchCron: "0 */3 * * *",
};

/**
 * Resolve the cadence profile for one demo invocation. `stage` is the `--stage`
 * ARGUMENT, never an env var.
 */
export function resolveDemoCadence(opts: { stage?: boolean } = {}): DemoCadence {
  return opts.stage ? REALISTIC : FAST;
}

export interface SubjectCadencePlan {
  /** Position of this subject in the demo's subject list. */
  index: number;
  /** Absolute epoch ms of this subject's FIRST session. */
  firstAt: number;
  /**
   * Absolute epoch ms of this subject's SECOND session — the first slot on the
   * steady-state grid (`≡ index * phaseOffsetMs (mod committeeIntervalMs)`)
   * strictly after `firstAt`.
   */
  steadyStartAt: number;
  /** Steady-state interval for this subject. */
  intervalMs: number;
  /** Phase offset applied to this subject's steady-state grid. */
  phaseOffsetMs: number;
}

/**
 * Plan every subject's session timetable for one demo boot.
 *
 * Two rules, both previously inline in demo-main.ts's committee driver:
 *
 *   1. PROMPTNESS — subject `i`'s first session fires at
 *      `now + i * committeeBootstrapStaggerMs`, so the site has data on first
 *      load under BOTH profiles (bounded by DEMO_FIRST_SESSION_MAX_MS).
 *   2. PHASE OFFSET — steady-state slots for subject `i` sit on the grid
 *      `now + i * (committeeIntervalMs / subjectCount) + n * committeeIntervalMs`,
 *      so sessions are spread evenly instead of clustering. The first steady
 *      slot is the earliest grid point strictly after that subject's first run.
 *
 * Under the fast profile with 2 subjects this reproduces today's timetable
 * exactly (0s/120s/240s… and 60s/180s/300s…).
 */
export function planSubjectSchedules(
  subjectCount: number,
  cadence: DemoCadence,
  nowMs: number,
): SubjectCadencePlan[] {
  if (!Number.isInteger(subjectCount) || subjectCount < 1) {
    throw new Error(`planSubjectSchedules needs at least one subject, got ${subjectCount}`);
  }
  const phaseOffsetMs = cadence.committeeIntervalMs / subjectCount;
  return Array.from({ length: subjectCount }, (_, index) => {
    const firstAt = nowMs + index * cadence.committeeBootstrapStaggerMs;
    const anchor = nowMs + index * phaseOffsetMs;
    // Smallest k >= 0 with anchor + k*interval STRICTLY after firstAt.
    const k = Math.max(0, Math.floor((firstAt - anchor) / cadence.committeeIntervalMs) + 1);
    return {
      index,
      firstAt,
      steadyStartAt: anchor + k * cadence.committeeIntervalMs,
      intervalMs: cadence.committeeIntervalMs,
      phaseOffsetMs,
    };
  });
}

/**
 * Absolute epoch ms of run `runs` (0-based) for a planned subject. Run 0 is the
 * bring-up session; every later run walks the steady-state grid.
 */
export function plannedRunAt(plan: SubjectCadencePlan, runs: number): number {
  if (runs <= 0) return plan.firstAt;
  return plan.steadyStartAt + (runs - 1) * plan.intervalMs;
}

/**
 * Safety-margin day step for {@link sessionDateFor}: strictly more than
 * ONE calendar day, so that even in the worst case where a run's own real
 * elapsed time (bounded by `committeeIntervalMs`, always well under 24 h for
 * every cadence profile) happens to tip `nowMs` over a midnight boundary, the
 * net movement is still a decrease — see that function's doc for why exactly
 * one day is NOT safe here.
 */
const SESSION_DATE_STEP_MS = 2 * 86_400_000;

/**
 * The demo's synthetic session date: roughly one calendar day EARLIER per
 * completed run for THIS subject, so sessions accumulate without colliding on
 * the backend's UNIQUE(date, subject_id).
 *
 * Issue #345: the previous expression walked FORWARD from the wall clock
 * (`nowMs + runs * day`). `nowMs` is itself the real clock at the moment of the
 * call, which already advances with every steady-state run — under the
 * REALISTIC profile (a run every 6 h) that meant every run's own elapsed real
 * time was compounding with a full synthetic day on TOP of it, so the standing
 * stage demo's committee/regime dates ran away into the future (observed: ~9
 * months ahead after a couple of months of uptime — read as broken on
 * /committee and /regime, which is the opposite of the separate cutover-data
 * gate's "too old" failure). A demo that never tears down has no bound on
 * `runs`, so ANY forward offset here eventually crosses into the future.
 *
 * Walking BACKWARD from `nowMs` instead removes the failure mode entirely: for
 * every `runs >= 0` the result is `<= nowMs`'s calendar day BY CONSTRUCTION, so
 * it can never read as "from the future" no matter how long the demo has been
 * running — a long-lived subject simply reads as a longer-established
 * committee history, which is the harmless direction to be wrong in.
 *
 * The step is a full TWO days (not one): `nowMs` at run `runs` already
 * reflects that run's own real elapsed time since run 0, so a plain `-1 day`
 * per run can net to LESS than a full day once that real drift is folded back
 * in — occasionally landing two runs on the same calendar day (an actual
 * collision on the very constraint this function exists to satisfy). Doubling
 * the step keeps the net movement negative by a comfortable margin for any
 * cadence well under 24 h (every profile in demo-schedule.ts qualifies),
 * guaranteeing a distinct, strictly decreasing date every run.
 */
export function sessionDateFor(nowMs: number, runs: number): string {
  return new Date(nowMs - runs * SESSION_DATE_STEP_MS).toISOString().slice(0, 10);
}

/** `120000 → "2 min"`, `21600000 → "6 h"` — the READY line's duration words. */
export function formatCadenceDuration(ms: number): string {
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Math.round(ms / 1000)} s`;
}

// Cron → human words for the READY line. A 3-hourly hour field renders as
// "every 3h at :MM"; a fixed hour renders as "daily at HH:MM".
export function describeCron(cron: string): string {
  const [minute = "0", hour = "0"] = cron.split(/\s+/);
  const every = /^\*\/(\d+)$/.exec(hour);
  if (every) return `every ${every[1]}h at :${minute.padStart(2, "0")}`;
  if (hour === "*") return `hourly at :${minute.padStart(2, "0")}`;
  return `daily at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

/**
 * The READY banner's cadence line, RENDERED from the resolved profile rather
 * than hardcoded — the banner and the docs must state the cadence actually in
 * force. Pure, so scripts/tests/unit/demo-schedule.test.ts executes it directly.
 */
export function renderCadenceLine(
  cadence: DemoCadence,
  subjectCount: number = DEMO_SUBJECT_COUNT,
): string {
  const perSubject = formatCadenceDuration(cadence.committeeIntervalMs);
  const overall = formatCadenceDuration(cadence.committeeIntervalMs / subjectCount);
  return (
    `Demo actions: a committee session per subject every ~${perSubject} ` +
    `(${subjectCount} subjects staggered → one lands about every ~${overall}); ` +
    `research ${describeCron(cadence.researchCron)}, regime ${describeCron(cadence.regimeCron)}.`
  );
}
