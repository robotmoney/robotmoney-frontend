// Demo CADENCE PROFILE — the SINGLE source for how fast the standing smoke
// publishes swarm sessions, admits newcomers, and refreshes analytics.
//
// Two profiles, selected by ONE invocation argument (`bun run smoke -- --stage`),
// never by an env var — the same hard rule `--pg-data` and `--stage`'s port pin
// already follow (docs/architecture.md §0). Cadence is a property of one
// deliberate invocation, not of a shell that happens to have something exported.
//
//   fast (default)      — `bun run smoke` and CI. Today's values, unchanged: a
//                         swarm session per subject every ~2 min, subjects
//                         staggered ~1 min. The required per-PR e2e smoke
//                         readiness gate and the nightly LIVE smoke both depend
//                         on this staying fast and BOUNDED.
//   realistic (--stage) — the standing/public smoke behind
//                         stage.robotmoney-labs.dev. A real investment swarm
//                         does not sit every two minutes: each subject convenes
//                         every 6 h, the subjects are phase-offset by
//                         6 h / subjectCount so a session lands that often
//                         overall (four smoke subjects → ~90 min), and the
//                         analytics-producer refreshes research every 3 h with
//                         regime on the same beat offset by 30 min.
//
// CONCURRENCY IS A CADENCE VALUE TOO (2026-09-25). How many sessions run at
// once, how many member containers one session runs, and how many swarm
// workers the stack starts are fields of the profile, not branches in the
// driver: fast runs every subject's session concurrently on four swarm
// workers; realistic (production) keeps one session at a time on one worker,
// pinned by PRODUCTION_CADENCE_INTENT. See SmokeCadence.maxConcurrentSessions.
//
// The SUBMISSION WINDOW is one of these timings and lives here for the same
// reason (issue #570): it equals the subject's own full cadence interval, so
// session N's advertised cutoff is session N+1's convene and an agent that
// polls on its own schedule is never told "no window is open". It is selected
// by the same one invocation argument — never by SWARM_WINDOW_MINUTES, which
// already exists and means the api container's seed-time cron payload.
//
// Every consumer derives its timings from here: scripts/lib/smoke-main.ts (the
// orchestrator that drives sessions and admissions) and scripts/smoke-live-smoke.ts
// (whose poll deadline is derived from the FAST profile only — issue #128 — so
// the nightly smoke can never inherit a 6 h budget and outlive its job timeout).
// The analytics-producer's PRODUCER_REGIME_CRON / PRODUCER_RESEARCH_CRON for a
// `--stage` stack are injected from this module through resolveSmokeEnv's
// composeEnv; the committed docker-compose.yml production defaults are never
// touched.
//
// This module is PURE and side-effect free: scripts/lib/smoke-main.ts boots a
// stack at module load and cannot be imported by a test, so every cadence
// DECISION lives here where the required per-PR `unit` workflow executes it
// directly (scripts/tests/unit/smoke-schedule.test.ts).

// THE SUBJECT COUNT IS NOT A CONSTANT. It used to be (`DEMO_SUBJECT_COUNT = 2`,
// "the standing smoke convenes exactly these subjects"), and REALISTIC derived
// its declared stagger from it. That was false the moment the production-shaped
// smoke boot landed: scripts/lib/smoke-mode.ts seats FOUR subjects
// (SMOKE_SUBJECTS) while the simulation smoke seats two (DEMO_SUBJECTS), so one
// number could not be right for both — and the READY banner printed "2 subjects
// staggered → one lands about every ~3 h" on a stack that was actually landing
// one every ~90 min. The count is a property of the SCENARIO, so every consumer
// now passes the count it is actually running (see swarmStaggerMsFor and
// renderCadenceLine, both of which require it).

/**
 * Promptness bound: whichever profile is in force, EVERY subject's first
 * session must be scheduled within this window of boot, so the site is never
 * empty on first load. The slow profile only governs steady state.
 */
export const DEMO_FIRST_SESSION_MAX_MS = 120_000;

export type SmokeCadenceProfile = "fast" | "realistic";

