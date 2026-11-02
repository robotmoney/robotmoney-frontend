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
// an absence was recorded before the excusal. Inactive seats have no count
// (null).
//
// A JUDGE'S COUNT (issue 1495). An active judge-role seat counts the sessions
// whose judging deadline passed after the latest of
//   - the judge's newest ON-TIME answer (created at or before its session's
//     judging deadline; one resets the count for every later session),
//   - the judge's activated_at,
//   - swarm_dormancy_baseline.counted_from,
// that had at least one take, that the judge has no take in, that ran with
// judging on, and that the judge could answer (an in-house seat, or outside
// judging switched on: an outside judge is not charged for a session it was
// refused). A judge that answered after the deadline filed no on-time answer.
//
// READ ONLY, AND NOTHING ACTS ON IT. Owner decision 2026-10-09: no automatic
// deactivation, excusal or key revocation. The count is shown on the public
// member page and the admin member list (memberStatusLine in
// frontend/public/assets/js/app/lib/member-status.js); removal stays the
// explicit admin action deactivateMemberAdmin. Absences are recorded exactly as
// before (domain.ts recordAbsencesTx).
import { sql, type DbHandle } from "../db/client.ts";
import { on, registerQuery } from "../db/registry.ts";
// A cycle with domain.ts (which imports this module): the constants are read only when a query runs.
import { IN_HOUSE_OPERATOR, IN_HOUSE_SEAT_HANDLES } from "./domain.ts";

/** The status line's default threshold, the same number the page uses. */
export const DEFAULT_SWARM_DORMANCY_THRESHOLD_SESSIONS = 7;

/** SWARM_DORMANCY_THRESHOLD_SESSIONS, or the default when unset or not a positive integer. */
export function dormancyThresholdSessions(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.SWARM_DORMANCY_THRESHOLD_SESSIONS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SWARM_DORMANCY_THRESHOLD_SESSIONS;
}

// getMember()'s callers, as resolveMemberRow declares them, the admin list, the
// admin overview's quiet-seat alerts and a seat's own health read.
const CALLERS = [
  "src/api/routes/swarm",
  "src/api/routes/swarm/onboarding",
  "src/api/routes/swarm-admin",
  "src/api/routes/admin",
  "src/api/routes/swarm-judge-participant",
];

const SILENT_STATEMENT =
  "SELECT m.id AS member_id, m.role AS role, m.handle AS handle, m.name AS name, " +
  "CASE WHEN m.role = 'judge' THEN jm.n ELSE (SELECT count(*)::int FROM swarm_agent_health_events e " +
  "JOIN swarm_sessions s ON s.id = e.session_id WHERE e.member_id = m.id AND e.event_type = 'absent' " +
  "AND s.convened_at > GREATEST(m.activated_at, b.counted_from, " +
  "(SELECT max(r.received_at) FROM swarm_recommendations r WHERE r.member_id = m.id)) " +
  "AND NOT EXISTS (SELECT 1 FROM swarm_session_members sm WHERE sm.session_id = e.session_id " +
  "AND sm.member_id = e.member_id AND sm.status = 'excused')) END AS silent_sessions, " +
  "jm.oldest AS oldest_miss_at " +
  "FROM swarm_members m LEFT JOIN swarm_dormancy_baseline b ON true " +
  "LEFT JOIN LATERAL (SELECT count(*)::int AS n, min(js.judging_deadline_at) AS oldest FROM swarm_sessions js " +
  "WHERE m.role = 'judge' AND js.judging_deadline_at IS NOT NULL AND js.judging_deadline_at < now() " +
  "AND js.judge_mode IS DISTINCT FROM 'off' " +
  "AND js.judging_deadline_at > GREATEST(m.activated_at, b.counted_from, " +
  "(SELECT max(j.created_at) FROM swarm_session_judgements j JOIN swarm_sessions ps ON ps.id = j.session_id " +
  "WHERE j.judged_by_member_id = m.id AND j.created_at <= ps.judging_deadline_at)) " +
  "AND EXISTS (SELECT 1 FROM swarm_recommendations jr WHERE jr.session_id = js.id) " +
  "AND NOT EXISTS (SELECT 1 FROM swarm_recommendations mr WHERE mr.session_id = js.id AND mr.member_id = m.id) " +
  "AND (m.operator = $2 OR m.handle = ANY(string_to_array($3, ',')) " +
  "OR COALESCE((SELECT c.third_party_enabled FROM swarm_judge_config c WHERE c.id = 1), false))) jm ON true " +
  "WHERE m.status = 'active' AND m.role IN ('member', 'judge') AND ($1::text IS NULL OR m.id = $1::text)";
const SILENT_PROBE = { statement: SILENT_STATEMENT, params: [null, "robotmoney", "athena"] } as const;
const PURPOSE = "Count each seated member's consecutive missed sessions since its latest take, activation or the dormancy baseline, and each judge's since its latest on-time answer.";
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
const silentJudgements = registerQuery({
  role: "rm_app", object: "swarm_session_judgements", privileges: ["SELECT"],
  site: "src/swarm/dormancy:silentSessions.judgements",
  purpose: PURPOSE, callers: CALLERS, probe: SILENT_PROBE,
});
const silentConfig = registerQuery({
  role: "rm_app", object: "swarm_judge_config", privileges: ["SELECT"],
  site: "src/swarm/dormancy:silentSessions.config",
  purpose: PURPOSE, callers: CALLERS, probe: SILENT_PROBE,
});

