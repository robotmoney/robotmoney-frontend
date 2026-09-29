// The session lifecycle verbs the fixtures drive sessions with.
//
// They lived in src/swarm/admin.ts. No route, worker or script reaches them: the
// admin route answers 410 to each (D55 decision 4) and the scheduler settles a
// session through the API. A statement no production path issues has no call
// site to declare (D55 (13)), so the verbs moved here, where the legacy-fixture
// suites that still drive sessions with them import them. This file issues
// plain statements because tests are not in the registry's scope.
import { sql, type DbHandle } from "../../src/db/client.ts";
import { aggregateSession as domainAggregateSession } from "../../src/swarm/domain.ts";
import { ADMIN_ACTOR, type AdminResult } from "../../src/swarm/admin.ts";

type Actor = string;

function err(status: number, error: string): AdminResult {
  return { ok: false, status, error };
}

async function audit(actor: Actor, action: string, scope: Record<string, unknown>, tx: DbHandle = sql) {
  await tx`INSERT INTO audit_log (actor, action, scope) VALUES (${actor}, ${action}, ${tx.json(scope as any)})`;
}

// ── Guarded lifecycle transitions ───────────────────────────────────────────
// Session states: scheduled → collecting → window_closed → aggregated →
// [judged] → published, with `cancelled` reachable from any non-terminal state
// and `window_closed` reopenable back to `collecting`. published/cancelled are
// terminal — no further transition is ever legal. Action names and the legal
// matrix match docs/architecture.md §4 US-C4 exactly.
//
// `judged` (issue #752) is the JUDGED-BUT-UNSIGNED state, and it is OPTIONAL BY
// CONSTRUCTION: `aggregated -> published` remains legal, so a deployment with
// the judge off publishes exactly the sessions it publishes today and the state
// never appears. It reopens like `aggregated` does, so a session whose judge
// said "hold" can go back for more takes rather than being stuck one step from
// terminal.
//
// NO STATE ADDED HERE CAN REOPEN THE SUBMISSION WINDOW. A take — first or
// amendment — lands only while its session is `collecting` and before its
// `window_closes_at` (D51; the INSERT in domain.ts submitRecommendation), so
// every other state is frozen by construction. `swarm-take-revisions.test.ts`
// walks SESSION_STATES below and asserts it.
const TERMINAL = new Set(["published", "cancelled"]);
const TRANSITIONS: Record<string, readonly string[]> = {
  scheduled: ["collecting", "cancelled"],
  collecting: ["window_closed", "cancelled"],
  window_closed: ["collecting", "aggregated", "cancelled"],
  aggregated: ["window_closed", "judged", "published"],
  judged: ["window_closed", "published"],
  published: [],
  cancelled: [],
};
/** Every session state the lifecycle knows about. Exported so a test can walk
 *  the whole set rather than a hand-copied literal. */
export const SESSION_STATES: readonly string[] = Object.freeze(Object.keys(TRANSITIONS));

const ACTION_FOR_TO_STATE: Record<string, string> = {
  collecting: "publish_brief", // scheduled -> collecting; window_closed -> collecting is "reopen" (passed explicitly)
  window_closed: "close_window",
  aggregated: "aggregate",
  judged: "judge",
  published: "publish",
  cancelled: "cancel",
};

export interface GuardedTransitionResult extends AdminResult {
  session?: { id: string; state: string; version: number };
  idempotent?: boolean;
}

// Advances swarm_sessions.state under an optimistic-concurrency + legal-
// transition guard, and writes exactly one swarm_session_events row
// (with the NOT NULL `action` column the canonical schema requires) and one
// audit_log row for every REAL transition, transactionally. Re-requesting the
// CURRENT state is idempotent (200, no version bump, no new event/audit row);
// requesting a transition out of a terminal state, or one not in the legal
// table, is 409.
export async function guardedTransition(
  sessionId: string,
  toState: string,
  actor: Actor,
  opts: { expectedVersion?: number; action?: string; reason?: string } = {},
): Promise<GuardedTransitionResult> {
  return sql.begin((tx) => transitionWithin(tx, sessionId, toState, actor, opts));
}

/**
 * The guard's body, on a transaction handle. It was split out so the retired
 * inline judge could put a transition and a judgement row in one transaction;
 * the judge is a participant now (issue #1026) and `guardedTransition` is the
 * only caller, but the handle keeps the transition, its event row and its audit
 * row visibly in one transaction.
 */