export interface SmokeCadence {
  /** Which profile these values came from. */
  profile: SmokeCadenceProfile;
  /** Steady-state interval between swarm sessions for ONE subject. */
  swarmIntervalMs: number;
  /**
   * How long a session's submission window stays open — the value the brief
   * ADVERTISES as `windowClosesAt` and the backend enforces against submitters.
   *
   * IT EQUALS `swarmIntervalMs`, ALWAYS, AND THAT IS THE WHOLE POINT (issue
   * #570). The cutoff of session N is then exactly the convene time of session
   * N+1 for that subject, so there is no interval in which a subject has no
   * session accepting takes — the dead zone is removed by arithmetic rather
   * than by an epoch table. Before this the driver advertised a flat 60 minutes
   * and then closed the window as soon as its own in-process agents settled, so
   * every live session promised an hour and ended in 1-3 minutes; the committed
   * goldens carry `publishedAt` ~59.9 minutes BEFORE `windowClosesAt` on every
   * row.
   *
   * Consequences of making it the FULL interval, accepted deliberately: under
   * the realistic profile a subject's session sits in `collecting` for ~6 h
   * before it aggregates, and one session per subject is open at a time (four
   * subjects ⇒ ~4 concurrent open sessions). Under the fast profile it is 2
   * minutes, so a CI run adds at most one window per session it drives.
   *
   * It is a property of the CADENCE PROFILE — selected by the `--static-port`
   * invocation argument like every other timing here — and NEVER of an env var.
   * `SWARM_WINDOW_MINUTES` already exists (backend/src/config.ts) and means
   * something else: it is the window carried on the seed-time
   * `swarm.publish_brief` CRON payload inside the api container. Reusing that
   * name here would give one variable two meanings and let a stale export in an
   * operator's shell silently change production behaviour.
   */
  swarmWindowMs: number;
  /**
   * Gap between subjects' FIRST sessions at boot. Deliberately independent of
   * the steady-state stagger: under the realistic profile the phase offset is
   * hours, but bring-up must still land every subject's first session inside
   * DEMO_FIRST_SESSION_MAX_MS.
   */
  swarmBootstrapStaggerMs: number;
  /** Delay from boot to the FIRST newcomer admission. */
  onboardingFirstMs: number;
  /** Delay between subsequent newcomer admissions. */
  onboardingIntervalMs: number;
  /** analytics-producer regime timer (PRODUCER_REGIME_CRON). */
  regimeCron: string;
  /** analytics-producer research timer (PRODUCER_RESEARCH_CRON). */
  researchCron: string;
  /**
   * How many swarm sessions (one per subject, never two for the same subject)
   * the host driver may have IN FLIGHT at once.
   *
   * WHY THIS IS A CADENCE VALUE AND NOT A MODE. The driver used to await one
   * whole session — window included — before it would convene the next
   * subject's, so a four-subject twin with a six-minute window took ~38
   * minutes per round, most of it one subject idling while another's window
   * ran out. Nothing about a session needs the others to be quiet: each
   * subject's window is its own, openSession is per subject, and the shared
   * resources (the swarm lane, a member's HOME volume, the regime producer)
   * are each made safe for concurrent sessions in SHARED code — see
   * `swarmWorkers` below, the per-member lock in swarm/agent.ts and the
   * in-flight regime memo in swarm/session.ts. So there is ONE driver code
   * path, and the only thing a profile chooses is this number.
   *
   * 1 is today's behaviour exactly: the scheduler (subjectsToStart) with a cap
   * of one starts subjects in the same earliest-`nextAt`-first order the old
   * sequential loop did. Production pins it (PRODUCTION_CADENCE_INTENT).
   */
  maxConcurrentSessions: number;
  /**
   * Member containers ONE session runs at once (mapSettledWithConcurrency in
   * swarm/session.ts). This is the old `SWARM_MAX_CONCURRENCY ?? 4` default,
   * moved here so a profile can state it; the env var, when set, still
   * overrides it (resolveMemberConcurrency), which keeps any operator who
   * already pins it on a production host exactly where they were.
   *
   * It is a PER-SESSION bound. The bound on member containers across the
   * whole driver is the roster size, enforced by the per-member lock in
   * swarm/agent.ts: a member runs in at most one session at a time, whatever
   * this number says.
   */
  memberConcurrency: number;
  /**
   * `worker-swarm` replicas the smoke boot starts (`docker compose up --scale
   * worker-swarm=N`, scripts/stack/config.ts upArgs).
   *
   * One swarm worker drains ONE job at a time, and a `swarm.judge` job holds it
   * for minutes (measured on the 2026-09-25 twin: 137 s average, 272 s max).
   * With sessions in flight for several subjects, one subject's judge would
   * then sit in front of every other subject's open/close/aggregate/publish,
   * and their 30-second state waits would expire against a lane nothing could
   * free. N workers is the configuration answer: the claim is `FOR UPDATE SKIP
   * LOCKED`, scheduler slots are dedupe-keyed, and each replica keeps its own
   * heartbeat file and (backend/src/worker/runtime.ts) its own worker id.
   * The driver's waits also stop counting time a job spends QUEUED behind
   * other work (session.ts waitWhileQueued), so a busy lane is waited out
   * rather than reported as a failed session.
   *
   * INVARIANT (checked in productionConstantMismatches for every boot):
   * `swarmWorkers >= maxConcurrentSessions` — every session in flight can have
   * its current lifecycle job running at the same time.
   */
  swarmWorkers: number;
}

