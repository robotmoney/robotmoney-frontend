// One answer to "what phase is this session in", because two surfaces were
// answering it differently about the same row: /swarm derived it from the
// deadline, which is what the server does, while /swarm/sessions/:id printed
// `session.state` raw. The same session read "closed" on one page and
// "collecting" on the other, one sentence after the visitor clicked through.
//
// THE DEADLINE IS THE TIMESTAMP, NOT THE STATE. That is the backend's rule, not
// a frontend preference: backend/src/swarm/domain.ts:567 (issue #570) records
// that a `state !== 'collecting'` gate was REMOVED from the submission path for
// creating a dead zone, and the real gate at :589 is
// `window_closes_at < now`. Consequences this file exists to respect:
//
//   * `window_closed` with a timestamp still ahead is a session the API is
//     STILL ACCEPTING TAKES FOR. Calling it shut contradicts the server.
//   * `collecting` past its timestamp is not accepting takes.
//   * a null timestamp is no deadline at all, which the backend treats as open
//     (the `session.window_closes_at &&` conjunct at :589 short-circuits).
//
// And one thing it must NOT do: nothing in the repo advances state by
// timestamp, so an orphaned `collecting` row can sit past its deadline
// indefinitely. That case reports the closure and claims nothing about what
// happens next, because no aggregation is necessarily running or scheduled.
//
// Same shape as swarm-disclaimer.js: one definition, every surface imports it.

export const PHASE = {
  scheduled: "scheduled",
  open: "open",
  aggregating: "aggregating",
  closed: "closed",
  published: "published",
};

// Written to the DB by closeWindow()/aggregateSession(); both mean the window
// is shut AND something is genuinely working on it.
const AGGREGATING_STATES = new Set(["window_closed", "aggregated"]);
// The states worth announcing at all. `scheduled` exists but has no window yet.
const LIVE_STATES = new Set(["collecting", "window_closed", "aggregated"]);

/** @param {unknown} state */
export function isLiveState(state) {
  return LIVE_STATES.has(String(state || ""));
}

/**
 * @param {any} session
 * @param {number} [now]
 * @returns {{key: string, label: string, isOpen: boolean, closesAt: number|null}}
 */
export function sessionPhase(session, now = Date.now()) {
  const state = String(session?.state || "");
  if (state === "published") {
    return { key: PHASE.published, label: "published", isOpen: false, closesAt: null };
  }
  if (state === "scheduled") {
    return { key: PHASE.scheduled, label: "scheduled", isOpen: false, closesAt: null };
  }

  const raw = session?.windowClosesAt ?? session?.window_closes_at ?? null;
  const closesAt = raw ? Date.parse(raw) : null;
  const hasDeadline = Number.isFinite(closesAt);

  // No deadline means no deadline to be past.
  if (!hasDeadline) {
    return { key: PHASE.open, label: "collecting", isOpen: true, closesAt: null };
  }
  if (closesAt !== null && closesAt > now) {
    return { key: PHASE.open, label: "collecting", isOpen: true, closesAt };
  }
  if (AGGREGATING_STATES.has(state)) {
    return { key: PHASE.aggregating, label: "aggregating", isOpen: false, closesAt };
  }
  // Past its deadline and still `collecting`: the orphan. State the closure,
  // promise nothing.
  return { key: PHASE.closed, label: "closed", isOpen: false, closesAt };
}