async function transitionWithin(
  tx: DbHandle,
  sessionId: string,
  toState: string,
  actor: Actor,
  opts: { expectedVersion?: number; action?: string; reason?: string } = {},
): Promise<GuardedTransitionResult> {
  const action = opts.action ?? ACTION_FOR_TO_STATE[toState] ?? toState;
  const row = (await tx`SELECT id, state, version FROM swarm_sessions WHERE id = ${sessionId} FOR UPDATE`)[0] as
    | { id: string; state: string; version: number }
    | undefined;
  if (!row) return err(404, "session not found");
  if (opts.expectedVersion != null && Number(row.version) !== opts.expectedVersion) return err(409, "stale_version");
  if (row.state === toState) {
    return { ok: true, status: 200, idempotent: true, session: { id: row.id, state: row.state, version: Number(row.version) } };
  }
  if (TERMINAL.has(row.state)) return err(409, `terminal_state:${row.state}`);
  const legal = TRANSITIONS[row.state] ?? [];
  if (!legal.includes(toState)) return err(409, `illegal_transition:${row.state}->${toState}`);
  // A close captures what settlement runs on (system-scheduler-spec.md §4.4),
  // as turnover and deactivation do, so this path cannot produce a session
  // settlement must refuse as `judging_not_captured`. First close only: a
  // re-close after a reopen keeps the values the first close captured.
  const upd = toState === "window_closed"
    ? await tx`
        UPDATE swarm_sessions s
           SET state = 'window_closed', version = s.version + 1,
               judge_mode = COALESCE(s.judge_mode,
                 COALESCE((SELECT CASE WHEN c.mode = 'enforce' THEN 'enforce' ELSE 'off' END
                             FROM swarm_judge_config c WHERE c.id = 1), 'off')),
               judging_duration_seconds = COALESCE(s.judging_duration_seconds, t.judging_duration_seconds)
          FROM swarm_subjects t
         WHERE s.id = ${sessionId} AND t.id = s.subject_id
        RETURNING s.id, s.state, s.version`
    : await tx`UPDATE swarm_sessions SET state = ${toState}, version = version + 1 WHERE id = ${sessionId} RETURNING id, state, version`;
  await tx`
    INSERT INTO swarm_session_events (session_id, from_state, to_state, action, actor, reason)
    VALUES (${sessionId}, ${row.state}, ${toState}, ${action}, ${actor}, ${opts.reason ?? null})`;
  await audit(actor, "session_transition", { sessionId, from: row.state, to: toState, action }, tx);
  return { ok: true, status: 200, session: { id: upd[0].id, state: upd[0].state, version: Number(upd[0].version) } };
}

// No route reaches the five verbs below: routes/swarm-admin.ts answers 410 to
// each (D55 decision 4), and no src module calls them. They remain only because
// legacy-fixture suites (swarm-judge, consensus-receipt-publish and others)
// still drive sessions with them; delete them with those fixtures.
export async function cancelSessionAdmin(sessionId: string, expectedVersion: number | undefined, actor: Actor = ADMIN_ACTOR, reason?: string) {
  return guardedTransition(sessionId, "cancelled", actor, { expectedVersion, reason });
}

export async function closeSessionAdmin(sessionId: string, expectedVersion: number | undefined, actor: Actor = ADMIN_ACTOR, reason?: string) {
  return guardedTransition(sessionId, "window_closed", actor, { expectedVersion, reason });
}

export async function reopenSessionAdmin(sessionId: string, expectedVersion: number | undefined, actor: Actor = ADMIN_ACTOR, reason?: string) {
  return guardedTransition(sessionId, "collecting", actor, { expectedVersion, action: "reopen", reason });
}

export async function aggregateSessionAdmin(sessionId: string, expectedVersion: number | undefined, actor: Actor = ADMIN_ACTOR) {
  const t = await guardedTransition(sessionId, "aggregated", actor, { expectedVersion });
  if (!t.ok) return t;
  const rollup = await domainAggregateSession(sessionId);
  return { ...t, ...rollup, status: t.status };
}


export async function publishSessionAdmin(sessionId: string, expectedVersion: number | undefined, actor: Actor = ADMIN_ACTOR) {
  const t = await guardedTransition(sessionId, "published", actor, { expectedVersion });
  if (!t.ok) return t;
  await sql`UPDATE swarm_sessions SET published_at = now() WHERE id = ${sessionId} AND published_at IS NULL`;
  return t;
}