/**
 * The committed docker-compose.yml defaults for the analytics-producer, mirrored
 * here so the fast profile states the SAME schedule a non-stage stack resolves
 * from compose. scripts/tests/unit/smoke-schedule.test.ts pins these against the
 * compose file itself, so drift in either direction is red.
 */
export const COMMITTED_REGIME_CRON = "30 22 * * *";
export const COMMITTED_RESEARCH_CRON = "0 23 * * *";

const HOUR_MS = 3_600_000;

const FAST_INTERVAL_MS = 120_000;
const REALISTIC_INTERVAL_MS = 6 * HOUR_MS;

/** Today's values — `bun run smoke` and CI. Changing these changes CI. */
const FAST: SmokeCadence = {
  profile: "fast",
  swarmIntervalMs: FAST_INTERVAL_MS,
  // One full interval — see SmokeCadence.swarmWindowMs. Two minutes, so a CI e2e
  // run that drives two sessions back to back adds at most ~4 minutes of pure
  // waiting to a step whose ceiling is 105 minutes and whose current wall clock
  // is ~14 minutes. Agents author DURING the window, so the true addition is
  // `max(0, window - agent time)` per session, not the window itself.
  swarmWindowMs: FAST_INTERVAL_MS,
  // 40 s, not the old 60 s. The promptness bound (DEMO_FIRST_SESSION_MAX_MS)
  // is for EVERY subject, and the production-shaped smoke/twin seats FOUR:
  // at 60 s the fourth subject's first session was planned for 180 s. That was
  // invisible while the driver ran sessions one at a time (the fourth subject
  // actually waited out three whole sessions first); with sessions concurrent
  // the plan is what happens, so it has to honour the bound. 3 x 40 s = 120 s.
  // It is also the gap that keeps concurrent sessions from asking for the same
  // member in the same instant — a member runs in one session at a time
  // (swarm/agent.ts), and a member's run takes ~46 s at p50.
  swarmBootstrapStaggerMs: 40_000,
  onboardingFirstMs: 60_000,
  onboardingIntervalMs: 300_000,
  regimeCron: COMMITTED_REGIME_CRON,
  researchCron: COMMITTED_RESEARCH_CRON,
  // Every subject the production-shaped smoke/twin seats (SMOKE_SUBJECTS: 4) in
  // flight at once, so no subject waits out another subject's window. The
  // two-subject simulation smoke simply never reaches the cap.
  maxConcurrentSessions: 4,
  // A whole default roster in one wave instead of two. Measured member runs:
  // p50 46 s, p90 115 s — two waves were most of a 2-minute window.
  memberConcurrency: 8,
  // One lane per concurrent session (swarmWorkers >= maxConcurrentSessions).
  swarmWorkers: 4,
};

/** The standing/public smoke — `bun run smoke -- --stage`. */
const REALISTIC: SmokeCadence = {
  profile: "realistic",
  swarmIntervalMs: REALISTIC_INTERVAL_MS,
  // One full interval — six hours per subject. The ~90-minute spacing an
  // outside observer sees on the public smoke is FOUR subjects phase-offset on
  // that six-hour grid, not the per-subject period.
  swarmWindowMs: REALISTIC_INTERVAL_MS,
  // Bring-up promptness: both subjects' first sessions land inside two minutes.
  swarmBootstrapStaggerMs: 30_000,
  // The first admission stays prompt (a visitor sees onboarding on the first
  // load); steady-state admissions then ride the swarm beat.
  onboardingFirstMs: 60_000,
  onboardingIntervalMs: 6 * HOUR_MS,
  regimeCron: "30 */3 * * *",
  researchCron: "0 */3 * * *",
  // PRODUCTION'S EXACT BEHAVIOUR, stated as values (owner decision
  // 2026-09-25): one session at a time, four member containers per session,
  // one swarm worker. Pinned independently in PRODUCTION_CADENCE_INTENT.
  maxConcurrentSessions: 1,
  memberConcurrency: 4,
  swarmWorkers: 1,
};

