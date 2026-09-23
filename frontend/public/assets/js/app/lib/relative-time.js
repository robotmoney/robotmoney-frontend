// One relative-time formatter. There were already three near-identical copies
// when this was written — views/list2.js:126, views/list3.js:124 and
// views/dash-vaults.js:92 — agreeing on "just now / Nm ago / Nh ago / Nd ago"
// and disagreeing past a month, so the fourth caller got this instead of a
// fourth copy. Those three are worth folding in, but they belong to other
// views and are not this change's to move.
//
// The scale is coarse on purpose. These stamps sit next to a countdown in the
// same component, and a ticking seconds figure would imply a precision the
// swarm's cadence does not have.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * "3 min ago", "2h ago", "4d ago". Empty string when there is nothing to say,
 * so a caller can `x-show` on it rather than render a placeholder.
 *
 * @param {string|number|Date|null|undefined} value
 * @param {number} now
 * @returns {string}
 */
export function timeAgo(value, now = Date.now()) {
  const t = value instanceof Date ? value.getTime()
    : typeof value === "number" ? value
      : value ? Date.parse(value) : NaN;
  if (!Number.isFinite(t)) return "";

  const ms = now - t;
  // A future instant is not "ago". Callers that can be handed one (a window
  // that has not closed yet) want the countdown instead, so say nothing here
  // rather than render "-3 min ago".
  if (ms < 0) return "";

  if (ms < MIN) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MIN)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  return `${Math.floor(ms / DAY)}d ago`;
}

/**
 * "3h 20m", "45 min", "under a minute": the time left until an instant, for a
 * window's countdown. Empty once it has passed (or when there is no instant),
 * so a caller switches to timeAgo() on the same stamp.
 *
 * @param {string|number|Date|null|undefined} value
 * @param {number} now
 * @returns {string}
 */
export function timeLeft(value, now = Date.now()) {
  const t = value instanceof Date ? value.getTime()
    : typeof value === "number" ? value
      : value ? Date.parse(value) : NaN;
  if (!Number.isFinite(t)) return "";
  const ms = t - now;
  if (ms <= 0) return "";
  const mins = Math.floor(ms / MIN);
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * The absolute instant, for the title attribute behind a relative stamp.
 * Minute precision and always UTC, matching how the swarm states times
 * everywhere else.
 *
 * @param {string|number|Date|null|undefined} value
 * @returns {string} e.g. "2026-08-27 15:25 UTC", or "" when unparseable.
 */
export function absoluteUtc(value) {
  const t = value instanceof Date ? value.getTime()
    : typeof value === "number" ? value
      : value ? Date.parse(value) : NaN;
  if (!Number.isFinite(t)) return "";
  try {
    return `${new Date(t).toISOString().replace("T", " ").slice(0, 16)} UTC`;
  } catch (_) {
    return "";
  }
}
