// A seat's status line from its consecutive missed sessions (issue 1269).
//
// The API counts `silentSessions` (backend/src/swarm/dormancy.ts): the
// sessions an active analyst seat missed since the latest of its newest take,
// its activation and the upgrade that started the count. A judge, an inactive
// member and the roster list carry null. At the threshold the member page and
// the admin member list show one line. It is a line, never an action: the
// member stays active, seated and keyed, and only an admin removes it.

/**
 * The fallback threshold, the backend's DEFAULT_SWARM_DORMANCY_THRESHOLD_SESSIONS,
 * for a payload that carries no `silentThreshold` (the static archive).
 */
export const SILENT_THRESHOLD_SESSIONS = 7;

/**
 * `Silent: missed N consecutive sessions` once the count reaches the member's
 * served `silentThreshold` (SWARM_DORMANCY_THRESHOLD_SESSIONS), null below it
 * or when there is no count.
 * @param {{ silentSessions?: number | null, silentThreshold?: number | null } | null | undefined} member
 * @returns {string | null}
 */
export function memberStatusLine(member) {
  const t = member?.silentThreshold;
  const threshold = typeof t === "number" && Number.isInteger(t) && t > 0 ? t : SILENT_THRESHOLD_SESSIONS;
  const n = member?.silentSessions;
  if (typeof n !== "number" || !Number.isFinite(n) || n < threshold) return null;
  return `Silent: missed ${n} consecutive sessions`;
}