/**
 * Resolve the cadence profile for one smoke invocation. `stage` is the `--stage`
 * ARGUMENT, never an env var.
 */
/**
 * Does the STAGE (six-hour) cadence apply to this boot?
 *
 * `--static-port` means "this boot owns the tunnel port". For the standing
 * PUBLIC smoke it also means production-like pacing, because an outside reader
 * should see a swarm that behaves like the real one. A `--db smoke-twin` boot
 * wears the same pin for the same tunnel and is NOT that thing: it is a test
 * instrument against a throwaway copy of production.
 *
 * A six-hour submission window makes every question asked of a twin — does the
 * judge run? does a receipt publish? — take six hours to answer, or forces an
 * operator to hand-enqueue lifecycle jobs to find out. That is precisely how
 * the judge sat unexercised on the standing twin: nothing was broken, the
 * evidence was just always six hours away. So a twin runs FAST.
 *
 * COST, STATED PLAINLY: FAST is one session per subject every two minutes, and
 * every session spends real inference for every seated member plus (once the
 * judge is configured) one judge call. On a twin seating the whole restored
 * roster that is a continuous spend, not a trickle. It is the price of a test
 * instrument that answers in minutes; `bun run smoke:stage` is the standing
 * public smoke and keeps the six-hour grid.
 */
export function stageCadenceApplies(staticPort: boolean, twin: boolean): boolean {
  return staticPort && !twin;
}

export function resolveSmokeCadence(opts: { stage?: boolean } = {}): SmokeCadence {
  return opts.stage ? REALISTIC : FAST;
}

/**
 * Steady-state phase offset between consecutive subjects for a scenario that
 * seats `subjectCount` of them: how long after one subject's slot the next
 * subject's slot lands, and therefore how often a session lands OVERALL.
 *
 * A function, not a profile field. It used to be `swarmStaggerMs`, frozen into
 * both profiles from a `DEMO_SUBJECT_COUNT = 2` that the four-subject smoke
 * scenario made wrong. planSubjectSchedules already derived the real offset
 * from the real count, so the field was a second, drifting statement of the
 * same rule — with nothing but the READY banner reading it, wrongly.
 */
export function swarmStaggerMsFor(cadence: SmokeCadence, subjectCount: number): number {
  if (!Number.isInteger(subjectCount) || subjectCount < 1) {
    throw new Error(`swarmStaggerMsFor needs at least one subject, got ${subjectCount}`);
  }
  return cadence.swarmIntervalMs / subjectCount;
}

/**
 * The submission window in MINUTES — the unit the `swarm.publish_brief` job
 * payload and backend/src/swarm/domain.ts publishBrief() speak. Throws rather
 * than rounding: a window that is not a whole positive number of minutes cannot
 * be advertised faithfully through that payload, and silently truncating it is
 * how a brief comes to promise something the close path will not honour.
 */
export function swarmWindowMinutes(cadence: SmokeCadence): number {
  const minutes = cadence.swarmWindowMs / 60_000;
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new Error(
      `cadence profile '${cadence.profile}' has swarmWindowMs=${cadence.swarmWindowMs}, ` +
        "which is not a whole positive number of minutes — publish_brief cannot advertise it faithfully",
    );
  }
  return minutes;
}

