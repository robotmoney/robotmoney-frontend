// A seat's silence, from its consecutive missed sessions (issue 1269).
//
// The API counts `silentSessions` (backend/src/swarm/dormancy.ts): the
// sessions an active analyst seat missed since the latest of its newest take,
// its activation and the upgrade that started the count. A judge's count is the
// sessions it filed no on-time answer for (issue 1495). An inactive member and
// the roster list carry null. At the threshold the member page shows a callout
// and the admin member list shows one line. It is a notice, never an action:
// the member stays active, seated and keyed, and only an admin removes it.

/**
 * The fallback threshold, the backend's DEFAULT_SWARM_DORMANCY_THRESHOLD_SESSIONS,
 * for a payload that carries no `silentThreshold` (the static archive).
 */
export const SILENT_THRESHOLD_SESSIONS = 7;

/**
 * `Silent: missed N consecutive sessions` once the count reaches the member's
 * served `silentThreshold` (SWARM_DORMANCY_THRESHOLD_SESSIONS), null below it
 * or when there is no count.
 * A judge's line says what its count is: sessions without an on-time answer.
 * @param {{ role?: string, silentSessions?: number | null, silentThreshold?: number | null } | null | undefined} member
 * @returns {string | null}
 */
export function memberStatusLine(member) {
  const t = member?.silentThreshold;
  const threshold = typeof t === "number" && Number.isInteger(t) && t > 0 ? t : SILENT_THRESHOLD_SESSIONS;
  const n = member?.silentSessions;
  if (typeof n !== "number" || !Number.isFinite(n) || n < threshold) return null;
  if (member?.role === "judge") return `Silent: no on-time answer in ${n} consecutive sessions`;
  return `Silent: missed ${n} consecutive sessions`;
}

/**
 * The member-page callout once `memberStatusLine` is set, or null below the
 * threshold. Both silence wordings get one: a judge who stopped answering on
 * time, and an analyst who stopped filing. The label is the line the admin
 * list already shows. The body says what it means and what to check. The
 * link is the swarm doc for that check.
 * Nothing here deactivates the seat.
 * @param {{ role?: string, silentSessions?: number | null, silentThreshold?: number | null } | null | undefined} member
 * @returns {{ label: string, body: string, href: string, link: string } | null}
 */
export function memberStatusCallout(member) {
  const label = memberStatusLine(member);
  if (!label) return null;
  if (member?.role === "judge") {
    return {
      label,
      body: "The seat stays active. Check the agent is running and connected to the feed.",
      href: "/docs/investment-swarm/participation#judging",
      link: "How a judge stays on the feed",
    };
  }
  return {
    label,
    body: "The seat stays active. Check the agent is running and filing when a session opens.",
    href: "/docs/investment-swarm/runbook#watch",
    link: "How an agent keeps filing",
  };
}
