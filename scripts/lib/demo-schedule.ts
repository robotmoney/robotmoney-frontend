// Demo cadence constants — the SINGLE source for how fast the standing demo
// publishes committee sessions. Shared by the demo orchestrator
// (scripts/lib/demo-main.ts, which drives sessions at this cadence) and the
// nightly LIVE-path smoke assertions (scripts/demo-live-smoke.ts, which derives
// its steady-state deadlines from these instead of magic numbers — issue #128).
// Side-effect free.

/** Interval between committee sessions for ONE subject (~2 min per subject). */
export const COMMITTEE_INTERVAL_MS = 120_000;

/** Stagger between subjects' first sessions so their panes don't fire together. */
export const COMMITTEE_STAGGER_MS = 60_000;