// ── Production constants assertion (issue #570) ─────────────────────────────
// The gap this closes is NOT "CI runs an accelerated clock" — it should. The
// gap is that NOTHING checked production was running production constants. The
// repo has no pre-flight that asserts a single config value: prod-bootstrap.ts
// drift-checks DATA (v0-seed-bootstrap compares seeded rows against the
// committed archive) and asserts no config at all, and the check that looks
// most like a production check — smoke-live-smoke.ts's deadline — is pinned to
// the FAST profile by construction and documented as never deriving from the
// cadence actually running. A green CI result therefore cannot distinguish
// "the driver honours the window" from "the window is two minutes".
//
// So the intended production values are stated HERE as literals, independently
// of the profile objects above. A check derived from the thing it is checking
// is a tautology; these are written out so that changing REALISTIC without
// meaning to is fatal at boot rather than invisible for a month.
export interface ProductionCadenceIntent {
  profile: SmokeCadenceProfile;
  swarmIntervalMs: number;
  swarmWindowMs: number;
  /**
   * The backend's swarm CRON master switch. It must be OFF in production: the
   * shipped crons are subject-blind (resolveSwarmSchedules emits no subjectId,
   * so the handler calls openSession("") and hits a foreign-key violation) and
   * the host driver is the real scheduler.
   *
   * docker-compose.smoke.yml ALSO pins the CONTAINER's own copy of this
   * variable to "0", unconditionally — no shell export can change what the
   * api process inside the container sees, on any boot that includes that
   * overlay (every boot through smoke-main.ts does). So this check is not
   * what stops the container from running the cron cadence; that hazard is
   * already foreclosed by the overlay pin before this ever runs. What this
   * buys instead: it runs HOST-side, before the container starts, against
   * whatever the operator's own repo-root `.env` actually exports — so that
   * file (and every runbook/dashboard that reads it) can never silently
   * disagree with what the container is really doing, and the check keeps
   * working as a safety net even if the overlay pin is ever refactored away.
   *
   * Absent is not acceptable (issue #806): docker-compose.yml declares
   * `SWARM_SCHEDULES_ENABLED: ${SWARM_SCHEDULES_ENABLED:-1}`, so an unset
   * variable IS the cron cadence — and that cadence seeds five schedules with
   * no `swarm.judge` among them. The check demands the literal "0".
   */
  swarmSchedulesEnabled: "0";
  /**
   * Production runs ONE session at a time, four member containers per session
   * and ONE swarm worker — the behaviour it had before these became cadence
   * values (owner decision 2026-09-25: concurrency is for test/CI/stage only).
   * Pinned here so that turning concurrency on for the fast profile can never
   * ride into production through a shared default.
   */
  maxConcurrentSessions: number;
  memberConcurrency: number;
  swarmWorkers: number;
}

export const PRODUCTION_CADENCE_INTENT: Readonly<ProductionCadenceIntent> = Object.freeze({
  profile: "realistic",
  swarmIntervalMs: 21_600_000, // 6 h per subject
  swarmWindowMs: 21_600_000, // …and the window IS that interval
  swarmSchedulesEnabled: "0",
  maxConcurrentSessions: 1, // one session at a time
  memberConcurrency: 4, // the old SWARM_MAX_CONCURRENCY default
  swarmWorkers: 1, // one worker-swarm container
});

/** The concurrency fields, named once so both assertion branches walk the same list. */
const CONCURRENCY_FIELDS = ["maxConcurrentSessions", "memberConcurrency", "swarmWorkers"] as const;

/**
 * PURE. Returns every way this boot's constants disagree with what it claims to
 * be; empty means they agree.
 *
 * `production` is the `--static-port` boot — the one cloudflared points at.
 * Both branches assert, and they assert OPPOSITE things, which is what makes
 * this unsatisfiable by a CI run on an accelerated clock: a fast-profile boot
 * cannot pass the production branch, it is required to fail it. The production
 * branch is reachable only from an invocation that actually selected the
 * realistic profile.
 */