/** One active seat's silence, as the overview and the count reader see it. */
export interface SeatSilence {
  memberId: string;
  role: "member" | "judge";
  handle: string | null;
  name: string | null;
  silentSessions: number;
  /** A judge's oldest counted miss (its judging deadline), null for a member. */
  oldestMissAt: Date | null;
}

async function readSeatSilence(memberId: string | null, tx: DbHandle): Promise<SeatSilence[]> {
  const handles = IN_HOUSE_SEAT_HANDLES.join(",");
  const rows = await on(tx, silentMembers, silentBaseline, silentEvents, silentSessionsTable, silentTakes, silentSeats, silentJudgements, silentConfig)<{
    member_id: string;
    role: "member" | "judge";
    handle: string | null;
    name: string | null;
    silent_sessions: number;
    oldest_miss_at: Date | null;
  }>`
    SELECT m.id AS member_id, m.role AS role, m.handle AS handle, m.name AS name,
           CASE WHEN m.role = 'judge' THEN jm.n ELSE (SELECT count(*)::int
              FROM swarm_agent_health_events e
              JOIN swarm_sessions s ON s.id = e.session_id
             WHERE e.member_id = m.id AND e.event_type = 'absent'
               AND s.convened_at > GREATEST(m.activated_at, b.counted_from,
                     (SELECT max(r.received_at) FROM swarm_recommendations r WHERE r.member_id = m.id))
               AND NOT EXISTS (SELECT 1 FROM swarm_session_members sm
                                WHERE sm.session_id = e.session_id AND sm.member_id = e.member_id
                                  AND sm.status = 'excused')) END AS silent_sessions,
           jm.oldest AS oldest_miss_at
      FROM swarm_members m
      LEFT JOIN swarm_dormancy_baseline b ON true
      LEFT JOIN LATERAL (SELECT count(*)::int AS n, min(js.judging_deadline_at) AS oldest FROM swarm_sessions js
         WHERE m.role = 'judge' AND js.judging_deadline_at IS NOT NULL AND js.judging_deadline_at < now()
           AND js.judge_mode IS DISTINCT FROM 'off'
           AND js.judging_deadline_at > GREATEST(m.activated_at, b.counted_from,
                 (SELECT max(j.created_at) FROM swarm_session_judgements j JOIN swarm_sessions ps ON ps.id = j.session_id
                   WHERE j.judged_by_member_id = m.id AND j.created_at <= ps.judging_deadline_at))
           AND EXISTS (SELECT 1 FROM swarm_recommendations jr WHERE jr.session_id = js.id)
           AND NOT EXISTS (SELECT 1 FROM swarm_recommendations mr WHERE mr.session_id = js.id AND mr.member_id = m.id)
           AND (m.operator = ${IN_HOUSE_OPERATOR} OR m.handle = ANY(string_to_array(${handles}, ','))
                OR COALESCE((SELECT c.third_party_enabled FROM swarm_judge_config c WHERE c.id = 1), false))) jm ON true
     WHERE m.status = 'active' AND m.role IN ('member', 'judge')
       AND (${memberId}::text IS NULL OR m.id = ${memberId}::text)`;
  return rows.map((r) => ({
    memberId: r.member_id,
    role: r.role,
    handle: r.handle,
    name: r.name,
    silentSessions: Number(r.silent_sessions),
    oldestMissAt: r.oldest_miss_at ? new Date(r.oldest_miss_at) : null,
  }));
}

/**
 * Each active seat's count, keyed by member id; one seat's when `memberId` is
 * given. A seat absent from the map has no count (it is not active), which the
 * projections render as null.
 */
export async function silentSessionsByMember(memberId: string | null = null, tx: DbHandle = sql): Promise<Map<string, number>> {
  return new Map((await readSeatSilence(memberId, tx)).map((r) => [r.memberId, r.silentSessions]));
}

/** How long a judge may go without an on-time answer before admin hears of it. */
export const QUIET_JUDGE_MS = 24 * 3600 * 1000;

/**
 * The seats admin should hear about (issue 1495): a member at or past
 * `threshold` missed sessions, and a judge whose misses began more than a day
 * ago with no on-time answer since. Read only: nothing acts on it.
 */
export async function quietSeats(
  threshold: number = dormancyThresholdSessions(),
  now: Date = new Date(),
  tx: DbHandle = sql,
): Promise<SeatSilence[]> {
  return (await readSeatSilence(null, tx)).filter((s) =>
    s.role === "member"
      ? s.silentSessions >= threshold
      : s.silentSessions > 0 && s.oldestMissAt !== null && now.getTime() - s.oldestMissAt.getTime() >= QUIET_JUDGE_MS);
}
