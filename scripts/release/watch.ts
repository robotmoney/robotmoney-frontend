// scripts/release/watch.ts — how long the release soak (W1, W2, R7.4a) waits after READY.
//
// THE SOAK (owner, 2026-10-14). Every target soaks SOAK_HOURS (30 minutes)
// after READY, with sessions deferred, then collects every container's logs
// (W2). The release no longer waits for a session to publish: the version tag
// is cut at the cutover (D70), so a session outcome cannot change the release,
// and a 37 h wait only delayed the evidence. Sessions are graded afterwards, as
// a report, by the same gate with `--sessions graded` once DEFAULT_WATCH_HOURS
// have passed (docs/technical/release-runbooks.md §4.7). The text below derives that bound.
//
// W1 runs `prod:gate --mode post-release --since READY`. Its check 7 needs
// every subject to publish one good (judged, receipted, attended) session in
// the window (scripts/lib/gate/grade.ts, per-subject `minSessions`). The owner
// decided on 2026-10-08 to keep that per-subject rule and make the watch long
// enough for the slowest subject instead.
//
// The slowest subject is one with no open window when the new stack boots
// (stage run 20261008T042158Z: robotmoney-treasury and woon). The scheduler
// gives it a FIRST epoch (docs/technical/system-scheduler-spec.md §2.2): it
// closes on the first grid instant at least half a duration after now, so the
// window lasts up to one and a half epochs. Then judging may take up to the
// subject's judging duration, and R7.4a allows a publish grace after that.
// Every subject runs 24 h epochs (owner decision 2026-10-09: one session per
// subject per day, as production ran before v0.6.0; checked by R7.4a), so:
//
//   1.5 × 24 h + 900 s judging + 1800 s grace = 36.75 h, rounded up to 37 h.
//
// A subject whose window was already open at boot closes it within one epoch
// (24 h), well inside that bound.
//
// A target that grades sessions in its soak must wait that long. The default
// soak defers them: W1 runs prod:gate --sessions deferred and R7.4a skips the
// in-flight publish check, because no 24 h epoch can close in 30 minutes.
// The target file sets both (./target.ts); the step list never changes.
//
// Pure. Unit tests: scripts/tests/unit/release-watch.test.ts.

/** Production's epoch, every active subject (owner decision 2026-10-09). */
export const PRODUCTION_EPOCH_SECONDS = 86400;
/** The spacing of the four production subjects' closes, times of day 6 h apart (migration 0121, issue 1286). */
export const SUBJECT_CLOSE_SPACING_SECONDS = 21600;
/** The default judging wait a subject carries (migration 0090). */
export const DEFAULT_JUDGING_SECONDS = 900;
/** Slack after close + judging before a publish counts as late (R7.4a). */
export const PUBLISH_GRACE_SECONDS = 1800;

/** The longest a first epoch's window lasts, as a share of the epoch (scheduler spec §2.2). */
export const FIRST_EPOCH_FACTOR = 1.5;

export interface WatchInputs {
  readonly epochSeconds: number;
  readonly judgingSeconds: number;
  readonly graceSeconds: number;
}

/**
 * Whole hours after READY by which every subject has published once: the
 * longest first epoch, plus its judging, plus the publish grace, rounded up.
 */
export function watchHoursFor(inputs: WatchInputs): number {
  const { epochSeconds, judgingSeconds, graceSeconds } = inputs;
  for (const [k, v] of Object.entries(inputs)) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`watchHoursFor: ${k} must be a non-negative number, got ${v}`);
  }
  if (epochSeconds <= 0) throw new Error("watchHoursFor: epochSeconds must be positive");
  return Math.ceil((FIRST_EPOCH_FACTOR * epochSeconds + judgingSeconds + graceSeconds) / 3600);
}

/** The soak every target gets unless its file sets another `watchHours`: 30 minutes (owner, 2026-10-14). */
export const SOAK_HOURS = 0.5;

/** The bound after which every subject has published once: 37 h. The post-release session report waits this long; the release does not. */
export const DEFAULT_WATCH_HOURS = watchHoursFor({
  epochSeconds: PRODUCTION_EPOCH_SECONDS,
  judgingSeconds: DEFAULT_JUDGING_SECONDS,
  graceSeconds: PUBLISH_GRACE_SECONDS,
});

/** How the watch treats sessions: graded (production) or deferred (a short stage watch). */
export const WATCH_SESSIONS = ["graded", "deferred"] as const;
export type WatchSessions = (typeof WATCH_SESSIONS)[number];