export function productionConstantMismatches(
  cadence: SmokeCadence,
  env: Record<string, string | undefined>,
  opts: { production: boolean; twin?: boolean },
): string[] {
  const problems: string[] = [];
  const schedules = env.SWARM_SCHEDULES_ENABLED;
  if (opts.production) {
    if (cadence.profile !== PRODUCTION_CADENCE_INTENT.profile) {
      problems.push(
        `resolved cadence profile is '${cadence.profile}', production intends ` +
          `'${PRODUCTION_CADENCE_INTENT.profile}'`,
      );
    }
    if (cadence.swarmIntervalMs !== PRODUCTION_CADENCE_INTENT.swarmIntervalMs) {
      problems.push(
        `swarmIntervalMs is ${cadence.swarmIntervalMs}, production intends ` +
          `${PRODUCTION_CADENCE_INTENT.swarmIntervalMs}`,
      );
    }
    if (cadence.swarmWindowMs !== PRODUCTION_CADENCE_INTENT.swarmWindowMs) {
      problems.push(
        `swarmWindowMs is ${cadence.swarmWindowMs}, production intends ` +
          `${PRODUCTION_CADENCE_INTENT.swarmWindowMs}`,
      );
    }
    // UNSET IS A FAILURE, NOT A PASS (issue #806). This used to skip when the
    // variable was absent or empty, on the reading that "nobody exported one"
    // is safe. It is the opposite of safe: docker-compose.yml declares
    // `SWARM_SCHEDULES_ENABLED: ${SWARM_SCHEDULES_ENABLED:-1}`, so an unset
    // variable is not "no crons" — it is the DEFAULT-ON cron cadence, whose five
    // seeded `job_schedules` rows are subject-blind (`resolveSwarmSchedules`
    // emits no subjectId) and, critically, include NO `swarm.judge`. A boot that
    // simply failed to export it therefore got a third cadence, running sessions
    // that can never be judged, past an assertion that reported nothing wrong.
    // The intent is a literal "0" and the check now demands exactly that.
    if (schedules !== PRODUCTION_CADENCE_INTENT.swarmSchedulesEnabled) {
      problems.push(
        `SWARM_SCHEDULES_ENABLED=${schedules === undefined ? "(unset)" : `'${schedules}'`} in a production boot; ` +
          `production intends '${PRODUCTION_CADENCE_INTENT.swarmSchedulesEnabled}' (the host driver is the ` +
          "scheduler, and compose defaults this variable to '1' when it is not exported). Export " +
          "SWARM_SCHEDULES_ENABLED=0 in the repo-root .env.",
      );
    }
    for (const field of CONCURRENCY_FIELDS) {
      if (cadence[field] !== PRODUCTION_CADENCE_INTENT[field]) {
        problems.push(`${field} is ${cadence[field]}, production intends ${PRODUCTION_CADENCE_INTENT[field]}`);
      }
    }
  } else {
    // A non-production boot must be the fast profile. Stated as an assertion,
    // not an assumption: it is what stops a `--static-port`-less invocation
    // from quietly inheriting a six-hour window and hanging its own gate.
    if (cadence.profile !== "fast") {
      problems.push(`a non-production boot resolved the '${cadence.profile}' profile; only 'fast' is allowed`);
    }
    const expectedWindow = opts.twin ? TWIN_WINDOW_MS : FAST_INTERVAL_MS;
    if (cadence.swarmWindowMs !== expectedWindow) {
      problems.push(`a non-production ${opts.twin ? "twin " : ""}boot has swarmWindowMs=${cadence.swarmWindowMs}, expected ${expectedWindow}`);
    }
  }
  // Holds in BOTH branches: the dead-zone fix is this equality and nothing else.
  if (cadence.swarmWindowMs !== cadence.swarmIntervalMs) {
    problems.push(
      `swarmWindowMs (${cadence.swarmWindowMs}) must equal swarmIntervalMs (${cadence.swarmIntervalMs}) — ` +
        "the window is one full cadence interval so session N's cutoff is session N+1's convene",
    );
  }
  // Also BOTH branches. A zero, fractional or negative count would stall the
  // driver (no session may start), run an unbounded member fan-out, or ask
  // compose for a meaningless replica count; none of those is a cadence.
  for (const field of CONCURRENCY_FIELDS) {
    if (!Number.isInteger(cadence[field]) || cadence[field] < 1) {
      problems.push(`${field} is ${cadence[field]}; it must be a whole number of at least 1`);
    }
  }
  // The lane rule that makes concurrent sessions safe (SmokeCadence.swarmWorkers):
  // fewer workers than sessions puts one subject's minutes-long judge job in
  // front of another subject's lifecycle step.
  if (cadence.swarmWorkers < cadence.maxConcurrentSessions) {
    problems.push(
      `swarmWorkers (${cadence.swarmWorkers}) is below maxConcurrentSessions (${cadence.maxConcurrentSessions}) — ` +
        "every session in flight needs a swarm worker free for its current lifecycle job",
    );
  }
  return problems;
}

/** Loudly fatal wrapper for productionConstantMismatches — called at smoke boot. */
export function assertProductionConstants(
  cadence: SmokeCadence,
  env: Record<string, string | undefined>,
  opts: { production: boolean; twin?: boolean },
): void {
  const problems = productionConstantMismatches(cadence, env, opts);
  if (problems.length === 0) return;
  throw new Error(
    `[smoke] REFUSING TO BOOT — the constants in force are not the ones this invocation claims ` +
      `(${opts.production ? "production/--static-port" : "non-production"}):\n` +
      problems.map((p) => `  - ${p}`).join("\n"),
  );
}

/**
 * The BOOT resolver: resolve the profile for one invocation and assert it is
 * the one that invocation claims to be, in a single step that cannot be half
 * performed.
 *
 * Deliberately not two calls. A separate `assertProductionConstants(...)` line
 * next to the resolve is a line anyone can delete, reorder, or forget to add to
 * a new entry point — and the whole point of this check is that the constants
 * cannot silently drift from intent. Fusing them makes "resolved the cadence"
 * and "proved the cadence" the same event. `resolveSmokeCadence` stays exported
 * and pure for tests and for smoke-live-smoke.ts, which deliberately pins itself
 * to the FAST profile rather than to whatever is running.
 *
 * Throws — the boot dies here rather than serving a swarm whose cadence, window
 * or scheduler ownership is not what the invocation claims.
 */
