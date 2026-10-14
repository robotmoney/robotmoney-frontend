// A seat's consecutive missed sessions (issue 1269, v0.6.0 post-mortem finding 9).
//
// WHAT IT COUNTS. For an active `member`-role seat: the sessions with an
// `absent` row in swarm_agent_health_events that convened after the latest of
//   - the member's newest take (one take resets the count for every later session),
//   - the member's activated_at,
//   - swarm_dormancy_baseline.counted_from (migration 0122: the instant the
//     release carrying this feature was migrated, so the absences the v0.6.0
//     submit rules caused count against no one).
// A session on which an operator excused the seat does not count, even when
// an absence was recorded before the excusal. Judge-role and inactive seats
// have no count (null).
//
// READ ONLY, AND NOTHING ACTS ON IT. Owner decision 2026-10-09: no automatic
// deactivation, excusal or key revocation. The count is shown on the public
// member page and the admin member list (memberStatusLine in
// frontend/public/assets/js/app/lib/member-status.js); removal stays the
// explicit admin action deactivateMemberAdmin. Absences are recorded exactly as
// before (domain.ts recordAbsencesTx).
import { sql, type DbHandle } from "../db/client.ts";
import { on, registerQuery } from "../db/registry.ts";

/** The status line's default threshold, the same number the page uses. */
export const DEFAULT_SWARM_DORMANCY_THRESHOLD_SESSIONS = 7;

/** SWARM_DORMANCY_THRESHOLD_SESSIONS, or the default when unset or not a positive integer. */
export function dormancyThresholdSessions(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.SWARM_DORMANCY_THRESHOLD_SESSIONS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SWARM_DORMANCY_THRESHOLD_SESSIONS;
}

// getMember()'s callers, as resolveMemberRow declares them, and the admin list.
const CALLERS = ["src/api/routes/swarm", "src/api/routes/swarm/onboarding", "src/api/routes/swarm-admin"];

const SILENT_PROBE = {
  statement:
    "SELECT m.id AS member_id, (SELECT count(*)::int FROM swarm_agent_health_events e " +
    "JOIN swarm_sessions s ON s.id = e.session_id WHERE e.member_id = m.id AND e.event_type = 'absent' " +
    "AND s.convened_at > GREATEST(m.activated_at, b.counted_from, " +
    "(SELECT max(r.received_at) FROM swarm_recommendations r WHERE r.member_id = m.id)) " +
    "AND NOT EXISTS (SELECT 1 FROM swarm_session_members sm WHERE sm.session_id = e.session_id " +
    "AND sm.member_id = e.member_id AND sm.status = 'excused')) AS silent_sessions " +
    "FROM swarm_members m LEFT JOIN swarm_dormancy_baseline b ON true " +
    "WHERE m.status = 'active' AND m.role = 'member' AND ($1::text IS NULL OR m.id = $1::text)",
  params: [null],
} as const;
const PURPOSE = "Count each seated member's consecutive missed sessions since its latest take, activation or the dormancy baseline.";
const silentMembers = registerQuery({
  role: "rm_app", object: "swarm_members", privileges: ["SELECT"],
  site: "src/swarm/dormancy:silentSessions.members",
  purpose: PURPOSE, callers: CALLERS, probe: SILENT_PROBE,
});
const silentBaseline = registerQuery({
  role: "rm_app", object: "swarm_dormancy_baseline", privileges: ["SELECT"],
  site: "src/swarm/dormancy:silentSessions.baseline",
  purpose: PURPOSE, callers: CALLERS, probe: SILENT_PROBE,
});
const silentEvents = registerQuery({
  role: "rm_app", object: "swarm_agent_health_events", privileges: ["SELECT"],
  site: "src/swarm/dormancy:silentSessions.healthEvents",
  purpose: PURPOSE, callers: CALLERS, probe: SILENT_PROBE,
});
const silentSessionsTable = registerQuery({
  role: "rm_app", object: "swarm_sessions", privileges: ["SELECT"],
  site: "src/swarm/dormancy:silentSessions.sessions",
  purpose: PURPOSE, callers: CALLERS, probe: SILENT_PROBE,
});
const silentTakes = registerQuery({
  role: "rm_app", object: "swarm_recommendations", privileges: ["SELECT"],
  site: "src/swarm/dormancy:silentSessions.takes",
  purpose: PURPOSE, callers: CALLERS, probe: SILENT_PROBE,
});
const silentSeats = registerQuery({
  role: "rm_app", object: "swarm_session_members", privileges: ["SELECT"],
  site: "src/swarm/dormancy:silentSessions.sessionMembers",
  purpose: PURPOSE, callers: CALLERS, probe: SILENT_PROBE,
});

/**
 * Each active member-role seat's count, keyed by member id; one member's
 * when `memberId` is given. A member absent from the map has no count (a judge,
 * or a seat that is not active), which the projections render as null.
 */
export async function silentSessionsByMember(memberId: string | null = null, tx: DbHandle = sql): Promise<Map<string, number>> {
  const rows = await on(tx, silentMembers, silentBaseline, silentEvents, silentSessionsTable, silentTakes, silentSeats)<{
    member_id: string;
    silent_sessions: number;
  }>`
    SELECT m.id AS member_id,
           (SELECT count(*)::int
              FROM swarm_agent_health_events e
              JOIN swarm_sessions s ON s.id = e.session_id
             WHERE e.member_id = m.id AND e.event_type = 'absent'
               AND s.convened_at > GREATEST(m.activated_at, b.counted_from,
                     (SELECT max(r.received_at) FROM swarm_recommendations r WHERE r.member_id = m.id))
               AND NOT EXISTS (SELECT 1 FROM swarm_session_members sm
                                WHERE sm.session_id = e.session_id AND sm.member_id = e.member_id
                                  AND sm.status = 'excused')) AS silent_sessions
      FROM swarm_members m
      LEFT JOIN swarm_dormancy_baseline b ON true
     WHERE m.status = 'active' AND m.role = 'member'
       AND (${memberId}::text IS NULL OR m.id = ${memberId}::text)`;
  return new Map(rows.map((r) => [r.member_id, Number(r.silent_sessions)]));
}