/**
 * A twin's submission window: the fast profile's spacing, but a window wide
 * enough to survive the brief step. The driver publishes each session's brief
 * INSIDE its window, and that step fetches live market data; on 2026-09-25 a
 * rate-limited source (geckoterminal HTTP 429, five retries) consumed the whole
 * 2-minute window before any member started, every member got `409 submission
 * window closed`, and the session published with no takes.
 *
 * The driver waits out every window it publishes, in full (only a twin's
 * ADOPTED window is not its own to wait out, see session.ts). CI's fast
 * profile is untouched.
 */
export const TWIN_WINDOW_MS = 6 * 60_000;

export function resolveSmokeCadenceForBoot(
  opts: { stage: boolean; twin?: boolean; env: Record<string, string | undefined> },
): SmokeCadence {
  const base = resolveSmokeCadence({ stage: opts.stage });
  // Interval moves WITH the window: the dead-zone rule below (window ===
  // interval) holds for every profile, the twin's included.
  const twin = Boolean(opts.twin) && !opts.stage;
  const cadence = twin ? { ...base, swarmIntervalMs: TWIN_WINDOW_MS, swarmWindowMs: TWIN_WINDOW_MS } : base;
  assertProductionConstants(cadence, opts.env, { production: opts.stage, twin });
  return cadence;
}

export interface SubjectCadencePlan {
  /** Position of this subject in the smoke's subject list. */
  index: number;
  /** Absolute epoch ms of this subject's FIRST session. */
  firstAt: number;
  /**
   * Absolute epoch ms of this subject's SECOND session — the first slot on the
   * steady-state grid (`≡ index * phaseOffsetMs (mod swarmIntervalMs)`)
   * strictly after `firstAt`.
   */
  steadyStartAt: number;
  /** Steady-state interval for this subject. */
  intervalMs: number;
  /** Phase offset applied to this subject's steady-state grid. */
  phaseOffsetMs: number;
}

/**
 * Plan every subject's session timetable for one smoke boot.
 *
 * Two rules, both previously inline in smoke-main.ts's swarm driver:
 *
 *   1. PROMPTNESS — subject `i`'s first session fires at
 *      `now + i * swarmBootstrapStaggerMs`, so the site has data on first
 *      load under BOTH profiles (bounded by DEMO_FIRST_SESSION_MAX_MS for
 *      either scenario's subject count — two or four).
 *   2. PHASE OFFSET — steady-state slots for subject `i` sit on the grid
 *      `now + i * (swarmIntervalMs / subjectCount) + n * swarmIntervalMs`,
 *      so sessions are spread evenly instead of clustering. The first steady
 *      slot is the earliest grid point strictly after that subject's first run.
 *
 * Under the fast profile with 2 subjects the steady-state grid is unchanged
 * (0s/120s/240s… and 60s/180s/300s…); only the second subject's bring-up
 * session moved from 60 s to 40 s with the four-subject promptness fix.
 *
 * A planned slot is a lower bound, not an appointment: a session lasts at least
 * its window, and the window IS the interval, so a subject's next slot has
 * normally passed by the time its session publishes. The driver then convenes
 * it at once (`max(plannedRunAt, now)`) — no idle time between one subject's
 * sessions, which with concurrent sessions is what "the cadence" means.
 */
export function planSubjectSchedules(
  subjectCount: number,
  cadence: SmokeCadence,
  nowMs: number,
): SubjectCadencePlan[] {
  if (!Number.isInteger(subjectCount) || subjectCount < 1) {
    throw new Error(`planSubjectSchedules needs at least one subject, got ${subjectCount}`);
  }
  const phaseOffsetMs = cadence.swarmIntervalMs / subjectCount;
  return Array.from({ length: subjectCount }, (_, index) => {
    const firstAt = nowMs + index * cadence.swarmBootstrapStaggerMs;
    const anchor = nowMs + index * phaseOffsetMs;
    // Smallest k >= 0 with anchor + k*interval STRICTLY after firstAt.
    const k = Math.max(0, Math.floor((firstAt - anchor) / cadence.swarmIntervalMs) + 1);
    return {
      index,
      firstAt,
      steadyStartAt: anchor + k * cadence.swarmIntervalMs,
      intervalMs: cadence.swarmIntervalMs,
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

// ── The session scheduler's decision (concurrent sessions, one code path) ────
// swarm/session-scheduler.ts keeps only the I/O: it asks subjectsToStart which
// subjects to convene now, starts them without awaiting, and sleeps until
// nextSchedulerWakeAt or until a running session ends, whichever is first. The
// decision lives HERE, pure, because smoke-main.ts cannot be imported by a test.

export interface SchedulerSubjectState {
  /** Epoch ms this subject's next session is due. */
  nextAt: number;
  /** Is a session for this subject in flight right now? */
  running: boolean;
}

/**
 * PURE. Indices (into `subjects`) of the subjects to convene at `nowMs`.
 *
 * Three rules, and nothing else:
 *   1. a subject with a session in flight is never started again — at most ONE
 *      session per subject (openSession would adopt the open one anyway, and
 *      the driver would then be waiting out the same window twice);
 *   2. only subjects whose `nextAt` has arrived are due;
 *   3. at most `maxConcurrent` sessions in flight, filled earliest-`nextAt`
 *      first, ties to the lower index.
 *
 * With `maxConcurrent = 1` this IS the old sequential loop: it picked the
 * earliest-due subject (`reduce` keeping the first on a tie), slept until its
 * slot, and ran it to completion before choosing again.
 */
export function subjectsToStart(
  subjects: readonly SchedulerSubjectState[],
  nowMs: number,
  maxConcurrent: number,
): number[] {
  const running = subjects.filter((s) => s.running).length;
  const free = Math.max(0, maxConcurrent - running);
  if (free === 0) return [];
  return subjects
    .map((s, index) => ({ ...s, index }))
    .filter((s) => !s.running && s.nextAt <= nowMs)
    .sort((a, b) => a.nextAt - b.nextAt || a.index - b.index)
    .slice(0, free)
    .map((s) => s.index);
}

/**
 * PURE. When the scheduler should next look again on its own — the earliest
 * `nextAt` among idle subjects — or `Infinity` when every free slot is taken
 * (only a running session ending can change anything then) or no subject is
 * idle. The driver also wakes whenever a running session ends.
 */
export function nextSchedulerWakeAt(
  subjects: readonly SchedulerSubjectState[],
  maxConcurrent: number,
): number {
  const running = subjects.filter((s) => s.running).length;
  if (running >= maxConcurrent) return Infinity;
  return subjects.reduce((min, s) => (s.running ? min : Math.min(min, s.nextAt)), Infinity);
}

/**
 * Member containers per session: `SWARM_MAX_CONCURRENCY` when the environment
 * sets it (the pre-existing override, parsed exactly as before — so an empty
 * string still means "unbounded"), otherwise the profile's memberConcurrency.
 */
export function resolveMemberConcurrency(
  cadence: SmokeCadence,
  env: Record<string, string | undefined>,
): number {
  const raw = env.SWARM_MAX_CONCURRENCY;
  return raw === undefined ? cadence.memberConcurrency : Number(raw);
}

/**
 * The smoke's synthetic session date: one calendar day per completed run for THIS
 * subject, so sessions accumulate without colliding on the backend's
 * UNIQUE(date, subject_id). Behaviour is unchanged from the inline expression it
 * replaces — the 2027-dated-session question belongs to issue #345, not here.
 */
// sessionDateFor() is REMOVED. It returned `now + runs days` — the smoke's
// synthetic session date, invented client-side so repeat runs would not collide
// on the backend's old UNIQUE(date, subject_id), and kept viable by a boot-time
// TRUNCATE of session history. Migration 0022 made a session's date DERIVED from
// the convened_at Postgres stamps, so a session's date is now a fact the
// database reports rather than a value any caller may choose. The driver opens
// the session first and reads the date back.

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
 * force. Pure, so scripts/tests/unit/smoke-schedule.test.ts executes it directly.
 */
export function renderCadenceLine(cadence: SmokeCadence, subjectCount: number): string {
  const perSubject = formatCadenceDuration(cadence.swarmIntervalMs);
  const overall = formatCadenceDuration(swarmStaggerMsFor(cadence, subjectCount));
  const window = formatCadenceDuration(cadence.swarmWindowMs);
  return (
    `Demo actions: a swarm session per subject every ~${perSubject} ` +
    `(${subjectCount} subjects staggered → one lands about every ~${overall}); ` +
    `submission window ${window} (one full interval, so no gap between sessions); ` +
    `research ${describeCron(cadence.researchCron)}, regime ${describeCron(cadence.regimeCron)}.`
  );
}
